import type { NextRequest } from "next/server";
import {
  LOGIN_LOCKOUT_MS,
  LOGIN_MAX_FAILURES_PER_ACCOUNT,
  LOGIN_MAX_FAILURES_PER_IP,
  LOGIN_RATE_WINDOW_MS,
  TRUST_PROXY,
} from "@/lib/config";

/**
 * Deliberately small brute-force protection for a private team app.
 *
 * Failed logins are counted in process memory per (client IP + username) and
 * per client IP. When a counter reaches its limit the keys are locked for
 * LOGIN_LOCKOUT_MS and further attempts get HTTP 429 with Retry-After; a
 * successful login clears that account's counters immediately. There is no
 * database table, no background job and no external service involved — the
 * whole thing is ~60 lines. Memory is bounded by MAX_TRACKED_KEYS below.
 *
 * Note (documented in the README): like the SSE fan-out, this state is
 * per-process, which matches the single-process deployment this app targets.
 */

type Bucket = {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
};

const buckets = new Map<string, Bucket>();
const MAX_TRACKED_KEYS = 5000;

export type RateLimitVerdict =
  | { limited: false }
  | { limited: true; retryAfterSeconds: number; message: string };

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  return `${Math.ceil(seconds / 60)} minute${Math.ceil(seconds / 60) === 1 ? "" : "s"}`;
}

function pruneExpired(now: number): void {
  if (buckets.size < MAX_TRACKED_KEYS) return;
  for (const [key, bucket] of buckets) {
    const windowExpired = now - bucket.firstFailureAt > LOGIN_RATE_WINDOW_MS;
    if (windowExpired && bucket.blockedUntil <= now) buckets.delete(key);
  }
  // Still full of live entries? Drop the oldest ones rather than grow forever.
  if (buckets.size >= MAX_TRACKED_KEYS) {
    const excess = buckets.size - MAX_TRACKED_KEYS + 1;
    let dropped = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (++dropped >= excess) break;
    }
  }
}

/**
 * Reads the client address. Proxy headers are attacker-controlled unless the
 * app really is behind a trusted reverse proxy, so they are only honoured when
 * TRUST_PROXY is enabled; otherwise every request shares one "direct" bucket
 * (the per-username limit below is the primary defence either way).
 */
export function clientIp(req: NextRequest): string {
  if (!TRUST_PROXY) return "direct";

  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip")?.trim() || "unknown";
}

export type RateLimitKeys = { account: string; ip: string };

/**
 * The account bucket is keyed by username only (never by IP) so a spoofed
 * forwarded-for header cannot be used to keep guessing the same password.
 */
export function loginRateLimitKeys(ip: string, username: string): RateLimitKeys {
  return { account: `login:acct:${username.trim().toLowerCase()}`, ip: `login:ip:${ip}` };
}

export function checkLoginAllowed(keys: RateLimitKeys): RateLimitVerdict {
  const now = Date.now();
  const checks: Array<[string, number]> = [
    [keys.account, LOGIN_MAX_FAILURES_PER_ACCOUNT],
    [keys.ip, LOGIN_MAX_FAILURES_PER_IP],
  ];

  for (const [key, limit] of checks) {
    const bucket = buckets.get(key);
    if (!bucket) continue;

    if (bucket.blockedUntil > now) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.blockedUntil - now) / 1000));
      const scope = key === keys.account ? "this account" : "this network";
      return {
        limited: true,
        retryAfterSeconds,
        message: `Too many failed login attempts for ${scope}. Try again in ${formatWait(retryAfterSeconds)}.`,
      };
    }

    // A stale window with no active lock starts over.
    if (now - bucket.firstFailureAt > LOGIN_RATE_WINDOW_MS && bucket.failures >= limit) {
      buckets.delete(key);
    }
  }

  return { limited: false };
}

export function recordLoginFailure(keys: RateLimitKeys): void {
  const now = Date.now();
  pruneExpired(now);

  const record = (key: string, limit: number) => {
    const existing = buckets.get(key);
    const bucket =
      existing && now - existing.firstFailureAt <= LOGIN_RATE_WINDOW_MS
        ? existing
        : { failures: 0, firstFailureAt: now, blockedUntil: 0 };

    bucket.failures += 1;
    if (bucket.failures >= limit) {
      bucket.blockedUntil = now + LOGIN_LOCKOUT_MS;
      console.warn(`[rate-limit] Locked ${key} for ${Math.round(LOGIN_LOCKOUT_MS / 1000)}s after ${bucket.failures} failed attempts.`);
    }
    buckets.set(key, bucket);
  };

  record(keys.account, LOGIN_MAX_FAILURES_PER_ACCOUNT);
  record(keys.ip, LOGIN_MAX_FAILURES_PER_IP);
}

export function clearLoginFailures(keys: RateLimitKeys): void {
  buckets.delete(keys.account);
  buckets.delete(keys.ip);
}
