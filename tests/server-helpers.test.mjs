import test from "node:test";
import assert from "node:assert/strict";

// Node runs these TypeScript modules directly (type stripping); the helpers
// under test have no runtime dependencies, so no build step is needed.
import {
  MIME_BY_EXT,
  canPresignPreviewMime,
  decodeImageDataUrl,
  getExt,
  getMimeForName,
  imageTypeFromExt,
  isSafeFileId,
  isValidUsername,
  sanitizeDisplayName,
  sanitizeRelativePath,
  sanitizeStoredName,
  sniffImageType,
} from "../src/lib/files.ts";

import { ServerTiming } from "../src/lib/timing.ts";

import { MIME_BY_EXT as CLIENT_MIME_BY_EXT } from "../public/vault/shared.js";

test("client and server agree on the MIME table", () => {
  assert.deepEqual(CLIENT_MIME_BY_EXT, MIME_BY_EXT);
  assert.equal(getMimeForName("a.GLB"), "model/gltf-binary");
  assert.equal(getMimeForName("a.bin"), "application/octet-stream");
  assert.equal(getExt("archive.tar.gz"), "gz");
});

test("sanitizeStoredName neutralizes traversal and control characters", () => {
  assert.equal(sanitizeStoredName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeStoredName("..\\..\\windows\\system32\\cmd.exe"), "cmd.exe");
  // only the final segment survives, so leading dots cannot create a hidden file
  assert.equal(sanitizeStoredName("....//evil.glb"), "evil.glb");
  assert.equal(sanitizeStoredName("....evil.glb"), "_evil.glb");
  assert.equal(sanitizeStoredName("bad\x00name\x1f.glb"), "bad_name_.glb");
  assert.equal(sanitizeStoredName(""), "file");
  assert.equal(sanitizeStoredName("/etc/shadow"), "shadow");
});

test("sanitizeRelativePath keeps folder structure but removes escapes", () => {
  assert.equal(sanitizeRelativePath("../../etc/passwd"), "etc/passwd");
  assert.equal(sanitizeRelativePath("scene/textures/albedo.png"), "scene/textures/albedo.png");
  assert.equal(sanitizeRelativePath("scene/../barrel.bin"), "barrel.bin");
  assert.equal(sanitizeRelativePath("scene//sub///a.bin"), "scene/sub/a.bin");
  assert.equal(sanitizeRelativePath(""), "");
});

test("sanitizeDisplayName never yields an empty or hidden name", () => {
  assert.equal(sanitizeDisplayName("Barrel.glb"), "Barrel.glb");
  assert.equal(sanitizeDisplayName("sub/dir/Barrel.glb"), "Barrel.glb");
  assert.equal(sanitizeDisplayName(""), "file");
  assert.equal(sanitizeDisplayName("."), "file");
});

test("isSafeFileId rejects anything that is not a plain id", () => {
  assert.ok(isSafeFileId("1a0c27e7-c029-4cc5-84f8-3b552ca49f88"));
  assert.ok(!isSafeFileId("../../etc/passwd"));
  assert.ok(!isSafeFileId("a/b"));
  assert.ok(!isSafeFileId("a\\b"));
  assert.ok(!isSafeFileId(".."));
  assert.ok(!isSafeFileId(""));
  assert.ok(!isSafeFileId(null));
  assert.ok(!isSafeFileId("x".repeat(200)));
});

test("isValidUsername matches the documented rules", () => {
  assert.ok(isValidUsername("owner"));
  assert.ok(isValidUsername("friend_1"));
  assert.ok(!isValidUsername("ab"));
  assert.ok(!isValidUsername("has space"));
  assert.ok(!isValidUsername("emoji😀"));
});

test("sniffImageType identifies real image bytes (and rejects non-images)", () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]);
  const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(16)]);
  const glb = Buffer.concat([Buffer.from("glTF"), Buffer.alloc(32)]);

  assert.equal(sniffImageType(jpeg)?.mime, "image/jpeg");
  assert.equal(sniffImageType(png)?.mime, "image/png");
  assert.equal(sniffImageType(webp)?.mime, "image/webp");
  assert.equal(sniffImageType(gif)?.mime, "image/gif");
  assert.equal(sniffImageType(glb), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
});

test("imageTypeFromExt only ever returns a supported extension", () => {
  assert.equal(imageTypeFromExt("jpg").ext, "jpg");
  assert.equal(imageTypeFromExt("PNG").ext, "png");
  assert.equal(imageTypeFromExt("exe").ext, "jpg"); // falls back to the default
  assert.equal(imageTypeFromExt(null).ext, "jpg");
});

test("decodeImageDataUrl validates the payload shape", () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(4)]);
  const ok = decodeImageDataUrl(`data:image/jpeg;base64,${jpeg.toString("base64")}`);
  assert.equal(ok?.declaredMime, "image/jpeg");
  assert.deepEqual(ok?.buffer, jpeg);

  assert.equal(decodeImageDataUrl("not a data url"), null);
  assert.equal(decodeImageDataUrl("data:image/jpeg;base64,"), null);
  assert.equal(decodeImageDataUrl("data:text/html;base64,PHNjcmlwdD4="), null);
});

test("ServerTiming measures sync and async executions and formats headers", async () => {
  const timing = new ServerTiming();

  const syncVal = timing.time("sync_step", () => 42, "Sync operation");
  assert.equal(syncVal, 42);

  const asyncVal = await timing.timeAsync("async_step", async () => "result", "Async operation");
  assert.equal(asyncVal, "result");

  timing.record("custom", 12.34, "Custom metric");

  const header = timing.headerValue();
  assert.ok(header.includes("sync_step;dur="));
  assert.ok(header.includes('desc="Sync operation"'));
  assert.ok(header.includes("async_step;dur="));
  assert.ok(header.includes("custom;dur=12.34"));

  const res = new Response(JSON.stringify({ ok: true }));
  timing.apply(res);
  assert.equal(res.headers.get("Server-Timing"), header);
});

test("ServerTiming records elapsed duration even when an operation throws", async () => {
  const timing = new ServerTiming();

  assert.throws(() => {
    timing.time("failing_sync", () => {
      throw new Error("fail");
    });
  }, /fail/);

  await assert.rejects(async () => {
    await timing.timeAsync("failing_async", async () => {
      throw new Error("async fail");
    });
  }, /async fail/);

  const header = timing.headerValue();
  assert.ok(header.includes("failing_sync;dur="));
  assert.ok(header.includes("failing_async;dur="));
});


test("canPresignPreviewMime gates active-content types out of presigned preview URLs", () => {
  // Every model/asset MIME the vault mints is safe to presign.
  for (const mime of Object.values(MIME_BY_EXT)) {
    if (mime === "image/svg+xml") continue;
    assert.equal(canPresignPreviewMime(mime), true, `${mime} should be presignable`);
  }
  assert.equal(canPresignPreviewMime("application/octet-stream"), true);

  // Active content must keep flowing through the authenticated route (which
  // adds CSP sandbox + nosniff), never via a direct bucket URL.
  for (const mime of [
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "text/xml",
    "application/xml",
    "application/xslt+xml",
  ]) {
    assert.equal(canPresignPreviewMime(mime), false, `${mime} must be proxied`);
  }

  // Parameters and case are normalized; empty/unknown-falsy mime is proxied.
  assert.equal(canPresignPreviewMime("text/html; charset=utf-8"), false);
  assert.equal(canPresignPreviewMime("IMAGE/SVG+XML"), false);
  assert.equal(canPresignPreviewMime(""), false);
  assert.equal(canPresignPreviewMime(null), false);
  assert.equal(canPresignPreviewMime(undefined), false);
});
