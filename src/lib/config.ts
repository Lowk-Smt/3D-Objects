import path from "node:path";
import fs from "node:fs";

// All of these can be overridden via environment variables so the app can be
// deployed somewhere other than a local sandbox without code changes.
// See .env.example for the documented list.
export const STORAGE_DIR = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.resolve(process.cwd(), "data");

export const FILES_DIR = path.join(STORAGE_DIR, "files");
export const THUMBS_DIR = path.join(STORAGE_DIR, "thumbnails");
// Deleted assets are moved here first (an atomic rename) and only then
// unlinked, so a failed delete can never leave a half-removed record.
export const TRASH_DIR = path.join(STORAGE_DIR, "trash");

export const MAX_UPLOAD_BYTES = positiveInt(process.env.MAX_UPLOAD_MB, 300) * 1024 * 1024;
export const MAX_THUMBNAIL_BYTES = 3 * 1024 * 1024;

/**
 * Optional workspace-wide storage cap. When set (and > 0) the server refuses
 * any upload that would push the shared library over it — the sidebar meter
 * is only a display of this, never the enforcement.
 */
export const LIBRARY_QUOTA_BYTES = optionalBytes(process.env.LIBRARY_QUOTA_BYTES);

export const SESSION_TTL_MS = positiveInt(process.env.SESSION_TTL_DAYS, 30) * 24 * 60 * 60 * 1000;

// Login brute-force protection (see src/lib/rate-limit.ts).
export const LOGIN_RATE_WINDOW_MS = positiveInt(process.env.LOGIN_RATE_WINDOW_MINUTES, 15) * 60_000;
export const LOGIN_MAX_FAILURES_PER_ACCOUNT = positiveInt(process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT, 8);
export const LOGIN_MAX_FAILURES_PER_IP = positiveInt(process.env.LOGIN_MAX_FAILURES_PER_IP, 40);
export const LOGIN_LOCKOUT_MS = positiveInt(process.env.LOGIN_LOCKOUT_MINUTES, 10) * 60_000;

// Off by default: only trust X-Forwarded-For when the app really does sit
// behind a reverse proxy that overwrites the header.
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

let ensured = false;

/**
 * Creates the storage tree if needed. Safe to call on every request; the
 * mkdir calls only happen once per process. Also opportunistically sweeps
 * trash left behind by a previous process (never awaited by callers).
 */
export function ensureStorageDirs() {
  if (ensured) return;
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  ensured = true;
}
