import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import {
  clearSessionCookies,
  hashPassword,
  requireCsrf,
  requireSession,
  revokeUserSessions,
  verifyPassword,
} from "@/lib/auth";
import { ApiError, handleApiError } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Self-service password change. Requires the current password, then revokes
 * *every* session for the account (including the caller's) so any other
 * browser that was already logged in has to authenticate again. The caller is
 * told to log in again rather than silently being handed a new session.
 */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireSession(req);
    requireCsrf(req, ctx);

    const body = await req.json().catch(() => null);
    const currentPassword = String(body?.currentPassword || "");
    const newPassword = String(body?.newPassword || "");

    if (!currentPassword || !newPassword) {
      throw new ApiError(400, "Current and new password are required.");
    }
    if (newPassword.length < 8) {
      throw new ApiError(400, "New password must be at least 8 characters.");
    }
    if (newPassword === currentPassword) {
      throw new ApiError(400, "The new password must be different from the current one.");
    }

    const row = (await db.select().from(users).where(eq(users.id, ctx.user.id)).limit(1))[0];
    if (!row) throw new ApiError(401, "Your account no longer exists.");

    const ok = await verifyPassword(currentPassword, row.passwordHash);
    if (!ok) throw new ApiError(403, "Your current password is incorrect.");

    await db.update(users).set({ passwordHash: await hashPassword(newPassword) }).where(eq(users.id, row.id));

    const revoked = await revokeUserSessions(row.id);

    const response = NextResponse.json({ ok: true, reauthRequired: true, sessionsRevoked: revoked });
    clearSessionCookies(response);
    return response;
  } catch (err) {
    return handleApiError(err);
  }
}
