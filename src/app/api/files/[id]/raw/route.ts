import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { files } from "@/db/schema";
import { requireSession } from "@/lib/auth";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { canPresignPreviewMime, getMimeForName, isSafeFileId, sanitizeStoredName } from "@/lib/files";
import { R2Error, fileObjectKey, getObjectStore, PRESIGNED_GET_PREVIEW_EXPIRES_IN_SECONDS } from "@/lib/r2";
import { streamFileResponse } from "@/lib/serve-file";
import { ServerTiming } from "@/lib/timing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Used by the 3D viewer to load model bytes for preview. Any authenticated
// workspace member may preview any file — this is a shared private library,
// not per-user isolated storage.
//
// Performance shape: the response is a short-lived presigned GET URL (120 s)
// for exactly one private object key, minted only after the session check and
// the file lookup succeed. The browser then fetches the bytes directly from
// the bucket (the signature is in the URL; no cookies or credentials are ever
// sent to storage), which keeps multi-MB model payloads off the serverless
// function. The bucket stays private: nothing is public, the URL grants one
// key for 120 seconds, and the response's Content-Type/Disposition are pinned
// by the signature.
//
// Safety valves, both intentional:
//  - Active-content MIME types (HTML/SVG/XML — see canPresignPreviewMime)
//    skip presigning entirely and stream through this route, keeping the
//    `Content-Security-Policy: sandbox` + `nosniff` headers the bucket cannot
//    add. The MIME comes from the server-side extension table, not the bytes.
//  - `?proxy=1` forces the streaming path. The browser uses it as an
//    automatic fallback when the direct fetch fails at the network level
//    (e.g. a bucket whose CORS rules do not yet allow s3_get), so preview
//    keeps working while CORS is being updated.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const timing = new ServerTiming();
  try {
    const { id } = await params;
    await timing.timeAsync("auth", () => requireSession(req), "Session authentication");

    if (!isSafeFileId(id)) throw new ApiError(400, "Invalid file id.");

    const row = await timing.timeAsync(
      "db",
      async () => (await db.select().from(files).where(eq(files.id, id)).limit(1))[0],
      "Database lookup",
    );
    if (!row) throw new ApiError(404, "File not found. It may have been deleted.");

    const mime = row.mime || getMimeForName(row.name);
    const proxy = new URL(req.url).searchParams.get("proxy") === "1";

    if (!proxy && canPresignPreviewMime(mime)) {
      const key = fileObjectKey(row.id, sanitizeStoredName(row.storedName));
      try {
        const url = await timing.timeAsync(
          "presign",
          () =>
            getObjectStore().presignGet(key, {
              contentType: mime,
              disposition: "inline",
              filename: row.name,
              expiresInSeconds: PRESIGNED_GET_PREVIEW_EXPIRES_IN_SECONDS,
            }),
          "Presigned preview URL",
        );
        const timingHeader = timing.headerValue();
        return NextResponse.json(
          { mode: "presigned", url, expiresIn: PRESIGNED_GET_PREVIEW_EXPIRES_IN_SECONDS, mime, name: row.name },
          { headers: { "Cache-Control": "private, no-store", ...(timingHeader ? { "Server-Timing": timingHeader } : {}) } },
        );
      } catch (err) {
        // Minting failed (storage unavailable/misconfigured): fall through to
        // the always-available streaming path rather than failing the preview.
        if (!(err instanceof R2Error)) {
          console.error(`[raw] Presign failed for ${key}, streaming instead:`, err);
        }
      }
    }

    return await streamFileResponse({
      id: row.id,
      storedName: row.storedName,
      mime,
      displayName: row.name,
      disposition: "inline",
      serverTiming: timing,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
