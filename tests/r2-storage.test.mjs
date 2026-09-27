import test from "node:test";
import assert from "node:assert/strict";

// The modules under test have no runtime `@/...` or database imports, so Node
// runs them directly (type stripping) with no build step and no network —
// object sequences run against MemoryObjectStore, the in-memory fake of the
// same ObjectStore interface the real R2Store implements.
import {
  MemoryObjectStore,
  R2Error,
  deleteFileObjects,
  deleteThumbnailObjects,
  fileObjectKey,
  fileObjectKeysForDelete,
  isR2Configured,
  normalizeThumbnailExt,
  presignedDisposition,
  putObjectWithVerify,
  r2ConfigFromEnv,
  regionFromEndpoint,
  requireR2Config,
  thumbnailCandidateKeys,
  thumbnailObjectKey,
  toR2Error,
} from "../src/lib/r2.ts";

import {
  UploadValidationError,
  formatBytes,
  quotaRejectionMessage,
  validatePresignInput,
} from "../src/lib/uploads.ts";

import {
  canUserCompleteUpload,
  canUserDeleteFiles,
  canUserManageThumbnail,
  isOwner,
} from "../src/lib/permissions.ts";

import {
  imageTypeFromExt,
  sanitizeDisplayName,
  sanitizeRelativePath,
  sanitizeStoredName,
  sniffImageType,
} from "../src/lib/files.ts";

import { findReferencedFile } from "../public/vault/shared.js";

const MB = 1024 * 1024;
const ID = "1a0c27e7-c029-4cc5-84f8-3b552ca49f88";
const KEY_PATTERN = /^files\/[A-Za-z0-9_-]{1,64}\/[^/]+$/;

function withR2Env(vars, fn) {
  // R2_ACCOUNT_ID is cleared too (but never used): a leftover value from an
  // older deployment must be ignored — configuration never depends on it.
  const names = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_ENDPOINT"];
  const saved = {};
  for (const name of names) saved[name] = process.env[name];
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, vars);
    return fn();
  } finally {
    for (const name of names) delete process.env[name];
    for (const [name, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[name] = value;
    }
  }
}

/* ------------------------------------------------- object key generation */

test("file keys use files/<generated-id>/<sanitized-name>", () => {
  assert.equal(fileObjectKey(ID, "Barrel.glb"), `files/${ID}/Barrel.glb`);
});

test("thumbnail keys use thumbnails/<generated-id>.<ext>", () => {
  assert.equal(thumbnailObjectKey(ID, "jpg"), `thumbnails/${ID}.jpg`);
  assert.equal(thumbnailObjectKey(ID, "png"), `thumbnails/${ID}.png`);
  assert.equal(normalizeThumbnailExt("PNG"), "png");
  assert.equal(normalizeThumbnailExt("exe"), "jpg"); // unknown -> default, never arbitrary
  assert.equal(normalizeThumbnailExt(null), "jpg");
});

test("key builders reject unsafe ids", () => {
  for (const bad of ["", "..", "a/b", "a\\b", "../x", "x".repeat(65), null, undefined, 42]) {
    assert.throws(() => fileObjectKey(bad, "a.glb"), R2Error, `id ${JSON.stringify(bad)}`);
    assert.throws(() => thumbnailObjectKey(bad, "jpg"), R2Error, `id ${JSON.stringify(bad)}`);
  }
});

test("key builders reject names that were not sanitized", () => {
  for (const bad of [
    "",
    "a/b.glb", // would add a key segment
    "a\\b.glb",
    ".hidden.glb", // never a hidden file
    ".",
    "..",
    " leading-space.glb",
    "trailing-space.glb ",
    "control\x00char.glb",
    "x".repeat(181),
  ]) {
    assert.throws(() => fileObjectKey(ID, bad), R2Error, `name ${JSON.stringify(bad)}`);
  }
});

test("client filenames can never become keys verbatim: sanitize -> key always holds", () => {
  const hostile = [
    "../../etc/passwd",
    "..\\..\\windows\\system32\\cmd.exe",
    "/abs/path/model.glb",
    "....//evil.glb",
    "....evil.glb",
    "bad\x00name\x1f.glb",
    "",
    ".",
    "..",
    "a".repeat(400) + ".glb",
    "sub/dir/texture.png",
    "  padded  ",
  ];
  for (const raw of hostile) {
    const sanitized = sanitizeStoredName(raw);
    const key = fileObjectKey(ID, sanitized); // must not throw
    assert.match(key, KEY_PATTERN, raw);
    assert.ok(!key.includes(".."), `key escapes scope: ${key}`);
    assert.ok(!key.split("/").slice(2).join("/").includes("/"), `multi-segment key: ${key}`);
    if (raw !== sanitized) assert.ok(!key.endsWith(`/${raw}`), `raw input survived: ${raw}`);
  }
});

test("thumbnail candidate keys lead with the hint, then cover every variant", () => {
  assert.deepEqual(thumbnailCandidateKeys(ID, "png"), [
    `thumbnails/${ID}.png`,
    `thumbnails/${ID}.jpg`,
    `thumbnails/${ID}.webp`,
    `thumbnails/${ID}.gif`,
  ]);
  // Unknown hints fall back to the default without duplicating it.
  assert.deepEqual(thumbnailCandidateKeys(ID, "exe"), [
    `thumbnails/${ID}.jpg`,
    `thumbnails/${ID}.png`,
    `thumbnails/${ID}.webp`,
    `thumbnails/${ID}.gif`,
  ]);
});

test("fileObjectKeysForDelete covers the model bytes plus every thumbnail variant", () => {
  assert.deepEqual(fileObjectKeysForDelete(ID, "Barrel.glb", "png"), [
    `files/${ID}/Barrel.glb`,
    `thumbnails/${ID}.png`,
    `thumbnails/${ID}.jpg`,
    `thumbnails/${ID}.webp`,
    `thumbnails/${ID}.gif`,
  ]);
});

/* ----------------------------------------------- upload input validation */

test("validatePresignInput accepts a well-formed request", () => {
  const out = validatePresignInput({
    name: "Barrel.glb",
    path: "models/Barrel.glb",
    size: 4096,
    optimized: false,
    preset: null,
    maxUploadBytes: 300 * MB,
  });
  assert.deepEqual(out, {
    name: "Barrel.glb",
    path: "models/Barrel.glb",
    size: 4096,
    optimized: false,
    optimizePreset: null,
  });
});

test("validatePresignInput rejects missing/invalid sizes with 400", () => {
  for (const size of [0, -1, 3.5, NaN, Infinity, "4096", null, undefined]) {
    assert.throws(
      () => validatePresignInput({ name: "a.glb", path: "a.glb", size, optimized: false, preset: null, maxUploadBytes: 300 * MB }),
      (err) => err instanceof UploadValidationError && err.status === 400,
      `size ${JSON.stringify(size)}`,
    );
  }
});

test("validatePresignInput rejects oversize uploads with 413", () => {
  assert.throws(
    () => validatePresignInput({ name: "big.glb", path: "big.glb", size: 301 * MB, optimized: false, preset: null, maxUploadBytes: 300 * MB }),
    (err) => err instanceof UploadValidationError && err.status === 413 && /too large/i.test(err.message),
  );
  // Exactly at the limit fits.
  const out = validatePresignInput({ name: "edge.glb", path: "edge.glb", size: 300 * MB, optimized: false, preset: null, maxUploadBytes: 300 * MB });
  assert.equal(out.size, 300 * MB);
});

test("validatePresignInput rejects bad names and paths", () => {
  assert.throws(
    () => validatePresignInput({ name: "", path: "a.glb", size: 8, optimized: false, preset: null, maxUploadBytes: MB }),
    (err) => err instanceof UploadValidationError && err.status === 400,
  );
  assert.throws(
    () => validatePresignInput({ name: "x".repeat(513), path: "a.glb", size: 8, optimized: false, preset: null, maxUploadBytes: MB }),
    /too long/,
  );
  assert.throws(
    () => validatePresignInput({ name: "a.glb", path: "x".repeat(1025), size: 8, optimized: false, preset: null, maxUploadBytes: MB }),
    /too long/,
  );
});

test("validatePresignInput coerces the optimized flag and whitelists presets", () => {
  const base = { name: "a.glb", path: "a.glb", size: 8, maxUploadBytes: MB };
  assert.equal(validatePresignInput({ ...base, optimized: true, preset: "high" }).optimizePreset, "high");
  assert.equal(validatePresignInput({ ...base, optimized: "true", preset: "small" }).optimizePreset, "small");
  // A preset without the flag, or outside the whitelist, is dropped — never stored raw.
  assert.equal(validatePresignInput({ ...base, optimized: false, preset: "high" }).optimizePreset, null);
  assert.equal(validatePresignInput({ ...base, optimized: true, preset: "evil'; DROP" }).optimizePreset, null);
  assert.equal(validatePresignInput({ ...base, optimized: "yes", preset: "high" }).optimized, false);
});

test("hostile names/paths sanitize cleanly before validation accepts them", () => {
  const name = sanitizeDisplayName("../../escape.glb");
  const path = sanitizeRelativePath("../../escape.glb") || name;
  assert.equal(name, "escape.glb");
  assert.ok(!path.includes(".."));
  const out = validatePresignInput({ name, path, size: 512, optimized: false, preset: null, maxUploadBytes: MB });
  assert.equal(out.name, "escape.glb");
});

/* ------------------------------------------------ authorization matrix */

test("delete permission: owner always, member only with canDelete", () => {
  assert.ok(canUserDeleteFiles({ id: "u1", role: "owner", canDelete: false }));
  assert.ok(canUserDeleteFiles({ id: "u2", role: "member", canDelete: true }));
  assert.ok(!canUserDeleteFiles({ id: "u3", role: "member", canDelete: false }));
  assert.ok(isOwner({ id: "u1", role: "owner", canDelete: false }));
  assert.ok(!isOwner({ id: "u2", role: "member", canDelete: true }));
});

test("thumbnail writes: uploader or owner only", () => {
  const owner = { id: "owner", role: "owner", canDelete: true };
  const uploader = { id: "uploader", role: "member", canDelete: true };
  const other = { id: "other", role: "member", canDelete: true };
  assert.ok(canUserManageThumbnail(owner, { uploaderId: "uploader" }));
  assert.ok(canUserManageThumbnail(uploader, { uploaderId: "uploader" }));
  assert.ok(!canUserManageThumbnail(other, { uploaderId: "uploader" }));
  // Orphaned files (uploader removed) can only be re-thumbnailed by the owner.
  assert.ok(!canUserManageThumbnail(other, { uploaderId: null }));
  assert.ok(canUserManageThumbnail(owner, { uploaderId: null }));
});

test("presigned-upload completion: starter or owner only", () => {
  const owner = { id: "owner", role: "owner", canDelete: true };
  const starter = { id: "starter", role: "member", canDelete: false };
  const other = { id: "other", role: "member", canDelete: true };
  assert.ok(canUserCompleteUpload(owner, { uploaderId: "starter" }));
  assert.ok(canUserCompleteUpload(starter, { uploaderId: "starter" }));
  assert.ok(!canUserCompleteUpload(other, { uploaderId: "starter" }));
  assert.ok(!canUserCompleteUpload(other, { uploaderId: null }));
});

// Reads (list/preview/download/thumbnail GET) authorize by session alone — any
// authenticated workspace member may read anything. That is enforced in the
// routes via requireSession() and covered by the end-to-end suite (which
// asserts both members can fetch both models' bytes, and anonymous requests
// get 401); there is deliberately no ownership helper for reads to unit-test.

/* --------------------------------------------------- thumbnail storage */

test("thumbnail bytes decide their own key: sniffed type wins over claims", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  const type = sniffImageType(png) ?? imageTypeFromExt("jpg");
  assert.equal(type.ext, "png");
  assert.equal(thumbnailObjectKey(ID, type.ext), `thumbnails/${ID}.png`);
});

test("a mislabeled thumbnail object can be repaired with copy + delete", async () => {
  const store = new MemoryObjectStore();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  await store.put(`thumbnails/${ID}.jpg`, png, "image/jpeg");

  // Same sequence storage.ts uses for repairs: copy to the correct key, drop the wrong one.
  await store.copy(`thumbnails/${ID}.jpg`, `thumbnails/${ID}.png`, "image/png");
  await store.delete(`thumbnails/${ID}.jpg`);

  assert.equal(await store.head(`thumbnails/${ID}.jpg`), null);
  const repaired = await store.getBuffer(`thumbnails/${ID}.png`);
  assert.ok(repaired);
  assert.deepEqual(repaired.data, png);
  assert.equal(repaired.contentType, "image/png");
});

test("deleteThumbnailObjects removes every variant for an id", async () => {
  const store = new MemoryObjectStore();
  await store.put(`thumbnails/${ID}.jpg`, Buffer.from([1]), "image/jpeg");
  await store.put(`thumbnails/${ID}.png`, Buffer.from([2]), "image/png");
  await store.put(`thumbnails/other-id.jpg`, Buffer.from([3]), "image/jpeg");

  const result = await deleteThumbnailObjects(store, ID);
  assert.equal(result.failed.length, 0);
  assert.equal((await store.list("thumbnails/", 100)).length, 1);
});

/* ------------------------------------------------------ R2 error handling */

test("R2Error passes through toR2Error, anything else becomes a safe 502", () => {
  const original = new R2Error(503, "Object storage is not configured.");
  assert.equal(toR2Error(original, "upload"), original);

  const mapped = toR2Error(new Error("boom"), "download");
  assert.ok(mapped instanceof R2Error);
  assert.equal(mapped.status, 502);
  assert.match(mapped.message, /temporarily unavailable/);
});

test("error messages never carry credentials", () => {
  const secret = "SUPER-SECRET-ACCESS-KEY-12345";
  const mapped = toR2Error(new Error(`connect failed with ${secret} inline`), "upload");
  assert.ok(!mapped.message.includes(secret), mapped.message);
});

test("missing R2 configuration fails fast with 503, never at import time", () => {
  withR2Env({}, () => {
    assert.equal(isR2Configured(), false);
    assert.equal(r2ConfigFromEnv(), null);
    assert.throws(
      () => requireR2Config(),
      (err) => {
        assert.ok(err instanceof R2Error && err.status === 503);
        // The message names exactly the four required variables…
        assert.match(err.message, /R2_ACCESS_KEY_ID/);
        assert.match(err.message, /R2_SECRET_ACCESS_KEY/);
        assert.match(err.message, /R2_BUCKET_NAME/);
        assert.match(err.message, /R2_ENDPOINT/);
        // …and never asks for an account id.
        assert.ok(!/R2_ACCOUNT_ID/.test(err.message), `account id must not be required: ${err.message}`);
        return true;
      },
    );
  });
});

test("R2 configuration needs only key, secret, bucket and endpoint — no account id", () => {
  withR2Env(
    {
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
      R2_BUCKET_NAME: "vault",
      R2_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
    },
    () => {
      assert.equal(isR2Configured(), true);
      const config = r2ConfigFromEnv();
      assert.equal(config.accessKeyId, "key");
      assert.equal(config.secretAccessKey, "secret");
      assert.equal(config.bucket, "vault");
      // R2_ENDPOINT is used verbatim as the actual S3-compatible endpoint.
      assert.equal(config.endpoint, "https://s3.us-west-004.backblazeb2.com");
      assert.ok(!("accountId" in config), "config must not carry an account id");
      // requireR2Config succeeds with exactly these four values.
      assert.equal(requireR2Config().endpoint, "https://s3.us-west-004.backblazeb2.com");
    },
  );
});

test("every one of the four storage variables is required on its own", () => {
  const all = {
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET_NAME: "vault",
    R2_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
  };
  for (const omitted of Object.keys(all)) {
    const vars = { ...all };
    delete vars[omitted];
    withR2Env(vars, () => {
      assert.equal(r2ConfigFromEnv(), null, `${omitted} must be required`);
      assert.equal(isR2Configured(), false, `${omitted} must be required`);
    });
  }
});

test("no endpoint is ever derived from an account id", () => {
  // A legacy R2_ACCOUNT_ID in the environment cannot stand in for R2_ENDPOINT.
  withR2Env(
    { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET_NAME: "vault" },
    () => {
      assert.equal(r2ConfigFromEnv(), null);
      assert.equal(isR2Configured(), false);
    },
  );
  // And with the four required values present, an account id is ignored entirely.
  withR2Env(
    {
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
      R2_BUCKET_NAME: "vault",
      R2_ENDPOINT: "http://127.0.0.1:9000",
    },
    () => {
      const config = r2ConfigFromEnv();
      assert.equal(config.endpoint, "http://127.0.0.1:9000");
      assert.ok(!("accountId" in config));
    },
  );
});

test("signing region: concrete for Backblaze B2 endpoints, neutral otherwise", () => {
  // Backblaze B2 signs with the region embedded in its S3 endpoint host.
  assert.equal(regionFromEndpoint("https://s3.us-west-004.backblazeb2.com"), "us-west-004");
  assert.equal(regionFromEndpoint("https://s3.us-east-005.backblazeb2.com/"), "us-east-005");
  // Custom endpoints: the bucket hostname variant also parses.
  assert.equal(regionFromEndpoint("https://mybucket.s3.us-west-004.backblazeb2.com"), "us-west-004");
  // Every other S3-compatible provider keeps the provider-neutral "auto".
  assert.equal(regionFromEndpoint("https://abc123.r2.cloudflarestorage.com"), "auto");
  assert.equal(regionFromEndpoint("http://127.0.0.1:9000"), "auto");
  assert.equal(regionFromEndpoint("not a url"), "auto");
});

test("presigned URLs embed the key and carry no credentials", async () => {
  const store = new MemoryObjectStore();
  const url = await store.presignPut(`files/${ID}/Barrel.glb`, "model/gltf-binary", 300);
  assert.ok(url.includes(encodeURIComponent(`files/${ID}/Barrel.glb`)), url);
  assert.ok(!/secret|accesskey|password/i.test(url), url);
});

test("presignedDisposition encodes filenames safely for downloads", () => {
  assert.equal(
    presignedDisposition("attachment", "Barrel.glb"),
    `attachment; filename="Barrel.glb"; filename*=UTF-8''Barrel.glb`,
  );
  const tricky = presignedDisposition("attachment", 'evil"\r\nname.glb');
  assert.ok(!/[\r\n]/.test(tricky), tricky);
  assert.ok(tricky.startsWith("attachment;"), tricky);
});

test("presigned GET URLs carry the authorized response overrides", async () => {
  const store = new MemoryObjectStore();
  const url = await store.presignGet(`files/${ID}/Barrel.glb`, {
    contentType: "model/gltf-binary",
    disposition: "attachment",
    filename: "Barrel.glb",
    expiresInSeconds: 300,
  });
  assert.ok(url.includes(encodeURIComponent(`files/${ID}/Barrel.glb`)), url);
  assert.ok(url.includes("response-content-type=model%2Fgltf-binary"), url);
  assert.ok(url.includes("response-content-disposition="), url);
  assert.ok(url.includes("attachment"), url);
  assert.ok(!/secret|accesskey|password/i.test(url), url);
});

/* ------------------------------------------------------ quota accounting */

test("quotaRejectionMessage allows unlimited workspaces and exact fits", () => {
  assert.equal(quotaRejectionMessage({ usedBytes: 10 ** 12, reservedBytes: 0, quotaBytes: null, size: 10 ** 12 }), null);
  assert.equal(quotaRejectionMessage({ usedBytes: 100, reservedBytes: 0, quotaBytes: 150, size: 50 }), null);
});

test("quotaRejectionMessage counts reservations and rejects over-quota uploads", () => {
  const over = quotaRejectionMessage({ usedBytes: 100, reservedBytes: 40, quotaBytes: 150, size: 11 });
  assert.ok(over);
  assert.match(over, /Storage limit reached/);
  assert.match(over, /LIBRARY_QUOTA_BYTES/);

  const fits = quotaRejectionMessage({ usedBytes: 100, reservedBytes: 40, quotaBytes: 150, size: 10 });
  assert.equal(fits, null);
});

test("formatBytes renders the units used in quota messages", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(10 * 1024 * 1024 * 1024), "10.0 GB");
});

/* --------------------------------- GLTF companion resolution (R2 metadata) */

test("gltf companions resolve from Postgres logical paths, not disk layout", () => {
  // Rows shaped exactly like the `files` table (plus ignored metadata): the
  // resolver only ever sees `name`/`path`, never a filesystem location.
  const library = [
    { id: "gltf", name: "barrel.gltf", path: "scene/barrel.gltf", size: 512, uploaderName: "owner" },
    { id: "bin", name: "barrel.bin", path: "scene/barrel.bin", size: 1024, uploaderName: "owner" },
    { id: "tex", name: "albedo.png", path: "scene/textures/albedo.png", size: 64, uploaderName: "member" },
  ];
  const model = library[0];
  assert.equal(findReferencedFile(library, model, "barrel.bin")?.id, "bin");
  assert.equal(findReferencedFile(library, model, "textures/albedo.png")?.id, "tex");
  assert.equal(findReferencedFile(library, model, "missing.bin"), null);
});

test("companion resolution survives renames (logical path follows the name)", () => {
  const library = [
    { id: "gltf", name: "Barrel Deluxe.gltf", path: "scene/Barrel Deluxe.gltf" },
    { id: "bin", name: "barrel.bin", path: "scene/barrel.bin" },
  ];
  assert.equal(findReferencedFile(library, library[0], "barrel.bin")?.id, "bin");
});

test("ambiguous companion basenames still refuse to guess", () => {
  const library = [
    { id: "gltf", name: "barrel.gltf", path: "barrel.gltf" },
    { id: "t1", name: "albedo.png", path: "a/albedo.png" },
    { id: "t2", name: "albedo.png", path: "b/albedo.png" },
  ];
  assert.throws(() => findReferencedFile(library, library[0], "x/albedo.png"), /Multiple library files match/);
});

/* ------------------------------------------------------ rollback behavior */

test("putObjectWithVerify stores bytes and reports the verified size", async () => {
  const store = new MemoryObjectStore();
  const data = Buffer.from("glTF-model-bytes");
  const { size } = await putObjectWithVerify(store, `files/${ID}/a.glb`, data, "model/gltf-binary");
  assert.equal(size, data.length);
  assert.deepEqual((await store.getBuffer(`files/${ID}/a.glb`)).data, data);
});

test("putObjectWithVerify propagates a failed write with nothing stored", async () => {
  const store = new MemoryObjectStore();
  store.failPutWith = new R2Error(502, "Object storage is temporarily unavailable (upload). Please try again in a moment.");
  await assert.rejects(
    () => putObjectWithVerify(store, `files/${ID}/a.glb`, Buffer.from("x"), "model/gltf-binary"),
    (err) => err instanceof R2Error && err.status === 502,
  );
  assert.equal(store.objects.size, 0);
});

test("putObjectWithVerify rolls back when verification disagrees on size", async () => {
  const store = new MemoryObjectStore();
  store.lieAboutSize = 999; // HEAD disagrees with what was written
  await assert.rejects(
    () => putObjectWithVerify(store, `files/${ID}/a.glb`, Buffer.from("0123456789"), "model/gltf-binary"),
    (err) => err instanceof R2Error && err.status === 502 && /Nothing was saved/.test(err.message),
  );
  assert.equal(store.objects.size, 0, "the unverified object must be deleted again");
});

test("putObjectWithVerify rolls back when the object vanishes before HEAD", async () => {
  const inner = new MemoryObjectStore();
  const vanishing = Object.create(inner);
  vanishing.head = async () => null; // HEAD finds nothing even though PUT succeeded
  await assert.rejects(
    () => putObjectWithVerify(vanishing, `files/${ID}/a.glb`, Buffer.from("0123456789"), "model/gltf-binary"),
    (err) => err instanceof R2Error && err.status === 502,
  );
  assert.equal(inner.objects.size, 0, "the unverified object must be deleted again");
});

test("deleteFileObjects removes the model key and every thumbnail variant", async () => {
  const store = new MemoryObjectStore();
  await store.put(`files/${ID}/Barrel.glb`, Buffer.from([1]), "model/gltf-binary");
  await store.put(`thumbnails/${ID}.jpg`, Buffer.from([2]), "image/jpeg");
  await store.put(`thumbnails/${ID}.png`, Buffer.from([3]), "image/png");
  await store.put(`files/other/a.glb`, Buffer.from([4]), "model/gltf-binary");

  const result = await deleteFileObjects(store, ID, "Barrel.glb", "jpg");
  assert.equal(result.failed.length, 0);
  assert.deepEqual([...store.objects.keys()], [`files/other/a.glb`]);
});

test("deleteFileObjects reports per-key failures instead of throwing", async () => {
  const store = new MemoryObjectStore();
  store.failDeleteWith = new Error("R2 is down");
  await store.put(`files/${ID}/Barrel.glb`, Buffer.from([1]), "model/gltf-binary");

  const result = await deleteFileObjects(store, ID, "Barrel.glb", "jpg");
  assert.ok(result.failed.length > 0, "failures must be reported");
  assert.ok(result.failed.includes(`files/${ID}/Barrel.glb`));
});

test("deleteFileObjects falls back to key-by-key deletion when the batch throws", async () => {
  const inner = new MemoryObjectStore();
  await inner.put(`files/${ID}/Barrel.glb`, Buffer.from([1]), "model/gltf-binary");
  await inner.put(`thumbnails/${ID}.jpg`, Buffer.from([2]), "image/jpeg");
  const throwing = Object.create(inner);
  throwing.deleteMany = async () => {
    throw new Error("batch endpoint down");
  };

  const result = await deleteFileObjects(throwing, ID, "Barrel.glb", "jpg");
  assert.equal(result.failed.length, 0);
  assert.equal(inner.objects.size, 0);
});
