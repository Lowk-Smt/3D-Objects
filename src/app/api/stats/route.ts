import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { files } from "@/db/schema";
import { requireSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireSession(req);

    const rows = await db
      .select({
        count: sql<number>`count(*)::int`,
        totalBytes: sql<number>`coalesce(sum(${files.size}), 0)::bigint`,
      })
      .from(files);

    const row = rows[0];

    return NextResponse.json({
      fileCount: row?.count ?? 0,
      totalBytes: Number(row?.totalBytes ?? 0),
      quotaBytes: process.env.LIBRARY_QUOTA_BYTES ? Number(process.env.LIBRARY_QUOTA_BYTES) : null,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
