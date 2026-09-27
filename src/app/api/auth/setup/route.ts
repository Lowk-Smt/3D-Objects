import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { attachSessionCookies, createSessionForUser, hashPassword } from "@/lib/auth";
import { isValidUsername } from "@/lib/files";
import {
  checkLoginAllowed,
  clientIp,
  loginRateLimitKeys,
  RateLimitKeys,
  recordLoginFailure,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Arbitrary but fixed key for the Postgres advisory lock that serializes
// "create the first owner" across concurrent requests (and processes).
const SETUP_LOCK_KEY = 8_140_221;

// Creates the first "owner" account. Only works while the users table is
// empty — after that, only an existing owner can invite new members via
// POST /api/users.
export async function POST(req: NextRequest) {
  let keys: RateLimitKeys | null = null;

  try {
    const body = await req.json().catch(() => null);
    const username = String(body?.username || "").trim();
    const password = String(body?.password || "");

    // Same brute-force protection as login: this endpoint is unauthenticated
    // and burns a bcrypt hash on every call.
    keys = loginRateLimitKeys(clientIp(req), `setup:${username}`);
    const verdict = checkLoginAllowed(keys);
    if (verdict.limited) {
      throw new ApiError(429, verdict.message, { "Retry-After": String(verdict.retryAfterSeconds) });
    }

    if (!isValidUsername(username)) {
      throw new ApiError(400, "Username must be 3-32 characters (letters, numbers, . _ -).");
    }
    if (password.length < 8) {
      throw new ApiError(400, "Password must be at least 8 characters.");
    }

    // Hash before taking the lock so the critical section stays short.
    const passwordHash = await hashPassword(password);
    const id = crypto.randomUUID();

    // The emptiness check and the insert must be one atomic step: otherwise
    // two simultaneous setup requests both see "no users yet" and both become
    // owners. A transaction-scoped advisory lock serializes them, and the
    // unique index on users.username is a second line of defense.
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK_KEY})`);

      const existing = await tx.select({ id: users.id }).from(users).limit(1);
      if (existing.length > 0) {
        throw new ApiError(409, "Setup already completed. Ask the workspace owner for an invite.");
      }

      await tx.insert(users).values({
        id,
        username,
        passwordHash,
        role: "owner",
        canDelete: true,
      });
    });

    const session = await createSessionForUser(id);
    const response = NextResponse.json({
      user: { id, username, role: "owner", canDelete: true },
    });
    attachSessionCookies(response, session);
    return response;
  } catch (err) {
    // Every unsuccessful attempt counts toward the rate limit (400/409), but a
    // 429 is already a limit response and a 5xx is our fault, not a guess.
    if (keys && err instanceof ApiError && (err.status === 400 || err.status === 409)) {
      recordLoginFailure(keys);
    }
    return handleApiError(err);
  }
}
