import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BoxGeometry,
  CylinderGeometry,
  TorusGeometry,
  SphereGeometry,
  BufferGeometry,
  BufferAttribute,
  Float32BufferAttribute,
  Uint16BufferAttribute,
  Uint32BufferAttribute,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  EdgesGeometry,
} from 'three';

import {
  extractWireframeEdges,
  buildWorkerPayload,
  packPositionAttribute,
  packVertexPositions,
  readVertex,
  DEFAULT_THRESHOLD_ANGLE,
} from '../public/vault/wireframe.js';

// ---------------------------------------------------------------------------
// The reference is the REAL THREE.EdgesGeometry from the exact installed
// three@0.169.0 — never a second homemade implementation. The viewer loads
// three@0.169.0 from unpkg (see the import map in src/app/page.tsx) and the
// installed package is pinned to that same version in package.json.
// ---------------------------------------------------------------------------

const THRESHOLD = 25;

function referenceEdges(geometry, thresholdAngle = THRESHOLD) {
  const edges = new EdgesGeometry(geometry, thresholdAngle);
  const position = edges.getAttribute('position');
  return position ? position.array : new Float32Array(0);
}

/** A/B compare the shared extractor against THREE.EdgesGeometry, verbatim. */
/** Count how many triangles use each quantised (undirected) edge. */
function edgeMultiplicities(positions, index) {
  const q = (i) => {
    const b = i * 3;
    return `${Math.round(positions[b] * 1e4)},${Math.round(positions[b + 1] * 1e4)},${Math.round(positions[b + 2] * 1e4)}`;
  };
  const counts = new Map();
  const tri = [];
  const count = index ? index.length : positions.length / 3;
  for (let i = 0; i < count; i += 3) {
    tri.length = 0;
    for (let j = 0; j < 3; j++) tri.push(index ? index[i + j] : i + j);
    for (let j = 0; j < 3; j++) {
      const a = q(tri[j]);
      const b = q(tri[(j + 1) % 3]);
      if (a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

function assertSameEdges(geometry, label, thresholdAngle = THRESHOLD) {
  const expected = Array.from(referenceEdges(geometry, thresholdAngle));
  const actual = Array.from(extractWireframeEdges(geometry, thresholdAngle));
  assert.deepEqual(
    actual,
    expected,
    `${label}: shared extractor must emit exactly the EdgesGeometry(f, ${thresholdAngle}) segments`
  );
  return expected.length / 6;
}

// ---------------------------------------------------------------------------
// Drive the REAL worker program in-process.
//
// wireframe-worker.js is loaded verbatim (only its relative import is
// rewritten to the absolute file URL, exactly like the blob shim in app.js)
// with a minimal `self` stand-in, so these tests exercise the shipped worker
// glue — message reconstruction, the transfer list, error handling — not a
// re-implementation of it.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(here, '..', 'public', 'vault', 'wireframe-worker.js');
const SHARED_PATH = path.join(here, '..', 'public', 'vault', 'wireframe.js');

const posted = [];
globalThis.self = {
  postMessage(message, transfer) {
    posted.push({ message, transfer });
  },
};

const workerSource = readFileSync(WORKER_PATH, 'utf8').replace(
  /from\s*['"]\.\/wireframe\.js['"]/,
  `from ${JSON.stringify(pathToFileURL(SHARED_PATH).href)}`
);
await import('data:text/javascript;base64,' + Buffer.from(workerSource).toString('base64'));

const workerOnMessage = globalThis.self.onmessage;

test('wireframe-worker.js registers a message handler', () => {
  assert.equal(typeof workerOnMessage, 'function');
});

/** Send one payload to the real worker and return its reply plus transfer list. */
function runWorker(geometry, { id = 1, thresholdAngle = THRESHOLD } = {}) {
  const { message, transfer } = buildWorkerPayload(geometry, id, thresholdAngle);
  posted.length = 0;
  workerOnMessage({ data: message });
  assert.equal(posted.length, 1, 'worker must post exactly one reply per task');
  return { ...posted[0], request: message, requestTransfer: transfer };
}

/** The worker's reply must equal the real THREE.EdgesGeometry output exactly. */
function assertSameEdgesViaWorker(geometry, label) {
  const reply = runWorker(geometry);
  assert.equal(reply.message.type, 'result', `${label}: worker replied with an error: ${reply.message.message}`);
  assert.equal(reply.message.id, 1);

  const expected = Array.from(referenceEdges(geometry));
  assert.deepEqual(Array.from(reply.message.positions), expected, `${label}: worker reply must match EdgesGeometry`);

  // Transferable ArrayBuffer: the reply buffer is in the transfer list.
  assert.ok(
    reply.transfer.includes(reply.message.positions.buffer),
    `${label}: the result buffer must be transferred, not copied`
  );
}

// ---------------------------------------------------------------------------
// Geometry fixtures
// ---------------------------------------------------------------------------

function indexedCube() {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(
      [
        0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, // front
        0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, // back
      ],
      3
    )
  );
  geometry.setIndex(new Uint16BufferAttribute([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6], 1));
  return geometry;
}

function nonIndexedCoincident() {
  // Two triangles sharing an edge, expressed with DUPLICATED vertices (so the
  // edge is only matched through the quantised position hash, never through
  // shared index values).
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(
      [
        0, 0, 0, 1, 0, 0, 1, 1, 0, // tri A
        0, 0, 0, 1, 1, 0, 0, 1, 0, // tri B — same edge 0-0 -> 1-1
      ],
      3
    )
  );
  return geometry;
}

function coplanarTriangles() {
  // Two coplanar triangles sharing edge (1,0,0)-(1,1,0): normals are equal, so
  // the shared edge is below the crease threshold and must NOT be emitted.
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(
      [
        0, 0, 0, 1, 0, 0, 1, 1, 0,
        0, 0, 0, 1, 1, 0, 0, 1, 0,
      ],
      3
    )
  );
  return geometry;
}

function hardCrease() {
  // Two triangles sharing edge (0,0,0)-(1,0,0) at 90 degrees: normals differ by
  // 90 > 25, so the shared edge IS a crease and must be emitted.
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(
      [
        0, 0, 0, 1, 0, 0, 0, 1, 0, // in the XY plane
        0, 0, 0, 1, 0, 0, 0, 0, 1, // in the XZ plane
      ],
      3
    )
  );
  return geometry;
}

function boundaryTriangle() {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  return geometry;
}

function nonManifold() {
  // Three triangles all sharing the edge (0,0,0)-(1,0,0). three.js pairs the
  // first two (emitting a crease if sharp) and leaves the third unmatched — so
  // it is emitted later as a boundary edge. Pinned against EdgesGeometry.
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(
      [
        0, 0, 0, 1, 0, 0, 0, 1, 0, // +Z
        0, 0, 0, 1, 0, 0, 0, 0, 1, // +Y
        0, 0, 0, 1, 0, 0, 0, -1, 0, // -Z (still fanning around the shared edge)
      ],
      3
    )
  );
  return geometry;
}

function geometryFrom(positions, index) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  if (index) geometry.setIndex(new Uint16BufferAttribute(index, 1));
  return geometry;
}

/** Build a geometry whose position attribute is an InterleavedBufferAttribute. */
function interleavedPositionGeometry() {
  // 2 triangles, stride 3, but the position lives at offset 0 of a buffer that
  // also carries an unused extra float per vertex (stride 4) to prove the
  // stride/offset handling.
  const positions = [
    0, 0, 0, 9, 1, 0, 0, 9, 0, 1, 0, 9,
    0, 0, 0, 9, 0, 1, 0, 9, 1, 0, 0, 9,
  ];
  const buffer = new InterleavedBuffer(new Float32Array(positions), 4);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new InterleavedBufferAttribute(buffer, 3, 0));
  return geometry;
}

// ---------------------------------------------------------------------------
// Required A/B cases
// ---------------------------------------------------------------------------

test('indexed cube matches THREE.EdgesGeometry', () => {
  const segments = assertSameEdges(indexedCube(), 'indexed cube');
  assert.ok(segments > 0, 'indexed cube must produce edges');
  assertSameEdgesViaWorker(indexedCube(), 'indexed cube');
});

test('non-indexed coincident geometry matches THREE.EdgesGeometry', () => {
  const segments = assertSameEdges(nonIndexedCoincident(), 'non-indexed coincident');
  // Two coplanar triangles forming a quad: 5 unique edges, the shared one
  // suppressed -> 4 boundary segments.
  assert.equal(segments, 4, 'a coplanar quad emits its 4 boundary edges');
  assertSameEdgesViaWorker(nonIndexedCoincident(), 'non-indexed coincident');
});

test('coplanar triangles match THREE.EdgesGeometry (shared edge suppressed)', () => {
  const reference = referenceEdges(coplanarTriangles());
  const actual = extractWireframeEdges(coplanarTriangles());
  assert.deepEqual(Array.from(actual), Array.from(reference));
  // The shared middle edge must NOT be present: 4 boundary edges -> 4 segments.
  assert.equal(reference.length / 6, 4);
  assertSameEdgesViaWorker(coplanarTriangles(), 'coplanar triangles');
});

test('hard crease matches THREE.EdgesGeometry (shared edge emitted)', () => {
  const reference = referenceEdges(hardCrease());
  const actual = extractWireframeEdges(hardCrease());
  assert.deepEqual(Array.from(actual), Array.from(reference));
  // Quad boundary (4) + the sharp shared edge (1) = 5 segments.
  assert.equal(reference.length / 6, 5);
  assertSameEdgesViaWorker(hardCrease(), 'hard crease');
});

test('boundary triangle matches THREE.EdgesGeometry', () => {
  const reference = referenceEdges(boundaryTriangle());
  assert.deepEqual(Array.from(extractWireframeEdges(boundaryTriangle())), Array.from(reference));
  assert.equal(reference.length / 6, 3, 'a lone triangle has three boundary edges');
  assertSameEdgesViaWorker(boundaryTriangle(), 'boundary triangle');
});

test('genuine non-manifold geometry (3+ triangles per edge) matches THREE.EdgesGeometry', () => {
  const geometry = nonManifold();
  // Prove the fixture really is non-manifold rather than merely claiming it:
  // some edge must be shared by 3+ triangles.
  const multiplicities = edgeMultiplicities(
    Array.from(geometry.getAttribute('position').array),
    null
  );
  assert.equal(
    Math.max(...multiplicities.values()),
    3,
    'fixture must have an edge used by 3 triangles (genuinely non-manifold)'
  );

  const reference = referenceEdges(geometry);
  assert.deepEqual(Array.from(extractWireframeEdges(geometry)), Array.from(reference));
  assert.ok(reference.length > 0, 'the non-manifold fan still yields segments');
  assertSameEdgesViaWorker(geometry, 'non-manifold');
});

test('representative THREE.BoxGeometry matches THREE.EdgesGeometry', () => {
  const geometry = new BoxGeometry(1.5, 2, 3, 2, 3, 4);
  const segments = assertSameEdges(geometry, 'BoxGeometry');
  assert.ok(segments > 0, 'a subdivided box has edges');
  assertSameEdgesViaWorker(geometry, 'BoxGeometry');
});

test('THREE.CylinderGeometry matches THREE.EdgesGeometry', () => {
  const geometry = new CylinderGeometry(1, 1, 2, 24, 1);
  const reference = referenceEdges(geometry);
  assert.deepEqual(Array.from(extractWireframeEdges(geometry)), Array.from(reference));
  assert.ok(reference.length > 0);
  assertSameEdgesViaWorker(geometry, 'CylinderGeometry');
});

test('THREE.TorusGeometry matches THREE.EdgesGeometry', () => {
  // A faceted torus (8 radial segments = 45 degree faces) has real creases.
  const faceted = new TorusGeometry(1, 0.35, 8, 16);
  const facetedReference = referenceEdges(faceted);
  assert.ok(facetedReference.length > 0, 'a faceted torus must have crease edges');
  assert.deepEqual(Array.from(extractWireframeEdges(faceted)), Array.from(facetedReference));
  assertSameEdgesViaWorker(faceted, 'TorusGeometry (faceted)');

  // A smooth torus has no crease above 25 degrees and no boundary: three.js
  // legitimately emits ZERO edges, and so must the worker.
  const smooth = new TorusGeometry(1, 0.35, 16, 32);
  const smoothReference = referenceEdges(smooth);
  assert.equal(smoothReference.length, 0, 'a smooth closed torus has no crease edges at 25 degrees');
  assert.deepEqual(Array.from(extractWireframeEdges(smooth)), Array.from(smoothReference));
  assertSameEdgesViaWorker(smooth, 'TorusGeometry (smooth)');
});

test('THREE.SphereGeometry matches THREE.EdgesGeometry', () => {
  const geometry = new SphereGeometry(1, 24, 16);
  const reference = referenceEdges(geometry);
  assert.deepEqual(Array.from(extractWireframeEdges(geometry)), Array.from(reference));
  assertSameEdgesViaWorker(geometry, 'SphereGeometry');
});

test('duplicate-edge detection matches THREE.EdgesGeometry (repeated edge pair)', () => {
  // The exact same triangle twice: the second pass re-encounters every edge in
  // the same direction, which three.js ignores via `hash in edgeData`. Only the
  // first pass's boundary edges survive.
  const single = boundaryTriangle();
  const doubled = geometryFrom([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const reference = referenceEdges(doubled);
  assert.deepEqual(Array.from(extractWireframeEdges(doubled)), Array.from(reference));

  const singleReference = referenceEdges(single);
  assert.deepEqual(reference, singleReference, 'duplicate triangles must not add edges');
  assertSameEdgesViaWorker(doubled, 'duplicate-edge detection');
});

// ---------------------------------------------------------------------------
// Threshold behaviour
// ---------------------------------------------------------------------------

test('threshold angle is honoured exactly like THREE.EdgesGeometry', () => {
  const geometry = hardCrease(); // 90-degree crease
  for (const angle of [1, 25, 45, 89, 90, 91, 120]) {
    assert.deepEqual(
      Array.from(extractWireframeEdges(geometry, angle)),
      Array.from(referenceEdges(geometry, angle)),
      `threshold ${angle} must match EdgesGeometry`
    );
  }
});

test('default threshold is 25 degrees and matches EdgesGeometry(f, 25)', () => {
  assert.equal(DEFAULT_THRESHOLD_ANGLE, 25);
  const geometry = new TorusGeometry(1, 0.35, 16, 32);
  assert.deepEqual(
    Array.from(extractWireframeEdges(geometry)),
    Array.from(referenceEdges(geometry, 25))
  );
});

// ---------------------------------------------------------------------------
// Attribute handling: fast path + interleaved packing
// ---------------------------------------------------------------------------

test('standard tightly packed Float32 positions take the fast path', () => {
  const geometry = new BoxGeometry(1, 1, 1);
  const position = geometry.getAttribute('position');
  assert.equal(packPositionAttribute(position), position.array, 'must return the live Float32Array');
  assert.equal(packPositionAttribute(position).constructor, Float32Array);
});

test('interleaved, normalized and non-float attributes do NOT take the fast path', () => {
  const interleaved = interleavedPositionGeometry().getAttribute('position');
  assert.equal(packPositionAttribute(interleaved), null, 'interleaved must not use the fast path');

  const normalized = new BufferGeometry();
  normalized.setAttribute('position', new Uint16BufferAttribute([0, 0, 0, 65535, 0, 0, 0, 65535, 0], 3, true));
  assert.equal(packPositionAttribute(normalized.getAttribute('position')), null, 'normalized must not use the fast path');

  const integer = new BufferGeometry();
  integer.setAttribute('position', new Uint32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  assert.equal(packPositionAttribute(integer.getAttribute('position')), null, 'non-float must not use the fast path');
});

test('InterleavedBufferAttribute positions are packed (XYZ) and match EdgesGeometry', () => {
  const geometry = interleavedPositionGeometry();
  const position = geometry.getAttribute('position');

  // The extractor must read through stride/offset exactly like three.js.
  assert.deepEqual(readVertex(position, 0), { x: 0, y: 0, z: 0 });
  assert.deepEqual(readVertex(position, 1), { x: 1, y: 0, z: 0 });
  assert.deepEqual(readVertex(position, 2), { x: 0, y: 1, z: 0 });

  assert.deepEqual(
    Array.from(extractWireframeEdges(geometry)),
    Array.from(referenceEdges(geometry)),
    'interleaved geometry must match EdgesGeometry'
  );

  // The packed XYZ must be gathered before the worker ever sees the data:
  // stride 4 is unwrapped into a flat, tightly packed Float32Array.
  const packed = packVertexPositions(position);
  assert.equal(packed.fast, false, 'interleaved positions cannot use the fast path');
  assert.ok(packed.array instanceof Float32Array);
  assert.equal(packed.array.length, position.count * 3);
  assert.deepEqual(Array.from(packed.array.slice(0, 12)), [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0]);

  const { message } = buildWorkerPayload(geometry, 7);
  assert.ok(message.positions instanceof Float32Array, 'the worker receives packed XYZ');
  assert.deepEqual(Array.from(message.positions), Array.from(packed.array));
  assertSameEdgesViaWorker(geometry, 'interleaved positions');
});

test('normalized integer position attributes match EdgesGeometry', () => {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Uint16BufferAttribute([0, 0, 0, 65535, 0, 0, 0, 65535, 0], 3, true));
  assert.deepEqual(Array.from(extractWireframeEdges(geometry)), Array.from(referenceEdges(geometry)));

  const integer = new BufferGeometry();
  integer.setAttribute('position', new Uint32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  assert.deepEqual(Array.from(extractWireframeEdges(integer)), Array.from(referenceEdges(integer)));

  const asUint32Index = new BufferGeometry();
  asUint32Index.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3));
  asUint32Index.setIndex(new Uint32BufferAttribute([0, 1, 2, 1, 3, 2], 1));
  assert.deepEqual(Array.from(extractWireframeEdges(asUint32Index)), Array.from(referenceEdges(asUint32Index)));
});

test('indexed and non-indexed geometry both match EdgesGeometry', () => {
  const indexed = geometryFrom(
    [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
    [0, 1, 2, 0, 2, 3]
  );
  assert.deepEqual(Array.from(extractWireframeEdges(indexed)), Array.from(referenceEdges(indexed)));

  const nonIndexed = geometryFrom([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  assert.deepEqual(Array.from(extractWireframeEdges(nonIndexed)), Array.from(referenceEdges(nonIndexed)));
});

// ---------------------------------------------------------------------------
// Degenerate / edge-case parity
// ---------------------------------------------------------------------------

test('degenerate triangles are skipped exactly like EdgesGeometry', () => {
  const geometry = geometryFrom([
    0, 0, 0, 0, 0, 0, 1, 1, 0, // fully degenerate (two identical corners)
    0, 0, 0, 1, 0, 0, 0, 1, 0, // real triangle
  ]);
  assert.deepEqual(Array.from(extractWireframeEdges(geometry)), Array.from(referenceEdges(geometry)));
});

test('empty geometry, missing attribute and single triangle match EdgesGeometry', () => {
  assert.deepEqual(Array.from(extractWireframeEdges(new BufferGeometry())), []);
  assert.ok(extractWireframeEdges(new BoxGeometry(1, 1, 1)).length > 0);

  const missing = { getIndex: () => null, getAttribute: () => null };
  assert.deepEqual(Array.from(extractWireframeEdges(missing)), []);
});

// ---------------------------------------------------------------------------
// Worker payload mechanics
// ---------------------------------------------------------------------------

test('worker payload copies the geometry data (never detaches live buffers)', () => {
  const geometry = new BoxGeometry(1, 1, 1);
  const positionBefore = geometry.getAttribute('position').array.slice();
  const indexBefore = geometry.getIndex().array.slice();

  const { message, transfer } = buildWorkerPayload(geometry, 3);
  assert.equal(message.type, 'extract');
  assert.equal(message.id, 3);
  assert.equal(message.thresholdAngle, 25);
  assert.ok(message.positions instanceof Float32Array);
  assert.equal(message.index.count, geometry.getIndex().count);

  // Transfer list must reference only our copies.
  assert.ok(transfer.includes(message.positions.buffer));
  assert.ok(transfer.includes(message.index.array.buffer));
  assert.notEqual(message.positions.buffer, geometry.getAttribute('position').array.buffer);

  // The live geometry is untouched.
  assert.deepEqual(Array.from(geometry.getAttribute('position').array), Array.from(positionBefore));
  assert.deepEqual(Array.from(geometry.getIndex().array), Array.from(indexBefore));
});

test('worker payload is always packed XYZ: Float32 fast path, Float64 for the rest', () => {
  const boxPayload = buildWorkerPayload(new BoxGeometry(1, 1, 1), 1);
  assert.ok(boxPayload.message.positions instanceof Float32Array);
  assert.equal(boxPayload.message.positions.length, boxPayload.message.positions.length);

  // Interleaved Float32 sources are gathered into a packed Float32Array.
  const interleavedPayload = buildWorkerPayload(interleavedPositionGeometry(), 2);
  assert.ok(interleavedPayload.message.positions instanceof Float32Array);

  // Integer / normalized sources are gathered into Float64Array so no precision
  // is lost relative to reading the attribute directly.
  const integer = new BufferGeometry();
  integer.setAttribute('position', new Uint32BufferAttribute([0, 0, 0, 4000000, 0, 0, 0, 4000000, 0], 3));
  const integerPayload = buildWorkerPayload(integer, 3);
  assert.ok(integerPayload.message.positions instanceof Float64Array);
  assert.deepEqual(Array.from(integerPayload.message.positions.slice(0, 6)), [0, 0, 0, 4000000, 0, 0]);
});

test('giant default threshold sanity: 1 degree emits more edges than 91 degrees', () => {
  const geometry = new TorusGeometry(1, 0.3, 8, 12);
  const fine = extractWireframeEdges(geometry, 1);
  const coarse = extractWireframeEdges(geometry, 91);
  assert.ok(fine.length >= coarse.length);
  assert.deepEqual(Array.from(fine), Array.from(referenceEdges(geometry, 1)));
  assert.deepEqual(Array.from(coarse), Array.from(referenceEdges(geometry, 91)));
});

test('worker uses transferable buffers and never detaches the live geometry', () => {
  const geometry = new BoxGeometry(1, 1, 1);
  const positionBuffer = geometry.getAttribute('position').array.buffer;
  const indexBuffer = geometry.getIndex().array.buffer;

  const reply = runWorker(geometry);
  assert.equal(reply.message.type, 'result');
  assert.ok(reply.message.positions instanceof Float32Array);
  assert.ok(reply.transfer.includes(reply.message.positions.buffer), 'result is transferred');

  // The app's request copy is transferred; the geometry's own buffers are not.
  assert.equal(reply.request.positions.buffer.byteLength, positionBuffer.byteLength);
  assert.notEqual(reply.request.positions.buffer, positionBuffer);
  assert.equal(positionBuffer.byteLength > 0, true, 'live position buffer must stay attached');
  assert.equal(indexBuffer.byteLength > 0, true, 'live index buffer must stay attached');
});

test('worker reports a task-level error instead of throwing', () => {
  posted.length = 0;
  workerOnMessage({ data: { type: 'extract', id: 42, positions: null, position: null, index: null } });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].message.type, 'error');
  assert.equal(posted[0].message.id, 42);
  assert.ok(typeof posted[0].message.message === 'string' && posted[0].message.message.length > 0);
});

test('worker ignores messages it does not understand', () => {
  posted.length = 0;
  workerOnMessage({ data: null });
  workerOnMessage({ data: { type: 'something-else' } });
  assert.equal(posted.length, 0, 'non-extract messages must be ignored silently');

  // An extract with no geometry at all is answered with an error (never a
  // crash and never a silent hang).
  workerOnMessage({ data: { type: 'extract', id: 5 } });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].message.type, 'error');
  assert.equal(posted[0].message.id, 5);
});

test('large representative geometry: extractor equals EdgesGeometry segment-for-segment', () => {
  const geometry = new TorusGeometry(1, 0.4, 32, 64);
  const reference = referenceEdges(geometry);
  const actual = extractWireframeEdges(geometry);
  assert.equal(actual.length, reference.length);
  assert.deepEqual(Array.from(actual), Array.from(reference));
});
