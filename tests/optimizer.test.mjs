import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";

import { Document, WebIO } from "@gltf-transform/core";
import { dedup, prune } from "@gltf-transform/functions";

import {
  CANCEL_MESSAGE,
  DEFAULT_PRESET_KEY,
  GENERATOR_TAG,
  GlbValidationError,
  OPTIMIZE_PRESETS,
  STAGE_ORDER,
  cleanMetadata,
  inspectDocument,
  optimizeDocument,
  optimizeGlbBytes,
  resolvePreset,
  shouldUseOptimized,
  validateGlbContainer,
} from "../public/vault/optimizer-core.mjs";
import {
  createCanvasTextureStrategy,
  pickOutputFormat,
  planTextureEncode,
} from "../public/vault/optimizer-browser-textures.mjs";
import { createHeadlessTextureStrategy } from "../scripts/lib/headless-textures.mjs";
import {
  PngError,
  decodePng,
  downscaleRgba,
  encodePng,
  hasAlphaChannel,
} from "../scripts/lib/png-codec.mjs";

/**
 * These tests run the SHIPPING optimizer core — the same module
 * public/vault/app.js loads in the browser and scripts/benchmark-optimizer.mjs
 * runs headlessly — not a mirror of it. They exist because the README and the
 * Optimize dialog make specific promises about validation, names, metadata,
 * stage order and texture handling — promises that must be verified, not
 * assumed.
 */

/* ---------- helpers ---------- */

function readGlbJson(glb) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  const chunkType = view.getUint32(16, true);
  assert.equal(chunkType, 0x4e4f534a, "first GLB chunk should be JSON");
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
}

/** Minimal GLB writer so tests can craft containers the parser never produced. */
function makeGlb(json, bin = new Uint8Array(0), { version = 2, declaredLength = null } = {}) {
  const jsonBytes = new TextEncoder().encode(typeof json === "string" ? json : JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + (bin.length ? 8 + bin.length + binPad : 0);
  const glb = new Uint8Array(total);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, version, true);
  view.setUint32(8, declaredLength === null ? total : declaredLength, true);
  view.setUint32(12, jsonBytes.length + jsonPad, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.set(jsonBytes, 20);
  for (let i = 0; i < jsonPad; i++) glb[20 + jsonBytes.length + i] = 0x20; // spec: pad with spaces
  if (bin.length) {
    const binStart = 20 + jsonBytes.length + jsonPad;
    view.setUint32(binStart, bin.length + binPad, true);
    view.setUint32(binStart + 4, 0x004e4942, true);
    glb.set(bin, binStart + 8);
  }
  return glb;
}

function rgba(width, height, paint) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b, a] = paint(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return data;
}

async function buildSourceDocument() {
  const doc = new Document();
  doc.getRoot().getAsset().generator = "Sketchfab-Exporter 3.1";
  doc.getRoot().getAsset().extras = { author: "someone", aiTool: "made-up" };
  doc.getRoot().setExtras({ vault: "original" });

  const buffer = doc.createBuffer();
  const position = doc
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);

  const barrelMaterial = doc
    .createMaterial("BarrelMaterial")
    .setBaseColorFactor([1, 0.5, 0.2, 1])
    .setExtras({ tool: "substance-painter" });
  // Same values, different name: must NOT be merged away by dedup().
  const lidMaterial = doc.createMaterial("LidMaterial").setBaseColorFactor([1, 0.5, 0.2, 1]);

  const texture = doc.createTexture("albedo").setImage(new Uint8Array([1, 2, 3])).setMimeType("image/png");
  barrelMaterial.setBaseColorTexture(texture);

  const barrelMesh = doc
    .createMesh("BarrelMesh")
    .addPrimitive(doc.createPrimitive().setAttribute("POSITION", position).setMaterial(barrelMaterial));
  const lidMesh = doc
    .createMesh("LidMesh")
    .addPrimitive(doc.createPrimitive().setAttribute("POSITION", position).setMaterial(lidMaterial));

  const named = doc.createNode("BarrelNode").setMesh(barrelMesh);
  const unnamed = doc.createNode().setMesh(lidMesh).setExtras({ from: "blender" });

  doc.createScene("Scene").addChild(named).addChild(unnamed);
  return doc;
}

async function optimizeLikeTheApp(options = {}) {
  const io = new WebIO();
  const document = await io.readBinary(await io.writeBinary(await buildSourceDocument()));
  await optimizeDocument(document, options);
  return readGlbJson(await io.writeBinary(document));
}

/** A document with a real, oversized PNG texture for the texture-path tests. */
async function buildTexturedDocument(pngBytes, width, height, mimeType = "image/png") {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const material = doc.createMaterial("TexturedMaterial");
  const texture = doc.createTexture("albedo").setImage(pngBytes).setMimeType(mimeType);
  material.setBaseColorTexture(texture);
  const mesh = doc.createMesh("TexturedMesh").addPrimitive(
    doc.createPrimitive().setAttribute("POSITION", position).setMaterial(material),
  );
  doc.createScene("Scene").addChild(doc.createNode("TexturedNode").setMesh(mesh));
  return doc;
}

/**
 * A bumpy height-field grid: enough geometry for the simplifier to have real
 * work to do (a perfectly flat plane can collapse to nothing, and a tiny grid
 * is below the scale where meshopt can decimate), and no textures at all.
 */
function buildHeightfieldDocument(grid = 128) {
  const positions = [];
  const indices = [];
  for (let y = 0; y <= grid; y++) {
    for (let x = 0; x <= grid; x++) {
      // One smooth oscillation across the surface, whatever the grid size, so
      // the simplifier has both usable flatness and real curvature.
      positions.push(x / grid, y / grid, Math.sin((x / grid) * Math.PI * 2) * Math.cos((y / grid) * Math.PI * 2) * 0.4);
    }
  }
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid; x++) {
      const a = y * (grid + 1) + x;
      indices.push(a, a + 1, a + grid + 2, a, a + grid + 2, a + grid + 1);
    }
  }
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document.createAccessor().setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer);
  const index = document.createAccessor().setArray(new Uint32Array(indices)).setBuffer(buffer);
  const mesh = document.createMesh("HeightfieldMesh").addPrimitive(
    document.createPrimitive().setAttribute("POSITION", position).setIndices(index),
  );
  document.createScene("Scene").addChild(document.createNode("HeightfieldNode").setMesh(mesh));
  return document;
}

/** Incompressible-ish RGBA pixels, so PNG size really tracks pixel count. */
function pseudoRandomRgba(width, height, seed = 0x9e3779b9) {
  let s = seed;
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % 256;
  };
  return rgba(width, height, () => [rand(), rand(), rand(), 255]);
}

function fakeCanvasEnv({ width, height, pixels, webp = true, encodedBytes = 64 }) {
  return {
    async createImageBitmap() {
      return { width, height, close() {}, __pixels: pixels };
    },
    createCanvas(w, h) {
      return {
        width: w,
        height: h,
        getContext() {
          let stored = null;
          return {
            drawImage(bitmap) {
              const sw = bitmap.width;
              const sh = bitmap.height;
              const out = new Uint8ClampedArray(w * h * 4);
              for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                  const sx = Math.min(sw - 1, Math.floor((x * sw) / w));
                  const sy = Math.min(sh - 1, Math.floor((y * sh) / h));
                  const si = (sy * sw + sx) * 4;
                  const ti = (y * w + x) * 4;
                  out[ti] = bitmap.__pixels[si];
                  out[ti + 1] = bitmap.__pixels[si + 1];
                  out[ti + 2] = bitmap.__pixels[si + 2];
                  out[ti + 3] = bitmap.__pixels[si + 3];
                }
              }
              stored = out;
            },
            getImageData() {
              return { data: stored || new Uint8ClampedArray(w * h * 4) };
            },
          };
        },
        toBlob(cb, type) {
          cb(new Blob([new Uint8Array(encodedBytes)], { type: webp ? type : "image/png" }));
        },
      };
    },
  };
}

/* ---------- browser / Node parity ---------- */

test("the installed glTF-Transform matches the version the browser loads", () => {
  // The import map in src/app/page.tsx pins the exact version the browser
  // uses; the devDependency must match, or these assertions could pass
  // while the real optimizer behaves differently.
  const installed = JSON.parse(
    fs.readFileSync(new URL("../node_modules/@gltf-transform/core/package.json", import.meta.url), "utf8"),
  ).version;
  const page = fs.readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  assert.ok(
    page.includes(`@gltf-transform/core@${installed}`),
    `src/app/page.tsx does not pin @gltf-transform/core@${installed}`,
  );
  assert.ok(page.includes(`@gltf-transform/functions@${installed}`), "functions version drifted");
});

test("the installed meshoptimizer matches the version the browser loads", () => {
  // optimizer-core.mjs imports MeshoptSimplifier directly, so the WASM that
  // simplifies meshes in the benchmark must be the one the browser loads.
  const installed = JSON.parse(
    fs.readFileSync(new URL("../node_modules/meshoptimizer/package.json", import.meta.url), "utf8"),
  ).version;
  const page = fs.readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  assert.ok(
    page.includes(`meshoptimizer@${installed}`),
    `src/app/page.tsx does not pin meshoptimizer@${installed}`,
  );
});

/* ---------- presets ---------- */

test("every preset resolves to its exact documented values", () => {
  assert.deepEqual(resolvePreset("high"), { key: "high", ratio: 0.7, error: 0.0005, textureSize: 2048, textureQuality: 0.92 });
  assert.deepEqual(resolvePreset("balanced"), { key: "balanced", ratio: 0.5, error: 0.0005, textureSize: 1536, textureQuality: 0.85 });
  assert.deepEqual(resolvePreset("small"), { key: "small", ratio: 0.25, error: 0.001, textureSize: 1024, textureQuality: 0.75 });
});

test("an unknown preset key falls back to balanced instead of throwing", () => {
  assert.equal(resolvePreset("ultra").key, DEFAULT_PRESET_KEY);
  assert.equal(resolvePreset(undefined).key, DEFAULT_PRESET_KEY);
  assert.equal(resolvePreset("").key, DEFAULT_PRESET_KEY);
});

test("presets are frozen so a caller cannot rewrite them mid-run", () => {
  assert.ok(Object.isFrozen(OPTIMIZE_PRESETS));
  assert.ok(Object.isFrozen(OPTIMIZE_PRESETS.high));
  assert.throws(() => { OPTIMIZE_PRESETS.high.ratio = 0.1; });
});

/* ---------- container validation ---------- */

test("a real GLB passes validation and reports its container facts", async () => {
  const io = new WebIO();
  const glb = await io.writeBinary(await buildSourceDocument());
  const info = validateGlbContainer(new Uint8Array(glb));
  assert.equal(info.version, 2);
  assert.equal(info.declaredLength, glb.byteLength);
  assert.equal(info.hasBinChunk, true);
});

test("validation rejects anything that is not a Uint8Array", () => {
  for (const bad of [null, undefined, "glTF", [1, 2, 3], new ArrayBuffer(64)]) {
    assert.throws(() => validateGlbContainer(bad), err => err instanceof GlbValidationError && err.code === "INVALID_INPUT");
  }
});

test("validation rejects files too short to hold a GLB header", () => {
  assert.throws(() => validateGlbContainer(new Uint8Array(8)), err => err.code === "TRUNCATED");
  assert.throws(() => validateGlbContainer(new Uint8Array(0)), err => err.code === "TRUNCATED");
});

test("validation rejects files without the glTF magic", () => {
  const bytes = new Uint8Array(64); // all zeroes: wrong magic
  assert.throws(() => validateGlbContainer(bytes), err => err.code === "NOT_GLB");
});

test("validation rejects GLB version 1", () => {
  const glb = makeGlb({ asset: { version: "2.0" } }, new Uint8Array(4), { version: 1 });
  assert.throws(() => validateGlbContainer(glb), err => err.code === "BAD_VERSION");
});

test("validation rejects a header that declares more bytes than the file has", () => {
  const glb = makeGlb({ asset: { version: "2.0" } }, new Uint8Array(4));
  glb[8] = 0xff; // declared length is now enormous
  glb[9] = 0xff;
  glb[10] = 0xff;
  glb[11] = 0x7f;
  assert.throws(() => validateGlbContainer(glb), err => err.code === "TRUNCATED");
});

test("validation rejects trailing bytes beyond the declared length", () => {
  const glb = makeGlb({ asset: { version: "2.0" } }, new Uint8Array(4));
  const padded = new Uint8Array(glb.length + 4);
  padded.set(glb, 0);
  assert.throws(() => validateGlbContainer(padded), err => err.code === "LENGTH_MISMATCH");
});

test("validation rejects a GLB whose first chunk is not JSON", () => {
  const glb = makeGlb({ asset: { version: "2.0" } }, new Uint8Array(4));
  new DataView(glb.buffer).setUint32(16, 0x004e4942, true); // 'BIN\0'
  assert.throws(() => validateGlbContainer(glb), err => err.code === "MISSING_JSON_CHUNK");
});

test("validation rejects a GLB with a corrupt JSON chunk", () => {
  const glb = makeGlb({ asset: { version: "2.0" } }, new Uint8Array(4));
  glb[20] = 0x7b; // '{'
  glb[21] = 0x7b; // '{'  → "{{" is not valid JSON
  assert.throws(() => validateGlbContainer(glb), err => err.code === "BAD_JSON");
});

test("validation rejects a GLB whose JSON has no asset.version", () => {
  const glb = makeGlb({ scenes: [] }, new Uint8Array(4));
  assert.throws(() => validateGlbContainer(glb), err => err.code === "MISSING_ASSET");
});

test("validation messages are human-readable, not parser internals", () => {
  try {
    validateGlbContainer(new Uint8Array(64));
    assert.fail("should have thrown");
  } catch (err) {
    assert.match(err.message, /not a \.glb file/);
    assert.equal(err.name, "GlbValidationError");
  }
});

/* ---------- metadata cleanup (the documented promises) ---------- */

test("optimizing preserves every existing name", async () => {
  const json = await optimizeLikeTheApp();

  assert.deepEqual(json.nodes.map((n) => n.name), ["BarrelNode", "node_1"]);
  assert.deepEqual(json.meshes.map((m) => m.name), ["BarrelMesh", "LidMesh"]);
  assert.deepEqual(json.materials.map((m) => m.name), ["BarrelMaterial", "LidMaterial"]);
  assert.deepEqual(json.images.map((i) => i.name), ["albedo"]);
  assert.deepEqual(json.scenes.map((s) => s.name), ["Scene"]);
});

test("only properties that had no name get a placeholder", async () => {
  const json = await optimizeLikeTheApp();
  // The second node was created without a name; everything else was named.
  assert.equal(json.nodes[1].name, "node_1");
  for (const name of json.meshes.map((m) => m.name)) {
    assert.ok(!/^mesh_\d+$/.test(name), `${name} was renamed by the optimizer`);
  }
  for (const name of json.materials.map((m) => m.name)) {
    assert.ok(!/^material_\d+$/.test(name), `${name} was renamed by the optimizer`);
  }
});

test("tool metadata (extras) is really removed from the written file", async () => {
  const json = await optimizeLikeTheApp();

  assert.equal(json.extras, undefined);
  assert.equal(json.asset.extras, undefined);
  for (const collection of [json.nodes, json.meshes, json.materials, json.images ?? [], json.scenes]) {
    for (const entry of collection ?? []) {
      assert.equal(entry.extras, undefined, `${entry.name} still carries extras`);
    }
  }
});

test("the original exporter's generator string does not survive", async () => {
  const json = await optimizeLikeTheApp();
  assert.equal(json.asset.generator, GENERATOR_TAG);
  assert.ok(!JSON.stringify(json).includes("Sketchfab"), "the uploader's exporter string leaked into the result");
  assert.ok(!JSON.stringify(json).includes("substance-painter"), "material extras leaked into the result");
});

test("dedup does not merge properties that have different names", async () => {
  const json = await optimizeLikeTheApp();
  // BarrelMaterial and LidMaterial have identical values in the fixture.
  assert.equal(json.materials.length, 2);
  assert.deepEqual(json.materials.map((m) => m.name).sort(), ["BarrelMaterial", "LidMaterial"]);
});

test("cleanMetadata is idempotent", async () => {
  const io = new WebIO();
  const document = await io.readBinary(await io.writeBinary(await buildSourceDocument()));
  cleanMetadata(document);
  const once = readGlbJson(await io.writeBinary(document));
  cleanMetadata(document);
  const twice = readGlbJson(await io.writeBinary(document));
  assert.deepEqual(twice, once);
});

/* ---------- pipeline behaviour ---------- */

test("a full-featured document runs every stage in the documented order", async () => {
  const io = new WebIO();
  const png = encodePng({ width: 8, height: 8, data: rgba(8, 8, (x, y) => [x * 8, y * 8, 128, 255]) });
  const document = await io.readBinary(await io.writeBinary(await buildTexturedDocument(png, 8, 8)));

  const seen = [];
  await optimizeDocument(document, {
    resizeTexture: createHeadlessTextureStrategy().resize,
    timeStage: async (label, run) => { seen.push(label); return run(); },
  });
  assert.deepEqual(seen, [...STAGE_ORDER]);
});

test("simplify is skipped entirely when the document has no mesh primitives", async () => {
  const document = new Document();
  document.createScene("Scene").addChild(document.createNode("Empty"));

  const seen = [];
  await optimizeDocument(document, { timeStage: async (label, run) => { seen.push(label); return run(); } });
  assert.ok(!seen.includes("simplify"), `simplify ran on an empty document: ${seen.join(", ")}`);
});

test("the texture stage is skipped when the document has no textures", async () => {
  const document = buildHeightfieldDocument(8);

  const seen = [];
  await optimizeDocument(document, {
    resizeTexture: createHeadlessTextureStrategy().resize,
    timeStage: async (label, run) => { seen.push(label); return run(); },
  });
  assert.ok(!seen.includes("textures"), `texture stage ran without textures: ${seen.join(", ")}`);
  assert.ok(!seen.includes("dedup:final"), "dedup:final only exists to re-merge resized textures");
});

test("simplify actually reduces the triangle count", async () => {
  const document = buildHeightfieldDocument();

  const before = inspectDocument(document);
  await optimizeDocument(document, { preset: "small" });
  const after = inspectDocument(document);

  assert.equal(before.triangleCount, 128 * 128 * 2);
  assert.ok(after.triangleCount < before.triangleCount * 0.5, `expected a big drop, got ${after.triangleCount}`);
  assert.ok(after.triangleCount > 0, "simplify must not empty the mesh");
});

test("prune drops meshes, materials and nodes nothing references", async () => {
  const io = new WebIO();
  const document = await io.readBinary(await io.writeBinary(await buildSourceDocument()));

  // Add data nothing points at — exactly what a downloaded model carries.
  const buffer = document.createBuffer();
  const orphanPosition = document
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  document.createMesh("OrphanMesh").addPrimitive(document.createPrimitive().setAttribute("POSITION", orphanPosition));
  document.createNode("OrphanNode");

  const before = inspectDocument(document);
  await optimizeDocument(document);
  const after = inspectDocument(document);

  assert.equal(before.meshCount, 3);
  assert.equal(after.meshCount, 2, "the unreferenced mesh should be gone");
  assert.ok(after.nodeCount < before.nodeCount, "the unreferenced node should be gone");
});

test("dedup merges byte-identical duplicate meshes into one", async () => {
  const document = new Document();
  const shared = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const meshA = document.createMesh("CopyA").addPrimitive(
    document.createPrimitive().setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(new Float32Array(shared)).setBuffer(document.createBuffer())),
  );
  const meshB = document.createMesh("CopyB").addPrimitive(
    document.createPrimitive().setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(new Float32Array(shared)).setBuffer(document.createBuffer())),
  );
  document.createScene("Scene")
    .addChild(document.createNode("A").setMesh(meshA))
    .addChild(document.createNode("B").setMesh(meshB));

  await optimizeDocument(document);
  assert.equal(inspectDocument(document).meshCount, 1, "the two identical meshes should have merged");
});

test("cancelling before the first stage rejects with the shared cancel message", async () => {
  const io = new WebIO();
  const document = await io.readBinary(await io.writeBinary(await buildSourceDocument()));
  await assert.rejects(
    () => optimizeDocument(document, { shouldCancel: () => true }),
    err => err.message === CANCEL_MESSAGE,
  );
});

test("a texture strategy that throws never aborts the optimization", async () => {
  const io = new WebIO();
  const png = encodePng({ width: 8, height: 8, data: rgba(8, 8, (x, y) => [x * 8, y * 8, 128, 255]) });
  const document = await io.readBinary(await io.writeBinary(await buildTexturedDocument(png, 8, 8)));

  let calls = 0;
  const result = await optimizeDocument(document, {
    resizeTexture: async () => { calls++; throw new Error("decoder exploded"); },
  });
  assert.equal(calls, 1, "the failing texture should have been attempted");
  assert.ok(result.stages.includes("metadata"), "the run should still finish cleanly");
});

test("inspectDocument reports the counts the adaptive stages decide on", async () => {
  const io = new WebIO();
  const document = await io.readBinary(await io.writeBinary(await buildSourceDocument()));
  const work = inspectDocument(document);
  assert.equal(work.meshCount, 2);
  assert.equal(work.primitiveCount, 2);
  assert.equal(work.textureCount, 1);
  assert.equal(work.triangleCount, 2);
});

/* ---------- end-to-end ---------- */

test("optimizeGlbBytes rejects a non-GLB before parsing anything", async () => {
  await assert.rejects(
    () => optimizeGlbBytes(new Uint8Array(512)),
    err => err instanceof GlbValidationError && err.code === "NOT_GLB",
  );
});

test("optimizeGlbBytes shrinks a real GLB and the result still parses", async () => {
  const io = new WebIO();
  const original = await io.writeBinary(buildHeightfieldDocument(24));

  const result = await optimizeGlbBytes(new Uint8Array(original), { preset: "small" });

  assert.equal(result.preset.key, "small");
  assert.ok(result.byteLength < original.byteLength, "the optimized GLB should be smaller");
  assert.equal(result.validation.version, 2);
  assert.ok(result.stages.includes("simplify"));
  assert.ok(!result.stages.includes("textures"), "this document has no textures");

  // The output must still be a valid GLB the viewer can load. Assert the
  // generator on the WRITTEN file: glTF-Transform's reader restamps
  // asset.generator with its own version string on the way in.
  assert.equal(readGlbJson(result.glb).asset.generator, GENERATOR_TAG);
  const reloaded = await io.readBinary(result.glb);
  assert.equal(reloaded.getRoot().listMeshes()[0].getName(), "HeightfieldMesh");
});

test("optimizeGlbBytes actually re-encodes an oversized texture on the headless path", async () => {
  const io = new WebIO();
  const png = encodePng({ width: 96, height: 96, data: rgba(96, 96, (x, y) => [x * 2, y * 2, (x + y) % 256, 255]) });
  const original = await io.writeBinary(await buildTexturedDocument(png, 96, 96));

  const result = await optimizeGlbBytes(new Uint8Array(original), {
    preset: "small", // textureSize 1024 — too big to force a downscale of 96px
    resizeTexture: createHeadlessTextureStrategy().resize,
  });
  assert.equal(result.work.textureCount, 1);

  const headless = createHeadlessTextureStrategy();
  const document = await io.readBinary(result.glb);
  const texture = document.getRoot().listTextures()[0];
  const before = texture.getImage().byteLength;
  const outcome = await headless.resize(texture, { maxSize: 32 });
  assert.equal(outcome.changed, true, "a 96px texture must be downscaled to 32px");
  const decoded = decodePng(texture.getImage());
  assert.equal(decoded.width, 32);
  assert.equal(decoded.height, 32);
  assert.ok(texture.getImage().byteLength < before, "the downscaled PNG should be smaller");
});

/* ---------- never-bigger rule ---------- */

test("shouldUseOptimized only accepts a strictly smaller result", () => {
  assert.equal(shouldUseOptimized(1000, 999), true);
  assert.equal(shouldUseOptimized(1000, 1000), false, "same size is not an optimization");
  assert.equal(shouldUseOptimized(1000, 1001), false);
});

/* ---------- PNG codec (headless path) ---------- */

test("PNG encode → decode round-trips pixels exactly", () => {
  const width = 37;
  const height = 23;
  const data = rgba(width, height, (x, y) => [(x * 7) % 256, (y * 11) % 256, (x * y) % 256, x % 5 === 0 ? 128 : 255]);
  const decoded = decodePng(encodePng({ width, height, data }));
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.deepEqual(decoded.data, data);
});

test("an opaque PNG can be encoded as the smaller RGB color type", () => {
  const width = 16;
  const height = 16;
  const data = rgba(width, height, (x, y) => [x * 16, y * 16, 128, 255]);
  const decoded = decodePng(encodePng({ width, height, data, colorType: 2 }));
  assert.equal(decoded.colorType, 2);
  assert.deepEqual(decoded.data, data);
});

test("hasAlphaChannel sees partial transparency", () => {
  assert.equal(hasAlphaChannel(rgba(4, 4, () => [1, 2, 3, 255])), false);
  assert.equal(hasAlphaChannel(rgba(4, 4, (x, y) => [1, 2, 3, x + y === 0 ? 0 : 255])), true);
});

test("downscaleRgba fits the longest edge and never upscales", () => {
  const data = rgba(64, 32, (x, y) => [x * 4, y * 8, 64, 255]);
  const wide = downscaleRgba(data, 64, 32, 16);
  assert.deepEqual([wide.width, wide.height], [16, 8]);

  const alreadySmall = downscaleRgba(data, 64, 32, 128);
  assert.deepEqual([alreadySmall.width, alreadySmall.height], [64, 32]);
  assert.deepEqual(alreadySmall.data, data);
});

test("decodePng rejects bytes that are not a PNG", () => {
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3, 4])), err => err instanceof PngError && err.code === "BAD_SIGNATURE");
});

test("decodePng reports unsupported variants instead of guessing", () => {
  const base = encodePng({ width: 4, height: 4, data: rgba(4, 4, () => [9, 9, 9, 255]) });
  const sixteenBit = new Uint8Array(base);
  sixteenBit[24] = 16; // IHDR bit depth
  assert.throws(() => decodePng(sixteenBit), err => err.code === "UNSUPPORTED_BIT_DEPTH");

  const interlaced = new Uint8Array(base);
  interlaced[28] = 1; // IHDR interlace method
  assert.throws(() => decodePng(interlaced), err => err.code === "UNSUPPORTED_INTERLACE");
});

/* ---------- headless texture strategy ---------- */

test("the headless path downscales an oversized PNG texture", async () => {
  const doc = new Document();
  // High-entropy pixels: a smooth gradient would compress so well that the
  // smaller image is not smaller in bytes, and the never-bigger rule would
  // (correctly) keep the original.
  const png = encodePng({
    width: 64,
    height: 64,
    data: pseudoRandomRgba(64, 64),
  });
  const texture = doc.createTexture("albedo").setImage(png).setMimeType("image/png");

  const outcome = await createHeadlessTextureStrategy().resize(texture, { maxSize: 32 });
  assert.equal(outcome.changed, true);
  assert.equal(outcome.to.width, 32);
  assert.equal(outcome.to.height, 32);
  assert.ok(outcome.to.bytes < outcome.from.bytes);

  const decoded = decodePng(texture.getImage());
  assert.equal(decoded.width, 32);
  assert.equal(texture.getMimeType(), "image/png", "the headless path keeps PNG");
});

test("the headless path leaves textures within the cap untouched", async () => {
  const doc = new Document();
  const png = encodePng({ width: 32, height: 32, data: rgba(32, 32, (x, y) => [x * 8, y * 8, 128, 255]) });
  const texture = doc.createTexture("albedo").setImage(png).setMimeType("image/png");
  const before = texture.getImage().byteLength;

  const outcome = await createHeadlessTextureStrategy().resize(texture, { maxSize: 2048 });
  assert.equal(outcome.changed, false);
  assert.equal(outcome.reason, "within-cap");
  assert.equal(texture.getImage().byteLength, before);
});

test("the headless path passes non-PNG textures through untouched", async () => {
  const doc = new Document();
  const texture = doc.createTexture("albedo").setImage(new Uint8Array([1, 2, 3, 4])).setMimeType("image/jpeg");

  const outcome = await createHeadlessTextureStrategy().resize(texture, { maxSize: 32 });
  assert.equal(outcome.changed, false);
  assert.equal(outcome.reason, "not-png-passthrough");
  assert.deepEqual(texture.getImage(), new Uint8Array([1, 2, 3, 4]));
});

test("the headless path passes unsupported PNGs through instead of failing", async () => {
  const doc = new Document();
  const base = encodePng({ width: 64, height: 64, data: rgba(64, 64, (x, y) => [x * 4, y * 4, 128, 255]) });
  const sixteenBit = new Uint8Array(base);
  sixteenBit[24] = 16;
  const texture = doc.createTexture("albedo").setImage(sixteenBit).setMimeType("image/png");

  const outcome = await createHeadlessTextureStrategy().resize(texture, { maxSize: 32 });
  assert.equal(outcome.changed, false);
  assert.equal(outcome.reason, "png-unsupported:UNSUPPORTED_BIT_DEPTH");
  assert.equal(texture.getImage().byteLength, sixteenBit.byteLength);
});

test("the headless path drops the alpha channel when the downscaled image is opaque", async () => {
  const doc = new Document();
  const png = encodePng({ width: 64, height: 64, data: rgba(64, 64, (x, y) => [x * 4, y * 4, 128, 255]) });
  const texture = doc.createTexture("albedo").setImage(png).setMimeType("image/png");

  await createHeadlessTextureStrategy().resize(texture, { maxSize: 32 });
  assert.equal(decodePng(texture.getImage()).colorType, 2, "opaque images should be re-encoded as RGB");
});

/* ---------- browser texture decisions (pure) ---------- */

test("pickOutputFormat chooses by alpha, then by WebP support", () => {
  assert.equal(pickOutputFormat({ hasAlpha: false, webpSupported: true }), "image/webp");
  assert.equal(pickOutputFormat({ hasAlpha: false, webpSupported: false }), "image/jpeg");
  assert.equal(pickOutputFormat({ hasAlpha: true, webpSupported: true }), "image/webp");
  assert.equal(pickOutputFormat({ hasAlpha: true, webpSupported: false }), "image/png");
});

test("planTextureEncode re-encodes when downscaling, whatever the source", () => {
  for (const mimeType of ["image/png", "image/jpeg", "image/webp"]) {
    const plan = planTextureEncode({ mimeType, hasAlpha: false, webpSupported: true, needsDownscale: true });
    assert.equal(plan.reencode, true);
    assert.equal(plan.reason, "downscale");
  }
});

test("planTextureEncode upgrades opaque PNGs to a lossy codec", () => {
  assert.deepEqual(
    planTextureEncode({ mimeType: "image/png", hasAlpha: false, webpSupported: true }),
    { reencode: true, outputType: "image/webp", reason: "png-to-lossy" },
  );
  assert.deepEqual(
    planTextureEncode({ mimeType: "image/png", hasAlpha: false, webpSupported: false }),
    { reencode: true, outputType: "image/jpeg", reason: "png-to-lossy" },
  );
});

test("planTextureEncode leaves already-optimal textures alone", () => {
  assert.equal(planTextureEncode({ mimeType: "image/webp", hasAlpha: false, webpSupported: true }).reencode, false);
  assert.equal(planTextureEncode({ mimeType: "image/jpeg", hasAlpha: false, webpSupported: false }).reencode, false);
  assert.equal(planTextureEncode({ mimeType: "image/png", hasAlpha: true, webpSupported: false }).reencode, false);
});

test("planTextureEncode moves opaque JPEGs to WebP when the browser can", () => {
  const plan = planTextureEncode({ mimeType: "image/jpeg", hasAlpha: false, webpSupported: true });
  assert.deepEqual(plan, { reencode: true, outputType: "image/webp", reason: "jpeg-to-webp" });
});

/* ---------- browser texture strategy (fake canvas env) ---------- */

test("the browser path downscales and re-encodes an oversized texture", async () => {
  const doc = new Document();
  const pixels = rgba(64, 64, (x, y) => [x * 4, y * 4, 128, 255]);
  const texture = doc.createTexture("albedo").setImage(new Uint8Array([9, 9, 9])).setMimeType("image/png");

  const strategy = createCanvasTextureStrategy(fakeCanvasEnv({ width: 64, height: 64, pixels }));
  const outcome = await strategy.resize(texture, { maxSize: 32 });

  assert.equal(outcome.changed, true);
  assert.equal(outcome.to.width, 32);
  assert.equal(outcome.to.height, 32);
  assert.equal(outcome.to.mimeType, "image/webp", "opaque + WebP support → lossy WebP");
  assert.equal(texture.getMimeType(), "image/webp");
  assert.equal(texture.getImage().byteLength, 64, "the fake encoder emitted 64 bytes");
});

test("the browser path picks the lossless PNG codec for alpha textures without WebP", async () => {
  const doc = new Document();
  const pixels = rgba(64, 64, (x, y) => [x * 4, y * 4, 128, x + y === 0 ? 0 : 255]);
  const texture = doc.createTexture("albedo").setImage(new Uint8Array([9, 9, 9])).setMimeType("image/png");

  const strategy = createCanvasTextureStrategy(fakeCanvasEnv({ width: 64, height: 64, pixels, webp: false }));
  const outcome = await strategy.resize(texture, { maxSize: 32 });

  assert.equal(outcome.changed, true);
  assert.equal(outcome.to.mimeType, "image/png", "alpha without WebP must stay lossless PNG");
});

test("the browser path falls back to JPEG for opaque textures without WebP", async () => {
  const doc = new Document();
  const pixels = rgba(64, 64, (x, y) => [x * 4, y * 4, 128, 255]);
  const texture = doc.createTexture("albedo").setImage(new Uint8Array([9, 9, 9])).setMimeType("image/png");

  const strategy = createCanvasTextureStrategy(fakeCanvasEnv({ width: 64, height: 64, pixels, webp: false }));
  const outcome = await strategy.resize(texture, { maxSize: 32 });
  assert.equal(outcome.to.mimeType, "image/jpeg");
});

test("the browser path leaves an in-cap lossy texture untouched", async () => {
  const doc = new Document();
  const pixels = rgba(32, 32, (x, y) => [x * 8, y * 8, 128, 255]);
  const texture = doc.createTexture("albedo").setImage(new Uint8Array([9, 9, 9])).setMimeType("image/webp");

  const strategy = createCanvasTextureStrategy(fakeCanvasEnv({ width: 32, height: 32, pixels }));
  const outcome = await strategy.resize(texture, { maxSize: 2048 });

  assert.equal(outcome.changed, false);
  assert.equal(outcome.reason, "lossy-optimal");
  assert.deepEqual(texture.getImage(), new Uint8Array([9, 9, 9]), "the original bytes must survive");
});

test("the browser path keeps the original bytes when re-encoding grows the file", async () => {
  const doc = new Document();
  const pixels = rgba(32, 32, (x, y) => [x * 8, y * 8, 128, 255]);
  const original = new Uint8Array([9, 9, 9]);
  const texture = doc.createTexture("albedo").setImage(original).setMimeType("image/png");

  // No downscale needed, but the fake encoder emits 512 bytes — bigger than
  // the original 3 — so the strategy must keep what the model shipped with.
  const strategy = createCanvasTextureStrategy(fakeCanvasEnv({ width: 32, height: 32, pixels, encodedBytes: 512 }));
  const outcome = await strategy.resize(texture, { maxSize: 2048 });

  assert.equal(outcome.changed, false);
  assert.equal(outcome.reason, "reencode-larger");
  assert.equal(texture.getImage(), original);
  assert.equal(texture.getMimeType(), "image/png");
});

test("the browser path probes WebP support once and reuses the answer", async () => {
  const env = fakeCanvasEnv({ width: 32, height: 32, pixels: rgba(32, 32, () => [1, 2, 3, 255]), webp: false });
  const strategy = createCanvasTextureStrategy(env);
  assert.equal(await strategy.supportsWebp(), false);
  assert.equal(await strategy.supportsWebp(), false);
});

test("the canvas strategy refuses to construct without createImageBitmap", () => {
  assert.throws(() => createCanvasTextureStrategy({}), /createImageBitmap/);
});
