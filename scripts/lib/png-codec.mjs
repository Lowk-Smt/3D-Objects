/* ============================================================
   PNG CODEC — dependency-free (Node zlib only) decode / encode used by the
   headless half of the optimizer's dual-path texture handling
   (scripts/lib/headless-textures.mjs) and by the crate fixture builder
   (scripts/lib/crate-fixture.mjs).

   Supported: 8-bit, non-interlaced, color types 0 (gray), 2 (RGB),
   4 (gray+alpha), 6 (RGBA). Anything else raises a PngError with a stable
   `code` so callers can pass such textures through untouched instead of
   failing the whole optimization.
   ============================================================ */

import { inflateSync, deflateSync } from 'node:zlib';

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CHUNK_IHDR = 0x49484452;
const CHUNK_IDAT = 0x49444154;
const CHUNK_IEND = 0x49454e44;

const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 4: 2, 6: 4 };

export class PngError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PngError';
    this.code = code;
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeChunk(type, data) {
  const out = new Uint8Array(8 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  view.setUint32(4, type, false);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode a PNG to straight RGBA8.
 * @returns {{ width: number, height: number, colorType: number, data: Uint8Array }}
 */
export function decodePng(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new PngError('BAD_SIGNATURE', 'not a PNG file');
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const idatParts = [];
  let sawIend = false;

  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint32(offset, false);
    const type = view.getUint32(offset + 4, false);
    const start = offset + 8;
    if (start + length > bytes.length) throw new PngError('TRUNCATED', 'chunk runs past the end of the file');
    const data = bytes.subarray(start, start + length);

    if (type === CHUNK_IHDR) {
      const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = header.getUint32(0, false);
      height = header.getUint32(4, false);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === CHUNK_IDAT) {
      idatParts.push(data);
    } else if (type === CHUNK_IEND) {
      sawIend = true;
      break;
    }
    offset = start + length + 4; // skip CRC
  }

  if (!sawIend) throw new PngError('TRUNCATED', 'no IEND chunk');
  if (!width || !height) throw new PngError('BAD_IHDR', 'missing or zero-sized IHDR');
  if (bitDepth !== 8) throw new PngError('UNSUPPORTED_BIT_DEPTH', `only 8-bit PNGs are supported (got ${bitDepth})`);
  if (interlace !== 0) throw new PngError('UNSUPPORTED_INTERLACE', 'interlaced PNGs are not supported');
  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (!channels) throw new PngError('UNSUPPORTED_COLOR_TYPE', `color type ${colorType} is not supported`);
  if (!idatParts.length) throw new PngError('MISSING_IDAT', 'no image data');

  const compressedLength = idatParts.reduce((n, part) => n + part.length, 0);
  const compressed = new Uint8Array(compressedLength);
  let cursor = 0;
  for (const part of idatParts) {
    compressed.set(part, cursor);
    cursor += part.length;
  }

  const raw = inflateSync(compressed);
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (raw.length < expected) throw new PngError('TRUNCATED', 'inflated data is shorter than the image');

  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const lineStart = y * (stride + 1);
    const filter = raw[lineStart];
    const line = raw.subarray(lineStart + 1, lineStart + 1 + stride);
    const current = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? current[x - channels] : 0;
      const b = previous ? previous[x] : 0;
      const c = previous && x >= channels ? previous[x - channels] : 0;
      let value;
      switch (filter) {
        case 0: value = line[x]; break;
        case 1: value = line[x] + a; break;
        case 2: value = line[x] + b; break;
        case 3: value = line[x] + ((a + b) >> 1); break;
        case 4: value = line[x] + paeth(a, b, c); break;
        default: throw new PngError('BAD_FILTER', `unknown filter type ${filter}`);
      }
      current[x] = value & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const src = i * channels;
    const dst = i * 4;
    if (colorType === 6) {
      rgba[dst] = pixels[src];
      rgba[dst + 1] = pixels[src + 1];
      rgba[dst + 2] = pixels[src + 2];
      rgba[dst + 3] = pixels[src + 3];
    } else if (colorType === 2) {
      rgba[dst] = pixels[src];
      rgba[dst + 1] = pixels[src + 1];
      rgba[dst + 2] = pixels[src + 2];
      rgba[dst + 3] = 255;
    } else if (colorType === 0) {
      rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = pixels[src];
      rgba[dst + 3] = 255;
    } else {
      rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = pixels[src];
      rgba[dst + 3] = pixels[src + 1];
    }
  }

  return { width, height, colorType, data: rgba };
}

function buildScanlines(width, height, rgba, colorType, filter) {
  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  const stride = width * channels;
  const lines = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const lineStart = y * (stride + 1);
    lines[lineStart] = filter;
    for (let x = 0; x < stride; x++) {
      const pixel = Math.floor(x / channels);
      const channel = x % channels;
      const current = rgba[(y * width + pixel) * 4 + channel];
      if (filter === 2 && y > 0) {
        const up = rgba[((y - 1) * width + pixel) * 4 + channel];
        lines[lineStart + 1 + x] = (current - up) & 0xff;
      } else {
        lines[lineStart + 1 + x] = current;
      }
    }
  }
  return lines;
}

/**
 * Encode straight RGBA8 as a PNG.
 * @param {{ width: number, height: number, data: Uint8Array, colorType?: 2|6 }}
 *        colorType defaults to 6 (RGBA); pass 2 to drop the alpha channel and
 *        emit a smaller RGB file when the image is known to be opaque.
 */
export function encodePng({ width, height, data, colorType = 6 }) {
  if (!width || !height) throw new PngError('BAD_SIZE', 'width and height must be positive');
  if (data.length < width * height * 4) throw new PngError('BAD_SIZE', 'pixel buffer is too small');
  if (colorType !== 2 && colorType !== 6) throw new PngError('UNSUPPORTED_COLOR_TYPE', 'only RGB and RGBA encoding is supported');

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  // compression 0, filter 0, interlace 0

  // Two candidate filters; keep whichever deflates smaller. Deterministic.
  const noneLines = buildScanlines(width, height, data, colorType, 0);
  const upLines = buildScanlines(width, height, data, colorType, 2);
  const noneDeflated = deflateSync(noneLines, { level: 9 });
  const upDeflated = deflateSync(upLines, { level: 9 });
  const idat = upDeflated.length < noneDeflated.length ? upDeflated : noneDeflated;

  const out = [];
  out.push(PNG_SIGNATURE);
  out.push(writeChunk(CHUNK_IHDR, ihdr));
  out.push(writeChunk(CHUNK_IDAT, idat));
  out.push(writeChunk(CHUNK_IEND, new Uint8Array(0)));

  const total = out.reduce((n, part) => n + part.length, 0);
  const png = new Uint8Array(total);
  let cursor = 0;
  for (const part of out) {
    png.set(part, cursor);
    cursor += part.length;
  }
  return png;
}

/** True when any pixel is not fully opaque. */
export function hasAlphaChannel(rgba) {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) return true;
  }
  return false;
}

/**
 * Bilinear downscale of straight RGBA8 so the longest edge fits maxSize.
 * Never upscales. Returns the new dimensions alongside the pixels.
 */
export function downscaleRgba(rgba, width, height, maxSize) {
  const longest = Math.max(width, height);
  const scale = Math.min(1, maxSize / longest);
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));

  const out = new Uint8Array(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y++) {
    const sy = Math.min(height - 1, Math.max(0, (y + 0.5) * height / outHeight - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < outWidth; x++) {
      const sx = Math.min(width - 1, Math.max(0, (x + 0.5) * width / outWidth - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sx - x0;
      for (let c = 0; c < 4; c++) {
        const p00 = rgba[(y0 * width + x0) * 4 + c];
        const p01 = rgba[(y0 * width + x1) * 4 + c];
        const p10 = rgba[(y1 * width + x0) * 4 + c];
        const p11 = rgba[(y1 * width + x1) * 4 + c];
        const top = p00 + (p01 - p00) * fx;
        const bottom = p10 + (p11 - p10) * fx;
        out[(y * outWidth + x) * 4 + c] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return { width: outWidth, height: outHeight, data: out };
}
