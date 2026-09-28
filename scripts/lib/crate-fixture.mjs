/* ============================================================
   CRATE FIXTURE — deterministic generator for the benchmark's "real crate"
   GLB (scripts/benchmark-optimizer.mjs, scripts/build-crate-fixture.mjs).

   The asset is built the way a downloaded model actually looks:
     - a 6-face wooden crate with plank gaps and relief-displaced geometry,
     - three PBR textures (wood albedo, tangent-space normal map, roughness),
     - redundant data on purpose: four byte-identical nail meshes (dedup
       work), plus an unreferenced node / mesh / material / texture
       (prune work), a nameless node (placeholder-naming work) and extras
       blocks everywhere (metadata-cleanup work).

   Everything is seeded, so the same parameters always produce the same
   bytes — the benchmark numbers are reproducible. The generated .glb is a
   build artifact (gitignored under fixtures/), never a committed binary.
   ============================================================ */

import { encodePng } from './png-codec.mjs';

/* ---- deterministic randomness + value noise ---- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise(seed) {
  const rand = mulberry32(seed);
  const SIZE = 256;
  const lattice = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
  const at = (x, y) => lattice[((y & 255) << 8) | (x & 255)];
  const smooth = t => t * t * (3 - 2 * t);
  function noise2(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = smooth(x - xi);
    const yf = smooth(y - yi);
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  }
  function fbm(x, y, octaves = 4) {
    let value = 0;
    let amplitude = 0.5;
    let frequency = 1;
    for (let o = 0; o < octaves; o++) {
      value += amplitude * noise2(x * frequency, y * frequency);
      frequency *= 2;
      amplitude *= 0.5;
    }
    return value;
  }
  return { noise2, fbm };
}

const clamp255 = v => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/* ---- textures ---- */

function woodAlbedoPng(size, noise) {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const warp = noise.fbm(u * 5 + 31, v * 5 + 17, 5);
      const rings = Math.sin((u * 11 + warp * 2.6) * Math.PI * 2);
      const grain = 0.5 + 0.5 * rings;
      const fine = noise.fbm(u * 96 + 5, v * 96 + 9, 4);
      const shade = 0.45 + 0.55 * grain;
      const i = (y * size + x) * 4;
      rgba[i] = clamp255(122 * shade + 36 * fine);
      rgba[i + 1] = clamp255(78 * shade + 26 * fine);
      rgba[i + 2] = clamp255(44 * shade + 17 * fine);
      rgba[i + 3] = 255;
    }
  }
  return encodePng({ width: size, height: size, data: rgba, colorType: 2 });
}

function crateNormalPng(size, noise) {
  const rgba = new Uint8Array(size * size * 4);
  const height = (u, v) => noise.fbm(u * 24 + 3, v * 24 + 8, 5);
  const e = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const dx = (height(u + e, v) - height(u - e, v)) * 2.2;
      const dy = (height(u, v + e) - height(u, v - e)) * 2.2;
      const length = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      rgba[i] = clamp255(((-dx / length) * 0.5 + 0.5) * 255);
      rgba[i + 1] = clamp255(((-dy / length) * 0.5 + 0.5) * 255);
      rgba[i + 2] = clamp255(((1 / length) * 0.5 + 0.5) * 255);
      rgba[i + 3] = 255;
    }
  }
  return encodePng({ width: size, height: size, data: rgba, colorType: 2 });
}

function roughnessPng(size, noise) {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const r = clamp255(150 + 85 * noise.fbm(u * 3 + 2, v * 3 + 6, 4));
      const i = (y * size + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = r;
      rgba[i + 3] = 255;
    }
  }
  return encodePng({ width: size, height: size, data: rgba, colorType: 2 });
}

function magentaPng(size) {
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = 220;
    rgba[i * 4 + 1] = 40;
    rgba[i * 4 + 2] = 170;
    rgba[i * 4 + 3] = 255;
  }
  return encodePng({ width: size, height: size, data: rgba, colorType: 2 });
}

/* ---- GLB assembly ---- */

const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

class BinBuilder {
  constructor() {
    this.parts = [];
    this.length = 0;
  }

  add(bytes) {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    const byteOffset = this.length;
    this.parts.push(bytes);
    this.length += bytes.length;
    return byteOffset;
  }

  finish() {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    const out = new Uint8Array(this.length);
    let cursor = 0;
    for (const part of this.parts) {
      out.set(part, cursor);
      cursor += part.length;
    }
    return out;
  }
}

function writeGlb(json, bin) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const jsonChunk = 8 + jsonBytes.length + jsonPad;
  const binChunk = 8 + bin.length + binPad;
  const total = 12 + jsonChunk + binChunk;

  const glb = new Uint8Array(total);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length + jsonPad, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  glb.set(jsonBytes, 20);
  for (let i = 0; i < jsonPad; i++) glb[20 + jsonBytes.length + i] = 0x20;

  const binStart = 20 + jsonBytes.length + jsonPad;
  view.setUint32(binStart, bin.length + binPad, true);
  view.setUint32(binStart + 4, 0x004e4942, true); // 'BIN\0'
  glb.set(bin, binStart + 8);
  return glb;
}

/* ---- geometry ---- */

const HALF = 0.5;
const FACES = [
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
];

/** Build the crate's planked shell: positions, normals, uvs, indices. */
function buildCrateShell({ planksPerFace, plankGrid, noise }) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const gap = 0.018;
  const plankSpan = (1 - gap * (planksPerFace - 1)) / planksPerFace;
  const reliefAt = (face, fu, fv) =>
    (noise.fbm(fu * 14 + face * 37.3, fv * 14 + face * 11.7, 4) - 0.5) * 0.045;
  const gridStep = 1 / plankGrid;
  const normalScale = 0.045 / (2 * HALF * gridStep) * 0.35;

  FACES.forEach((face, faceIndex) => {
    for (let p = 0; p < planksPerFace; p++) {
      const vStart = p * (plankSpan + gap);
      for (let gy = 0; gy <= plankGrid; gy++) {
        for (let gx = 0; gx <= plankGrid; gx++) {
          const fu = gx * gridStep;
          const fv = vStart + plankSpan * (gy * gridStep);
          const relief = reliefAt(faceIndex, fu, fv);

          const dRu = reliefAt(faceIndex, Math.min(1, fu + gridStep), fv) - reliefAt(faceIndex, Math.max(0, fu - gridStep), fv);
          const dRv = reliefAt(faceIndex, fu, Math.min(1, fv + gridStep)) - reliefAt(faceIndex, fu, Math.max(0, fv - gridStep));
          let nx = face.n[0] - face.u[0] * dRu * normalScale - face.v[0] * dRv * normalScale;
          let ny = face.n[1] - face.u[1] * dRu * normalScale - face.v[1] * dRv * normalScale;
          let nz = face.n[2] - face.u[2] * dRu * normalScale - face.v[2] * dRv * normalScale;
          const nLength = Math.hypot(nx, ny, nz) || 1;
          nx /= nLength; ny /= nLength; nz /= nLength;

          const pu = (fu * 2 - 1) * HALF;
          const pv = (fv * 2 - 1) * HALF;
          const depth = HALF + relief;
          positions.push(
            face.n[0] * depth + face.u[0] * pu + face.v[0] * pv,
            face.n[1] * depth + face.u[1] * pu + face.v[1] * pv,
            face.n[2] * depth + face.u[2] * pu + face.v[2] * pv,
          );
          normals.push(nx, ny, nz);
          uvs.push(fu, fv);
        }
      }
    }
  });

  const perFace = planksPerFace * (plankGrid + 1) * (plankGrid + 1);
  FACES.forEach((_, faceIndex) => {
    const base = faceIndex * perFace;
    for (let p = 0; p < planksPerFace; p++) {
      for (let gy = 0; gy < plankGrid; gy++) {
        for (let gx = 0; gx < plankGrid; gx++) {
          const a = base + p * (plankGrid + 1) * (plankGrid + 1) + gy * (plankGrid + 1) + gx;
          const b = a + 1;
          const c = a + (plankGrid + 1) + 1;
          const d = a + (plankGrid + 1);
          indices.push(a, b, c, a, c, d);
        }
      }
    }
  });

  return { positions, normals, uvs, indices };
}

/** A small cube used for the (redundant) nails and the sign. */
function buildCube(center, halfSize, signShade = null) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const [cx, cy, cz] = center;
  const corners = [
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  ];
  corners.forEach(face => {
    const start = positions.length / 3;
    for (const [su, sv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const pu = (su * 2 - 1) * halfSize;
      const pv = (sv * 2 - 1) * halfSize;
      positions.push(
        cx + face.n[0] * halfSize + face.u[0] * pu + face.v[0] * pv,
        cy + face.n[1] * halfSize + face.u[1] * pu + face.v[1] * pv,
        cz + face.n[2] * halfSize + face.u[2] * pu + face.v[2] * pv,
      );
      normals.push(...face.n);
      uvs.push(su, sv);
    }
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  });
  return { positions, normals, uvs, indices, shade: signShade };
}

/** A flat two-triangle quad — the unreferenced mesh prune() should drop. */
function buildUnusedQuad() {
  return {
    positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

/* ---- fixture ---- */

const DEFAULTS = {
  seed: 20260928,
  planksPerFace: 3,
  plankGrid: 104,
  textureSize: 4096,
  roughnessSize: 2048,
  nailCount: 4,
};

/**
 * Build the crate GLB.
 * @returns {{ glb: Uint8Array, stats: object }}
 */
export function buildCrateGlb(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const noise = makeNoise(config.seed);

  const albedo = woodAlbedoPng(config.textureSize, noise);
  const normalMap = crateNormalPng(config.textureSize, noise);
  const rough = roughnessPng(config.roughnessSize, noise);
  const unused = magentaPng(64);

  const shell = buildCrateShell({ planksPerFace: config.planksPerFace, plankGrid: config.plankGrid, noise });
  const nail = buildCube([0, 0, 0], 0.018);
  const sign = buildCube([0.9, -0.2, 0.55], 0.16);
  const unusedQuad = buildUnusedQuad();

  const bin = new BinBuilder();
  const bufferViews = [];
  const accessors = [];

  const addGeometry = (geometry, { elementTarget = true } = {}) => {
    const positionArray = new Float32Array(geometry.positions);
    const normalArray = new Float32Array(geometry.normals);
    const uvArray = new Float32Array(geometry.uvs);
    const indexArray = new Uint32Array(geometry.indices);
    const vertexCount = positionArray.length / 3;

    const positionOffset = bin.add(new Uint8Array(positionArray.buffer, positionArray.byteOffset, positionArray.byteLength));
    const normalOffset = bin.add(new Uint8Array(normalArray.buffer, normalArray.byteOffset, normalArray.byteLength));
    const uvOffset = bin.add(new Uint8Array(uvArray.buffer, uvArray.byteOffset, uvArray.byteLength));
    const indexOffset = bin.add(new Uint8Array(indexArray.buffer, indexArray.byteOffset, indexArray.byteLength));

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertexCount; i++) {
      for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c], geometry.positions[i * 3 + c]);
        max[c] = Math.max(max[c], geometry.positions[i * 3 + c]);
      }
    }

    const base = accessors.length;
    bufferViews.push({ buffer: 0, byteOffset: positionOffset, byteLength: positionArray.byteLength, target: ARRAY_BUFFER });
    bufferViews.push({ buffer: 0, byteOffset: normalOffset, byteLength: normalArray.byteLength, target: ARRAY_BUFFER });
    bufferViews.push({ buffer: 0, byteOffset: uvOffset, byteLength: uvArray.byteLength, target: ARRAY_BUFFER });
    bufferViews.push({ buffer: 0, byteOffset: indexOffset, byteLength: indexArray.byteLength, target: ELEMENT_ARRAY_BUFFER });
    accessors.push({ bufferView: base, componentType: FLOAT, count: vertexCount, type: 'VEC3', min, max });
    accessors.push({ bufferView: base + 1, componentType: FLOAT, count: vertexCount, type: 'VEC3' });
    accessors.push({ bufferView: base + 2, componentType: FLOAT, count: vertexCount, type: 'VEC2' });
    accessors.push({ bufferView: base + 3, componentType: UNSIGNED_INT, count: indexArray.length, type: 'SCALAR' });
    void elementTarget;
    return {
      position: base,
      normal: base + 1,
      uv: base + 2,
      indices: base + 3,
      vertexCount,
      triangleCount: indexArray.length / 3,
    };
  };

  const addImage = (png, name) => {
    const offset = bin.add(png);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: png.length });
    return { view: bufferViews.length - 1, name, bytes: png.length, width: 0, height: 0 };
  };

  const shellAccessors = addGeometry(shell);
  const nailAccessors = [];
  for (let i = 0; i < config.nailCount; i++) nailAccessors.push(addGeometry(nail));
  const signAccessors = addGeometry(sign);
  const unusedAccessors = addGeometry(unusedQuad);

  const albedoImage = addImage(albedo, 'crate_albedo');
  const normalImage = addImage(normalMap, 'crate_normal');
  const roughImage = addImage(rough, 'crate_roughness');
  const unusedImage = addImage(unused, 'unused_swatch');
  for (const [image, png] of [[albedoImage, albedo], [normalImage, normalMap], [roughImage, rough], [unusedImage, unused]]) {
    const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
    image.width = header.getUint32(16, false);
    image.height = header.getUint32(20, false);
  }

  const primitive = accessors => ({
    attributes: { POSITION: accessors.position, NORMAL: accessors.normal, TEXCOORD_0: accessors.uv },
    indices: accessors.indices,
    material: 0,
  });

  const json = {
    asset: {
      version: '2.0',
      generator: 'Crate Fixture Builder 1.0',
      extras: { author: 'fixture-builder' },
    },
    extras: { vault: 'fixture' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [0, 1, 2, 3, 4, 5] }],
    nodes: [
      { name: 'Crate', mesh: 0, extras: { tool: 'fixture' } },
      { name: 'Nail_0', mesh: 1 },
      { name: 'Nail_1', mesh: 2 },
      { name: 'Nail_2', mesh: 3 },
      { name: 'Nail_3', mesh: 4 },
      { mesh: 5 }, // deliberately nameless → the optimizer must give it a placeholder
      { name: 'UnusedEmptyNode' }, // unreferenced → prune() must drop it
    ],
    meshes: [
      { name: 'CrateMesh', primitives: [primitive(shellAccessors)] },
      ...nailAccessors.map((accessors, i) => ({ name: `NailMesh_${i}`, primitives: [primitive(accessors)] })),
      { name: 'SignMesh', primitives: [primitive(signAccessors)] },
      { name: 'UnusedMesh', primitives: [{ ...primitive(unusedAccessors), material: 3 }] },
    ],
    materials: [
      {
        name: 'CrateMaterial',
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicRoughnessTexture: { index: 2 },
          metallicFactor: 0,
          roughnessFactor: 1,
        },
        normalTexture: { index: 1 },
        extras: { tool: 'substance-painter' },
      },
      { name: 'NailMaterial', pbrMetallicRoughness: { baseColorFactor: [0.35, 0.35, 0.38, 1], metallicFactor: 0.9, roughnessFactor: 0.4 } },
      { name: 'SignMaterial', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.2, 0.15, 1], metallicFactor: 0, roughnessFactor: 0.6 } },
      { name: 'UnusedMaterial', pbrMetallicRoughness: { baseColorTexture: { index: 3 } } },
    ],
    textures: [
      { name: 'crate_albedo', source: 0, sampler: 0 },
      { name: 'crate_normal', source: 1, sampler: 0 },
      { name: 'crate_roughness', source: 2, sampler: 0 },
      { name: 'unused_swatch', source: 3, sampler: 0 },
    ],
    images: [
      { name: albedoImage.name, bufferView: albedoImage.view, mimeType: 'image/png' },
      { name: normalImage.name, bufferView: normalImage.view, mimeType: 'image/png' },
      { name: roughImage.name, bufferView: roughImage.view, mimeType: 'image/png' },
      { name: unusedImage.name, bufferView: unusedImage.view, mimeType: 'image/png' },
    ],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: 0 }],
  };

  const binBuffer = bin.finish();
  json.buffers[0].byteLength = binBuffer.length;
  const glb = writeGlb(json, binBuffer);

  const stats = {
    byteLength: glb.byteLength,
    seed: config.seed,
    planksPerFace: config.planksPerFace,
    plankGrid: config.plankGrid,
    nodes: json.nodes.length,
    meshes: json.meshes.length,
    materials: json.materials.length,
    textures: json.textures.length,
    shellTriangles: shellAccessors.triangleCount,
    images: [
      { name: albedoImage.name, width: albedoImage.width, height: albedoImage.height, bytes: albedo.length },
      { name: normalImage.name, width: normalImage.width, height: normalImage.height, bytes: normalMap.length },
      { name: roughImage.name, width: roughImage.width, height: roughImage.height, bytes: rough.length },
      { name: unusedImage.name, width: unusedImage.width, height: unusedImage.height, bytes: unused.length },
    ],
  };

  return { glb, stats };
}
