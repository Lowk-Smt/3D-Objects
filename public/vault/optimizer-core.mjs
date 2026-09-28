/* ============================================================
   OPTIMIZER CORE — validated, adaptive, dual-path GLB optimization.

   Pure logic only: no DOM, no timers, no console, no globals beyond the
   glTF-Transform / meshoptimizer imports (resolved by the import map in the
   browser, by node_modules under Node). The browser UI
   (public/vault/app.js), the unit tests (tests/optimizer.test.mjs) and the
   headless benchmark (scripts/benchmark-optimizer.mjs) all run THIS module,
   so what is verified in CI is what ships to the browser.

   Pipeline (performance reorder — cheapest structural passes first, and a
   second dedup after textures change, because two different textures can
   become byte-identical once resized):

     validate → read → prune → dedup → simplify → textures → dedup → prune
              → metadata → write

   Every stage is adaptive: it is skipped entirely when the document has no
   work for it (no mesh primitives → no simplify, no textures → no texture
   pass), so a file is never pushed through a stage that cannot help it.

   Texture handling is dual-path. The core never touches pixels itself; it
   calls an injected `resizeTexture(texture, limits)` strategy:
     - browser: public/vault/optimizer-browser-textures.mjs (canvas decode,
       per-texture alpha scan, WebP/JPEG/PNG encoder choice)
     - headless: scripts/lib/headless-textures.mjs (dependency-free pure-JS
       PNG decode → bilinear downscale → PNG re-encode)
   ============================================================ */

import { WebIO } from '@gltf-transform/core';
import { simplify, prune, dedup } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

/** Stamped into the optimized file's asset.generator. */
export const GENERATOR_TAG = 'Model Vault 1.0 (glTF-Transform)';

/**
 * Optimization presets, in the order the UI offers them.
 *  - ratio / error      → MeshoptSimplifier target triangle ratio / error
 *  - textureSize        → max texture edge, in pixels, for BOTH paths
 *  - textureQuality     → lossy encoder quality for the browser path
 *                         (ignored by the headless PNG path, which is
 *                         lossless; the shrink there comes from downscale)
 */
export const OPTIMIZE_PRESETS = Object.freeze({
  high: Object.freeze({ ratio: 0.7, error: 0.0005, textureSize: 2048, textureQuality: 0.92 }),
  balanced: Object.freeze({ ratio: 0.5, error: 0.0005, textureSize: 1536, textureQuality: 0.85 }),
  small: Object.freeze({ ratio: 0.25, error: 0.001, textureSize: 1024, textureQuality: 0.75 }),
});

export const DEFAULT_PRESET_KEY = 'balanced';

/** Exact stage labels emitted (in order) for a document that has both meshes and textures. */
export const STAGE_ORDER = Object.freeze([
  'prune:initial',
  'dedup:initial',
  'simplify',
  'textures',
  'dedup:final',
  'prune:final',
  'metadata',
]);

export const CANCEL_MESSAGE = 'OPTIMIZE_CANCELLED';

/**
 * Texture roles. Only `color` (photographic) textures may ever take a lossy
 * encoder; every other role carries material DATA and must stay lossless,
 * because JPEG/WebP chroma subsampling and quantization silently corrupt it
 * (normal maps bend light wrongly, packed roughness/metallic values drift,
 * occlusion and mask thresholds shift).
 */
export const TEXTURE_ROLES = Object.freeze({ COLOR: 'color', NORMAL: 'normal', DATA: 'data' });

/** The role assumed for anything we cannot prove is photographic. */
export const DEFAULT_TEXTURE_ROLE = TEXTURE_ROLES.DATA;

// The only material slots known to hold photographic imagery.
const COLOR_SLOT_GETTERS = Object.freeze(['getBaseColorTexture', 'getEmissiveTexture']);

function isMaterial(property) {
  return Boolean(property)
    && typeof property.getBaseColorTexture === 'function'
    && typeof property.getNormalTexture === 'function';
}

/** Every texture slot the material exposes, whatever it is called. */
function materialTextureGetters(material) {
  return Object.getOwnPropertyNames(Object.getPrototypeOf(material))
    .filter(name => /^get[A-Z]\w*Texture$/.test(name));
}

function referencesNormalSlot(texture) {
  return texture.listParents().some(
    parent => isMaterial(parent) && parent.getNormalTexture() === texture,
  );
}

/**
 * Classify every texture in the document by the role its material slot gives
 * it, returning a Map<Texture, role>.
 *
 * Conservative by construction, in two ways:
 *  - a texture is `color` only when a known photographic slot (base color,
 *    emissive) references it. Every other slot — normal, packed
 *    roughness/metallic, occlusion, masks — carries material DATA;
 *  - if a texture is referenced by a colour slot AND any other slot, the
 *    restrictive role wins, and any texture referenced only through a slot we
 *    cannot enumerate (extension objects) is treated as DATA too.
 */
export function classifyTextures(document) {
  const roles = new Map();
  const dataTextures = new Set();

  for (const material of document.getRoot().listMaterials()) {
    for (const getter of materialTextureGetters(material)) {
      const texture = material[getter]();
      if (!texture) continue;
      if (COLOR_SLOT_GETTERS.includes(getter)) {
        if (!roles.has(texture)) roles.set(texture, TEXTURE_ROLES.COLOR);
      } else {
        dataTextures.add(texture);
      }
    }
  }

  // Restrictive role wins for dual-use textures.
  for (const texture of dataTextures) {
    roles.set(texture, referencesNormalSlot(texture) ? TEXTURE_ROLES.NORMAL : TEXTURE_ROLES.DATA);
  }

  // Anything a material points at that the slot scan could not see (extension
  // objects) is material data until proven photographic.
  for (const texture of document.getRoot().listTextures()) {
    if (roles.has(texture)) continue;
    if (texture.listParents().some(isMaterial)) {
      roles.set(texture, referencesNormalSlot(texture) ? TEXTURE_ROLES.NORMAL : TEXTURE_ROLES.DATA);
    }
  }

  return roles;
}

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_TYPE_JSON = 0x4e4f534a; // 'JSON'

/**
 * A rejected input file. Carries a stable `code` so callers (and tests) can
 * tell "this is not a GLB at all" apart from "this GLB is truncated".
 */
export class GlbValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GlbValidationError';
    this.code = code;
  }
}

/** Normalize a preset key; unknown keys fall back to `balanced` (never throws). */
export function resolvePreset(key) {
  const preset = OPTIMIZE_PRESETS[key];
  if (!preset) return { key: DEFAULT_PRESET_KEY, ...OPTIMIZE_PRESETS[DEFAULT_PRESET_KEY] };
  return { key, ...preset };
}

/**
 * Validate the GLB *container* before handing bytes to the parser, so a
 * corrupt or foreign file fails fast with an actionable message instead of a
 * cryptic parser error halfway through the pipeline.
 *
 * Checks: magic, version, declared length vs actual length, chunk bounds,
 * JSON chunk first + parsable, and the presence of `asset`.
 */
export function validateGlbContainer(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new GlbValidationError('INVALID_INPUT', 'expected a Uint8Array of GLB bytes');
  }
  if (bytes.byteLength < 12) {
    throw new GlbValidationError('TRUNCATED', `file is ${bytes.byteLength} bytes — too short to be a GLB`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    throw new GlbValidationError('NOT_GLB', 'missing the glTF binary magic — this is not a .glb file');
  }

  const version = view.getUint32(4, true);
  if (version !== 2) {
    throw new GlbValidationError('BAD_VERSION', `unsupported GLB version ${version} — only version 2 is supported`);
  }

  const declaredLength = view.getUint32(8, true);
  if (declaredLength > bytes.byteLength) {
    throw new GlbValidationError(
      'TRUNCATED',
      `header declares ${declaredLength} bytes but the file is only ${bytes.byteLength}`,
    );
  }
  if (declaredLength < bytes.byteLength) {
    throw new GlbValidationError(
      'LENGTH_MISMATCH',
      `header declares ${declaredLength} bytes but the file is ${bytes.byteLength} — trailing garbage?`,
    );
  }

  let offset = 12;
  let json = null;
  let hasBinChunk = false;
  while (offset < declaredLength) {
    if (offset + 8 > declaredLength) {
      throw new GlbValidationError('TRUNCATED', `chunk header at byte ${offset} runs past the end of the file`);
    }
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    if (chunkStart + chunkLength > declaredLength) {
      throw new GlbValidationError(
        'TRUNCATED',
        `chunk at byte ${offset} declares ${chunkLength} bytes, which runs past the end of the file`,
      );
    }
    if (chunkType === CHUNK_TYPE_JSON) {
      if (json !== null) {
        throw new GlbValidationError('BAD_JSON', 'file contains more than one JSON chunk');
      }
      // Chunk padding is spec'd as trailing spaces, but tolerate NUL padding
      // too: some exporters pad that way, and it is not worth rejecting an
      // otherwise perfectly good model over.
      const text = new TextDecoder()
        .decode(bytes.subarray(chunkStart, chunkStart + chunkLength))
        .replace(/\0+$/, '');
      try {
        json = JSON.parse(text);
      } catch {
        throw new GlbValidationError('BAD_JSON', 'the JSON chunk is not valid JSON');
      }
    } else {
      hasBinChunk = true;
    }
    offset = chunkStart + chunkLength;
  }

  if (json === null) {
    throw new GlbValidationError('MISSING_JSON_CHUNK', 'no JSON chunk found — not a valid GLB');
  }
  if (!json.asset || typeof json.asset.version !== 'string') {
    throw new GlbValidationError('MISSING_ASSET', 'JSON chunk has no asset.version — not a valid glTF');
  }

  return { version, declaredLength, hasBinChunk, json };
}

/**
 * Remove tool/export metadata WITHOUT touching meaningful names.
 *
 * Verified behaviour (asserted by tests/optimizer.test.mjs, documented in
 * the README's "Optimization" section):
 *  - the glTF writer always emits an `asset.generator`, and glTF-Transform's
 *    reader never carries the *original* exporter string into the document,
 *    so the uploaded file is deliberately re-tagged as Model Vault's output;
 *  - `asset.extras` (and every node/mesh/material/texture/scene `extras`
 *    block) is dropped from the written file, so tool-specific metadata does
 *    not travel with the shared model;
 *  - existing names are kept byte-for-byte. Only properties that were saved
 *    without any name get a neutral placeholder, so they stay identifiable.
 */
export function cleanMetadata(document) {
  const asset = document.getRoot().getAsset();
  if (asset) {
    asset.generator = GENERATOR_TAG;
    delete asset.extras;
  }
  document.getRoot().setExtras({});

  const fallbackName = (prefix, i, existing) => (existing && existing.trim() ? existing : `${prefix}_${i}`);
  document.getRoot().listNodes().forEach((n, i) => { n.setName(fallbackName('node', i, n.getName())); n.setExtras({}); });
  document.getRoot().listMeshes().forEach((n, i) => { n.setName(fallbackName('mesh', i, n.getName())); n.setExtras({}); });
  document.getRoot().listMaterials().forEach((n, i) => { n.setName(fallbackName('material', i, n.getName())); n.setExtras({}); });
  document.getRoot().listTextures().forEach((n, i) => { n.setName(fallbackName('texture', i, n.getName())); n.setExtras({}); });
  document.getRoot().listScenes().forEach((n, i) => { n.setName(fallbackName('scene', i, n.getName())); n.setExtras({}); });
}

/** What each adaptive stage would find in this document. */
export function inspectDocument(document) {
  const root = document.getRoot();
  let primitiveCount = 0;
  let vertexCount = 0;
  let triangleCount = 0;
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      primitiveCount++;
      const indices = primitive.getIndices();
      const position = primitive.getAttribute('POSITION');
      // Primitive.getMode() is null (meaning TRIANGLES) unless set explicitly.
      const isTriangles = (primitive.getMode() ?? 4) === 4;
      if (indices) {
        if (isTriangles) triangleCount += indices.getCount() / 3;
      } else if (position && isTriangles) {
        triangleCount += position.getCount() / 3;
      }
      if (position) vertexCount += position.getCount();
    }
  }
  return {
    nodeCount: root.listNodes().length,
    meshCount: root.listMeshes().length,
    materialCount: root.listMaterials().length,
    textureCount: root.listTextures().length,
    primitiveCount,
    vertexCount,
    triangleCount: Math.round(triangleCount),
  };
}

const defaultTimeStage = (label, run) => run();

/**
 * Run the optimization stages over an already-read glTF-Transform document.
 *
 * @param {object} options
 * @param {string} [options.preset] preset key (see OPTIMIZE_PRESETS)
 * @param {Function} [options.resizeTexture] texture strategy:
 *        async (texture, { maxSize, quality }) => result | null
 * @param {Function} [options.timeStage] (label, run) => Promise — wraps each
 *        stage so callers can time it (perf marks in the browser, timings in
 *        the benchmark). Default: run directly.
 * @param {Function} [options.onProgress] (step, pct) => void
 * @param {Function} [options.shouldCancel] () => boolean
 */
export async function optimizeDocument(document, options = {}) {
  const {
    preset: presetKey = DEFAULT_PRESET_KEY,
    resizeTexture = null,
    timeStage = defaultTimeStage,
    onProgress = null,
    shouldCancel = null,
  } = options;

  const preset = resolvePreset(presetKey);
  const work = inspectDocument(document);
  const stages = [];

  const report = (step, pct) => { if (onProgress) onProgress(step, pct); };
  const throwIfCancelled = () => {
    if (shouldCancel && shouldCancel()) throw new Error(CANCEL_MESSAGE);
  };

  throwIfCancelled();

  report('Cleaning unused data…', 25);
  await timeStage('prune:initial', async () => { await document.transform(prune()); });
  stages.push('prune:initial');
  throwIfCancelled();

  await timeStage('dedup:initial', async () => { await document.transform(dedup()); });
  stages.push('dedup:initial');
  throwIfCancelled();

  // MeshoptSimplifier has nothing to do without primitives, and throws on an
  // empty document — skip the stage entirely instead of paying for it.
  if (work.primitiveCount > 0) {
    report('Simplifying mesh…', 50);
    await timeStage('simplify', async () => {
      await document.transform(simplify({
        simplifier: MeshoptSimplifier,
        ratio: preset.ratio,
        error: preset.error,
      }));
    });
    stages.push('simplify');
    throwIfCancelled();
  }

  if (resizeTexture && work.textureCount > 0) {
    report('Resizing textures…', 70);
    const roles = classifyTextures(document);
    const limits = { maxSize: preset.textureSize, quality: preset.textureQuality };
    await timeStage('textures', async () => {
      const textures = document.getRoot().listTextures();
      for (let i = 0; i < textures.length; i++) {
        // A single bad texture must never abort the whole optimization —
        // keep the original bytes for that texture and carry on.
        try {
          await resizeTexture(textures[i], {
            ...limits,
            role: roles.get(textures[i]) || DEFAULT_TEXTURE_ROLE,
          });
        } catch (err) {
          console.warn('Texture resize skipped for one texture:', err);
        }
        report('Resizing textures…', Math.min(70 + Math.round(((i + 1) / textures.length) * 15), 85));
        throwIfCancelled();
      }
    });
    stages.push('textures');

    // Two textures that differed before can be byte-identical after the same
    // downscale + re-encode; dedup again so only one copy is written.
    await timeStage('dedup:final', async () => { await document.transform(dedup()); });
    stages.push('dedup:final');
    throwIfCancelled();
  }

  report('Final cleanup…', 88);
  await timeStage('prune:final', async () => { await document.transform(prune()); });
  stages.push('prune:final');
  throwIfCancelled();

  report('Removing tool metadata…', 92);
  await timeStage('metadata', async () => { cleanMetadata(document); });
  stages.push('metadata');

  return { preset, work, stages };
}

/**
 * Validate → read → optimize → write. Returns the optimized GLB bytes.
 * Rejects with GlbValidationError before parsing if the container is invalid.
 */
export async function optimizeGlbBytes(bytes, options = {}) {
  const { io = new WebIO(), ...rest } = options;
  const validation = validateGlbContainer(bytes);
  const document = await io.readBinary(bytes);
  const { preset, work, stages } = await optimizeDocument(document, { ...rest, io });
  const glb = await io.writeBinary(document);
  return { glb, byteLength: glb.byteLength, preset, work, stages, validation };
}

/**
 * The uploader's safety rule: an "optimization" that grew the file is a
 * failure, so the original is uploaded instead. Pure so it can be tested.
 */
export function shouldUseOptimized(originalSize, optimizedSize) {
  return optimizedSize < originalSize;
}
