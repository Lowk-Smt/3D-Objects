import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-helpers";
import { isSafeFileId, sanitizeStoredName } from "@/lib/files";
import { R2Error, fileObjectKey, getObjectStore } from "@/lib/r2";
import { ServerTiming } from "@/lib/timing";

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
  serverTiming?: ServerTiming;
}): Promise<NextResponse> {
  const timing = opts.serverTiming || new ServerTiming();

  if (!isSafeFileId(opts.id)) throw new ApiError(400, "Invalid file id.");

  // storedName is sanitized on write and again here. The key builder rejects
  // anything that is not a single safe segment, so this can only ever address
  // files/<server-generated id>/<sanitized name> in the private bucket.
  const key = fileObjectKey(opts.id, sanitizeStoredName(opts.storedName));

  let object;
  try {
    object = await timing.timeAsync(
      "storage_get",
      () => getObjectStore().getStream(key),
      "Object storage getStream",
    );
  } catch (err) {
    if (err instanceof R2Error && err.status === 503) {
      throw new ApiError(503, err.message);
    }
    console.error(`[serve-file] Failed to load ${key}:`, err);
    throw new ApiError(502, "Object storage is temporarily unavailable. Please try again in a moment.");
  }

  if (!object) {
    throw new ApiError(404, "This file's data is missing from storage on the server.");
  }

  const headers = new Headers({
    "Content-Type": opts.mime || "application/octet-stream",
    "Content-Length": String(object.size),
    "Content-Disposition": contentDispositionValue(opts.disposition, opts.displayName),
    // Uploaded files are user-supplied content: never let a browser sniff it
    // into something executable, and neutralize any active content (e.g. an
    // SVG with a script) if one is opened directly.
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, max-age=0, no-cache",
  });

  const timingHeader = timing.headerValue();
  if (timingHeader) {
    headers.set("Server-Timing", timingHeader);
  }

  return new NextResponse(object.stream, { headers });
}
