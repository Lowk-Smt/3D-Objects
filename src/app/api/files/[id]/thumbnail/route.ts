import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { files } from "@/db/schema";
import { requireCsrf, requireSession } from "@/lib/auth";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { ensureStorageDirs, MAX_THUMBNAIL_BYTES, THUMBS_DIR } from "@/lib/config";
import { broadcast } from "@/lib/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function thumbPath(id: string) {
  return path.join(THUMBS_DIR, `${id}.jpg`);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requireSession(req);

    const buffer = await fs.readFile(thumbPath(id)).catch(() => null);
    if (!buffer) throw new ApiError(404, "No thumbnail available.");

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

// The 3D viewer renders a thumbnail client-side (same as before) and then
// uploads the resulting JPEG here so every other workspace member can see it
// too — thumbnails are never left as browser-local blob URLs.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireSession(req);
    requireCsrf(req, ctx);

    const row = (await db.select().from(files).where(eq(files.id, id)).limit(1))[0];
    if (!row) throw new ApiError(404, "File not found.");

    const body = await req.json().catch(() => null);
    const dataUrl = String(body?.dataUrl || "");
    const match = /^data:image\/(jpeg|png);base64,(.+)$/.exec(dataUrl);
    if (!match) throw new ApiError(400, "Invalid thumbnail image.");

    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length === 0) throw new ApiError(400, "Invalid thumbnail image.");
    if (buffer.length > MAX_THUMBNAIL_BYTES) throw new ApiError(413, "Thumbnail is too large.");

    ensureStorageDirs();
    await fs.writeFile(thumbPath(id), buffer);

    await db.update(files).set({ hasThumbnail: true, updatedAt: new Date() }).where(eq(files.id, id));

    broadcast("file-updated", { id, hasThumbnail: true, updatedAt: Date.now() });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
