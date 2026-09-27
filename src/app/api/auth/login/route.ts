import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import {
  attachSessionCookies,
  createSessionForUser,
  deleteExpiredSessions,
  verifyPassword,
} from "@/lib/auth";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import {
  checkLoginAllowed,
  clearLoginFailures,
  clientIp,
  loginRateLimitKeys,
  RateLimitKeys,
  recordLoginFailure,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let keys: RateLimitKeys | null = null;

  try {
    const body = await req.json().catch(() => null);
    const username = String(body?.username || "").trim();
    const password = String(body?.password || "");

    keys = loginRateLimitKeys(clientIp(req), username);

    // Brute-force protection: too many recent failures for this account (or
    // this client address) short-circuits before any password work happens.
    const verdict = checkLoginAllowed(keys);
    if (verdict.limited) {
      throw new ApiError(429, verdict.message, { "Retry-After": String(verdict.retryAfterSeconds) });
    }

    if (!username || !password) {
      throw new ApiError(400, "Username and password are required.");
    }

    const rows = await db.select().from(users).where(eq(users.username, username)).limit(1);
    const row = rows[0];

    // Always run bcrypt.compare even on unknown users to reduce user
    // enumeration via timing, using a static dummy hash.
    const validHash = row?.passwordHash ?? "$2a$12$C6UzMDM.H6dfI/f/IKcEeO/sIn4YEmZfHDOgP1EhQjSPTvV3Pv0uu";
    const ok = await verifyPassword(password, validHash);

    if (!row || !ok) {
      recordLoginFailure(keys);
      throw new ApiError(401, "Invalid username or password.");
    }

    clearLoginFailures(keys);
    // Cheap housekeeping so expired sessions don't accumulate forever.
    void deleteExpiredSessions();

    const session = await createSessionForUser(row.id);
    const response = NextResponse.json({
      user: { id: row.id, username: row.username, role: row.role, canDelete: row.canDelete },
    });
    attachSessionCookies(response, session);
    return response;
  } catch (err) {
    return handleApiError(err);
  }
}
