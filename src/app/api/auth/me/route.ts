import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireSession(req);
    return NextResponse.json({ user: ctx.user, csrfToken: ctx.csrfToken });
  } catch (err) {
    return handleApiError(err);
  }
}
