import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { files } from "@/db/schema";
import { canUserDeleteFiles, requireCsrf, requireSession } from "@/lib/auth";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { getExt, getMimeForName, isSafeFileId, sanitizeDisplayName } from "@/lib/files";
import { broadcast } from "@/lib/events";
import { deleteFileRecords } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function loadFile(id: string) {
  if (!isSafeFileId(id)) throw new ApiError(400, "Invalid file id.");
  const row = (await db.select().from(files).where(eq(files.id, id)).limit(1))[0];
  if (!row) throw new ApiError(404, "File not found. It may have been deleted by another user.");
  return row;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireSession(req);
    requireCsrf(req, ctx);

    const row = await loadFile(id);

    const body = await req.json().catch(() => null);
    const requestedBase = String(body?.name || "").trim();
    if (!requestedBase) throw new ApiError(400, "A file name is required.");

    // Renaming never changes a model's file type: the stored extension wins.
    const ext = row.ext || getExt(row.name);
    const withoutExt = ext && requestedBase.toLowerCase().endsWith(`.${ext.toLowerCase()}`)
      ? requestedBase.slice(0, -(ext.length + 1))
      : requestedBase;

    const cleanedBase = sanitizeDisplayName(withoutExt);
    if (!cleanedBase || cleanedBase === "file") {
      throw new ApiError(400, "Invalid file name.");
    }

    const newName = ext ? `${cleanedBase}.${ext}` : cleanedBase;
    if (newName.length > 255) throw new ApiError(400, "File name is too long.");

    const dirOld = row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : "";
    const newPath = dirOld ? `${dirOld}/${newName}` : newName;
    const mime = getMimeForName(newName);
    const updatedAt = new Date();

    // The bytes on disk keep their original name (storedName); only the
    // logical path used for glTF companion resolution changes.
    await db
      .update(files)
      .set({ name: newName, path: newPath, mime, updatedAt })
      .where(eq(files.id, id));

    const payload = { id, name: newName, path: newPath, mime, updatedAt: updatedAt.getTime() };
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

    if (!isSafeFileId(id)) throw new ApiError(400, "Invalid file id.");

    const row = (await db.select({ id: files.id }).from(files).where(eq(files.id, id)).limit(1))[0];
    if (!row) throw new ApiError(404, "File not found. It may already have been deleted.");

    if (!canUserDeleteFiles(ctx.user)) {
      throw new ApiError(403, "You don't have permission to delete files. Ask the owner for access.");
    }

    // Removes bytes and row together (or neither) — see src/lib/storage.ts.
    const result = await deleteFileRecords([id]);
    broadcast("file-deleted", { id });

    return NextResponse.json({ ok: true, deleted: result.deleted, cleanupPending: !result.cleanupComplete });
  } catch (err) {
    return handleApiError(err);
  }
}
