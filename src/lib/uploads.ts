/**
 * Pure upload validation + quota math for both upload flows:
 *
 *  - the browser's presigned flow (POST /api/files/presign → PUT to R2 →
 *    POST /api/files/complete), used for every UI upload so multi-hundred-MB
 *    models never need to fit through a serverless request body;
 *  - the legacy single-request multipart flow (POST /api/files), kept for
 *    small files, scripts and the end-to-end test.
 *
 * This module is dependency-free (no `@/...` imports) so the unit tests can
 * exercise the real validation without a database or network. Sanitizing
 * itself stays in src/lib/files.ts (single source of truth, already tested);
 * the tests compose sanitizers → validators over hostile inputs to prove the
 * pipeline end to end.
 *
 * Callers translate UploadValidationError into ApiError (same status/message).
 */

export class UploadValidationError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "UploadValidationError";
    this.status = status;
  }
}

export const OPTIMIZE_PRESETS = ["high", "balanced", "small"] as const;
export type OptimizePreset = (typeof OPTIMIZE_PRESETS)[number];

export const MAX_NAME_INPUT_LENGTH = 512;
export const MAX_PATH_INPUT_LENGTH = 1024;

/* ------------------------------------------------------- presign validation */

export type PresignInput = {
  /** Raw client-supplied display name (unsanitized). */
  name: string;
  /** Raw client-supplied logical path (unsanitized). */
  path: string;
  /** Declared file size in bytes. Must be > 0. */
  size: number;
  /** Raw client "optimized" flag (any JSON value). */
  optimized: unknown;
  /** Raw client preset (any JSON value). */
  preset: unknown;
  /** Server-side per-file limit, from MAX_UPLOAD_MB. */
  maxUploadBytes: number;
};

export type ValidatedPresignInput = {
  /** Sanitized inputs, validated lengths (still need display/path sanitize). */
  name: string;
  path: string;
  size: number;
  optimized: boolean;
  optimizePreset: string | null;
};

/**
 * Validates a presign request's shape. Sanitizing (basename extraction,
 * traversal removal) happens in the caller via src/lib/files.ts; this step
 * enforces lengths, size bounds and the preset whitelist so no caller can
 * forget them.
 */
export function validatePresignInput(input: PresignInput): ValidatedPresignInput {
  const size = input.size;
  if (!Number.isFinite(size) || !Number.isInteger(size) || size <= 0) {
    throw new UploadValidationError(400, "A valid file size is required.");
  }
  if (size > input.maxUploadBytes) {
    throw new UploadValidationError(
      413,
      `File is too large. Max upload size is ${mb(input.maxUploadBytes)}.`,
    );
  }

  const name = String(input.name ?? "");
  if (name.length === 0) throw new UploadValidationError(400, "A file name is required.");
  if (name.length > MAX_NAME_INPUT_LENGTH) {
    throw new UploadValidationError(400, "File name is too long.");
  }

  const path = String(input.path ?? "");
  if (path.length > MAX_PATH_INPUT_LENGTH) {
    throw new UploadValidationError(400, "File path is too long.");
  }

  const optimized = input.optimized === true || String(input.optimized || "") === "true";
  const presetRaw = input.preset === null || input.preset === undefined ? "" : String(input.preset);
  const optimizePreset =
    optimized && (OPTIMIZE_PRESETS as readonly string[]).includes(presetRaw) ? presetRaw : null;

  return { name, path, size, optimized, optimizePreset };
}

/* -------------------------------------------------------------------- quota */

/**
 * Decides whether `size` more bytes fit under `quotaBytes`.
 *
 * `usedBytes` is the committed library (sum of files.size in Postgres),
 * `reservedBytes` covers bytes promised to in-flight uploads (unexpired
 * pending_uploads rows, plus the in-process reservation for the multipart
 * flow). Pure so the boundary conditions are unit-testable; storage.ts
 * supplies the numbers from Postgres.
 *
 * Returns null when the upload fits, otherwise the user-facing 413 message.
 */
export function quotaRejectionMessage(args: {
  usedBytes: number;
  reservedBytes: number;
  quotaBytes: number | null;
  size: number;
}): string | null {
  const { usedBytes, reservedBytes, quotaBytes, size } = args;
  if (quotaBytes === null || quotaBytes === undefined) return null;
  const used = usedBytes + reservedBytes;
  if (used + size > quotaBytes) {
    return (
      `Storage limit reached: the workspace allows ${formatBytes(quotaBytes)} and ` +
      `${formatBytes(used)} is already used, so this ${formatBytes(size)} upload was rejected. ` +
      `Delete some files or ask the owner to raise LIBRARY_QUOTA_BYTES.`
    );
  }
  return null;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}
