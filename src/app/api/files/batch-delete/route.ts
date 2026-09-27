import { NextRequest, NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { files } from "@/db/schema";
import { canUserDeleteFiles, requireCsrf, requireSession } from "@/lib/auth";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { isSafeFileId } from "@/lib/files";
import { broadcast } from "@/lib/events";
import { deleteFileRecords } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BATCH = 500;

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireSession(req);
    requireCsrf(req, ctx);

    if (!canUserDeleteFiles(ctx.user)) {
      throw new ApiError(403, "You don't have permission to delete files. Ask the owner for access.");
    }

    const body = await req.json().catch(() => null);
    const requested: string[] = Array.isArray(body?.ids)
      ? body.ids.filter((value: unknown): value is string => typeof value === "string")
      : [];

    const ids = [...new Set(requested.filter(isSafeFileId))];
    if (ids.length === 0) throw new ApiError(400, "No file ids were provided.");
    if (ids.length > MAX_BATCH) throw new ApiError(400, `Please delete at most ${MAX_BATCH} files at a time.`);

    const existing = await db.select({ id: files.id }).from(files).where(inArray(files.id, ids));
    const foundIds = existing.map((row) => row.id);

    if (foundIds.length === 0) {
      return NextResponse.json({ deleted: [], missing: ids, cleanupPending: false });
    }

    const result = await deleteFileRecords(foundIds);
    broadcast("files-deleted", { ids: result.deleted });

    return NextResponse.json({
      deleted: result.deleted,
      missing: ids.filter((id) => !result.deleted.includes(id)),
      cleanupPending: !result.cleanupComplete,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
