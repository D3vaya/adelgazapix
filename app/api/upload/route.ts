import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { branding } from "@/branding.config";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * Generates a short-lived, restricted token that the browser uses to upload
 * directly to Vercel Blob storage. Bypasses the 4.5 MB function payload limit.
 *
 * Returns 503 if `BLOB_READ_WRITE_TOKEN` is not configured — client falls back
 * to direct multipart upload for files under the platform limit.
 */
export async function POST(req: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return Response.json(
      {
        error: {
          code: "BLOB_NOT_CONFIGURED",
          message: "Vercel Blob is not enabled on this deployment.",
        },
      },
      { status: 503 },
    );
  }

  let body: HandleUploadBody;
  try {
    body = (await req.json()) as HandleUploadBody;
  } catch {
    return Response.json(
      { error: { code: "INVALID_FORM", message: "Invalid JSON body." } },
      { status: 400 },
    );
  }

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [...branding.processing.allowedMime],
        maximumSizeInBytes: branding.processing.maxFileBytes,
        addRandomSuffix: true,
        validUntil: Date.now() + 60_000,
      }),
      onUploadCompleted: async () => {
        // No-op; the client immediately calls /api/process which deletes the blob.
      },
    });
    return Response.json(jsonResponse);
  } catch (err) {
    return Response.json(
      {
        error: {
          code: "UPLOAD_FAILED",
          message: err instanceof Error ? err.message : "Upload failed",
        },
      },
      { status: 400 },
    );
  }
}
