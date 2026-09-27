import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { files } from "@/db/schema";
import { ApiError } from "@/lib/api-helpers";
import {
  ensureStorageDirs,
  FILES_DIR,
  LIBRARY_QUOTA_BYTES,
  THUMBS_DIR,
  TRASH_DIR,
} from "@/lib/config";
import {
  ImageType,
  imageTypeFromExt,
  isSafeFileId,
  sanitizeStoredName,
  sniffImageType,
} from "@/lib/files";

/**
 * Everything that touches uploaded bytes lives here, so the "database row and
 * file on disk agree" invariant is enforced in exactly one place:
 *
 *  - uploads write the file first and roll the file back if the DB insert
 *    fails (no orphaned bytes, no phantom rows);
 *  - deletes move bytes to STORAGE_DIR/trash with an atomic rename *before*
 *    the row is removed, and rename them back if the row delete fails, so a
 *    partially completed delete can never leave inconsistent state;
 *  - thumbnails are written atomically (tmp + rename) and stored under the
 *    extension/mime of their actual bytes.
 */

function assertSafeId(id: string): string {
  if (!isSafeFileId(id)) throw new ApiError(400, "Invalid file id.");
  return id;
}

export function fileDir(id: string): string {
  return path.join(FILES_DIR, assertSafeId(id));
}

export function fileDiskPath(id: string, storedName: string): string {
  return path.join(fileDir(id), sanitizeStoredName(storedName));
}

export function thumbnailPath(id: string, ext: string): string {
  return path.join(THUMBS_DIR, `${assertSafeId(id)}.${imageTypeFromExt(ext).ext}`);
}

/* ------------------------------------------------------------------ uploads */

/**
 * Writes uploaded bytes to `STORAGE_DIR/files/<id>/<storedName>`.
 * Throws (and leaves nothing behind) if the bytes cannot be written
 * completely — callers may only insert the DB row after this resolves.
 */
export async function saveFileData(id: string, storedName: string, buffer: Buffer): Promise<void> {
  ensureStorageDirs();

  const dir = fileDir(id);
  const target = path.join(dir, sanitizeStoredName(storedName));

  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(target, buffer);

    // Verify the write before the caller commits metadata to Postgres.
    const stat = await fs.stat(target);
    if (stat.size !== buffer.length) {
      throw new Error(`size mismatch after write (${stat.size} != ${buffer.length})`);
    }
  } catch (err) {
    console.error(`[storage] Failed to write upload ${id}:`, err);
    await discardFileData(id);
    throw new ApiError(500, "The file could not be written to server storage. Nothing was saved — please try again.");
  }
}

/** Best-effort removal of an upload's bytes (rollback path). Never throws. */
export async function discardFileData(id: string): Promise<void> {
  if (!isSafeFileId(id)) return;
  try {
    await fs.rm(fileDir(id), { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  } catch (err) {
    // Loud, because this is the one case that can leave orphaned bytes.
    console.error(`[storage] ORPHANED upload directory for ${id} — could not roll back:`, err);
  }
}

/* ------------------------------------------------------------------ deletes */

type TrashMove = { from: string; to: string };

function trashTarget(kind: string, id: string): string {
  return path.join(TRASH_DIR, `${kind}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${id}`);
}

async function moveToTrash(source: string, kind: string, id: string): Promise<TrashMove | null> {
  const to = trashTarget(kind, id);
  try {
    await fs.rename(source, to);
    return { from: source, to };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null; // nothing on disk to remove — fine
    throw err;
  }
}

async function restoreFromTrash(moves: TrashMove[]): Promise<void> {
  for (const move of moves) {
    try {
      await fs.rename(move.to, move.from);
    } catch (err) {
      console.error(`[storage] Could not restore ${move.from} after a failed delete:`, err);
    }
  }
}

async function purgeTrash(moves: TrashMove[]): Promise<boolean> {
  let allPurged = true;
  for (const move of moves) {
    try {
      await fs.rm(move.to, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (err) {
      allPurged = false;
      console.error(`[storage] Failed to purge ${move.to} — it will be swept on the next restart:`, err);
    }
  }
  return allPurged;
}

const THUMB_CANDIDATE_EXTS = ["jpg", "png", "webp", "gif"];

function thumbnailCandidates(id: string, hintExt?: string | null): string[] {
  const exts = [imageTypeFromExt(hintExt).ext, ...THUMB_CANDIDATE_EXTS].filter(
    (ext, index, all) => all.indexOf(ext) === index,
  );
  return exts.map((ext) => path.join(THUMBS_DIR, `${id}.${ext}`));
}

export type DeleteResult = {
  /** ids whose DB row and bytes are both gone (or whose bytes never existed). */
  deleted: string[];
  /** false when bytes are parked in the trash because purging them failed. */
  cleanupComplete: boolean;
};

/**
 * Deletes file rows together with their bytes, safely and in a recoverable
 * order. Returns the ids that actually existed. Throws ApiError(500) if the
 * database delete fails — in that case nothing is deleted at all (the bytes
 * are renamed back), so the caller never sees a half-deleted library.
 */
export async function deleteFileRecords(ids: string[]): Promise<DeleteResult> {
  ensureStorageDirs();

  const safeIds = ids.filter(isSafeFileId);
  if (safeIds.length === 0) return { deleted: [], cleanupComplete: true };

  const rows = await db
    .select({ id: files.id, thumbExt: files.thumbExt })
    .from(files)
    .where(inArray(files.id, safeIds));

  const foundIds = rows.map((row) => row.id);
  if (foundIds.length === 0) return { deleted: [], cleanupComplete: true };

  const moves: TrashMove[] = [];
  const parkingFailed: string[] = [];

  for (const row of rows) {
    try {
      const fileMove = await moveToTrash(fileDir(row.id), "files", row.id);
      if (fileMove) moves.push(fileMove);

      for (const candidate of thumbnailCandidates(row.id, row.thumbExt)) {
        const thumbMove = await moveToTrash(candidate, "thumb", row.id);
        if (thumbMove) moves.push(thumbMove);
      }
    } catch (err) {
      console.error(`[storage] Could not park ${row.id} for deletion:`, err);
      parkingFailed.push(row.id);
      await restoreFromTrash(moves.splice(0, moves.length));
      throw new ApiError(
        500,
        "Could not remove this file from storage, so nothing was deleted. Check the server's storage directory and try again.",
      );
    }
  }

  try {
    await db.delete(files).where(inArray(files.id, foundIds));
  } catch (err) {
    console.error("[storage] Database delete failed — restoring parked bytes:", err);
    await restoreFromTrash(moves);
    throw new ApiError(500, "The database could not delete this file, so nothing was removed. Please try again.");
  }

  const cleanupComplete = await purgeTrash(moves);

  if (!cleanupComplete) {
    console.warn("[storage] Some deleted bytes are still parked in trash and will be swept later.");
  }

  return { deleted: foundIds, cleanupComplete };
}

/**
 * Removes anything left in STORAGE_DIR/trash from a previous process. Only
 * touches entries older than `maxAgeMs` so an in-flight delete in this
 * process can never be swept from underneath it. Best effort.
 */
export async function sweepTrash(maxAgeMs = 60 * 60 * 1000): Promise<void> {
  try {
    ensureStorageDirs();
    const entries = await fs.readdir(TRASH_DIR, { withFileTypes: true });
    const cutoff = Date.now() - maxAgeMs;

    for (const entry of entries) {
      const full = path.join(TRASH_DIR, entry.name);
      try {
        const stat = await fs.stat(full);
        if (stat.mtimeMs > cutoff) continue;
        await fs.rm(full, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
        console.warn(`[storage] Swept leftover trash entry ${entry.name}`);
      } catch (err) {
        console.error(`[storage] Could not sweep ${full}:`, err);
      }
    }
  } catch (err) {
    console.error("[storage] Trash sweep failed:", err);
  }
}

let sweepScheduled = false;

/** Fire-and-forget, once per process. */
export function scheduleTrashSweep(): void {
  if (sweepScheduled) return;
  sweepScheduled = true;
  void sweepTrash().catch(() => {
    /* already logged */
  });
}

/* --------------------------------------------------------------- thumbnails */

export type StoredThumbnail = {
  buffer: Buffer;
  ext: string;
  mime: string;
  /** Set when the bytes on disk were found under the wrong extension. */
  repairedExt?: string;
};

/**
 * Loads a thumbnail for `id`, verifying the served type against the actual
 * bytes. If a legacy file is found under an extension that does not match its
 * content (e.g. PNG bytes in `<id>.jpg`), it is renamed to the correct
 * extension and `repairedExt` is reported so the caller can persist it.
 */
export async function readThumbnail(id: string, hintExt?: string | null): Promise<StoredThumbnail | null> {
  for (const candidate of thumbnailCandidates(id, hintExt)) {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(candidate);
    } catch {
      continue;
    }

    const onDiskExt = path.extname(candidate).slice(1).toLowerCase();
    const sniffed = sniffImageType(buffer);
    const type: ImageType = sniffed ?? imageTypeFromExt(onDiskExt);

    if (type.ext !== onDiskExt) {
      const repaired = await repairThumbnailExt(candidate, id, type.ext);
      return { buffer, ext: type.ext, mime: type.mime, repairedExt: repaired ? type.ext : undefined };
    }

    return { buffer, ext: type.ext, mime: type.mime };
  }

  return null;
}

/** Renames a thumbnail whose extension disagrees with its bytes. Best effort. */
async function repairThumbnailExt(currentPath: string, id: string, correctExt: string): Promise<boolean> {
  const target = path.join(THUMBS_DIR, `${id}.${correctExt}`);
  try {
    await fs.rename(currentPath, target);
    console.warn(`[storage] Repaired thumbnail extension for ${id}: ${path.basename(currentPath)} -> ${path.basename(target)}`);
    return true;
  } catch (err) {
    console.error(`[storage] Could not repair thumbnail extension for ${id}:`, err);
    return false;
  }
}

/**
 * Writes a thumbnail atomically under the extension of its real bytes,
 * removing any stale thumbnail stored under a different extension.
 */
export async function writeThumbnail(id: string, buffer: Buffer, type: ImageType): Promise<void> {
  ensureStorageDirs();

  const target = thumbnailPath(id, type.ext);
  const tmp = `${target}.${crypto.randomBytes(4).toString("hex")}.tmp`;

  try {
    await fs.writeFile(tmp, buffer);
    await fs.rename(tmp, target);
  } catch (err) {
    console.error(`[storage] Failed to write thumbnail for ${id}:`, err);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw new ApiError(500, "The thumbnail could not be saved on the server. Please try again.");
  }

  // Drop any thumbnail left over from a previous, differently-typed upload.
  for (const candidate of thumbnailCandidates(id, null)) {
    if (candidate !== target) await fs.rm(candidate, { force: true }).catch(() => undefined);
  }
}

/** Removes every stored thumbnail variant for `id`. Best effort. */
export async function removeThumbnails(id: string): Promise<void> {
  for (const candidate of thumbnailCandidates(id, null)) {
    await fs.rm(candidate, { force: true }).catch(() => undefined);
  }
}

/* -------------------------------------------------------------------- quota */

/**
 * In-flight upload reservations, so two concurrent uploads cannot both pass
 * the quota check with the same "free space" and overshoot it.
 *
 * Like the SSE fan-out, this is per-process state: correct for the single
 * server process this app is designed to run as (see README "Limitations").
 */
let pendingUploadBytes = 0;
let reservationChain: Promise<void> = Promise.resolve();

export async function workspaceUsage(): Promise<{ fileCount: number; totalBytes: number }> {
  const rows = await db
    .select({ id: files.id, size: files.size })
    .from(files);
  return {
    fileCount: rows.length,
    totalBytes: rows.reduce((sum, row) => sum + Number(row.size || 0), 0),
  };
}

/**
 * Reserves `size` bytes of the configured quota, or throws ApiError(413).
 * No-op when LIBRARY_QUOTA_BYTES is not configured.
 */
export async function reserveUploadBytes(size: number): Promise<void> {
  if (!LIBRARY_QUOTA_BYTES) return;

  const previous = reservationChain;
  let release!: () => void;
  reservationChain = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    const { totalBytes } = await workspaceUsage();
    const used = totalBytes + pendingUploadBytes;

    if (used + size > LIBRARY_QUOTA_BYTES) {
      throw new ApiError(
        413,
        `Storage limit reached: the workspace allows ${formatBytes(LIBRARY_QUOTA_BYTES)} and ` +
          `${formatBytes(used)} is already used, so this ${formatBytes(size)} upload was rejected. ` +
          `Delete some files or ask the owner to raise LIBRARY_QUOTA_BYTES.`,
      );
    }

    pendingUploadBytes += size;
  } finally {
    release();
  }
}

export function releaseUploadBytes(size: number): void {
  if (!LIBRARY_QUOTA_BYTES) return;
  pendingUploadBytes = Math.max(0, pendingUploadBytes - size);
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
