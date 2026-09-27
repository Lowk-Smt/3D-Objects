import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { files } from "@/db/schema";
import { requireCsrf, requireSession } from "@/lib/auth";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { MAX_UPLOAD_BYTES } from "@/lib/config";
import {
  getExt,
  getMimeForName,
  sanitizeDisplayName,
  sanitizeRelativePath,
  serializeFile,
} from "@/lib/files";
import { broadcast } from "@/lib/events";
import {
  discardFileData,
  releaseUploadBytes,
  reserveUploadBytes,
  saveFileData,
  scheduleStorageSweep,
} from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OPTIMIZE_PRESETS = new Set(["high", "balanced", "small"]);

export async function GET(req: NextRequest) {
  try {
    await requireSession(req);
    const rows = await db.select().from(files).orderBy(desc(files.uploadedAt));
    return NextResponse.json({ files: rows.map(serializeFile) });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  let reservedBytes = 0;

  try {
    const ctx = await requireSession(req);
    requireCsrf(req, ctx);
    scheduleStorageSweep();

    const declaredLength = Number(req.headers.get("content-length") || 0);
    if (declaredLength && declaredLength > MAX_UPLOAD_BYTES) {
      throw new ApiError(413, `File is too large. Max upload size is ${mb(MAX_UPLOAD_BYTES)}.`);
    }

    const form = await req.formData();
    const blob = form.get("file");

    if (!(blob instanceof Blob)) {
      throw new ApiError(400, "No file was provided.");
    }
    if (blob.size === 0) {
      throw new ApiError(400, "The uploaded file is empty.");
    }
    if (blob.size > MAX_UPLOAD_BYTES) {
      throw new ApiError(413, `File is too large. Max upload size is ${mb(MAX_UPLOAD_BYTES)}.`);
    }

    // The display name and the relative path are only ever hints from the
    // browser: both are sanitized here, and neither is trusted for anything
    // that determines where bytes land in object storage (that is the server-side UUID).
    const rawName = String(form.get("name") || (blob as File).name || "file");
    if (rawName.length > 512) throw new ApiError(400, "File name is too long.");
    const originalName = sanitizeDisplayName(rawName);

    const relativePath = sanitizeRelativePath(String(form.get("path") || originalName)) || originalName;
    if (relativePath.length > 1024) throw new ApiError(400, "File path is too long.");

    // "optimized"/"preset" are cosmetic metadata supplied by the client; keep
    // them within a known shape instead of storing arbitrary strings.
    const optimized = String(form.get("optimized") || "") === "true";
    const presetRaw = form.get("preset") ? String(form.get("preset")) : "";
    const optimizePreset = optimized && OPTIMIZE_PRESETS.has(presetRaw) ? presetRaw : null;

    await reserveUploadBytes(blob.size);
    reservedBytes = blob.size;

    const id = crypto.randomUUID();
    const buffer = Buffer.from(await blob.arrayBuffer());
    const storedName = originalName;

    // Bytes first, metadata second — and the bytes are rolled back if the
    // insert fails. This is the only way to guarantee we never end up with a
    // row pointing at a file that was never written.
    try {
      await saveFileData(id, storedName, buffer);
    } catch (err) {
      reservedBytes = 0;
      releaseUploadBytes(blob.size);
      throw err;
    }

    const now = new Date();
    const record = {
      id,
      name: originalName,
      ext: getExt(originalName),
      mime: getMimeForName(originalName),
      size: buffer.length,
      path: relativePath,
      storedName,
      uploaderId: ctx.user.id,
      uploaderName: ctx.user.username,
      uploadedAt: now,
      updatedAt: now,
      hasThumbnail: false,
      thumbExt: "jpg",
      thumbMime: "image/jpeg",
      optimized,
      optimizePreset,
    };

    try {
      await db.insert(files).values(record);
    } catch (err) {
      console.error(`[files] Insert failed for upload ${id}; rolling back stored bytes:`, err);
      await discardFileData(id, storedName);
      reservedBytes = 0;
      releaseUploadBytes(blob.size);
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        500,
        "The upload could not be recorded in the library database, so nothing was saved. Please try again.",
      );
    }

    releaseUploadBytes(blob.size);
    reservedBytes = 0;

    const meta = serializeFile(record);
    broadcast("file-added", meta);

    return NextResponse.json({ file: meta }, { status: 201 });
  } catch (err) {
    if (reservedBytes) releaseUploadBytes(reservedBytes);
    return handleApiError(err);
  }
}

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}
