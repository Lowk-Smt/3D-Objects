import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-helpers";
import { isSafeFileId, sanitizeStoredName } from "@/lib/files";
import { fileDir, fileDiskPath } from "@/lib/storage";

/** Encode a filename for use in Content-Disposition, RFC 5987 safe. */
function contentDispositionValue(disposition: "inline" | "attachment", filename: string): string {
  // Never let a CR/LF or quote escape into the header.
  const cleaned = String(filename || "download").replace(/[\r\n]/g, " ").trim() || "download";
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "'");
  const encoded = encodeURIComponent(cleaned);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function streamFileResponse(opts: {
  id: string;
  storedName: string;
  mime: string;
  displayName: string;
  disposition: "inline" | "attachment";
}): Promise<NextResponse> {
  if (!isSafeFileId(opts.id)) throw new ApiError(400, "Invalid file id.");

  // storedName is sanitized on write and again here, and always resolved
  // beneath STORAGE_DIR/files/<server-generated id>/.
  const dir = fileDir(opts.id);
  const diskPath = fileDiskPath(opts.id, sanitizeStoredName(opts.storedName));
  if (diskPath !== path.join(dir, path.basename(diskPath))) {
    throw new ApiError(400, "Invalid file path.");
  }

  let stat;
  try {
    stat = await fs.promises.stat(diskPath);
  } catch {
    throw new ApiError(404, "This file's data is missing from storage on the server.");
  }

  if (!stat.isFile()) {
    throw new ApiError(404, "This file's data is missing from storage on the server.");
  }

  const nodeStream = fs.createReadStream(diskPath);
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  return new NextResponse(webStream, {
    headers: {
      "Content-Type": opts.mime || "application/octet-stream",
      "Content-Length": String(stat.size),
      "Content-Disposition": contentDispositionValue(opts.disposition, opts.displayName),
      // Uploaded files are user-supplied content: never let a browser sniff it
      // into something executable, and neutralize any active content (e.g. an
      // SVG with a script) if one is opened directly.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, max-age=0, no-cache",
    },
  });
}
