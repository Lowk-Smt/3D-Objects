// All of these can be overridden via environment variables so the app can be
// deployed somewhere other than a local sandbox without code changes.
// See .env.example for the documented list.
//
// Model binaries and thumbnails live in a private S3-compatible bucket
// (Backblaze B2 in production — see src/lib/r2.ts) — never on a server-local
// filesystem, which Vercel functions do not persist. There is intentionally
// no STORAGE_DIR anymore.

export const MAX_UPLOAD_BYTES = positiveInt(process.env.MAX_UPLOAD_MB, 300) * 1024 * 1024;
export const MAX_THUMBNAIL_BYTES = 3 * 1024 * 1024;

/**
 * Optional workspace-wide storage cap. When set (and > 0) the server refuses
 * any upload that would push the shared library over it — the sidebar meter
 * is only a display of this, never the enforcement. Accounting comes from
 * Postgres (committed files + in-flight presigned reservations), never from a
 * local filesystem walk.
 */
export const LIBRARY_QUOTA_BYTES = optionalBytes(process.env.LIBRARY_QUOTA_BYTES);

export const SESSION_TTL_MS = positiveInt(process.env.SESSION_TTL_DAYS, 30) * 24 * 60 * 60 * 1000;

/**
 * How long a presigned upload reservation (pending_uploads row + PUT URL)
 * stays valid before it expires and its bytes are cleaned up.
 */
export const PENDING_UPLOAD_TTL_MS = positiveInt(process.env.PENDING_UPLOAD_TTL_MINUTES, 30) * 60_000;

// Login brute-force protection (see src/lib/rate-limit.ts).
export const LOGIN_RATE_WINDOW_MS = positiveInt(process.env.LOGIN_RATE_WINDOW_MINUTES, 15) * 60_000;
export const LOGIN_MAX_FAILURES_PER_ACCOUNT = positiveInt(process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT, 8);
export const LOGIN_MAX_FAILURES_PER_IP = positiveInt(process.env.LOGIN_MAX_FAILURES_PER_IP, 40);
export const LOGIN_LOCKOUT_MS = positiveInt(process.env.LOGIN_LOCKOUT_MINUTES, 10) * 60_000;

// Off by default: only trust X-Forwarded-For when the app really does sit
// behind a reverse proxy that overwrites the header. On Vercel the platform
// sets X-Forwarded-For itself, so TRUST_PROXY=true gives accurate per-IP
// rate-limit keys there (the per-account limit is the primary defence either
// way — see README "Limitations").
export const TRUST_PROXY = process.env.TRUST_PROXY === "true" || process.env.TRUST_PROXY === "1";

export const IS_PRODUCTION = process.env.NODE_ENV === "production";

function positiveInt(raw: string | undefined | null, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function optionalBytes(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    if (value !== 0) console.warn(`[config] Ignoring invalid LIBRARY_QUOTA_BYTES=${raw}`);
    return null;
  }
  return Math.floor(value);
}
