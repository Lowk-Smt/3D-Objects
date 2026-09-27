import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { files } from "@/db/schema";
import { requireSession } from "@/lib/auth";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { streamFileResponse } from "@/lib/serve-file";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requireSession(req);

    const row = (await db.select().from(files).where(eq(files.id, id)).limit(1))[0];
    if (!row) throw new ApiError(404, "File not found. It may have been deleted.");

    return await streamFileResponse({
      id: row.id,
      storedName: row.storedName,
      mime: row.mime,
      displayName: row.name,
      disposition: "attachment",
    });
  } catch (err) {
    return handleApiError(err);
  }
}
