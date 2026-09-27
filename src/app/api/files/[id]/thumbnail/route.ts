import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { files } from "@/db/schema";
import { canUserManageThumbnail, requireCsrf, requireSession } from "@/lib/auth";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { MAX_THUMBNAIL_BYTES } from "@/lib/config";
import { decodeImageDataUrl, isSafeFileId, sniffImageType } from "@/lib/files";
import { broadcast } from "@/lib/events";
import { readThumbnail, removeThumbnails, writeThumbnail } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function loadFile(id: string) {
  if (!isSafeFileId(id)) throw new ApiError(400, "Invalid file id.");
  const row = (await db.select().from(files).where(eq(files.id, id)).limit(1))[0];
  if (!row) throw new ApiError(404, "File not found. It may have been deleted.");
  return row;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requireSession(req);

    // A thumbnail is only served for a file that actually exists in the
    // library, and the id is validated before it ever reaches object storage.
    const row = await loadFile(id);
    if (!row.hasThumbnail) throw new ApiError(404, "No thumbnail available.");

    const thumb = await readThumbnail(id, row.thumbExt);
    if (!thumb) throw new ApiError(404, "No thumbnail available.");

    // Keep the stored extension/mime in sync with the bytes we just read.
    if (thumb.repairedExt && thumb.repairedExt !== row.thumbExt) {
      await db.update(files).set({ thumbExt: thumb.ext, thumbMime: thumb.mime }).where(eq(files.id, id));
    }

    return new NextResponse(new Uint8Array(thumb.buffer), {
      headers: {
        // Always the type of the bytes actually being served.
        "Content-Type": thumb.mime,
        "Content-Length": String(thumb.buffer.length),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

// The 3D viewer renders a thumbnail client-side (same as the original app) and
// then uploads the resulting JPEG here so every other workspace member sees it
// too — thumbnails are never left as browser-local blob URLs.
//
// Server-side authorization: only the member who uploaded the file, or an
// owner, may create/replace it. The bytes decide their own extension and MIME,
// so a PNG can never be stored as `<id>.jpg` or served as `image/jpeg`.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireSession(req);
    requireCsrf(req, ctx);

    const row = await loadFile(id);

    if (!canUserManageThumbnail(ctx.user, row)) {
      throw new ApiError(
        403,
        "Only the member who uploaded this file (or the workspace owner) can change its thumbnail.",
      );
    }

    const body = await req.json().catch(() => null);
    const decoded = decodeImageDataUrl(String(body?.dataUrl || ""));
    if (!decoded) throw new ApiError(400, "Invalid thumbnail image.");

    const { buffer, declaredMime } = decoded;
    if (buffer.length === 0) throw new ApiError(400, "Invalid thumbnail image.");
    if (buffer.length > MAX_THUMBNAIL_BYTES) {
      throw new ApiError(413, `Thumbnail is too large (max ${Math.round(MAX_THUMBNAIL_BYTES / 1024 / 1024)}MB).`);
    }

    const type = sniffImageType(buffer);
    if (!type) {
      throw new ApiError(415, "Thumbnails must be JPEG, PNG, WebP or GIF images.");
    }
    if (declaredMime !== type.mime) {
      console.warn(
        `[thumbnail] ${id}: client declared ${declaredMime} but the bytes are ${type.mime}; storing as ${type.ext}.`,
      );
    }

    await writeThumbnail(id, buffer, type);

    try {
      await db
        .update(files)
        .set({ hasThumbnail: true, thumbExt: type.ext, thumbMime: type.mime, updatedAt: new Date() })
        .where(eq(files.id, id));
    } catch (err) {
      // Don't leave an unreferenced thumbnail behind if the metadata write
      // fails — the next preview can simply generate it again.
      console.error(`[thumbnail] Metadata update failed for ${id}:`, err);
      await removeThumbnails(id);
      throw new ApiError(500, "The thumbnail could not be recorded in the database. Please try again.");
    }

    broadcast("file-updated", { id, hasThumbnail: true, updatedAt: Date.now() });

    return NextResponse.json({ ok: true, ext: type.ext, mime: type.mime });
  } catch (err) {
    return handleApiError(err);
  }
}
