/* ============================================================
   BROWSER TEXTURE PATH — the "canvas" half of the optimizer's dual-path
   texture handling (see optimizer-core.mjs).

   Per texture, the browser path:
     1. decodes the image with createImageBitmap (hardware decode),
     2. scans the decoded pixels for a real alpha channel,
     3. picks an output codec from that scan + a one-time WebP capability
        probe:  alpha → lossless (WebP, else PNG);  opaque → lossy
        (WebP, else JPEG), because a lossless PNG of an opaque photo is
        usually several times larger than a quality JPEG,
     4. downscales with a canvas when the texture exceeds the preset cap,
     5. keeps the ORIGINAL bytes whenever the re-encode would grow the file.

   The decision logic (planTextureEncode / pickOutputFormat) is pure and
   exported so tests can pin it without a browser; everything that touches
   the DOM is injected through `env`, which the tests fake.
   ============================================================ */

const PNG_MIME = 'image/png';
const JPEG_MIME = 'image/jpeg';
const WEBP_MIME = 'image/webp';

/**
 * Which codec should carry this texture? Pure.
 *
 * Lossy encoders (JPEG, and WebP as browsers expose it through
 * canvas.toBlob) are only ever chosen for photographic, opaque COLOUR data.
 * Normal maps, packed roughness/metallic, occlusion, masks and every other
 * material-DATA texture must stay lossless PNG — chroma subsampling and
 * quantization silently corrupt them. Alpha gets the same treatment: lossy
 * alpha encoding eats cutout edges.
 */
export function pickOutputFormat({ hasAlpha, webpSupported, role = 'data' }) {
  if (role !== 'color' || hasAlpha) return PNG_MIME;
  return webpSupported ? WEBP_MIME : JPEG_MIME;
}

/**
 * Decide whether a texture should be re-encoded at all, and to what.
 * Pure: no DOM, no timers. Returns
 *   { reencode: boolean, outputType: string, reason: string }
 */
export function planTextureEncode({
  mimeType = JPEG_MIME,
  hasAlpha = false,
  webpSupported = false,
  needsDownscale = false,
  role = 'data',
} = {}) {
  const normalized = String(mimeType || JPEG_MIME).toLowerCase();
  // Anything that is not photographic, or that carries an alpha channel,
  // may only be written losslessly.
  const mustStayLossless = role !== 'color' || hasAlpha;

  if (needsDownscale) {
    return {
      reencode: true,
      outputType: pickOutputFormat({ hasAlpha, webpSupported, role }),
      reason: 'downscale',
    };
  }

  if (mustStayLossless) {
    // Already lossless PNG and within the cap: re-encoding buys nothing.
    if (normalized === PNG_MIME) {
      return { reencode: false, outputType: PNG_MIME, reason: 'lossless-optimal' };
    }
    // A data texture shipped as JPEG keeps its bytes: re-encoding to PNG
    // cannot restore what JPEG already threw away, and only grows the file.
    return { reencode: false, outputType: normalized, reason: 'lossless-optimal' };
  }

  if (normalized === PNG_MIME) {
    return { reencode: true, outputType: webpSupported ? WEBP_MIME : JPEG_MIME, reason: 'png-to-lossy' };
  }
  if (webpSupported && normalized === JPEG_MIME) {
    return { reencode: true, outputType: WEBP_MIME, reason: 'jpeg-to-webp' };
  }
  return { reencode: false, outputType: normalized, reason: 'lossy-optimal' };
}

/**
 * One 8-bit step per channel is 2/255 in tangent space. A vector shorter than
 * that carries no resolvable direction (a flat/degenerate pixel), so
 * renormalizing it would only amplify quantization noise into a bogus
 * direction. The headless path uses the same threshold.
 */
const DEGENERATE_NORMAL_LENGTH = 2 / 255;

/**
 * Renormalize tangent-space normal-map pixels in place (RGBA8).
 *
 * Bilinear canvas filtering averages normalized vectors, which shortens and
 * biases them — a filtered normal map no longer describes unit-length
 * surface directions, so light bends wrongly. This reads the RGB channels as
 * tangent-space vectors (n = rgb/255*2-1), restores unit length and writes
 * the RGB channels back. Alpha is left untouched.
 *
 * Pure and exported so it can be tested without a canvas.
 */
export function renormalizeNormalMapPixels(data, width, height) {
  const pixelCount = width * height;
  for (let i = 0; i < pixelCount; i++) {
    const offset = i * 4;
    const nx = (data[offset] / 255) * 2 - 1;
    const ny = (data[offset + 1] / 255) * 2 - 1;
    const nz = (data[offset + 2] / 255) * 2 - 1;
    const length = Math.hypot(nx, ny, nz);
    if (length < DEGENERATE_NORMAL_LENGTH) continue; // noise, not a direction
    data[offset] = Math.round(((nx / length) * 0.5 + 0.5) * 255);
    data[offset + 1] = Math.round(((ny / length) * 0.5 + 0.5) * 255);
    data[offset + 2] = Math.round(((nz / length) * 0.5 + 0.5) * 255);
  }
  return data;
}

function defaultCreateCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** One-time probe: can this browser's canvas encode WebP? (Async, cached per strategy.) */
export function probeWebpSupport(createCanvas) {
  return new Promise(resolve => {
    try {
      const canvas = createCanvas(2, 2);
      canvas.toBlob(blob => resolve(Boolean(blob) && blob.type === WEBP_MIME), WEBP_MIME);
    } catch {
      resolve(false);
    }
  });
}

/** Full decode + alpha scan with early exit; false when the texture is opaque. */
async function detectAlpha(bitmap, createCanvas) {
  const canvas = createCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true;
  }
  return false;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error(`canvas could not encode ${type}`))), type, quality);
  });
}

/**
 * Create the browser texture strategy consumed by optimizer-core.mjs.
 *
 * @param {object} [env] injectable environment (tests):
 *        { createImageBitmap, createCanvas } — both default to the browser's.
 * @returns {{ name: string, supportsWebp: () => Promise<boolean>,
 *            resize: (texture, { maxSize, quality }) => Promise<object> }}
 */
export function createCanvasTextureStrategy(env = {}) {
  const createImageBitmap = env.createImageBitmap || globalThis.createImageBitmap;
  const createCanvas = env.createCanvas || defaultCreateCanvas;

  if (typeof createImageBitmap !== 'function') {
    throw new Error('createCanvasTextureStrategy requires createImageBitmap (browser only)');
  }

  let webpProbe = null;
  const supportsWebp = () => {
    if (!webpProbe) webpProbe = probeWebpSupport(createCanvas);
    return webpProbe;
  };

  return {
    name: 'canvas',

    supportsWebp,

    async resize(texture, { maxSize = 2048, quality = 0.85, role = 'data' } = {}) {
      const image = texture.getImage();
      if (!image) return { changed: false, reason: 'no-image' };

      const mimeType = texture.getMimeType() || JPEG_MIME;
      const bitmap = await createImageBitmap(new Blob([image], { type: mimeType }));
      try {
        const width = bitmap.width;
        const height = bitmap.height;
        const needsDownscale = Math.max(width, height) > maxSize;

        const hasAlpha = await detectAlpha(bitmap, createCanvas);
        const plan = planTextureEncode({
          mimeType,
          hasAlpha,
          webpSupported: await supportsWebp(),
          needsDownscale,
          role,
        });

        if (!plan.reencode) {
          return { changed: false, reason: plan.reason, role, outputType: plan.outputType };
        }

        const scale = needsDownscale ? maxSize / Math.max(width, height) : 1;
        const outWidth = Math.max(1, Math.round(width * scale));
        const outHeight = Math.max(1, Math.round(height * scale));

        const canvas = createCanvas(outWidth, outHeight);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, outWidth, outHeight);

        // Canvas filtering averages normalized vectors: a downscaled normal
        // map must be renormalized before it is written, or every filtered
        // pixel describes a shortened, biased direction.
        if (role === 'normal') {
          const frame = ctx.getImageData(0, 0, outWidth, outHeight);
          renormalizeNormalMapPixels(frame.data, outWidth, outHeight);
          ctx.putImageData(frame, 0, 0);
        }

        const encodeQuality = plan.outputType === PNG_MIME ? undefined : quality;
        const blob = await canvasToBlob(canvas, plan.outputType, encodeQuality);
        const buffer = new Uint8Array(await blob.arrayBuffer());

        // Per-texture "never bigger": a same-size re-encode that grew the
        // bytes is not an optimization — keep what the model shipped with.
        if (!needsDownscale && buffer.byteLength >= image.byteLength) {
          return { changed: false, reason: 'reencode-larger' };
        }

        texture.setImage(buffer);
        texture.setMimeType(plan.outputType);
        return {
          changed: true,
          reason: plan.reason,
          role,
          from: { mimeType, width, height, bytes: image.byteLength },
          to: { mimeType: plan.outputType, width: outWidth, height: outHeight, bytes: buffer.byteLength },
        };
      } finally {
        if (typeof bitmap.close === 'function') bitmap.close();
      }
    },
  };
}
