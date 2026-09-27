import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { files } from "@/db/schema";
import { canUserDeleteFiles, requireCsrf, requireSession } from "@/lib/auth";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { FILES_DIR, THUMBS_DIR } from "@/lib/config";
import { getMimeForName } from "@/lib/files";
import { broadcast } from "@/lib/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireSession(req);
    requireCsrf(req, ctx);

    const row = (await db.select().from(files).where(eq(files.id, id)).limit(1))[0];
    if (!row) throw new ApiError(404, "File not found. It may have been deleted by another user.");

    const body = await req.json().catch(() => null);
    const requestedBase = String(body?.name || "").trim();

    if (!requestedBase) throw new ApiError(400, "A file name is required.");

    const cleanedBase = requestedBase.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim();
    if (!cleanedBase) throw new ApiError(400, "Invalid file name.");

    // Extension is always preserved, exactly like the original client-only
    // behavior — renaming never changes a model's file type.
    const newName = row.ext ? `${cleanedBase}.${row.ext}` : cleanedBase;
    if (newName.length > 255) throw new ApiError(400, "File name is too long.");

    const dirOld = path.dirname(row.path);
    const newPath = dirOld && dirOld !== "." ? `${dirOld}/${newName}` : newName;

    await db
      .update(files)
      .set({ name: newName, path: newPath, mime: getMimeForName(newName), updatedAt: new Date() })
      .where(eq(files.id, id));

    const payload = { id, name: newName, path: newPath, mime: getMimeForName(newName), updatedAt: Date.now() };
    broadcast("file-updated", payload);

    return NextResponse.json({ file: payload });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireSession(req);
    requireCsrf(req, ctx);

    const row = (await db.select().from(files).where(eq(files.id, id)).limit(1))[0];
    if (!row) throw new ApiError(404, "File not found. It may already have been deleted.");

    if (!canUserDeleteFiles(ctx.user)) {
      throw new ApiError(403, "You don't have permission to delete files. Ask the owner for access.");
    }

    await db.delete(files).where(eq(files.id, id));

    await fs.rm(path.join(FILES_DIR, id), { recursive: true, force: true });
    await fs.rm(path.join(THUMBS_DIR, `${id}.jpg`), { force: true });

    broadcast("file-deleted", { id });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}


