"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertIcon,
  CheckIcon,
  CloseIcon,
  DownloadIcon,
  ImageIcon,
  SpinnerIcon,
  UploadIcon,
} from "@/components/icons";
import { branding } from "@/branding.config";

type Status = "queued" | "uploading" | "processing" | "done" | "error";

type Item = {
  id: string;
  file: File;
  status: Status;
  progress: number;
  webp?: Blob;
  webpSize?: number;
  errorMessage?: string;
};

const { maxFileBytes: MAX_FILE_BYTES, maxFiles: MAX_FILES, maxConcurrent: MAX_CONCURRENT } =
  branding.processing;

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function toWebpName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const safe = base.replace(/[^\w.\- ]/g, "_").trim() || "image";
  return safe.replace(/\.[^.]+$/, "") + ".webp";
}

type UploadResult = {
  webp: Blob;
  originalBytes: number;
  webpBytes: number;
};

type ProgressFn = (pct: number) => void;
type PhaseFn = (phase: "uploading" | "processing") => void;

/**
 * Vercel rejects function bodies > 4.5 MB at the platform layer. Files above
 * this threshold get uploaded directly to Vercel Blob first, then we hand the
 * blob URL to /api/process.
 */
const BLOB_THRESHOLD = 4 * 1024 * 1024;

function uploadDirect(
  file: File,
  onProgress: ProgressFn,
  onPhase: PhaseFn,
  signal: AbortSignal,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fd = new FormData();
    fd.append("file", file);

    const onAbort = () => xhr.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", onAbort);

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    });
    xhr.upload.addEventListener("load", () => {
      onProgress(100);
      onPhase("processing");
    });
    xhr.responseType = "blob";

    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        const blob = xhr.response as Blob;
        const original = Number(xhr.getResponseHeader("X-Original-Bytes")) || file.size;
        const webpBytes = Number(xhr.getResponseHeader("X-Webp-Bytes")) || blob.size;
        resolve({ webp: blob, originalBytes: original, webpBytes });
      } else {
        const blob = xhr.response as Blob;
        blob
          .text()
          .then((text) => {
            try {
              const parsed = JSON.parse(text);
              reject(new Error(parsed?.error?.message ?? `HTTP ${xhr.status}`));
            } catch {
              reject(new Error(`HTTP ${xhr.status}`));
            }
          })
          .catch(() => reject(new Error(`HTTP ${xhr.status}`)));
      }
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error("Network error"));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    xhr.open("POST", "/api/process");
    xhr.send(fd);
  });
}

async function uploadViaBlob(
  file: File,
  onProgress: ProgressFn,
  onPhase: PhaseFn,
  signal: AbortSignal,
): Promise<UploadResult> {
  const { upload } = await import("@vercel/blob/client");
  const blob = await upload(file.name, file, {
    access: "public",
    handleUploadUrl: "/api/upload",
    abortSignal: signal,
    onUploadProgress: ({ percentage }) => onProgress(percentage),
  });
  onProgress(100);
  onPhase("processing");

  const res = await fetch("/api/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blobUrl: blob.url }),
    signal,
  });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error?.message) message = j.error.message;
    } catch {}
    throw new Error(message);
  }

  const webp = await res.blob();
  const original = Number(res.headers.get("X-Original-Bytes")) || file.size;
  const webpBytes = Number(res.headers.get("X-Webp-Bytes")) || webp.size;
  return { webp, originalBytes: original, webpBytes };
}

async function uploadFile(
  file: File,
  onProgress: ProgressFn,
  onPhase: PhaseFn,
  signal: AbortSignal,
): Promise<UploadResult> {
  if (file.size > BLOB_THRESHOLD) {
    try {
      return await uploadViaBlob(file, onProgress, onPhase, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      // Fall back to direct only when Blob isn't configured on the server.
      // Works in local dev where Vercel's platform limit doesn't exist.
      if (!/BLOB_NOT_CONFIGURED|503/i.test(msg)) throw err;
    }
  }
  return uploadDirect(file, onProgress, onPhase, signal);
}

export function Uploader() {
  const [items, setItems] = useState<Item[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    const controllers = abortRef.current;
    return () => {
      for (const c of controllers.values()) c.abort();
      controllers.clear();
    };
  }, []);

  const updateItem = useCallback((id: string, patch: Partial<Item>) => {
    setItems((curr) => curr.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const processItem = useCallback(
    async (id: string, file: File) => {
      const controller = new AbortController();
      abortRef.current.set(id, controller);
      updateItem(id, { status: "uploading", progress: 0 });
      try {
        const result = await uploadFile(
          file,
          (pct) => startTransition(() => updateItem(id, { progress: pct })),
          (phase) => updateItem(id, { status: phase }),
          controller.signal,
        );
        updateItem(id, {
          status: "done",
          progress: 100,
          webp: result.webp,
          webpSize: result.webpBytes,
        });
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        updateItem(id, {
          status: "error",
          errorMessage: err instanceof Error ? err.message : "Error desconocido",
        });
      } finally {
        abortRef.current.delete(id);
      }
    },
    [updateItem],
  );

  const runQueue = useCallback(() => {
    setItems((curr) => {
      const active = curr.filter(
        (it) => it.status === "uploading" || it.status === "processing",
      ).length;
      const slots = MAX_CONCURRENT - active;
      if (slots <= 0) return curr;
      const next = curr.filter((it) => it.status === "queued").slice(0, slots);
      for (const it of next) {
        queueMicrotask(() => processItem(it.id, it.file));
      }
      return curr;
    });
  }, [processItem]);

  useEffect(() => {
    const hasQueued = items.some((it) => it.status === "queued");
    if (hasQueued) runQueue();
  }, [items, runQueue]);

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const arr = Array.from(incoming);
    const imgs = arr.filter((f) => f.type.startsWith("image/"));
    const tooBig = arr.filter((f) => f.size > MAX_FILE_BYTES);

    setGlobalError(null);
    if (arr.length === 0) return;
    if (imgs.length === 0) {
      setGlobalError("Solo se aceptan archivos de imagen.");
      return;
    }
    if (tooBig.length > 0) {
      setGlobalError(
        `${tooBig.length} archivo${tooBig.length === 1 ? "" : "s"} excede${tooBig.length === 1 ? "" : "n"} el límite de ${MAX_FILE_BYTES / (1024 * 1024)} MB.`,
      );
    }

    const valid = imgs.filter((f) => f.size <= MAX_FILE_BYTES);
    if (valid.length === 0) return;

    setItems((curr) => {
      const remaining = MAX_FILES - curr.length;
      if (remaining <= 0) {
        setGlobalError(`Límite de ${MAX_FILES} archivos por sesión.`);
        return curr;
      }
      const toAdd = valid.slice(0, remaining).map((file) => ({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        status: "queued" as Status,
        progress: 0,
      }));
      return [...curr, ...toAdd];
    });
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  const removeItem = useCallback((id: string) => {
    abortRef.current.get(id)?.abort();
    abortRef.current.delete(id);
    setItems((curr) => curr.filter((it) => it.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    for (const c of abortRef.current.values()) c.abort();
    abortRef.current.clear();
    setItems([]);
    setGlobalError(null);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const stats = useMemo(() => {
    let total = items.length;
    let done = 0;
    let error = 0;
    let active = 0;
    let originalDone = 0;
    let webpDone = 0;
    for (const it of items) {
      if (it.status === "done") {
        done++;
        originalDone += it.file.size;
        webpDone += it.webpSize ?? 0;
      } else if (it.status === "error") error++;
      else if (it.status === "uploading" || it.status === "processing") active++;
    }
    const overall = total === 0 ? 0 : Math.round(((done + error) / total) * 100);
    return { total, done, error, active, originalDone, webpDone, overall };
  }, [items]);

  const allFinished = stats.total > 0 && stats.active === 0 && items.every(
    (it) => it.status === "done" || it.status === "error",
  );
  const successItems = useMemo(
    () => items.filter((it): it is Item & { webp: Blob } => it.status === "done" && !!it.webp),
    [items],
  );
  const reduction = stats.originalDone > 0
    ? Math.round((1 - stats.webpDone / stats.originalDone) * 100)
    : 0;

  const downloadOne = useCallback((item: Item) => {
    if (!item.webp) return;
    const url = URL.createObjectURL(item.webp);
    const a = document.createElement("a");
    a.href = url;
    a.download = toWebpName(item.file.name);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, []);

  const downloadZip = useCallback(async () => {
    if (successItems.length === 0 || isDownloading) return;
    setIsDownloading(true);
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      const used = new Map<string, number>();
      for (const it of successItems) {
        const base = toWebpName(it.file.name);
        const count = used.get(base) ?? 0;
        used.set(base, count + 1);
        const finalName = count === 0 ? base : base.replace(/\.webp$/, `-${count}.webp`);
        zip.file(finalName, it.webp);
      }
      const blob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 9 },
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${branding.brand.product.toLowerCase().replace(/[^a-z0-9]/g, "-")}-webp.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "Error al generar ZIP");
    } finally {
      setIsDownloading(false);
    }
  }, [successItems, isDownloading]);

  return (
    <section className="space-y-5">
      <DropZone
        isDragging={isDragging}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        onPick={() => inputRef.current?.click()}
      />
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {globalError && (
        <div
          role="alert"
          className="animate-fade-in flex items-start gap-2 rounded-xl border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300"
        >
          <AlertIcon className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{globalError}</span>
        </div>
      )}

      {items.length > 0 && (
        <div className="animate-fade-in space-y-3 rounded-2xl border border-neutral-800 bg-neutral-950/60 p-4 shadow-2xl shadow-black/40">
          <Summary
            stats={stats}
            allFinished={allFinished}
            reduction={reduction}
            onClear={clearAll}
          />
          <ul className="max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
            {items.map((it) => (
              <FileRow
                key={it.id}
                item={it}
                onRemove={() => removeItem(it.id)}
                onDownload={() => downloadOne(it)}
              />
            ))}
          </ul>
        </div>
      )}

      {items.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={downloadZip}
            disabled={successItems.length === 0 || isDownloading}
            className="focus-ring inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-500/20 transition hover:bg-brand-400 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500 disabled:shadow-none"
          >
            {isDownloading ? (
              <>
                <SpinnerIcon className="h-4 w-4" />
                Generando ZIP…
              </>
            ) : (
              <>
                <DownloadIcon className="h-4 w-4" />
                Descargar .zip
                {successItems.length > 0 && (
                  <span className="rounded-md bg-white/15 px-1.5 text-xs">
                    {successItems.length}
                  </span>
                )}
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="focus-ring inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3 text-sm font-medium text-neutral-200 transition hover:border-neutral-700 hover:bg-neutral-800"
          >
            <UploadIcon className="h-4 w-4" />
            Añadir más
          </button>
        </div>
      )}
    </section>
  );
}

function DropZone({
  isDragging,
  onDragOver,
  onDragLeave,
  onDrop,
  onPick,
}: {
  isDragging: boolean;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onPick: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Seleccionar imágenes para comprimir"
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick();
        }
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`focus-ring group relative flex cursor-pointer flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl border border-dashed px-6 py-14 text-center transition-all duration-200 sm:py-16 ${
        isDragging
          ? "border-brand-400 bg-brand-500/10 ring-1 ring-brand-400/40"
          : "border-neutral-800 bg-neutral-950/40 hover:border-brand-500/50 hover:bg-neutral-900/60"
      }`}
    >
      <div
        className={`flex h-12 w-12 items-center justify-center rounded-xl bg-brand-500/10 text-brand-300 transition-transform duration-200 ${
          isDragging ? "scale-110" : "group-hover:scale-105"
        }`}
      >
        <UploadIcon className="h-5 w-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-neutral-100">
          {isDragging ? "Suelta para añadir" : "Arrastra imágenes aquí"}
        </p>
        <p className="text-xs text-neutral-500">
          o haz click para seleccionar · PNG, JPG, AVIF, GIF, TIFF, WebP
        </p>
        <p className="text-[11px] text-neutral-600">Máx. 25 MB por archivo</p>
      </div>
    </div>
  );
}

function Summary({
  stats,
  allFinished,
  reduction,
  onClear,
}: {
  stats: {
    total: number;
    done: number;
    error: number;
    active: number;
    originalDone: number;
    webpDone: number;
    overall: number;
  };
  allFinished: boolean;
  reduction: number;
  onClear: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2 text-neutral-400">
          <span className="font-medium text-neutral-200">
            {stats.done}/{stats.total}
          </span>
          {stats.active > 0 && (
            <span className="text-brand-300">· {stats.active} en curso</span>
          )}
          {stats.error > 0 && (
            <span className="text-red-400">· {stats.error} con error</span>
          )}
        </div>
        <button
          type="button"
          onClick={onClear}
          className="focus-ring cursor-pointer rounded text-neutral-500 transition-colors hover:text-neutral-200"
        >
          Limpiar todo
        </button>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-neutral-900"
        role="progressbar"
        aria-valuenow={stats.overall}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Progreso total"
      >
        <div
          className={`h-full transition-all duration-300 ${
            allFinished ? "bg-emerald-500" : "bg-brand-500"
          }`}
          style={{ width: `${stats.overall}%` }}
        />
      </div>
      {allFinished && stats.done > 0 && stats.originalDone > 0 && (
        <div className="flex items-center gap-2 pt-1 text-xs text-emerald-300">
          <CheckIcon className="h-3.5 w-3.5" />
          <span>
            {formatBytes(stats.originalDone)} → {formatBytes(stats.webpDone)} (
            {reduction}% más liviano)
          </span>
        </div>
      )}
    </div>
  );
}

function FileRow({
  item,
  onRemove,
  onDownload,
}: {
  item: Item;
  onRemove: () => void;
  onDownload: () => void;
}) {
  const { file, status, progress, webpSize, errorMessage } = item;
  const reduction =
    status === "done" && webpSize != null && file.size > 0
      ? Math.round((1 - webpSize / file.size) * 100)
      : null;

  return (
    <li className="animate-fade-in group rounded-xl border border-neutral-900 bg-neutral-950 px-3 py-2.5 transition-colors hover:border-neutral-800">
      <div className="flex items-center gap-3">
        <StatusIcon status={status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium text-neutral-100">
              {file.name}
            </span>
            <span className="flex-shrink-0 text-[11px] tabular-nums text-neutral-500">
              {status === "done" && webpSize != null ? (
                <>
                  <span className="text-neutral-500 line-through">
                    {formatBytes(file.size)}
                  </span>
                  <span className="ml-1.5 text-emerald-400">
                    {formatBytes(webpSize)}
                  </span>
                  {reduction !== null && reduction > 0 && (
                    <span className="ml-1 text-emerald-500">−{reduction}%</span>
                  )}
                </>
              ) : (
                formatBytes(file.size)
              )}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <ProgressBar status={status} progress={progress} />
            <StatusLabel status={status} progress={progress} />
          </div>
          {status === "error" && errorMessage && (
            <p className="mt-1 text-[11px] text-red-400">{errorMessage}</p>
          )}
        </div>
        <div className="flex items-center gap-1">
          {status === "done" && (
            <button
              type="button"
              onClick={onDownload}
              aria-label={`Descargar ${file.name}`}
              className="focus-ring cursor-pointer rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-brand-300"
            >
              <DownloadIcon className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Quitar ${file.name}`}
            className="focus-ring cursor-pointer rounded-md p-1.5 text-neutral-600 transition-colors hover:bg-neutral-900 hover:text-red-400"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </li>
  );
}

function StatusIcon({ status }: { status: Status }) {
  if (status === "done")
    return (
      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
        <CheckIcon className="h-4 w-4" />
      </span>
    );
  if (status === "error")
    return (
      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-red-500/15 text-red-400">
        <AlertIcon className="h-4 w-4" />
      </span>
    );
  if (status === "uploading" || status === "processing")
    return (
      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-500/15 text-brand-300">
        <SpinnerIcon className="h-4 w-4" />
      </span>
    );
  return (
    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-neutral-900 text-neutral-500">
      <ImageIcon className="h-4 w-4" />
    </span>
  );
}

function ProgressBar({ status, progress }: { status: Status; progress: number }) {
  const isActive = status === "uploading" || status === "processing";
  const isDone = status === "done";
  const isError = status === "error";
  const fill = isDone ? 100 : isError ? 100 : isActive ? progress : 0;
  return (
    <div className="h-1 flex-1 overflow-hidden rounded-full bg-neutral-900">
      <div
        className={`h-full transition-all duration-200 ${
          isError
            ? "bg-red-500/70"
            : isDone
              ? "bg-emerald-500"
              : status === "processing"
                ? "bg-brand-400 animate-pulse-soft"
                : "bg-brand-500"
        }`}
        style={{ width: `${fill}%` }}
      />
    </div>
  );
}

function StatusLabel({ status, progress }: { status: Status; progress: number }) {
  const label =
    status === "queued"
      ? "En cola"
      : status === "uploading"
        ? `${Math.round(progress)}%`
        : status === "processing"
          ? "Procesando…"
          : status === "done"
            ? "Listo"
            : "Error";
  const color =
    status === "done"
      ? "text-emerald-400"
      : status === "error"
        ? "text-red-400"
        : status === "queued"
          ? "text-neutral-500"
          : "text-brand-300";
  return (
    <span className={`flex-shrink-0 text-[11px] tabular-nums ${color}`}>{label}</span>
  );
}
