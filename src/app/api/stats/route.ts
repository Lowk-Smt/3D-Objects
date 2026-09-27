import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-helpers";
import { LIBRARY_QUOTA_BYTES } from "@/lib/config";
import { workspaceUsage } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Powers the sidebar storage meter. The same LIBRARY_QUOTA_BYTES value is
// enforced on upload in POST /api/files — this endpoint only reports it.
export async function GET(req: NextRequest) {
  try {
    await requireSession(req);

    const { fileCount, totalBytes } = await workspaceUsage();

    return NextResponse.json({
      fileCount,
      totalBytes,
      quotaBytes: LIBRARY_QUOTA_BYTES,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
