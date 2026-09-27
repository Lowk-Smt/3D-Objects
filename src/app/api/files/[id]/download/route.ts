import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { files } from "@/db/schema";
import { requireSession } from "@/lib/auth";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { getMimeForName, isSafeFileId } from "@/lib/files";
import { streamFileResponse } from "@/lib/serve-file";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requireSession(req);

    if (!isSafeFileId(id)) throw new ApiError(400, "Invalid file id.");

    const row = (await db.select().from(files).where(eq(files.id, id)).limit(1))[0];
    if (!row) throw new ApiError(404, "File not found. It may have been deleted.");

    // The stored name always carries its original extension (renames keep it),
    // so downloads are never served as a bare "file" / "download" / "unknown".
    const downloadName = row.name || `${row.id}${row.ext ? `.${row.ext}` : ""}`;

    return await streamFileResponse({
      id: row.id,
      storedName: row.storedName,
      mime: row.mime || getMimeForName(downloadName),
      displayName: downloadName,
      disposition: "attachment",
    });
  } catch (err) {
    return handleApiError(err);
  }
}
