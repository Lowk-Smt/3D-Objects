import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { IS_PRODUCTION, SESSION_TTL_MS } from "@/lib/config";

export const SESSION_COOKIE = "mv_session";
export const CSRF_COOKIE = "mv_csrf";

export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type SafeUser = {
  id: string;
  username: string;
  role: "owner" | "member";
  canDelete: boolean;
  createdAt: Date;
};

function toSafeUser(row: typeof users.$inferSelect): SafeUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role === "owner" ? "owner" : "member",
    canDelete: row.canDelete,
    createdAt: row.createdAt,
  };
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

function randomToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export async function createSessionForUser(userId: string) {
  const id = randomToken();
  const csrfToken = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(sessions).values({ id, userId, csrfToken, expiresAt });

  return { id, csrfToken, expiresAt };
}

export function attachSessionCookies(
  response: NextResponse,
  session: { id: string; csrfToken: string; expiresAt: Date },
) {
  response.cookies.set(SESSION_COOKIE, session.id, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "lax",
    path: "/",
    expires: session.expiresAt,
  });

  // Non-httpOnly on purpose: the frontend reads this to echo it back as an
  // `x-csrf-token` header on state-changing requests (double-submit cookie
  // pattern). It is useless to an attacker without also controlling a
  // same-site request, since the real secret (mv_session) stays httpOnly.
  response.cookies.set(CSRF_COOKIE, session.csrfToken, {
    httpOnly: false,
    secure: IS_PRODUCTION,
    sameSite: "lax",
    path: "/",
    expires: session.expiresAt,
  });
}

export function clearSessionCookies(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  response.cookies.set(CSRF_COOKIE, "", { path: "/", maxAge: 0 });
}

export async function destroySession(sessionId: string) {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export type SessionContext = {
  user: SafeUser;
  sessionId: string;
  csrfToken: string;
};

export async function getSessionContext(req: NextRequest): Promise<SessionContext | null> {
  const sessionId = req.cookies.get(SESSION_COOKIE)?.value;
  if (!sessionId) return null;

  const rows = await db
    .select({
      sessionId: sessions.id,
      csrfToken: sessions.csrfToken,
      expiresAt: sessions.expiresAt,
      user: users,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  if (row.expiresAt.getTime() < Date.now()) {
    await destroySession(sessionId);
    return null;
  }

  return {
    user: toSafeUser(row.user),
    sessionId: row.sessionId,
    csrfToken: row.csrfToken,
  };
}

export async function requireSession(req: NextRequest): Promise<SessionContext> {
  const ctx = await getSessionContext(req);
  if (!ctx) throw new AuthError(401, "Your session has expired. Please log in again.");
  return ctx;
}

/** Defense-in-depth CSRF check: double-submit token + same-origin check. */
export function requireCsrf(req: NextRequest, ctx: SessionContext) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");

  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        throw new AuthError(403, "Cross-origin request blocked.");
      }
    } catch {
      throw new AuthError(403, "Invalid origin header.");
    }
  }

  const headerToken = req.headers.get("x-csrf-token");
  if (!headerToken || headerToken !== ctx.csrfToken) {
    throw new AuthError(403, "Missing or invalid CSRF token.");
  }
}

export function requireOwner(user: SafeUser) {
  if (user.role !== "owner") {
    throw new AuthError(403, "Only the workspace owner can do that.");
  }
}

export function canUserDeleteFiles(user: SafeUser): boolean {
  return user.role === "owner" || user.canDelete;
}

export function authErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return null;
}
