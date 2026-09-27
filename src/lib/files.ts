// Shared filename / relative-path / MIME helpers used by the server. The
// browser-side equivalents live in public/vault/shared.js and are unit tested
// by tests/paths.test.mjs so client and server cannot silently disagree.

export const MIME_BY_EXT: Record<string, string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "text/plain",
  mtl: "text/plain",
  stl: "model/stl",
  fbx: "application/octet-stream",
  ply: "application/octet-stream",
  bin: "application/octet-stream",

  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",

  json: "application/json",
  zip: "application/zip",
  txt: "text/plain",

  ktx2: "image/ktx2",
};

export function getExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function getMimeForName(name: string): string {
  return MIME_BY_EXT[getExt(name)] || "application/octet-stream";
}

/**
 * File ids are server-generated UUIDs. Validating the shape before the value
 * is ever used to build an object-storage key is defense-in-depth (a DB
 * lookup already gates access, but never trust a key part).
 */
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeFileId(id: unknown): id is string {
  return typeof id === "string" && FILE_ID_PATTERN.test(id);
}

/**
 * Sanitize a user-supplied filename for safe object storage. This never
 * affects the "display name" stored in the database — it only controls the
 * final segment of the R2 object key (`files/<id>/<storedName>`), which is
 * always scoped to a server-generated id anyway (defense in depth).
 */
export function sanitizeStoredName(name: string): string {
  const base =
    String(name || "file")
      .replace(/\\/g, "/")
      .split("/")
      .pop() || "file";

  const cleaned = base
    .replace(/[\x00-\x1f<>:"|?*]/g, "_")
    .replace(/^\.+/, "_")
    .trim();

  const safe = cleaned.length ? cleaned : "file";

  return safe.length > 180 ? safe.slice(-180) : safe;
}

/** Display names never contain directory separators or control characters. */
export function sanitizeDisplayName(name: string): string {
  return sanitizeStoredName(name).replace(/^_+/, "").slice(0, 255) || "file";
}

/**
 * Sanitize a logical relative path (used for glTF companion-file resolution).
 * Strips ".." segments and empty parts to prevent traversal while preserving
 * the folder structure the .gltf file's references are resolved against.
 */
export function sanitizeRelativePath(inputPath: string): string {
  const parts = String(inputPath || "")
    .replace(/\\/g, "/")
    .split("/");

  const out: string[] = [];

  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }

  return out.map(sanitizeStoredName).join("/");
}

export function isValidUsername(username: string): boolean {
  return /^[a-zA-Z0-9._-]{3,32}$/.test(username);
}

/* -------------------------------------------------------------------------
   Content sniffing for thumbnails.

   A data URL is a client claim, not proof. Thumbnails are always stored and
   served under the type their *bytes* actually are, so a PNG can never end up
   as `something.jpg` or be served as `image/jpeg`.
   ------------------------------------------------------------------------- */

export type ImageType = { ext: "jpg" | "png" | "webp" | "gif"; mime: string };

const IMAGE_TYPES: ImageType[] = [
  { ext: "jpg", mime: "image/jpeg" },
  { ext: "png", mime: "image/png" },
  { ext: "webp", mime: "image/webp" },
  { ext: "gif", mime: "image/gif" },
];

export function imageTypeFromExt(ext: string | null | undefined): ImageType {
  return IMAGE_TYPES.find((t) => t.ext === String(ext || "").toLowerCase()) ?? IMAGE_TYPES[0];
}

export function sniffImageType(buffer: Buffer): ImageType | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return IMAGE_TYPES[0]; // JPEG
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return IMAGE_TYPES[1]; // PNG
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return IMAGE_TYPES[2]; // WebP
  }
  if (buffer.length >= 6 && buffer.subarray(0, 4).toString("ascii") === "GIF8") {
    return IMAGE_TYPES[3]; // GIF
  }
  return null;
}

/**
 * Decode an `data:image/...;base64,...` URL. Only image payloads are accepted
 * here; the declared media type is returned for comparison/logging only —
 * callers must trust the *sniffed* bytes, never this claim.
 */
export function decodeImageDataUrl(dataUrl: string): { buffer: Buffer; declaredMime: string } | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || "").trim());
  if (!match) return null;

  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length === 0) return null;

  return { buffer, declaredMime: match[1].toLowerCase() };
}

/* -------------------------------------------------------------------------
   Wire format for file metadata (shared by every route that returns a file).
   Dates become epoch milliseconds so the browser never has to guess.
   ------------------------------------------------------------------------- */

import type { files as filesTable } from "@/db/schema";

export type SerializedFile = {
  id: string;
  name: string;
  ext: string;
  mime: string;
  size: number;
  path: string;
  uploaderId: string | null;
  uploaderName: string;
  uploadedAt: number;
  updatedAt: number;
  hasThumbnail: boolean;
  optimized: boolean;
  optimizePreset: string | null;
};

export function serializeFile(row: typeof filesTable.$inferSelect): SerializedFile {
  return {
    id: row.id,
    name: row.name,
    ext: row.ext,
    mime: row.mime,
    size: row.size,
    path: row.path,
    uploaderId: row.uploaderId,
    uploaderName: row.uploaderName,
    uploadedAt: row.uploadedAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    hasThumbnail: row.hasThumbnail,
    optimized: row.optimized,
    optimizePreset: row.optimizePreset,
  };
}
