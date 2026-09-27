import path from "node:path";
import fs from "node:fs";

// All of these can be overridden via environment variables so the app can be
// deployed somewhere other than this sandbox without code changes.
export const STORAGE_DIR = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.resolve(process.cwd(), "data");

export const FILES_DIR = path.join(STORAGE_DIR, "files");
export const THUMBS_DIR = path.join(STORAGE_DIR, "thumbnails");

export const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 300) * 1024 * 1024;
export const MAX_THUMBNAIL_BYTES = 3 * 1024 * 1024;

export const SESSION_TTL_MS = (Number(process.env.SESSION_TTL_DAYS) || 30) * 24 * 60 * 60 * 1000;

export const IS_PRODUCTION = process.env.NODE_ENV === "production";

let ensured = false;

export function ensureStorageDirs() {
  if (ensured) return;
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
  ensured = true;
}
