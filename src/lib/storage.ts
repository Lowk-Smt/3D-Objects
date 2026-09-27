import crypto from "node:crypto";
import { gt, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { files, pendingUploads } from "@/db/schema";
import { ApiError } from "@/lib/api-helpers";
import { LIBRARY_QUOTA_BYTES, MAX_UPLOAD_BYTES, PENDING_UPLOAD_TTL_MS } from "@/lib/config";
import {
  ImageType,
  getExt,
  getMimeForName,
  imageTypeFromExt,
  isSafeFileId,
  sanitizeDisplayName,
  sanitizeRelativePath,
  sanitizeStoredName,
  serializeFile,
  sniffImageType,
  type SerializedFile,
} from "@/lib/files";
import { canUserCompleteUpload } from "@/lib/permissions";
import {
  PRESIGNED_PUT_EXPIRES_IN_SECONDS,
  R2Error,
  deleteFileObjects,
  deleteThumbnailObjects,
  fileObjectKey,
  getObjectStore,
  isR2Configured,
  putObjectWithVerify,
  requireR2Config,
  thumbnailCandidateKeys,
  thumbnailObjectKey,
  type ObjectStore,
} from "@/lib/r2";
import {
  UploadValidationError,
  quotaRejectionMessage,
  validatePresignInput,
} from "@/lib/uploads";

/**
 * Everything that touches uploaded bytes lives here, so the "database row and
 * stored object agree" invariant is enforced in exactly one place.
 *
 * Binaries live in the private Cloudflare R2 bucket (see src/lib/r2.ts);
 * Postgres is the metadata source of truth. There is no server-local
 * filesystem involved — Vercel functions have no persistent disk, and this
 * module never assumes otherwise.
 *
 * Consistency rules (the R2 equivalents of the old filesystem guarantees):
 *
 *  - uploads write the object first, verify it, and roll the object back if
 *    the DB insert fails (no orphaned bytes, no phantom rows);
 *  - deletes remove the DB rows FIRST and the objects afterwards: R2 has no
 *    atomic rename-to-trash, so bytes-first ordering cannot be recovered from
 *    a crash. Row-first means a failure can only leave orphaned (invisible,
 *    later swept) bytes, never a visible row pointing at missing bytes;
 *  - thumbnails are typed by their actual bytes and replaced atomically
 *    enough (put + best-effort cleanup of stale variants);
 *  - quota is accounted from Postgres (committed files + in-flight presigned
 *    reservations), which is shared across serverless instances — unlike the
 *    old in-process counter, which survives only as a fast path for the
 *    single-request multipart flow.
 */

function toApiError(err: unknown, fallback: string): ApiError {
  if (err instanceof ApiError) return err;
  // R2Error and UploadValidationError already carry user-safe messages.
  if (err instanceof R2Error || err instanceof UploadValidationError) {
    return new ApiError(err.status, err.message);
  }
  console.error("[storage] Unexpected failure:", err);
  return new ApiError(500, fallback);
}

/* ------------------------------------------------------------------ uploads
   Two flows share this module:
   1. presigned (used by the browser UI): presign → PUT directly to R2 →
      complete. Large files never pass through a serverless request body.
   2. single-request multipart (small files, scripts, e2e): buffer → R2 → row.
*/

export type PresignedUpload = {
  /** Reserved file id — becomes `files.id` on completion. */
  id: string;
  /** Short-lived PUT URL for exactly one object key. No credentials in it. */
  uploadUrl: string;
  /** Content-Type the browser must send on the PUT (part of the signature). */
  contentType: string;
  /** Epoch ms when the reservation + URL expire. */
  expiresAt: number;
};

export async function createPresignedUpload(args: {
  name: unknown;
  path: unknown;
  size: unknown;
  optimized: unknown;
  preset: unknown;
  user: { id: string; username: string };
}): Promise<PresignedUpload> {
  let validated;
  try {
    validated = validatePresignInput({
      name: String(args.name ?? ""),
      path: String(args.path ?? ""),
      size: args.size as number,
      optimized: args.optimized,
      preset: args.preset,
      maxUploadBytes: MAX_UPLOAD_BYTES,
    });
  } catch (err) {
    throw toApiError(err, "Invalid upload request.");
  }

  // Display name and relative path are browser hints only: both are sanitized
  // here, and neither decides where bytes land (that is the server-side UUID).
  const originalName = sanitizeDisplayName(validated.name);
  const relativePath = sanitizeRelativePath(validated.path || originalName) || originalName;
  if (relativePath.length > 1024) throw new ApiError(400, "File path is too long.");
  const storedName = sanitizeStoredName(originalName);
  const mime = getMimeForName(originalName);

  // Fail fast before reserving anything when object storage is unreachable.
  try {
    requireR2Config();
  } catch (err) {
    throw toApiError(err, "Object storage is unavailable.");
  }

  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PENDING_UPLOAD_TTL_MS);

  // Serialize check-then-reserve within this instance; the pending row itself
  // is the cross-instance reservation, and completion re-checks quota.
  await withReservationSlot(async () => {
    await expirePendingUploads();
    await assertQuotaFits(validated.size);
    try {
      await db.insert(pendingUploads).values({
        id,
        name: originalName,
        ext: getExt(originalName),
        mime,
        size: validated.size,
        path: relativePath,
        storedName,
        uploaderId: args.user.id,
        uploaderName: args.user.username,
        optimized: validated.optimized,
        optimizePreset: validated.optimizePreset,
        expiresAt,
        createdAt: now,
      });
    } catch (err) {
      console.error(`[storage] Could not reserve upload ${id}:`, err);
      throw new ApiError(
        500,
        "The upload could not be started. Please try again in a moment.",
      );
    }
  });

  const store = getObjectStore();
  const key = fileObjectKey(id, storedName);
  let uploadUrl: string;
  try {
    uploadUrl = await store.presignPut(key, mime, PRESIGNED_PUT_EXPIRES_IN_SECONDS);
  } catch (err) {
    // Never leave a reservation behind for a URL that was never minted.
    await db.delete(pendingUploads).where(inArray(pendingUploads.id, [id])).catch(() => undefined);
    throw toApiError(err, "The upload could not be started. Please try again in a moment.");
  }

  // Opportunistic hygiene (never awaited, never throws).
  scheduleStorageSweep();

  return { id, uploadUrl, contentType: mime, expiresAt: expiresAt.getTime() };
}

/**
 * Completes a presigned upload: verifies the object the browser PUT to R2
 * (existence + exact size), re-checks quota, and commits the `files` row.
 * Idempotent — retrying a completed id returns the committed file (with
 * `alreadyCompleted: true`) instead of failing or duplicating anything.
 */
export async function completePresignedUpload(args: {
  id: string;
  user: { id: string; role: "owner" | "member"; canDelete: boolean };
}): Promise<{ file: SerializedFile; alreadyCompleted: boolean }> {
  const id = args.id;
  if (!isSafeFileId(id)) throw new ApiError(400, "Invalid file id.");

  const pending = (
    await db.select().from(pendingUploads).where(inArray(pendingUploads.id, [id])).limit(1)
  )[0];
  if (!pending || pending.expiresAt.getTime() < Date.now()) {
    // A retry after a successful completion finds no reservation but a
    // committed row: report success, not expiry. (The id is unguessable and
    // the file list is visible to every member anyway, so looking it up here
    // leaks nothing.)
    const committed = (
      await db.select().from(files).where(inArray(files.id, [id])).limit(1)
    )[0];
    if (committed) return { file: serializeFile(committed), alreadyCompleted: true };

    if (pending) {
      await db.delete(pendingUploads).where(inArray(pendingUploads.id, [id])).catch(() => undefined);
      await discardFileData(id, pending.storedName);
    }
    throw new ApiError(404, "This upload session has expired. Please upload the file again.");
  }

  if (!canUserCompleteUpload(args.user, pending)) {
    throw new ApiError(403, "Only the member who started this upload can complete it.");
  }

  const store = getObjectStore();
  const key = fileObjectKey(pending.id, pending.storedName);

  let head;
  try {
    head = await store.head(key);
  } catch (err) {
    throw toApiError(err, "Object storage is temporarily unavailable. Please try again.");
  }
  if (!head) {
    await db.delete(pendingUploads).where(inArray(pendingUploads.id, [id])).catch(() => undefined);
    throw new ApiError(
      400,
      "No bytes were received for this upload. The direct upload to storage " +
        "may have failed — please try again.",
    );
  }
  if (head.size !== pending.size) {
    console.warn(
      `[storage] Upload ${id} size mismatch (stored ${head.size}, declared ${pending.size}) — discarding.`,
    );
    await discardFileData(id, pending.storedName);
    await db.delete(pendingUploads).where(inArray(pendingUploads.id, [id])).catch(() => undefined);
    throw new ApiError(
      400,
      "The uploaded bytes do not match the declared file size. Nothing was saved — please try again.",
    );
  }

  // Re-check quota at commit time: another upload may have landed first.
  const committed = await workspaceUsage();
  const reservedOthers = (await pendingReservationBytes()) - pending.size;
  const rejection = quotaRejectionMessage({
    usedBytes: committed.totalBytes,
    reservedBytes: Math.max(0, reservedOthers),
    quotaBytes: LIBRARY_QUOTA_BYTES,
    size: pending.size,
  });
  if (rejection) {
    await discardFileData(id, pending.storedName);
    await db.delete(pendingUploads).where(inArray(pendingUploads.id, [id])).catch(() => undefined);
    throw new ApiError(413, rejection);
  }

  const now = new Date();
  const record = {
    id: pending.id,
    name: pending.name,
    ext: pending.ext,
    mime: pending.mime,
    size: pending.size,
    path: pending.path,
    storedName: pending.storedName,
    uploaderId: pending.uploaderId,
    uploaderName: pending.uploaderName,
    uploadedAt: now,
    updatedAt: now,
    hasThumbnail: false,
    thumbExt: "jpg",
    thumbMime: "image/jpeg",
    optimized: pending.optimized,
    optimizePreset: pending.optimizePreset,
  };

  try {
    await db.insert(files).values(record);
  } catch (err) {
    // A retry racing the first completion must not roll back committed bytes:
    // if the row exists, this completion already succeeded.
    const existing = (
      await db.select().from(files).where(inArray(files.id, [id])).limit(1)
    )[0];
    if (existing) {
      await db.delete(pendingUploads).where(inArray(pendingUploads.id, [id])).catch(() => undefined);
      return { file: serializeFile(existing), alreadyCompleted: true };
    }
    console.error(`[storage] Insert failed for upload ${id}; rolling back stored object:`, err);
    await discardFileData(id, pending.storedName);
    await db.delete(pendingUploads).where(inArray(pendingUploads.id, [id])).catch(() => undefined);
    throw new ApiError(
      500,
      "The upload could not be recorded in the library database, so nothing was saved. Please try again.",
    );
  }

  await db.delete(pendingUploads).where(inArray(pendingUploads.id, [id])).catch((err) => {
    // Harmless: the row expires on its own and completion already succeeded.
    console.error(`[storage] Could not clear pending reservation ${id}:`, err);
  });

  return { file: serializeFile(record), alreadyCompleted: false };
}

/**
 * Writes uploaded bytes to `files/<id>/<storedName>` in R2 and verifies them.
 * Throws (and leaves nothing behind) if the bytes cannot be written
 * completely — callers may only insert the DB row after this resolves.
 */
export async function saveFileData(id: string, storedName: string, buffer: Buffer): Promise<void> {
  const key = fileObjectKey(id, sanitizeStoredName(storedName));
  try {
    await putObjectWithVerify(getObjectStore(), key, buffer, getMimeForName(storedName));
  } catch (err) {
    if (err instanceof R2Error && err.status === 503) throw toApiError(err, err.message);
    console.error(`[storage] Failed to write upload ${id}:`, err);
    if (err instanceof R2Error) {
      throw new ApiError(err.status, err.message);
    }
    throw new ApiError(500, "The file could not be written to server storage. Nothing was saved — please try again.");
  }
}

/** Best-effort removal of an upload's bytes (rollback path). Never throws. */
export async function discardFileData(id: string, storedName?: string | null): Promise<void> {
  if (!isSafeFileId(id)) return;
  if (!isR2Configured()) return;
  const store = getObjectStore();
  try {
    if (storedName) {
      await store.delete(fileObjectKey(id, sanitizeStoredName(storedName)));
      return;
    }
    // Fallback when the name is unknown: delete everything under the id's
    // prefix (the id is validated, so the prefix cannot escape its scope).
    const listed = await store.list(`files/${id}/`, 10);
    await store.deleteMany(listed.map((entry) => entry.key)).catch(() => undefined);
  } catch (err) {
    // Loud, because this is the one case that can leave orphaned bytes.
    console.error(`[storage] ORPHANED object(s) for ${id} — could not roll back:`, err);
  }
}

/* ------------------------------------------------------------------ deletes */

export type DeleteResult = {
  /** ids whose DB row is gone (bytes removed, or never existed). */
  deleted: string[];
  /** false when some bytes could not be removed and need sweeping later. */
  cleanupComplete: boolean;
};

/**
 * Deletes file rows together with their bytes. Rows go first: if the database
 * delete fails, nothing is deleted at all (bytes untouched); if an object
 * delete fails afterwards, the row is still gone — the bytes are invisible
 * because Postgres is the source of truth — and the orphan sweep reclaims
 * them later. Returns the ids that actually existed.
 */
export async function deleteFileRecords(ids: string[]): Promise<DeleteResult> {
  const safeIds = ids.filter(isSafeFileId);
  if (safeIds.length === 0) return { deleted: [], cleanupComplete: true };

  const rows = await db
    .select({ id: files.id, storedName: files.storedName, thumbExt: files.thumbExt })
    .from(files)
    .where(inArray(files.id, safeIds));

  const foundIds = rows.map((row) => row.id);
  if (foundIds.length === 0) return { deleted: [], cleanupComplete: true };

  try {
    await db.delete(files).where(inArray(files.id, foundIds));
  } catch (err) {
    console.error("[storage] Database delete failed — nothing was removed:", err);
    throw new ApiError(500, "The database could not delete this file, so nothing was removed. Please try again.");
  }

  let cleanupComplete = true;
  if (isR2Configured()) {
    const store = getObjectStore();
    for (const row of rows) {
      // Per-row guard: the rows are already gone, so one row's cleanup must
      // never abort the rest (or fail the request that already succeeded).
      try {
        const result = await deleteFileObjects(store, row.id, row.storedName, row.thumbExt);
        if (result.failed.length > 0) {
          cleanupComplete = false;
          console.error(`[storage] ${result.failed.length} object(s) for ${row.id} could not be removed; they will be swept later.`);
        }
      } catch (err) {
        cleanupComplete = false;
        console.error(`[storage] Could not clean up objects for ${row.id}; they will be swept later:`, err);
      }
    }
  } else {
    // No object store configured means there are no bytes to remove — but say
    // so loudly, because rows were just deleted.
    console.warn("[storage] R2 is not configured; deleted rows had no bytes to clean up.");
  }

  return { deleted: foundIds, cleanupComplete };
}

/* --------------------------------------------------------------- thumbnails */

export type StoredThumbnail = {
  buffer: Buffer;
  ext: string;
  mime: string;
  /** Set when the bytes were found under the wrong extension. */
  repairedExt?: string;
};

/**
 * Loads a thumbnail for `id`, verifying the served type against the actual
 * bytes. If the object is found under an extension that does not match its
 * content (e.g. PNG bytes in `thumbnails/<id>.jpg`), it is copied to the
 * correct key and `repairedExt` is reported so the caller can persist it.
 */
export async function readThumbnail(id: string, hintExt?: string | null): Promise<StoredThumbnail | null> {
  if (!isSafeFileId(id)) return null;
  const store = getObjectStore();

  for (const key of thumbnailCandidateKeys(id, hintExt)) {
    let found;
    try {
      found = await store.getBuffer(key);
    } catch (err) {
      throw toApiError(err, "The thumbnail could not be loaded. Please try again.");
    }
    if (!found) continue;

    const onDiskExt = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
    const sniffed = sniffImageType(found.data);
    const type: ImageType = sniffed ?? imageTypeFromExt(onDiskExt);

    if (type.ext !== onDiskExt) {
      const repaired = await repairThumbnailKey(store, key, id, type);
      return { buffer: found.data, ext: type.ext, mime: type.mime, repairedExt: repaired ? type.ext : undefined };
    }

    return { buffer: found.data, ext: type.ext, mime: type.mime };
  }

  return null;
}

/** Copies a thumbnail to its correct key and removes the wrong one. */
async function repairThumbnailKey(
  store: ObjectStore,
  currentKey: string,
  id: string,
  type: ImageType,
): Promise<boolean> {
  const target = thumbnailObjectKey(id, type.ext);
  try {
    await store.copy(currentKey, target, type.mime);
    await store.delete(currentKey).catch(() => undefined);
    console.warn(`[storage] Repaired thumbnail key for ${id}: ${currentKey} -> ${target}`);
    return true;
  } catch (err) {
    console.error(`[storage] Could not repair thumbnail key for ${id}:`, err);
    return false;
  }
}

/**
 * Writes a thumbnail under the extension of its real bytes, removing any
 * stale thumbnail stored under a different extension.
 */
export async function writeThumbnail(id: string, buffer: Buffer, type: ImageType): Promise<void> {
  const store = getObjectStore();
  const target = thumbnailObjectKey(id, type.ext);
  try {
    await putObjectWithVerify(store, target, buffer, type.mime);
  } catch (err) {
    console.error(`[storage] Failed to write thumbnail for ${id}:`, err);
    throw new ApiError(500, "The thumbnail could not be saved on the server. Please try again.");
  }

  // Drop any thumbnail left over from a previous, differently-typed upload.
  for (const candidate of thumbnailCandidateKeys(id, null)) {
    if (candidate !== target) await store.delete(candidate).catch(() => undefined);
  }
}

/** Removes every stored thumbnail variant for `id`. Best effort. */
export async function removeThumbnails(id: string): Promise<void> {
  if (!isSafeFileId(id)) return;
  if (!isR2Configured()) return;
  try {
    await deleteThumbnailObjects(getObjectStore(), id);
  } catch (err) {
    console.error(`[storage] Could not remove thumbnails for ${id}:`, err);
  }
}

/* -------------------------------------------------------------------- quota
   Quota is enforced against Postgres metadata: committed files plus
   unexpired presigned reservations. Both are visible to every serverless
   instance, so the cap holds however the app scales (concurrent multi-
   instance uploads can still race each other by a small margin — completion
   re-checks, which closes the hole in every case but a truly simultaneous
   commit).
*/

let pendingMultipartBytes = 0;
let reservationChain: Promise<void> = Promise.resolve();

async function withReservationSlot<T>(fn: () => Promise<T>): Promise<T> {
  const previous = reservationChain;
  let release!: () => void;
  reservationChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function workspaceUsage(): Promise<{ fileCount: number; totalBytes: number }> {
  const rows = await db.select({ id: files.id, size: files.size }).from(files);
  return {
    fileCount: rows.length,
    totalBytes: rows.reduce((sum, row) => sum + Number(row.size || 0), 0),
  };
}

/** Bytes promised to in-flight presigned uploads (unexpired reservations). */
export async function pendingReservationBytes(): Promise<number> {
  const rows = await db
    .select({ size: pendingUploads.size })
    .from(pendingUploads)
    .where(gt(pendingUploads.expiresAt, new Date()));
  return rows.reduce((sum, row) => sum + Number(row.size || 0), 0);
}

async function assertQuotaFits(size: number): Promise<void> {
  if (!LIBRARY_QUOTA_BYTES) return;
  const { totalBytes } = await workspaceUsage();
  const reserved = (await pendingReservationBytes()) + pendingMultipartBytes;
  const rejection = quotaRejectionMessage({
    usedBytes: totalBytes,
    reservedBytes: reserved,
    quotaBytes: LIBRARY_QUOTA_BYTES,
    size,
  });
  if (rejection) throw new ApiError(413, rejection);
}

/**
 * Reserves `size` bytes of the configured quota for the single-request
 * multipart flow, or throws ApiError(413). No-op when LIBRARY_QUOTA_BYTES is
 * not configured. Pair with releaseUploadBytes().
 */
export async function reserveUploadBytes(size: number): Promise<void> {
  if (!LIBRARY_QUOTA_BYTES) return;
  await withReservationSlot(async () => {
    await assertQuotaFits(size);
    pendingMultipartBytes += size;
  });
}

export function releaseUploadBytes(size: number): void {
  if (!LIBRARY_QUOTA_BYTES) return;
  pendingMultipartBytes = Math.max(0, pendingMultipartBytes - size);
}

/* ------------------------------------------------------------ hygiene sweeps
   Replaces the old STORAGE_DIR/trash sweep. There is no trash directory
   anymore (R2 has no atomic rename); instead this expires abandoned
   reservations and reclaims orphaned objects that can only exist when a
   process died between committing bytes and committing metadata.
*/

export async function expirePendingUploads(): Promise<number> {
  const now = new Date();
  let expired: Array<{ id: string; storedName: string }>;
  try {
    expired = await db
      .delete(pendingUploads)
      .where(lt(pendingUploads.expiresAt, now))
      .returning({ id: pendingUploads.id, storedName: pendingUploads.storedName });
  } catch (err) {
    console.error("[storage] Could not expire pending uploads:", err);
    return 0;
  }
  if (expired.length === 0) return 0;

  // A reservation whose completion succeeded but whose cleanup failed leaves
  // BOTH a pending row and a committed files row behind: its bytes belong to
  // the library and must never be discarded here.
  const committed = new Set<string>();
  for (let i = 0; i < expired.length; i += 500) {
    const chunk = expired.slice(i, i + 500).map((row) => row.id);
    try {
      const rows = await db.select({ id: files.id }).from(files).where(inArray(files.id, chunk));
      for (const row of rows) committed.add(row.id);
    } catch (err) {
      console.error("[storage] Could not check committed files while expiring uploads:", err);
      return expired.length;
    }
  }

  // The browser may have PUT bytes without ever completing: remove those.
  for (const row of expired) {
    if (committed.has(row.id)) {
      console.warn(`[storage] Cleared stale reservation for already-committed upload ${row.id}`);
      continue;
    }
    await discardFileData(row.id, row.storedName);
    console.warn(`[storage] Expired abandoned upload reservation ${row.id}`);
  }
  return expired.length;
}

export type OrphanSweepResult = { checked: number; deleted: string[]; failed: string[] };

/**
 * Deletes R2 objects older than `maxAgeMs` that are referenced by neither
 * the `files` table nor an active reservation. Best effort; capped so it
 * stays cheap on large libraries.
 */
export async function sweepOrphanedObjects(
  maxAgeMs = 24 * 60 * 60 * 1000,
  maxKeysPerPrefix = 5000,
): Promise<OrphanSweepResult> {
  const result: OrphanSweepResult = { checked: 0, deleted: [], failed: [] };
  if (!isR2Configured()) return result;
  const store = getObjectStore();
  const cutoff = Date.now() - maxAgeMs;

  let listed;
  try {
    const [modelObjects, thumbObjects] = await Promise.all([
      store.list("files/", maxKeysPerPrefix),
      store.list("thumbnails/", maxKeysPerPrefix),
    ]);
    listed = [...modelObjects, ...thumbObjects];
  } catch (err) {
    console.error("[storage] Orphan sweep listing failed:", err);
    return result;
  }

  const candidates = listed.filter(
    (entry) => entry.lastModified && entry.lastModified.getTime() <= cutoff,
  );
  result.checked = candidates.length;
  if (candidates.length === 0) return result;

  const ids = [...new Set(candidates.map((entry) => idFromKey(entry.key)).filter((id): id is string => !!id))];
  const known = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    try {
      const [fileRows, pendingRows] = await Promise.all([
        db.select({ id: files.id }).from(files).where(inArray(files.id, chunk)),
        db.select({ id: pendingUploads.id }).from(pendingUploads).where(inArray(pendingUploads.id, chunk)),
      ]);
      for (const row of [...fileRows, ...pendingRows]) known.add(row.id);
    } catch (err) {
      console.error("[storage] Orphan sweep lookup failed:", err);
      return result;
    }
  }

  const orphanKeys = candidates.filter((entry) => {
    const id = idFromKey(entry.key);
    return id && !known.has(id);
  }).map((entry) => entry.key);

  for (let i = 0; i < orphanKeys.length; i += 1000) {
    const chunk = orphanKeys.slice(i, i + 1000);
    try {
      const outcome = await store.deleteMany(chunk);
      result.deleted.push(...outcome.deleted);
      result.failed.push(...outcome.failed);
    } catch (err) {
      console.error("[storage] Orphan sweep delete failed:", err);
      result.failed.push(...chunk);
    }
  }

  if (result.deleted.length > 0) {
    console.warn(`[storage] Swept ${result.deleted.length} orphaned object(s).`);
  }
  return result;
}

function idFromKey(key: string): string | null {
  // files/<id>/<name> or thumbnails/<id>.<ext>
  const rest = key.startsWith("files/") ? key.slice("files/".length) : key.startsWith("thumbnails/") ? key.slice("thumbnails/".length) : null;
  if (!rest) return null;
  const id = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest.split(".")[0];
  return isSafeFileId(id) ? id : null;
}

/**
 * Fire-and-forget hygiene: always expires abandoned reservations (cheap),
 * and occasionally sweeps orphaned objects. Never throws, never awaited.
 */
export function scheduleStorageSweep(): void {
  void expirePendingUploads().catch(() => {
    /* already logged */
  });
  // Probabilistic so N serverless instances don't each sweep on every upload.
  if (Math.random() < 0.05) {
    void sweepOrphanedObjects().catch(() => {
      /* already logged */
    });
  }
}
