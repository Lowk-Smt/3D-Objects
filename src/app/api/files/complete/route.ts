import { NextRequest, NextResponse } from "next/server";
import { requireCsrf, requireSession } from "@/lib/auth";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { isSafeFileId } from "@/lib/files";
import { broadcast } from "@/lib/events";
import { completePresignedUpload } from "@/lib/storage";
import { ServerTiming } from "@/lib/timing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Step 3 of the browser upload flow: after the browser PUT the bytes directly
 * to R2, this verifies the object (existence + exact size), re-checks quota,
 * and commits the `files` row. All metadata comes from the server-side
 * reservation made at presign time — the client only supplies the id.
 */
export async function POST(req: NextRequest) {
  const timing = new ServerTiming();
  try {
    const ctx = await timing.timeAsync("auth", () => requireSession(req), "Session auth");
    timing.time("csrf", () => requireCsrf(req, ctx), "CSRF check");

    const body = await req.json().catch(() => null);
    const id = String(body?.id || "");
    if (!isSafeFileId(id)) throw new ApiError(400, "Invalid upload id.");

    const { file, alreadyCompleted } = await timing.timeAsync(
      "complete",
      () => completePresignedUpload({ id, user: ctx.user }),
      "Verify and commit pending upload",
    );
    // A retried completion returns the same file without re-announcing it.
    if (!alreadyCompleted) broadcast("file-added", file);

    const res = NextResponse.json({ file }, { status: 201 });
    return timing.apply(res);
  } catch (err) {
    return handleApiError(err);
  }
}
