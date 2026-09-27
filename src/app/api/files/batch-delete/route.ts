import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { files } from "@/db/schema";
import { canUserDeleteFiles, requireCsrf, requireSession } from "@/lib/auth";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { FILES_DIR, THUMBS_DIR } from "@/lib/config";
import { broadcast } from "@/lib/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireSession(req);
    requireCsrf(req, ctx);

    if (!canUserDeleteFiles(ctx.user)) {
      throw new ApiError(403, "You don't have permission to delete files. Ask the owner for access.");
    }

    const body = await req.json().catch(() => null);
    const ids: string[] = Array.isArray(body?.ids) ? body.ids.filter((x: unknown) => typeof x === "string") : [];

    if (ids.length === 0) throw new ApiError(400, "No file ids were provided.");

    const rows = await db.select({ id: files.id }).from(files).where(inArray(files.id, ids));
    const foundIds = rows.map((r) => r.id);

    if (foundIds.length > 0) {
      await db.delete(files).where(inArray(files.id, foundIds));

      await Promise.all(
        foundIds.map(async (id) => {
          await fs.rm(path.join(FILES_DIR, id), { recursive: true, force: true });
          await fs.rm(path.join(THUMBS_DIR, `${id}.jpg`), { force: true });
        }),
      );

      broadcast("files-deleted", { ids: foundIds });
    }

    return NextResponse.json({ deleted: foundIds, missing: ids.filter((id) => !foundIds.includes(id)) });
  } catch (err) {
    return handleApiError(err);
  }
}

