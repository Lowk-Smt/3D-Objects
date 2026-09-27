import test from "node:test";
import assert from "node:assert/strict";

import {
  MIME_BY_EXT,
  basename,
  dirname,
  findReferencedFile,
  getDownloadName,
  getExt,
  getMimeForName,
  isInlineOrRemoteUri,
  normalizePath,
  sanitizeBaseName,
} from "../public/vault/shared.js";

test("getExt / getMimeForName agree with the server-side MIME table", () => {
  assert.equal(getExt("Barrel.glb"), "glb");
  assert.equal(getExt("model.GLTF"), "gltf");
  assert.equal(getExt("no-extension"), "");
  assert.equal(getExt(""), "");

  assert.equal(getMimeForName("Barrel.glb"), "model/gltf-binary");
  assert.equal(getMimeForName("scene.gltf"), "model/gltf+json");
  assert.equal(getMimeForName("texture.png"), "image/png");
  assert.equal(getMimeForName("mystery.xyz"), "application/octet-stream");
  assert.ok(Object.keys(MIME_BY_EXT).length > 10);
});

test("normalizePath / dirname / basename handle Windows-style and relative segments", () => {
  assert.equal(normalizePath("models\\barrel\\textures/albedo.png"), "models/barrel/textures/albedo.png");
  assert.equal(normalizePath("models/../barrel.gltf"), "barrel.gltf");
  assert.equal(dirname("models/barrel.gltf"), "models");
  assert.equal(dirname("barrel.gltf"), "");
  assert.equal(basename("models/barrel.gltf"), "barrel.gltf");
});

test("sanitizeBaseName strips path separators and control characters", () => {
  assert.equal(sanitizeBaseName("../../etc/passwd"), "....etcpasswd");
  assert.equal(sanitizeBaseName("Bad<Name>|?.glb"), "BadName.glb");
  assert.equal(sanitizeBaseName("  spaced  "), "spaced");
  assert.equal(sanitizeBaseName(""), "");
});

test("getDownloadName always yields a real filename with an extension", () => {
  assert.equal(getDownloadName({ name: "Barrel.glb", ext: "glb" }), "Barrel.glb");
  assert.equal(getDownloadName({ name: "weird", ext: "glb" }), "weird.glb");
  assert.equal(getDownloadName({ name: "with spaces and ünïcode.gltf", ext: "gltf" }), "with spaces and ünïcode.gltf");
  // Only a nameless record falls back, and never to a bare "file"/"blob"/"unknown".
  const fallback = getDownloadName({ id: "abc123", ext: "stl" });
  assert.equal(fallback, "model-abc123.stl");
  for (const bad of ["file", "download", "blob", "unknown"]) {
    assert.notEqual(fallback, bad);
  }
});

test("findReferencedFile resolves .gltf companions by exact relative path", () => {
  const files = [
    { id: "model", name: "barrel.gltf", path: "scene/barrel.gltf" },
    { id: "bin", name: "barrel.bin", path: "scene/barrel.bin" },
    { id: "tex", name: "albedo.png", path: "scene/textures/albedo.png" },
    { id: "other", name: "albedo.png", path: "scene/other/albedo.png" },
  ];
  const model = files[0];

  assert.equal(findReferencedFile(files, model, "barrel.bin")?.id, "bin");
  assert.equal(findReferencedFile(files, model, "textures/albedo.png")?.id, "tex");
  assert.equal(findReferencedFile(files, model, "textures%2Falbedo.png")?.id, "tex");
});

test("findReferencedFile falls back to a whole-library unique basename", () => {
  const files = [
    { id: "model", name: "barrel.gltf", path: "barrel.gltf" },
    { id: "bin", name: "barrel.bin", path: "barrel.bin" },
  ];
  assert.equal(findReferencedFile(files, files[0], "assets/barrel.bin")?.id, "bin");
  assert.equal(findReferencedFile(files, files[0], "missing.bin"), null);
});

test("findReferencedFile refuses to guess when a basename is ambiguous", () => {
  const files = [
    { id: "model", name: "barrel.gltf", path: "barrel.gltf" },
    { id: "tex1", name: "albedo.png", path: "a/albedo.png" },
    { id: "tex2", name: "albedo.png", path: "b/albedo.png" },
  ];
  assert.throws(() => findReferencedFile(files, files[0], "textures/albedo.png"), /Multiple library files match/);
  // ...but an exact path match still wins even then.
  assert.equal(findReferencedFile(files, files[0], "b/albedo.png")?.id, "tex2");
});

test("inline and remote URIs are recognised so they are never looked up locally", () => {
  assert.ok(isInlineOrRemoteUri("data:application/octet-stream;base64,AAAA"));
  assert.ok(isInlineOrRemoteUri("https://example.com/tex.png"));
  assert.ok(isInlineOrRemoteUri("blob:http://localhost/abc"));
  assert.ok(!isInlineOrRemoteUri("textures/albedo.png"));
});
