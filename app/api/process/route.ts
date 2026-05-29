import { NextRequest } from "next/server";
import sharp from "sharp";
import { branding } from "@/branding.config";
import { getClientIp, getRatelimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
/**
 * Sharp WebP at effort 6 on a 12 MB image can take 30–60+s.
 * 90s gives margin for blob fetch + decode + slow-encode + cleanup,
 * without letting truly stuck requests linger.
 */
export const maxDuration = 90;
export const dynamic = "force-dynamic";

const {
  quality: QUALITY,
  effort: EFFORT,
  maxFileBytes: MAX_FILE_BYTES,
  maxDimension: MAX_DIMENSION,
  allowedMime,
} = branding.processing;

const ALLOWED_MIME = new Set<string>(allowedMime);

type ErrorCode =
  | "INVALID_FORM"
  | "NO_FILE"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "DECODE_FAILED"
  | "IMAGE_TOO_LARGE"
  | "RATE_LIMITED"
  | "BLOB_FETCH_FAILED"
  | "INTERNAL";

function errorBody(code: ErrorCode, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details && { details }) } };
}

function jsonError(
  code: ErrorCode,
  message: string,
  status: number,
  details?: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
) {
  return Response.json(errorBody(code, message, details), {
    status,
    headers: extraHeaders,
  });
}

type Input =
  | { kind: "buffer"; buffer: Buffer; originalSize: number; cleanupBlobUrl?: string }
  | { kind: "error"; response: Response };

async function readInput(req: NextRequest): Promise<Input> {
  const contentType = req.headers.get("content-type") ?? "";

  // ----- Path A: { blobUrl } JSON body (used for files > 4 MB on Vercel) -----
  if (contentType.includes("application/json")) {
    let body: { blobUrl?: string };
    try {
      body = (await req.json()) as { blobUrl?: string };
    } catch {
      return { kind: "error", response: jsonError("INVALID_FORM", "Invalid JSON.", 400) };
    }
    const blobUrl = body.blobUrl;
    if (!blobUrl || typeof blobUrl !== "string") {
      return { kind: "error", response: jsonError("NO_FILE", 'Missing "blobUrl".', 400) };
    }
    // Restrict to Vercel Blob domains for safety (prevent SSRF).
    if (!/^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i.test(blobUrl)) {
      return {
        kind: "error",
        response: jsonError("BLOB_FETCH_FAILED", "blobUrl must point to Vercel Blob storage.", 400),
      };
    }

    let res: Response;
    try {
      res = await fetch(blobUrl);
    } catch {
      return {
        kind: "error",
        response: jsonError("BLOB_FETCH_FAILED", "Could not fetch the uploaded blob.", 502),
      };
    }
    if (!res.ok) {
      return {
        kind: "error",
        response: jsonError("BLOB_FETCH_FAILED", `Blob fetch returned ${res.status}.`, 502),
      };
    }

    const declared = res.headers.get("content-type") ?? "";
    if (declared && !ALLOWED_MIME.has(declared.split(";")[0].trim())) {
      return {
        kind: "error",
        response: jsonError(
          "UNSUPPORTED_TYPE",
          `Content type "${declared}" is not a supported image format.`,
          415,
        ),
      };
    }

    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    if (buffer.length > MAX_FILE_BYTES) {
      return {
        kind: "error",
        response: jsonError(
          "FILE_TOO_LARGE",
          `File exceeds maximum size of ${MAX_FILE_BYTES / (1024 * 1024)} MB.`,
          413,
          { size: buffer.length, max: MAX_FILE_BYTES },
        ),
      };
    }
    return { kind: "buffer", buffer, originalSize: buffer.length, cleanupBlobUrl: blobUrl };
  }

  // ----- Path B: multipart/form-data with `file` (legacy / small files) -----
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return {
      kind: "error",
      response: jsonError("INVALID_FORM", "Request body is not valid multipart/form-data.", 400),
    };
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { kind: "error", response: jsonError("NO_FILE", 'Missing required field "file".', 400) };
  }
  if (file.size === 0) {
    return { kind: "error", response: jsonError("NO_FILE", "File is empty.", 400) };
  }
  if (file.size > MAX_FILE_BYTES) {
    return {
      kind: "error",
      response: jsonError(
        "FILE_TOO_LARGE",
        `File exceeds maximum size of ${MAX_FILE_BYTES / (1024 * 1024)} MB.`,
        413,
        { size: file.size, max: MAX_FILE_BYTES },
      ),
    };
  }
  if (file.type && !ALLOWED_MIME.has(file.type)) {
    return {
      kind: "error",
      response: jsonError(
        "UNSUPPORTED_TYPE",
        `Content type "${file.type}" is not a supported image format.`,
        415,
        { allowed: Array.from(ALLOWED_MIME) },
      ),
    };
  }

  let inputBuffer: Buffer;
  try {
    inputBuffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return { kind: "error", response: jsonError("INTERNAL", "Could not read uploaded file.", 500) };
  }
  return { kind: "buffer", buffer: inputBuffer, originalSize: file.size };
}

export async function POST(req: NextRequest) {
  // ---- Rate limit (no-op if UPSTASH_* env vars are not set) ----
  const limiter = getRatelimit();
  if (limiter) {
    const ip = getClientIp(req);
    const { success, limit, remaining, reset } = await limiter.limit(ip);
    const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
    const rateHeaders = {
      "X-RateLimit-Limit": String(limit),
      "X-RateLimit-Remaining": String(Math.max(0, remaining)),
      "X-RateLimit-Reset": String(reset),
    };
    if (!success) {
      return jsonError(
        "RATE_LIMITED",
        "Too many requests. Try again in a moment.",
        429,
        { retryAfterSeconds: retryAfter },
        { ...rateHeaders, "Retry-After": String(retryAfter) },
      );
    }
  }

  const input = await readInput(req);
  if (input.kind === "error") return input.response;
  const { buffer: inputBuffer, originalSize, cleanupBlobUrl } = input;

  let webp: Buffer;
  try {
    const pipeline = sharp(inputBuffer, {
      failOn: "error",
      limitInputPixels: MAX_DIMENSION * MAX_DIMENSION,
    });
    const meta = await pipeline.metadata();

    if (
      typeof meta.width === "number" &&
      typeof meta.height === "number" &&
      (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION)
    ) {
      return jsonError(
        "IMAGE_TOO_LARGE",
        `Image dimensions exceed ${MAX_DIMENSION}px on one side.`,
        422,
        { width: meta.width, height: meta.height, max: MAX_DIMENSION },
      );
    }

    webp = await pipeline
      .rotate()
      .webp({ quality: QUALITY, effort: EFFORT, smartSubsample: true })
      .toBuffer();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown decoding error";
    return jsonError("DECODE_FAILED", `Could not decode image: ${msg}`, 422);
  }

  // Best-effort cleanup: remove the source blob now that we have the WebP.
  if (cleanupBlobUrl) {
    try {
      const { del } = await import("@vercel/blob");
      await del(cleanupBlobUrl);
    } catch {
      /* swallow — the blob has a short TTL via Vercel's auto-cleanup anyway */
    }
  }

  return new Response(new Uint8Array(webp), {
    status: 200,
    headers: {
      "Content-Type": "image/webp",
      "Content-Length": String(webp.length),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Original-Bytes": String(originalSize),
      "X-Webp-Bytes": String(webp.length),
    },
  });
}

export async function GET() {
  return jsonError("INVALID_FORM", "Method not allowed. Use POST.", 405);
}
