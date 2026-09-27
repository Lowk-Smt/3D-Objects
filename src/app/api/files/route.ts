import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@/db";
import { files } from "@/db/schema";
import { requireCsrf, requireSession } from "@/lib/auth";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { ensureStorageDirs, FILES_DIR, MAX_UPLOAD_BYTES } from "@/lib/config";
import { getExt, getMimeForName, sanitizeRelativePath, sanitizeStoredName } from "@/lib/files";
import { broadcast } from "@/lib/events";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireSession(req);
    const rows = await db.select().from(files).orderBy(desc(files.uploadedAt));

    const list = rows.map((row) => ({
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
    }));

    return NextResponse.json({ files: list });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireSession(req);
    requireCsrf(req, ctx);

    const contentLength = Number(req.headers.get("content-length") || 0);
    if (contentLength && contentLength > MAX_UPLOAD_BYTES) {
      throw new ApiError(413, `File is too large. Max upload size is ${(MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0)}MB.`);
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
      throw new ApiError(413, `File is too large. Max upload size is ${(MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0)}MB.`);
    }

    const originalName = String(form.get("name") || (blob as File).name || "file").trim() || "file";
    const relativePath = sanitizeRelativePath(String(form.get("path") || originalName));
    const optimized = String(form.get("optimized") || "") === "true";
    const optimizePreset = form.get("preset") ? String(form.get("preset")) : null;

    if (originalName.length > 255) {
      throw new ApiError(400, "File name is too long.");
    }

    ensureStorageDirs();

    const id = crypto.randomUUID();
    const storedName = sanitizeStoredName(originalName);
    const dir = path.join(FILES_DIR, id);
    await fs.mkdir(dir, { recursive: true });

    const buffer = Buffer.from(await blob.arrayBuffer());
    await fs.writeFile(path.join(dir, storedName), buffer);

    const ext = getExt(originalName);
    const mime = getMimeForName(originalName);
    const now = new Date();

    await db.insert(files).values({
      id,
      name: originalName,
      ext,
      mime,
      size: buffer.length,
      path: relativePath || originalName,
      storedName,
      uploaderId: ctx.user.id,
      uploaderName: ctx.user.username,
      uploadedAt: now,
      updatedAt: now,
      hasThumbnail: false,
      optimized,
      optimizePreset,
    });

    const meta = {
      id,
      name: originalName,
      ext,
      mime,
      size: buffer.length,
      path: relativePath || originalName,
      uploaderId: ctx.user.id,
      uploaderName: ctx.user.username,
      uploadedAt: now.getTime(),
      updatedAt: now.getTime(),
      hasThumbnail: false,
      optimized,
      optimizePreset,
    };

    broadcast("file-added", meta);

    return NextResponse.json({ file: meta }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
