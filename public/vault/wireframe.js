/* ============================================================
   Wireframe edge extraction (shared)

   This module is the ONE source of truth for "which line segments does the
   wireframe overlay draw". It is loaded in three places:

     1. public/vault/wireframe-worker.js  — a real Web Worker that runs it
        off the main thread so large models never freeze the UI.
     2. public/vault/app.js               — the synchronous fallback path,
        used only when Workers are unavailable or worker messaging fails.
     3. tests/wireframe-edges.test.mjs    — A/B compared against the REAL
        THREE.EdgesGeometry from the exact installed three@0.169.0.

   It must therefore stay dependency-free and environment-neutral: no DOM,
   no `window`, no three.js import. Everything is plain ArrayBuffer /
   typed-array math, ES2017 syntax only.

   The algorithm reproduces THREE.EdgesGeometry(geometry, thresholdAngle)
   exactly (three r169):

     - triangles are walked 3 vertices at a time (indexed via the index
       attribute, otherwise sequentially);
     - each vertex is hashed by its position quantised to 4 decimals
       (`Math.round(x * 10^4)`), and degenerate triangles whose quantised
       vertices collide are skipped;
     - the hash (not an exact key) is what makes position-coincident but
       topologically separate vertices share an edge — three.js' crease
       detection;
     - for every mesh edge we look for the reverse-direction sibling; when
       the two face normals diverge by more than thresholdAngle we emit the
       segment (v0 -> v1) using the CURRENT triangle's vertex values, then
       drop both from the map;
     - edges that never find a sibling (boundary edges) are emitted at the
       very end using their stored original vertex indices.

   The output is a flat Float32Array of XYZ pairs — exactly the buffer
   THREE.EdgesGeometry puts on its `position` attribute — so a LineSegments
   built from it looks pixel-identical to the old synchronous code while
   being produced without blocking the main thread.
   ============================================================ */

export const DEFAULT_THRESHOLD_ANGLE = 25;
export const EDGE_PRECISION_POINTS = 4;
/** 2 XYZ vertices per emitted line segment. */
export const FLOATS_PER_SEGMENT = 6;

/** Absolute URL of the worker entry, used to build its Blob shim. */
export const WORKER_FILE_URL = new URL('./wireframe-worker.js', import.meta.url).href;

/**
 * Tightly packed floating-point position array (Float32 or Float64), safe for
 * direct index-based access without readVertex overhead.
 */
export function tightlyPackedFloatPositions(attr) {
  if (!attr || !attr.array) return null;
  if (attr.itemSize !== 3) return null;
  if (attr.normalized) return null;
  if (attr.isInterleavedBufferAttribute) return null;
  if (attr.array instanceof Float32Array || attr.array instanceof Float64Array) {
    return attr.array;
  }
  return null;
}

/**
 * Positions are packed into a tightly packed Float32Array only when the
 * source `position` attribute is itself a plain, non-normalized, tightly
 * packed Float32 attribute. Interleaved (stride) buffers, normalized
 * integer buffers and non-float buffers all fall back to the safe
 * per-attribute read path.
 *
 * @param {{array:ArrayLike<number>, itemSize:number, normalized?:boolean,
 *          isInterleavedBufferAttribute?:boolean}|null} attr
 * @returns {Float32Array|null}
 */
export function packPositionAttribute(attr) {
  if (!attr || !attr.array) return null;
  if (attr.itemSize !== 3) return null;
  if (attr.normalized) return null;
  if (attr.isInterleavedBufferAttribute) return null;
  if (!(attr.array instanceof Float32Array)) return null;
  return attr.array;
}

/**
 * Read vertex `index` (X, Y, Z) from a three.js BufferAttribute-shaped
 * object, matching BufferAttribute.getX/getY/getZ and
 * InterleavedBufferAttribute.getX/getY/getZ semantics (including integer
 * normalisation and stride/offset handling).
 *
 * @returns {{x:number, y:number, z:number}}
 */
export function readVertex(attr, index) {
  if (attr.isInterleavedBufferAttribute) {
    const data = attr.data;
    const array = data.array;
    const base = index * data.stride + (attr.offset || 0);
    let x = array[base];
    let y = array[base + 1];
    let z = array[base + 2];
    if (attr.normalized) {
      x = denormalize(x, array);
      y = denormalize(y, array);
      z = denormalize(z, array);
    }
    return { x, y, z };
  }

  const array = attr.array;
  const base = index * attr.itemSize;
  let x = array[base];
  let y = array[base + 1];
  let z = array[base + 2];
  if (attr.normalized) {
    x = denormalize(x, array);
    y = denormalize(y, array);
    z = denormalize(z, array);
  }
  return { x, y, z };
}

/**
 * Vertex count of a position attribute.
 *
 * A real BufferAttribute exposes `count`; the worker rebuilds a lightweight
 * descriptor instead (it only ever sees typed arrays), so the count is derived
 * from the array length and the stride when it is absent. Getting this wrong
 * silently produces an EMPTY wireframe for every non-indexed geometry, which
 * is exactly why tests/wireframe-edges.test.mjs drives the worker payload end
 * to end.
 */
export function positionCount(attr) {
  if (!attr || !attr.array) return 0;
  if (typeof attr.count === 'number') return attr.count;
  const interleaved = !!attr.isInterleavedBufferAttribute;
  const stride = interleaved ? attr.data.stride : (attr.itemSize || 3);
  const offset = interleaved ? (attr.offset || 0) : 0;
  if (!stride) return 0;
  return Math.floor((attr.array.length - offset) / stride);
}

/** Mirrors three.js MathUtils.denormalize for the integer array types. */
export function denormalize(value, array) {
  switch (array.constructor) {
    case Float32Array:
    case Float64Array:
      return value;
    case Uint32Array:
      return value / 4294967295.0;
    case Uint16Array:
      return value / 65535.0;
    case Uint8Array:
      return value / 255.0;
    case Int32Array:
      return Math.max(value / 2147483647.0, -1);
    case Int16Array:
      return Math.max(value / 32767.0, -1);
    case Int8Array:
      return Math.max(value / 127.0, -1);
    default:
      throw new Error('Wireframe: unsupported normalized attribute array type');
  }
}

/**
 * Extract wireframe edges from a geometry.
 *
 * @param {object} geometry a three.js BufferGeometry-shaped object; only
 *   `getIndex()` and `getAttribute('position')` are required.
 * @param {number} [thresholdAngle] degrees; faces whose normals diverge by
 *   more than this are treated as a hard edge.
 * @returns {Float32Array} flat XYZ pairs ready for a BufferAttribute.
 */
export function extractWireframeEdges(geometry, thresholdAngle = DEFAULT_THRESHOLD_ANGLE) {
  const positionAttr = geometry && geometry.getAttribute ? geometry.getAttribute('position') : null;
  if (!positionAttr) return new Float32Array(0);

  const thresholdDot = Math.cos((Math.PI / 180) * thresholdAngle);
  // Fast path: any tightly packed floating-point XYZ array. The worker always
  // hands us one (Float32Array for standard attributes, Float64Array when the
  // source had to be gathered), so its inner loop never allocates.
  const packed = tightlyPackedFloatPositions(positionAttr);

  const fast = packed !== null;
  const px = packed || positionAttr.array;

  const indexAttr = geometry.getIndex ? geometry.getIndex() : null;
  const indexCount = indexAttr ? indexAttr.count : positionCount(positionAttr);

  const vertices = [];
  /** key -> { index0, index1, nx, ny, nz } | null */
  const edgeData = new Map();

  for (let i = 0; i < indexCount; i += 3) {
    let i0, i1, i2;
    if (indexAttr) {
      i0 = indexAttr.getX(i);
      i1 = indexAttr.getX(i + 1);
      i2 = indexAttr.getX(i + 2);
    } else {
      i0 = i;
      i1 = i + 1;
      i2 = i + 2;
    }

    const a = fast ? vertexFromPacked(px, i0) : readVertex(positionAttr, i0);
    const b = fast ? vertexFromPacked(px, i1) : readVertex(positionAttr, i1);
    const c = fast ? vertexFromPacked(px, i2) : readVertex(positionAttr, i2);

    // Face normal — matches Triangle.getNormal: (c - b) x (a - b), then normalize.
    let nx = (c.y - b.y) * (a.z - b.z) - (c.z - b.z) * (a.y - b.y);
    let ny = (c.z - b.z) * (a.x - b.x) - (c.x - b.x) * (a.z - b.z);
    let nz = (c.x - b.x) * (a.y - b.y) - (c.y - b.y) * (a.x - b.x);
    const lengthSq = nx * nx + ny * ny + nz * nz;
    if (lengthSq > 0) {
      const inv = 1 / Math.sqrt(lengthSq);
      nx *= inv;
      ny *= inv;
      nz *= inv;
    }

    // Position hashes (quantised to 4 decimals) for the three corners.
    const h0 = hashVertex(a);
    const h1 = hashVertex(b);
    const h2 = hashVertex(c);

    // Skip degenerate triangles exactly like three.js does.
    if (h0 === h1 || h1 === h2 || h2 === h0) continue;

    const indexArr = [i0, i1, i2];
    const hashes = [h0, h1, h2];
    const corners = [a, b, c];

    for (let j = 0; j < 3; j++) {
      const jNext = (j + 1) % 3;
      const vecHash0 = hashes[j];
      const vecHash1 = hashes[jNext];
      const v0 = corners[j];
      const v1 = corners[jNext];

      const hash = `${vecHash0}_${vecHash1}`;
      const reverseHash = `${vecHash1}_${vecHash0}`;

      const sibling = edgeData.get(reverseHash);
      if (sibling !== undefined && sibling !== null) {
        // Sibling edge found: emit if the crease is sharp enough, then drop both.
        if (nx * sibling.nx + ny * sibling.ny + nz * sibling.nz <= thresholdDot) {
          vertices.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z);
        }
        edgeData.set(reverseHash, null);
      } else if (!edgeData.has(hash)) {
        edgeData.set(hash, { index0: indexArr[j], index1: indexArr[jNext], nx, ny, nz });
      }
    }
  }

  // Remaining unmatched (boundary) edges.
  for (const entry of edgeData.values()) {
    if (!entry) continue;
    const v0 = fast ? vertexFromPacked(px, entry.index0) : readVertex(positionAttr, entry.index0);
    const v1 = fast ? vertexFromPacked(px, entry.index1) : readVertex(positionAttr, entry.index1);
    vertices.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z);
  }

  return Float32Array.from(vertices);
}

/**
 * Pack a position attribute into a tightly packed XYZ array.
 *
 * - Standard tightly packed Float32 attributes are returned as-is (this is the
 *   fast path — the caller only has to copy them once).
 * - InterleavedBufferAttribute is the important case: the XYZ components are
 *   strided inside a larger buffer, so they are gathered into a packed array
 *   FIRST, through three.js' own getX/getY/getZ semantics.
 * - Normalized integer and non-float buffers are gathered the same way, into a
 *   Float64Array so no precision is lost versus reading the attribute directly.
 *
 * @returns {{array:Float32Array|Float64Array, fast:boolean}|null}
 */
export function packVertexPositions(attr) {
  if (!attr || !attr.array) return null;

  const fast = packPositionAttribute(attr);
  if (fast) return { array: fast, fast: true };

  const count = positionCount(attr);
  const source = attr.isInterleavedBufferAttribute ? attr.data.array : attr.array;
  const useFloat32 = !attr.normalized && source instanceof Float32Array;
  const out = useFloat32 ? new Float32Array(count * 3) : new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const v = readVertex(attr, i);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  return { array: out, fast: false };
}

/**
 * Build the worker message for one geometry, plus the transferable list.
 *
 * Every buffer is a COPY: the geometry's own position/index arrays are still
 * being rendered on the main thread, so detaching them is never acceptable.
 * The worker only ever receives tightly packed XYZ positions, so its inner
 * loop has a single, allocation-free shape.
 *
 * @returns {{message:object, transfer:ArrayBuffer[]}}
 */
export function buildWorkerPayload(geometry, id, thresholdAngle = DEFAULT_THRESHOLD_ANGLE) {
  const message = {
    type: 'extract',
    id,
    thresholdAngle,
    positions: null,
    position: null,
    index: null
  };
  const transfer = [];

  const index = geometry.getIndex ? geometry.getIndex() : null;
  if (index) {
    const count = index.count;
    const array = new Uint32Array(count);
    for (let i = 0; i < count; i++) array[i] = index.getX(i);
    message.index = { array, count };
    if (array.buffer.byteLength) transfer.push(array.buffer);
  }

  const position = geometry.getAttribute('position');
  if (!position) return { message, transfer };

  // Tightly packed XYZ (gathered first for interleaved/normalized attributes),
  // copied so the geometry's own buffer is never detached.
  const copy = packVertexPositions(position).array.slice();
  message.positions = copy;
  transfer.push(copy.buffer);
  return { message, transfer };
}

function vertexFromPacked(array, index) {
  const base = index * 3;
  return { x: array[base], y: array[base + 1], z: array[base + 2] };
}

function hashVertex(v) {
  const precision = Math.pow(10, EDGE_PRECISION_POINTS);
  return `${Math.round(v.x * precision)},${Math.round(v.y * precision)},${Math.round(v.z * precision)}`;
}
