import { NextRequest, NextResponse } from "next/server";
import { destroySession, getSessionContext, clearSessionCookies } from "@/lib/auth";
import { handleApiError } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const ctx = await getSessionContext(req);
    if (ctx) {
      await destroySession(ctx.sessionId);
    }
    const response = NextResponse.json({ ok: true });
    clearSessionCookies(response);
    return response;
  } catch (err) {
    return handleApiError(err);
  }
}
