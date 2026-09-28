/* ============================================================
   HEADLESS TEXTURE PATH — the "pure-JS PNG" half of the optimizer's
   dual-path texture handling (see public/vault/optimizer-core.mjs).

   The browser path decodes with createImageBitmap and re-encodes with a
   canvas; neither exists under Node. This strategy gives the tests and the
   benchmark a real, dependency-free texture pass instead of a no-op:

     PNG decode (zlib inflate + unfilter) → alpha scan → bilinear downscale
     → PNG re-encode (smaller of two deterministic filters)

   Textures that are not PNGs, or that our decoder does not support
   (16-bit, interlaced, palette…), are passed through untouched — the same
   "one bad texture must not abort the run" rule the browser path follows.
   ============================================================ */

import {
  PngError,
  decodePng,
  downscaleRgba,
  encodePng,
  hasAlphaChannel,
} from './png-codec.mjs';

/**
 * @returns {{ name: string, resize: (texture, { maxSize, role }) => Promise<object> }}
 */
export function createHeadlessTextureStrategy() {
  return {
    name: 'headless-png',

    async resize(texture, { maxSize = 2048, role = 'data' } = {}) {
      const image = texture.getImage();
      if (!image) return { changed: false, reason: 'no-image' };

      const mimeType = texture.getMimeType() || '';
      if (mimeType !== 'image/png') {
        // No decoder for JPEG/WebP/KTX2 here — keep the original bytes.
        return { changed: false, reason: 'not-png-passthrough' };
      }

      let decoded;
      try {
        decoded = decodePng(image);
      } catch (err) {
        if (err instanceof PngError) return { changed: false, reason: `png-unsupported:${err.code}` };
        throw err;
      }

      const { width, height } = decoded;
      if (Math.max(width, height) <= maxSize) {
        return { changed: false, reason: 'within-cap' };
      }

      const scaled = downscaleRgba(decoded.data, width, height, maxSize, { renormalize: role === 'normal' });
      // Opaque images are encoded as RGB PNGs — 25% smaller than RGBA.
      const colorType = hasAlphaChannel(scaled.data) ? 6 : 2;
      const encoded = encodePng({ width: scaled.width, height: scaled.height, data: scaled.data, colorType });

      if (encoded.byteLength >= image.byteLength) {
        return { changed: false, reason: 'reencode-larger' };
      }

      texture.setImage(new Uint8Array(encoded));
      // mimeType stays image/png.
      return {
        changed: true,
        reason: 'downscale',
        role,
        from: { mimeType, width, height, bytes: image.byteLength },
        to: { mimeType, width: scaled.width, height: scaled.height, bytes: encoded.byteLength },
      };
    },
  };
}
