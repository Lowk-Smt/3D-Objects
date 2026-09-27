// Shared filename / MIME helpers used by the server. These intentionally
// mirror the logic in public/vault/app.js so client and server agree on
// extensions and content types.

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
 * Sanitize a user-supplied filename for safe storage on disk. This never
 * affects the "display name" stored in the database — it only controls the
 * name of the file actually written under STORAGE_DIR, which always lives
 * inside an id-scoped directory anyway (defense in depth against traversal).
 */
export function sanitizeStoredName(name: string): string {
  const base = String(name || "file")
    .replace(/\\/g, "/")
    .split("/")
    .pop() || "file";

  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"|?*]/g, "_")
    .replace(/^\.+/, "_")
    .trim();

  const safe = cleaned.length ? cleaned : "file";

  return safe.length > 180 ? safe.slice(-180) : safe;
}

/**
 * Sanitize a logical relative path (used for glTF companion-file
 * resolution). Strips ".." segments and empty parts to prevent traversal
 * while preserving folder structure for dependency resolution.
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
