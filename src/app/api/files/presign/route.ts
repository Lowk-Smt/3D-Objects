import { NextRequest, NextResponse } from "next/server";
import { requireCsrf, requireSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-helpers";
import { createPresignedUpload } from "@/lib/storage";
import { ServerTiming } from "@/lib/timing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Step 1 of the browser upload flow: authorize the upload, reserve quota and
 * mint a short-lived presigned PUT URL for one server-generated object key.
 *
 * The browser then PUTs the file bytes directly to R2 (step 2, no credentials
 * involved — the URL only permits that single key for a few minutes) and
 * calls POST /api/files/complete (step 3), which verifies the object and
 * commits the library row.
 *
 * This keeps multi-hundred-MB models out of the serverless request body
 * (Vercel caps those at a few MB) while every security decision stays
 * server-side: session, CSRF, size limits, sanitizing, quota and key choice.
 */
export async function POST(req: NextRequest) {
  const timing = new ServerTiming();
  try {
    const ctx = await timing.timeAsync("auth", () => requireSession(req), "Session auth");
    timing.time("csrf", () => requireCsrf(req, ctx), "CSRF check");

    const body = await req.json().catch(() => null);

    const presigned = await timing.timeAsync(
      "presign",
      () =>
        createPresignedUpload({
          name: body?.name,
          path: body?.path,
          size: body?.size,
          optimized: body?.optimized,
          preset: body?.preset,
          user: ctx.user,
        }),
      "Presigned upload reservation",
    );

    const res = NextResponse.json(presigned, { status: 201 });
    return timing.apply(res);
  } catch (err) {
    return handleApiError(err);
  }
}
