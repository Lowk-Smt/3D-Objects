import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { files } from "@/db/schema";
import { requireSession } from "@/lib/auth";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { isSafeFileId } from "@/lib/files";
import { streamFileResponse } from "@/lib/serve-file";
import { ServerTiming } from "@/lib/timing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Used by the 3D viewer to load model bytes for preview (inline, not a
// download). Any authenticated workspace member may preview any file — this
// is a shared private library, not per-user isolated storage.
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

    return await streamFileResponse({
      id: row.id,
      storedName: row.storedName,
      mime: row.mime,
      displayName: row.name,
      disposition: "inline",
      serverTiming: timing,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
