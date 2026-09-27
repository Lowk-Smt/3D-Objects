import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { IS_PRODUCTION, SESSION_TTL_MS } from "@/lib/config";

export const SESSION_COOKIE = "mv_session";
export const CSRF_COOKIE = "mv_csrf";

export class AuthError extends Error {
  status: number;
  headers?: Record<string, string>;

  constructor(status: number, message: string, headers?: Record<string, string>) {
    super(message);
    this.status = status;
    this.headers = headers;
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

/**
 * Revokes every server-side session belonging to a user. Called whenever a
 * password changes (by the user themselves or by an owner resetting it), so
 * old cookies stop working immediately instead of staying valid for the rest
 * of their TTL.
 */
export async function revokeUserSessions(userId: string): Promise<number> {
  const revoked = await db.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
  return revoked.length;
}

/** Housekeeping: drop session rows that are already past their expiry. */
export async function deleteExpiredSessions(): Promise<void> {
  try {
    await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  } catch (err) {
    console.error("[auth] Could not purge expired sessions:", err);
  }
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

/**
 * Cheap liveness check for a long-lived connection (the SSE stream). Sessions
 * are revoked by deleting their row, so this is all that is needed to notice
 * that a password changed or an account was removed mid-stream.
 */
export async function isSessionAlive(sessionId: string): Promise<boolean> {
  const rows = await db
    .select({ expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  const row = rows[0];
  return !!row && row.expiresAt.getTime() >= Date.now();
}

export async function requireSession(req: NextRequest): Promise<SessionContext> {
  const ctx = await getSessionContext(req);
  if (!ctx) throw new AuthError(401, "Your session has expired. Please log in again.");
  return ctx;
}

/**
 * Hosts this request could legitimately have been addressed to: the Host
 * header, whatever a reverse proxy reports in X-Forwarded-Host, and an
 * explicitly configured PUBLIC_ORIGIN. Comparing against all of them keeps
 * the check working behind a proxy that rewrites Host (e.g. the sandbox
 * preview URL) instead of breaking every state-changing request.
 */
function candidateRequestHosts(req: NextRequest): string[] {
  const hosts = new Set<string>();

  const host = req.headers.get("host");
  if (host) hosts.add(host.trim());

  const forwardedHost = req.headers.get("x-forwarded-host");
  if (forwardedHost) {
    for (const entry of forwardedHost.split(",")) {
      const trimmed = entry.trim();
      if (trimmed) hosts.add(trimmed);
    }
  }

  const configured = process.env.PUBLIC_ORIGIN;
  if (configured) {
    try {
      hosts.add(new URL(configured).host);
    } catch {
      console.warn(`[auth] Ignoring invalid PUBLIC_ORIGIN=${configured}`);
    }
  }

  return [...hosts];
}

/**
 * Defense-in-depth CSRF check: the double-submit token (which a cross-origin
 * page cannot read, let alone send as a header) plus an Origin/Host check.
 */
export function requireCsrf(req: NextRequest, ctx: SessionContext) {
  const origin = req.headers.get("origin");

  if (origin && origin !== "null") {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new AuthError(403, "Invalid origin header.");
    }

    const candidates = candidateRequestHosts(req);
    // Only enforce when we actually know a host this request was addressed to;
    // otherwise the token below is still required.
    if (candidates.length > 0 && !candidates.includes(originHost)) {
      throw new AuthError(403, "Cross-origin request blocked.");
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

/**
 * Who may create/replace a file's shared thumbnail: the member who uploaded
 * that file, or the workspace owner. Enforced server-side on every write —
 * the frontend only hides the action.
 */
export function canUserManageThumbnail(
  user: SafeUser,
  file: { uploaderId: string | null },
): boolean {
  if (user.role === "owner") return true;
  return !!file.uploaderId && file.uploaderId === user.id;
}

export function authErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return null;
}
