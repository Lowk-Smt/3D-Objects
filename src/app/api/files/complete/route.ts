import { NextRequest, NextResponse } from "next/server";
import { requireCsrf, requireSession } from "@/lib/auth";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { isSafeFileId } from "@/lib/files";
import { broadcast } from "@/lib/events";
import { completePresignedUpload } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Step 3 of the browser upload flow: after the browser PUT the bytes directly
 * to R2, this verifies the object (existence + exact size), re-checks quota,
 * and commits the `files` row. All metadata comes from the server-side
 * reservation made at presign time — the client only supplies the id.
 */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireSession(req);
    requireCsrf(req, ctx);

    const body = await req.json().catch(() => null);
    const id = String(body?.id || "");
    if (!isSafeFileId(id)) throw new ApiError(400, "Invalid upload id.");

    const { file, alreadyCompleted } = await completePresignedUpload({ id, user: ctx.user });
    // A retried completion returns the same file without re-announcing it.
    if (!alreadyCompleted) broadcast("file-added", file);

    return NextResponse.json({ file }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
