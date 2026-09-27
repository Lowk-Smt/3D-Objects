import fs from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { NextResponse } from "next/server";
import { FILES_DIR } from "@/lib/config";
import { ApiError } from "@/lib/api-helpers";

export function fileDiskPath(id: string, storedName: string): string {
  return path.join(FILES_DIR, id, storedName);
}

/** Encode a filename for use in Content-Disposition, RFC 5987 safe. */
function contentDispositionValue(disposition: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  const encoded = encodeURIComponent(filename);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function streamFileResponse(opts: {
  id: string;
  storedName: string;
  mime: string;
  displayName: string;
  disposition: "inline" | "attachment";
}): Promise<NextResponse> {
  const diskPath = fileDiskPath(opts.id, opts.storedName);

  let stat;
  try {
    stat = await fs.promises.stat(diskPath);
  } catch {
    throw new ApiError(404, "This file's data is missing from storage on the server.");
  }

  const nodeStream = fs.createReadStream(diskPath);
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  return new NextResponse(webStream, {
    headers: {
      "Content-Type": opts.mime || "application/octet-stream",
      "Content-Length": String(stat.size),
      "Content-Disposition": contentDispositionValue(opts.disposition, opts.displayName),
      "Cache-Control": "private, max-age=0, no-cache",
    },
  });
}
