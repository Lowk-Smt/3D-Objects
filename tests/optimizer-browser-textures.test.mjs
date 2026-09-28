/**
 * REAL canvas verification for the browser texture path.
 *
 * The decision logic in tests/optimizer.test.mjs is pinned with an injected
 * fake canvas; this file instead runs the SHIPPING strategy
 * (public/vault/optimizer-browser-textures.mjs) against a real canvas
 * implementation — real image decode, real 2D downscaling, real getImageData
 * alpha scans, and real PNG/WebP/JPEG encoders — so the claims below are
 * checked against bytes a real encoder actually produced, not a stub:
 *
 *   - normal maps and roughness/metallic data are written as real PNG
 *     (magic bytes + round-trip decode + pixel fidelity), never lossy,
 *     even when the canvas can encode WebP;
 *   - photographic colour textures DO get the lossy WebP treatment;
 *   - real alpha pixels are detected and force the lossless path;
 *   - the never-bigger rule holds against real encoded sizes.
 *
 * No browser binary is required (and none can be downloaded in every CI
 * environment); when the real-canvas devDependency is unavailable the file
 * skips loudly rather than pretending to verify anything.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Document } from "@gltf-transform/core";

import {
  createCanvasTextureStrategy,
  planTextureEncode,
  renormalizeNormalMapPixels,
} from "../public/vault/optimizer-browser-textures.mjs";
import { decodePng, encodePng } from "../scripts/lib/png-codec.mjs";

/** Real canvas environment: loadImage (real decode) + createCanvas (real 2D). */
async function loadRealCanvas() {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  return {
    async createImageBitmap(blob) {
      return loadImage(Buffer.from(await blob.arrayBuffer()));
    },
    createCanvas(width, height) {
      return createCanvas(width, height);
    },
  };
}

/**
 * A real canvas whose drawImage performs the BOX-AVERAGING filter a real
 * browser applies when downscaling. (This particular canvas build happens to
 * nearest-neighbour scaled draws, which never shortens vectors and would make
 * the renormalization test vacuous — so the averaging is installed explicitly,
 * on top of the real decode / real encode.)
 */
function averagingCanvasEnv(base) {
  return {
    async createImageBitmap(blob) {
      return base.createImageBitmap(blob);
    },
    createCanvas(width, height) {
      const canvas = base.createCanvas(width, height);
      const ctx = canvas.getContext("2d");
      const originalDrawImage = ctx.drawImage.bind(ctx);
      ctx.drawImage = (image, dx, dy, dw, dh) => {
        const targetWidth = dw ?? image.width;
        const targetHeight = dh ?? image.height;
        if (targetWidth === image.width && targetHeight === image.height) {
          return originalDrawImage(image, dx, dy, targetWidth, targetHeight);
        }
        const source = base.createCanvas(image.width, image.height);
        const sourceCtx = source.getContext("2d");
        sourceCtx.drawImage(image, 0, 0);
        const sourceData = sourceCtx.getImageData(0, 0, image.width, image.height).data;
        const frame = ctx.createImageData(targetWidth, targetHeight);
        const out = frame.data;
        for (let y = 0; y < targetHeight; y++) {
          const sy0 = Math.floor((y * image.height) / targetHeight);
          const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * image.height) / targetHeight));
          for (let x = 0; x < targetWidth; x++) {
            const sx0 = Math.floor((x * image.width) / targetWidth);
            const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * image.width) / targetWidth));
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            let n = 0;
            for (let sy = sy0; sy < sy1; sy++) {
              for (let sx = sx0; sx < sx1; sx++) {
                const i = (sy * image.width + sx) * 4;
                r += sourceData[i];
                g += sourceData[i + 1];
                b += sourceData[i + 2];
                a += sourceData[i + 3];
                n++;
              }
            }
            const o = (y * targetWidth + x) * 4;
            out[o] = r / n;
            out[o + 1] = g / n;
            out[o + 2] = b / n;
            out[o + 3] = a / n;
          }
        }
        ctx.putImageData(frame, 0, 0);
      };
      return canvas;
    },
  };
}

/** A normal map whose neighbouring vectors point in opposite directions. */
function highContrastNormalPng(size) {
  return encodePng({
    width: size,
    height: size,
    data: rgba(size, size, (x, y) => {
      const flip = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0 ? 1 : -1;
      const nx = flip * 0.7;
      const ny = flip * 0.2;
      const nz = 0.68;
      const length = Math.hypot(nx, ny, nz);
      return [
        Math.round(((nx / length) * 0.5 + 0.5) * 255),
        Math.round(((ny / length) * 0.5 + 0.5) * 255),
        Math.round(((nz / length) * 0.5 + 0.5) * 255),
        255,
      ];
    }),
  });
}

function meanVectorLength(rgbaData) {
  let total = 0;
  let count = 0;
  for (let i = 0; i < rgbaData.length; i += 4) {
    total += Math.hypot(
      (rgbaData[i] / 255) * 2 - 1,
      (rgbaData[i + 1] / 255) * 2 - 1,
      (rgbaData[i + 2] / 255) * 2 - 1,
    );
    count++;
  }
  return total / count;
}

/** Decode real encoded bytes back through the real canvas. */
async function decodeWithRealCanvas(bytes) {
  const { loadImage } = await import("@napi-rs/canvas");
  const image = await loadImage(Buffer.from(bytes));
  const probe = realCanvas.createCanvas(image.width, image.height);
  const ctx = probe.getContext("2d");
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, image.width, image.height).data;
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

/** Deterministic high-entropy RGBA, so encoded sizes track pixel counts. */
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

function magicOf(bytes, count) {
  return Buffer.from(bytes.subarray(0, count)).toString("latin1");
}

const isPng = bytes => magicOf(bytes, 8) === "\x89PNG\r\n\x1a\n";
const isWebp = bytes => magicOf(bytes, 4) === "RIFF" && magicOf(bytes.subarray(8, 12), 4) === "WEBP";
const isJpeg = bytes => magicOf(bytes, 3) === "\xff\xd8\xff";

// Loaded once, at collection time, so the skip flags below are decided
// before the runner registers the tests.
let realCanvas = null;
try {
  realCanvas = await loadRealCanvas();
} catch (err) {
  realCanvas = null;
  console.warn(`[skip] @napi-rs/canvas unavailable (${err.message}) — real-encoder checks skipped`);
}

const real = { skip: realCanvas ? undefined : "no real canvas implementation available" };

test("a real normal map is encoded as real PNG, never lossy", real, async () => {
  const strategy = createCanvasTextureStrategy(realCanvas);
  // The real encoder CAN do WebP here — the role must still win.
  assert.equal(await strategy.supportsWebp(), true, "this test is only meaningful when WebP is available");

  const doc = new Document();
  const png = encodePng({ width: 96, height: 96, data: pseudoRandomRgba(96, 96) });
  const texture = doc.createTexture("normal").setImage(png).setMimeType("image/png");

  const outcome = await strategy.resize(texture, { maxSize: 32, role: "normal" });

  assert.equal(outcome.changed, true);
  assert.equal(outcome.to.mimeType, "image/png");
  const written = texture.getImage();
  assert.ok(isPng(written), `normal map was written as ${magicOf(written, 4)} — lossy encoding of material data!`);
  assert.ok(!isWebp(written) && !isJpeg(written));

  // The real encoder really produced a 32x32 image that decodes back.
  const decoded = decodePng(written);
  assert.equal(decoded.width, 32);
  assert.equal(decoded.height, 32);
});

test("a real roughness/metallic map is encoded as real PNG", real, async () => {
  const strategy = createCanvasTextureStrategy(realCanvas);
  const doc = new Document();
  const png = encodePng({ width: 96, height: 96, data: pseudoRandomRgba(96, 96, 0x1234) });
  const texture = doc.createTexture("metallicRoughness").setImage(png).setMimeType("image/png");

  const outcome = await strategy.resize(texture, { maxSize: 32, role: "data" });

  assert.equal(outcome.changed, true);
  const written = texture.getImage();
  assert.ok(isPng(written), `material data was written as ${magicOf(written, 4)}`);
  assert.equal(decodePng(written).width, 32);
});

test("a real occlusion map is encoded as real PNG", real, async () => {
  const strategy = createCanvasTextureStrategy(realCanvas);
  const doc = new Document();
  const png = encodePng({ width: 96, height: 96, data: pseudoRandomRgba(96, 96, 0x5678) });
  const texture = doc.createTexture("occlusion").setImage(png).setMimeType("image/png");

  await strategy.resize(texture, { maxSize: 32, role: "data" });
  assert.ok(isPng(texture.getImage()), "occlusion data must stay lossless");
});

test("a real photographic colour texture IS encoded as real WebP", real, async () => {
  const strategy = createCanvasTextureStrategy(realCanvas);
  const doc = new Document();
  const png = encodePng({ width: 96, height: 96, data: pseudoRandomRgba(96, 96, 0x4321) });
  const texture = doc.createTexture("albedo").setImage(png).setMimeType("image/png");

  const outcome = await strategy.resize(texture, { maxSize: 32, role: "color" });

  assert.equal(outcome.changed, true);
  assert.equal(outcome.to.mimeType, "image/webp", "photographic colour should still get the lossy win");
  const written = texture.getImage();
  assert.ok(isWebp(written), `expected real WebP bytes, got ${magicOf(written, 4)}`);
  assert.ok(!isPng(written));
});

test("a real opaque colour texture falls back to real JPEG without WebP", real, async () => {
  // Same real canvas, but the WebP probe answers "no" — the way an older
  // browser would — so the lossy fallback must be real JPEG, never PNG.
  const env = { ...realCanvas, createCanvas: (width, height) => {
    const canvas = realCanvas.createCanvas(width, height);
    const original = canvas.toBlob.bind(canvas);
    canvas.toBlob = (cb, type, quality) => original(blob => {
      cb(blob && blob.type === "image/webp" ? null : blob);
    }, type, quality);
    return canvas;
  } };

  const strategy = createCanvasTextureStrategy(env);
  const doc = new Document();
  const png = encodePng({ width: 96, height: 96, data: pseudoRandomRgba(96, 96, 0x7777) });
  const texture = doc.createTexture("albedo").setImage(png).setMimeType("image/png");

  const outcome = await strategy.resize(texture, { maxSize: 32, role: "color" });

  assert.equal(outcome.to.mimeType, "image/jpeg");
  const written = texture.getImage();
  assert.ok(isJpeg(written), `expected real JPEG bytes, got ${magicOf(written, 4)}`);
});

test("real alpha pixels force the lossless path for a colour texture", real, async () => {
  const strategy = createCanvasTextureStrategy(realCanvas);
  const doc = new Document();
  // A real cutout: half the pixels are fully transparent.
  const png = encodePng({
    width: 96,
    height: 96,
    data: rgba(96, 96, (x, y) => [pseudoRandomRgba(1, 1, x * 31 + y)[0], 120, 200, x < 48 ? 0 : 255]),
  });
  const texture = doc.createTexture("decal").setImage(png).setMimeType("image/png");

  const outcome = await strategy.resize(texture, { maxSize: 32, role: "color" });

  assert.equal(outcome.changed, true);
  assert.equal(outcome.to.mimeType, "image/png", "alpha must not be lossy-encoded");
  assert.ok(isPng(texture.getImage()));
  // The real decoded result still carries transparency.
  const decoded = decodePng(texture.getImage());
  let transparentPixels = 0;
  for (let i = 3; i < decoded.data.length; i += 4) if (decoded.data[i] === 0) transparentPixels++;
  assert.ok(transparentPixels > 0, "the cutout must survive the round trip");
});

test("the real downscale preserves the image's structure", real, async () => {
  const strategy = createCanvasTextureStrategy(realCanvas);
  const doc = new Document();
  // A smooth gradient: the downscaled result must still be a gradient, i.e.
  // the real canvas really resampled rather than cropping or padding.
  const png = encodePng({
    width: 128,
    height: 128,
    data: rgba(128, 128, (x) => [Math.round((x / 127) * 255), 0, 0, 255]),
  });
  const texture = doc.createTexture("albedo").setImage(png).setMimeType("image/png");

  await strategy.resize(texture, { maxSize: 32, role: "color" });
  assert.equal(texture.getMimeType(), "image/webp");

  // Decode the REAL encoded bytes back through the real canvas.
  const { loadImage } = await import("@napi-rs/canvas");
  const image = await loadImage(Buffer.from(texture.getImage()));
  assert.equal(image.width, 32);
  const probe = realCanvas.createCanvas(32, 32);
  const ctx = probe.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, 32, 32);

  const redAt = x => data[x * 4];
  assert.ok(redAt(0) < 40, `left edge should be dark red, got ${redAt(0)}`);
  assert.ok(redAt(31) > 215, `right edge should be bright red, got ${redAt(31)}`);
  assert.ok(redAt(16) > redAt(0) && redAt(16) < redAt(31), "the middle must sit between the edges");
});

test("the real encoded result is never larger than the original bytes", real, async () => {
  const strategy = createCanvasTextureStrategy(realCanvas);
  const doc = new Document();
  const original = encodePng({ width: 8, height: 8, data: rgba(8, 8, () => [10, 20, 30, 255]) });
  const texture = doc.createTexture("albedo").setImage(original).setMimeType("image/png");

  const outcome = await strategy.resize(texture, { maxSize: 2048, role: "color" });
  const written = texture.getImage();

  if (outcome.changed) {
    // Whatever the real encoder produced, it must actually be smaller.
    assert.ok(written.byteLength < original.byteLength,
      `re-encode grew the file: ${original.byteLength}B → ${written.byteLength}B`);
  } else {
    // Or the original bytes survived untouched.
    assert.equal(written, original);
    assert.equal(outcome.reason === "reencode-larger" || outcome.reason === "lossy-optimal", true);
  }
});

test("a real re-encode that would grow a data texture is discarded", real, async () => {
  // In-cap normal map: no downscale, and PNG is already lossless-optimal, so
  // the real encoder must never even be consulted.
  const strategy = createCanvasTextureStrategy(realCanvas);
  const doc = new Document();
  const original = encodePng({ width: 8, height: 8, data: pseudoRandomRgba(8, 8) });
  const texture = doc.createTexture("normal").setImage(original).setMimeType("image/png");

  const outcome = await strategy.resize(texture, { maxSize: 2048, role: "normal" });

  assert.equal(outcome.changed, false);
  assert.equal(outcome.reason, "lossless-optimal");
  assert.equal(texture.getImage(), original);
  assert.ok(isPng(texture.getImage()));
});

test("the role survives into the strategy outcome for observability", real, async () => {
  const strategy = createCanvasTextureStrategy(realCanvas);
  const doc = new Document();
  const png = encodePng({ width: 96, height: 96, data: pseudoRandomRgba(96, 96, 0xdead) });
  const texture = doc.createTexture("normal").setImage(png).setMimeType("image/png");

  const outcome = await strategy.resize(texture, { maxSize: 32, role: "normal" });
  assert.equal(outcome.role, "normal");
  assert.equal(outcome.reason, "downscale");
  assert.deepEqual(Object.keys(outcome.from).sort(), ["bytes", "height", "mimeType", "width"]);
  assert.deepEqual(Object.keys(outcome.to).sort(), ["bytes", "height", "mimeType", "width"]);
});

test("a real downscaled browser normal map stays unit-length after decoding", real, async () => {
  const env = averagingCanvasEnv(realCanvas);
  const strategy = createCanvasTextureStrategy(env);

  const doc = new Document();
  const png = highContrastNormalPng(96);
  const texture = doc.createTexture("normal").setImage(png).setMimeType("image/png");

  const outcome = await strategy.resize(texture, { maxSize: 32, role: "normal" });
  assert.equal(outcome.changed, true);
  assert.equal(outcome.to.mimeType, "image/png");
  assert.ok(isPng(texture.getImage()), "normal maps must be written losslessly");

  // Decode the REAL encoded bytes and check every vector is ~unit length.
  const decoded = await decodeWithRealCanvas(texture.getImage());
  assert.equal(decoded.length, 32 * 32 * 4);
  for (let i = 0; i < decoded.length; i += 4) {
    const length = Math.hypot(
      (decoded[i] / 255) * 2 - 1,
      (decoded[i + 1] / 255) * 2 - 1,
      (decoded[i + 2] / 255) * 2 - 1,
    );
    assert.ok(Math.abs(length - 1) < 0.05, `normal ${i / 4} has length ${length.toFixed(3)}`);
  }
});

test("the same averaging filter WITHOUT renormalization would corrupt the map", real, async () => {
  // The control: proves this test can actually detect the bug it guards
  // against — the averaging filter really does shorten these vectors.
  const env = averagingCanvasEnv(realCanvas);
  const { loadImage } = await import("@napi-rs/canvas");
  const image = await loadImage(Buffer.from(highContrastNormalPng(96)));

  const canvas = env.createCanvas(32, 32);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, 32, 32);
  const filtered = ctx.getImageData(0, 0, 32, 32).data;

  assert.ok(meanVectorLength(filtered) < 0.9,
    `expected the averaging filter to shorten vectors, mean was ${meanVectorLength(filtered).toFixed(3)}`);

  // ...and renormalizing the very same frame restores them.
  const repaired = new Uint8ClampedArray(filtered);
  renormalizeNormalMapPixels(repaired, 32, 32);
  assert.ok(Math.abs(meanVectorLength(repaired) - 1) < 0.02,
    `renormalization should restore unit length, mean was ${meanVectorLength(repaired).toFixed(3)}`);
});

test("a real colour texture is untouched by the renormalization step", real, async () => {
  // The averaging filter applies to colour textures too, but colour vectors
  // must NOT be renormalized — doing so would warp photographic colours. A
  // smooth gradient gives an exact expected value for every output pixel, so
  // any warp (renormalization included) shows up as a large per-channel error.
  const size = 96;
  const source = rgba(size, size, (x, y) => [
    Math.round(30 + (200 * x) / (size - 1)),
    Math.round(60 + (150 * y) / (size - 1)),
    Math.round(255 - (220 * x) / (size - 1)),
    255,
  ]);
  const expected = [];
  for (let oy = 0; oy < 32; oy++) {
    for (let ox = 0; ox < 32; ox++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = oy * 3; sy < oy * 3 + 3; sy++) {
        for (let sx = ox * 3; sx < ox * 3 + 3; sx++) {
          const i = (sy * size + sx) * 4;
          r += source[i];
          g += source[i + 1];
          b += source[i + 2];
          n++;
        }
      }
      expected.push(r / n, g / n, b / n);
    }
  }

  const env = averagingCanvasEnv(realCanvas);
  const strategy = createCanvasTextureStrategy(env);
  const doc = new Document();
  const png = encodePng({ width: size, height: size, data: source });
  const texture = doc.createTexture("albedo").setImage(png).setMimeType("image/png");

  const outcome = await strategy.resize(texture, { maxSize: 32, role: "color" });
  assert.equal(outcome.to.mimeType, "image/webp", "colour still takes the lossy path");
  assert.ok(isWebp(texture.getImage()));

  const decoded = await decodeWithRealCanvas(texture.getImage());
  let worst = 0;
  for (let i = 0; i < decoded.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      worst = Math.max(worst, Math.abs(decoded[i + c] - expected[(i / 4) * 3 + c]));
    }
  }
  assert.ok(
    worst < 12,
    "colour pixels should match the plain average (worst channel delta " + worst.toFixed(1) +
      "); re-normalizing colour data would produce much larger errors",
  );
});
