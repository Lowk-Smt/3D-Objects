import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* ---- pure helpers shared with the server/tests (public/vault/shared.js) ---- */
import {
  MIME_BY_EXT, getExt, getMimeForName, normalizePath, basename, dirname, decodeUri,
  isInlineOrRemoteUri, sanitizeBaseName, findReferencedFile, getDownloadName
} from './shared.js';

/* ---- optimization pipeline imports ---- */
import { WebIO } from '@gltf-transform/core';
import { simplify, prune, dedup } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

/* ============================================================
   Model Vault — shared multi-user library frontend.

   The backend (Next.js API routes + Postgres + filesystem storage) is the
   canonical source of truth. This file is responsible for: auth screens,
   the Three.js viewer, client-side GLB optimization, thumbnail capture,
   search/sort/select UI, and talking to the backend over fetch() + SSE.
   Nothing here is persisted locally — a page reload always re-reads the
   shared library from the server.
   ============================================================ */

const $ = id => document.getElementById(id);

const uid = () => (
  crypto.randomUUID
    ? crypto.randomUUID()
    : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2)
);

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
);

function fmtSize(b){
  if (b === undefined || b === null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1){ n /= 1024; i++; }
  return (n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}

const fmtDate = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function presetLabel(key){
  switch (key){
    case 'high': return 'High quality';
    case 'balanced': return 'Balanced';
    case 'small': return 'Smallest file';
    default: return 'Optimized';
  }
}

function retypeBlob(blob, name){
  const wanted = getMimeForName(name);
  if (blob.type === wanted) return blob;
  return new Blob([blob], { type: wanted });
}

/* ============================================================
   BACKEND API CLIENT
   ============================================================ */

function getCookie(name){
  const escaped = name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&');
  const match = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

class ApiClientError extends Error {
  constructor(status, message){ super(message); this.status = status; }
}

let sessionExpiredHandled = false;

function setOffline(isOffline, message){
  const banner = $('errorBanner');
  if (isOffline){
    banner.textContent = message || "Can't reach the Model Vault server. Retrying…";
    banner.classList.remove('hidden');
    setConn('bad', 'Server unreachable');
  } else {
    banner.classList.add('hidden');
  }
}

async function rawFetch(url, options){
  try {
    return await fetch(url, options);
  } catch {
    setOffline(true);
    throw new ApiClientError(0, "Can't reach the server. Check your connection and try again.");
  }
}

async function apiFetch(url, options = {}){
  const opts = Object.assign({ credentials: 'same-origin' }, options);
  opts.headers = Object.assign({}, options.headers);

  const method = (opts.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD'){
    const csrf = getCookie('mv_csrf');
    if (csrf) opts.headers['x-csrf-token'] = csrf;
  }

  const response = await rawFetch(url, opts);
  setOffline(false);

  if (response.status === 401){
    onSessionExpired();
    throw new ApiClientError(401, 'Your session has expired. Please log in again.');
  }

  if (!response.ok){
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body && body.error) message = body.error;
    } catch { /* not json */ }
    throw new ApiClientError(response.status, message);
  }

  if (response.status === 204) return null;

  const ct = response.headers.get('content-type') || '';
  if (ct.includes('application/json')) return response.json();
  return response;
}

const api = {
  authStatus: () => rawFetch('/api/auth/status').then(r => r.json()),
  me: () => rawFetch('/api/auth/me', { credentials: 'same-origin' }),
  setup: (username, password) => apiFetch('/api/auth/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password })
  }),
  login: (username, password) => apiFetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password })
  }),
  logout: () => apiFetch('/api/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword, newPassword) => apiFetch('/api/auth/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword })
  }),

  listFiles: () => apiFetch('/api/files').then(d => d.files),
  fetchRaw: (id) => apiFetch(`/api/files/${id}/raw`).then(r => r.blob()),
  upload: (file, path, extra, onProgress) => uploadWithProgress(file, path, extra, onProgress),
  rename: (id, name) => apiFetch(`/api/files/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
  }),
  remove: (id) => apiFetch(`/api/files/${id}`, { method: 'DELETE' }),
  removeMany: (ids) => apiFetch('/api/files/batch-delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids })
  }),
  saveThumbnail: (id, dataUrl) => apiFetch(`/api/files/${id}/thumbnail`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl })
  }),
  stats: () => apiFetch('/api/stats'),

  listUsers: () => apiFetch('/api/users').then(d => d.users),
  createUser: (username, password, canDelete) => apiFetch('/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, canDelete })
  }),
  updateUser: (id, patch) => apiFetch(`/api/users/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
  }),
  deleteUser: (id) => apiFetch(`/api/users/${id}`, { method: 'DELETE' }),
};

function uploadWithProgress(file, relPath, extra, onProgress){
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('name', file.name);
    form.append('path', relPath || file.name);
    if (extra && extra.optimized) form.append('optimized', 'true');
    if (extra && extra.optimizePreset) form.append('preset', extra.optimizePreset);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files');
    xhr.withCredentials = true;
    const csrf = getCookie('mv_csrf');
    if (csrf) xhr.setRequestHeader('x-csrf-token', csrf);

    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
    };

    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* ignore */ }

      if (xhr.status === 401){ onSessionExpired(); reject(new ApiClientError(401, 'Session expired')); return; }

      if (xhr.status >= 200 && xhr.status < 300){
        resolve(body.file);
      } else {
        reject(new ApiClientError(xhr.status, (body && body.error) || `Upload failed (${xhr.status})`));
      }
    };

    xhr.onerror = () => { setOffline(true); reject(new ApiClientError(0, "Can't reach the server to upload this file.")); };

    xhr.send(form);
  });
}

/* ============================================================
   OPTIMIZATION PIPELINE (client-side, WASM-based) — unchanged behavior,
   except metadata cleanup no longer overwrites meaningful node / mesh /
   material / texture names. It only fills in a name when one is missing,
   and strips non-essential generator/tool metadata instead.
   ============================================================ */

// Stamped into the optimized file's asset.generator so a shared model always
// says where it came from, instead of advertising whatever exporter (or AI
// tool) produced the upload.
const GENERATOR_TAG = 'Model Vault 1.0 (glTF-Transform)';

const OPTIMIZE_PRESETS = {
  high:     { ratio: 0.7,  error: 0.0005, textureSize: 2048 },
  balanced: { ratio: 0.5,  error: 0.0005, textureSize: 2048 },
  small:    { ratio: 0.25, error: 0.001,  textureSize: 1024 }
};

async function resizeTextureManually(texture, maxSize){
  const mimeType = texture.getMimeType() || 'image/jpeg';
  const imageData = texture.getImage();
  if (!imageData) return;

  const blob = new Blob([imageData], { type: mimeType });
  const bitmap = await createImageBitmap(blob);

  if (bitmap.width <= maxSize && bitmap.height <= maxSize){ bitmap.close(); return; }

  const scale = maxSize / Math.max(bitmap.width, bitmap.height);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const outputType = mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
  const quality = outputType === 'image/jpeg' ? 0.9 : undefined;
  const outBlob = await new Promise(resolve => canvas.toBlob(resolve, outputType, quality));
  const buffer = new Uint8Array(await outBlob.arrayBuffer());

  texture.setImage(buffer);
  texture.setMimeType(outputType);
}

async function optimizeGLBBlob(blob, onProgress, presetKey = 'balanced', cancelToken = null){
  const preset = OPTIMIZE_PRESETS[presetKey] || OPTIMIZE_PRESETS.balanced;
  const report = (step, pct) => { if (onProgress) onProgress(step, pct); };
  const checkCancelled = () => { if (cancelToken && cancelToken.cancelled) throw new Error('OPTIMIZE_CANCELLED'); };

  report('Reading file…', 5);
  checkCancelled();

  const io = new WebIO();
  const buffer = await blob.arrayBuffer();
  const document = await io.readBinary(new Uint8Array(buffer));

  report('Simplifying mesh…', 20);
  await document.transform(simplify({ simplifier: MeshoptSimplifier, ratio: preset.ratio, error: preset.error }));
  checkCancelled();

  report('Resizing textures…', 50);
  const textures = document.getRoot().listTextures();
  for (let i = 0; i < textures.length; i++){
    try { await resizeTextureManually(textures[i], preset.textureSize); }
    catch (err){ console.warn('Texture resize skipped for one texture:', err); }
    report('Resizing textures…', Math.min(50 + Math.round(((i + 1) / textures.length) * 25), 75));
    checkCancelled();
  }

  report('Cleaning unused data…', 85);
  await document.transform(prune());
  await document.transform(dedup());
  checkCancelled();

  // Remove tool/export metadata WITHOUT touching meaningful names.
  //
  // Verified behaviour (asserted by tests/optimizer.test.mjs, documented in
  // the README's "Optimization" section):
  //  - the glTF writer always emits an `asset.generator`, and glTF-Transform's
  //    reader never carries the *original* exporter string into the document,
  //    so the uploaded file is deliberately re-tagged as Model Vault's output;
  //  - `asset.extras` (and every node/mesh/material/texture/scene `extras`
  //    block) is dropped from the written file, so tool-specific metadata does
  //    not travel with the shared model;
  //  - existing names are kept byte-for-byte. Only properties that were saved
  //    without any name get a neutral placeholder, so they stay identifiable.
  report('Removing tool metadata…', 92);
  const asset = document.getRoot().getAsset();
  if (asset){
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
  checkCancelled();

  report('Writing file…', 98);
  const result = await io.writeBinary(document);
  report('Done!', 100);

  return new Blob([result], { type: 'model/gltf-binary' });
}

function askToOptimize(file){
  return new Promise(resolve => {
    const overlay = $('optimizeModal');
    const nameEl = $('optimizeFileName');
    const actions = $('optimizeActions');
    const progress = $('optimizeProgress');
    const progressText = $('optimizeProgressText');
    const fillEl = $('optimizeProgressFill');
    const yesBtn = $('optimizeYes');
    const skipBtn = $('optimizeSkip');
    const cancelUploadBtn = $('optimizeCancelUpload');
    const cancelRunningBtn = $('optimizeCancelRunning');
    const presetSelect = $('optimizePreset');

    const cancelToken = { cancelled: false };

    nameEl.textContent = file.name + ' (' + fmtSize(file.size) + ')';
    actions.style.display = 'flex';
    cancelUploadBtn.style.display = 'block';
    cancelRunningBtn.disabled = false;
    progress.classList.remove('show');
    fillEl.style.width = '0%';
    overlay.classList.add('show');

    function cleanup(){
      overlay.classList.remove('show');
      yesBtn.removeEventListener('click', onYes);
      skipBtn.removeEventListener('click', onSkip);
      cancelUploadBtn.removeEventListener('click', onCancelUpload);
      cancelRunningBtn.removeEventListener('click', onCancelRunning);
    }

    function onSkip(){ cleanup(); resolve({ file, optimized: false, preset: null }); }
    function onCancelUpload(){ cleanup(); resolve({ file: null, optimized: false, preset: null }); }
    function onCancelRunning(){
      cancelToken.cancelled = true;
      cancelRunningBtn.disabled = true;
      progressText.textContent = 'Cancelling…';
    }

    async function onYes(){
      actions.style.display = 'none';
      cancelUploadBtn.style.display = 'none';
      progress.classList.add('show');

      const presetKey = presetSelect.value;

      try {
        const optimizedBlob = await optimizeGLBBlob(file, (step, pct) => {
          progressText.textContent = step;
          fillEl.style.width = pct + '%';
        }, presetKey, cancelToken);

        // Never make a file bigger by "optimizing" it — the original is the
        // safe fallback, and the user is told why.
        if (optimizedBlob.size >= file.size){
          cleanup();
          flash(
            `Optimizing "${file.name}" would have made it larger ` +
            `(${fmtSize(file.size)} → ${fmtSize(optimizedBlob.size)}), so the original was uploaded unchanged.`,
            5200
          );
          resolve({ file, optimized: false, preset: null });
          return;
        }

        const optimizedFile = new File([optimizedBlob], file.name, { type: 'model/gltf-binary', lastModified: Date.now() });

        cleanup();
        resolve({ file: optimizedFile, optimized: true, preset: presetKey });
      } catch (err){
        if (err && err.message === 'OPTIMIZE_CANCELLED'){ cleanup(); resolve({ file: null, optimized: false, preset: null }); return; }
        console.error('Optimization failed:', err);
        cleanup();
        alert(`Optimization failed for "${file.name}":\n${err.message}\n\nThe original file will be uploaded instead.`);
        resolve({ file, optimized: false, preset: null });
      }
    }

    yesBtn.addEventListener('click', onYes);
    skipBtn.addEventListener('click', onSkip);
    cancelUploadBtn.addEventListener('click', onCancelUpload);
    cancelRunningBtn.addEventListener('click', onCancelRunning);
  });
}

/* ============================================================
   THREE.JS VIEWER (unchanged from the original single-user app)
   ============================================================ */

const viewport = $('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
let needsRender = true;

renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1116);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
camera.position.set(2.4, 1.9, 3.2);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0.9, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.1));

const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
keyLight.position.set(4, 8, 6);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x99bbff, 0.9);
fillLight.position.set(-6, -2, -4);
scene.add(fillLight);

const grid = new THREE.GridHelper(20, 40, 0x2b3646, 0x1a2230);
grid.material.transparent = true;
grid.material.opacity = 0.75;
scene.add(grid);

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://unpkg.com/three@0.169.0/examples/jsm/libs/draco/');

const ktx2Loader = new KTX2Loader();
ktx2Loader.setTranscoderPath('https://unpkg.com/three@0.169.0/examples/jsm/libs/basis/');
ktx2Loader.detectSupport(renderer);

function resize(){
  const w = viewport.clientWidth; const h = viewport.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  needsRender = true;
}
new ResizeObserver(resize).observe(viewport);
resize();

const clock = new THREE.Clock();
let mixer = null;

controls.addEventListener('change', () => { needsRender = true; });

function animate(){
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if (mixer){ mixer.update(dt); needsRender = true; }
  controls.update();
  if (needsRender){ renderer.render(scene, camera); needsRender = false; }
}
animate();

let current = null;
let previewToken = 0;
let wireframeOn = false;

function disposeTree(root){
  root.traverse(object => {
    if (object.geometry) object.geometry.dispose();
    if (object.material){
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials){
        try {
          for (const key in material){
            const value = material[key];
            if (value && value.isTexture) value.dispose();
          }
        } catch { /* getters may throw */ }
        material.dispose();
      }
    }
  });
}

function clearModel(){
  if (current){
    if (wireframeOn) setWireframeMode(false);
    scene.remove(current);
    disposeTree(current);
    current = null;
  }
  mixer = null;
  wireframeOn = false;
  $('wireBtn').classList.remove('on');
  needsRender = true;
}

function normalize(object){
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = 2 / maxDim;
  object.scale.setScalar(scale);
  object.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  object.updateMatrixWorld(true);
}

function frameCamera(object){
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 0.35);
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.25;
  const direction = new THREE.Vector3(1, 0.75, 1.2).normalize();
  camera.position.copy(center).addScaledVector(direction, dist);
  camera.near = Math.max(dist / 1000, 0.001);
  camera.far = Math.max(dist * 100, 100);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
  needsRender = true;
}

function resetCamera(){
  camera.position.set(2.4, 1.9, 3.2);
  camera.near = 0.01; camera.far = 10000;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0.9, 0);
  controls.update();
  needsRender = true;
}

function captureThumb(size = 200){
  const renderTarget = new THREE.WebGLRenderTarget(size, size, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType, depthBuffer: true, stencilBuffer: false
  });
  renderTarget.texture.colorSpace = THREE.SRGBColorSpace;

  const oldTarget = renderer.getRenderTarget();
  const oldAspect = camera.aspect; const oldFov = camera.fov; const oldGrid = grid.visible;

  grid.visible = false;
  camera.aspect = 1; camera.fov = 36;
  camera.updateProjectionMatrix();

  renderer.setRenderTarget(renderTarget);
  renderer.render(scene, camera);

  const pixels = new Uint8Array(size * size * 4);
  renderer.readRenderTargetPixels(renderTarget, 0, 0, size, size, pixels);

  renderer.setRenderTarget(oldTarget);
  grid.visible = oldGrid;
  camera.aspect = oldAspect; camera.fov = oldFov;
  camera.updateProjectionMatrix();
  renderTarget.dispose();

  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(size, size);

  for (let y = 0; y < size; y++){
    const source = (size - 1 - y) * size * 4;
    imageData.data.set(pixels.subarray(source, source + size * 4), y * size * 4);
  }
  ctx.putImageData(imageData, 0, 0);
  needsRender = true;

  return canvas.toDataURL('image/jpeg', 0.72);
}

async function createDependencyUrl(modelMeta, uri, cache, createdUrls){
  if (isInlineOrRemoteUri(uri)) return uri;
  const key = decodeUri(uri);
  if (cache.has(key)) return cache.get(key);

  const dependencyMeta = findReferencedFile(state.files, modelMeta, key);
  if (!dependencyMeta){
    throw new Error(`Missing companion file "${key}". Add that file to the library along with "${modelMeta.name}".`);
  }

  const blob = retypeBlob(await api.fetchRaw(dependencyMeta.id), dependencyMeta.name);
  const objectUrl = URL.createObjectURL(blob);
  createdUrls.push(objectUrl);
  cache.set(key, objectUrl);
  return objectUrl;
}

async function parseGLTF(rawBlob, name, meta){
  const jsonText = await rawBlob.text();
  let json;
  try { json = JSON.parse(jsonText); } catch { throw new Error(`"${name}" is not valid glTF JSON.`); }

  const cache = new Map();
  const createdUrls = [];

  try {
    if (Array.isArray(json.buffers)){
      for (const buffer of json.buffers){
        if (buffer && buffer.uri && !isInlineOrRemoteUri(buffer.uri)){
          buffer.uri = await createDependencyUrl(meta, buffer.uri, cache, createdUrls);
        }
      }
    }
    if (Array.isArray(json.images)){
      for (const image of json.images){
        if (image && image.uri && !isInlineOrRemoteUri(image.uri)){
          image.uri = await createDependencyUrl(meta, image.uri, cache, createdUrls);
        }
      }
    }

    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);
    loader.setKTX2Loader(ktx2Loader);
    loader.setMeshoptDecoder(MeshoptDecoder);

    return await loader.parseAsync(JSON.stringify(json), '');
  } finally {
    for (const objectUrl of createdUrls) URL.revokeObjectURL(objectUrl);
  }
}

async function parseModel(rawBlob, name, meta){
  const blob = retypeBlob(rawBlob, name);
  const ext = getExt(name);

  switch (ext){
    case 'glb': {
      const buffer = await blob.arrayBuffer();
      const loader = new GLTFLoader();
      loader.setDRACOLoader(dracoLoader);
      loader.setKTX2Loader(ktx2Loader);
      loader.setMeshoptDecoder(MeshoptDecoder);
      const result = await loader.parseAsync(buffer, '');
      return { object: result.scene, animations: result.animations || [] };
    }
    case 'gltf': {
      const result = await parseGLTF(blob, name, meta);
      return { object: result.scene, animations: result.animations || [] };
    }
    case 'obj': {
      const text = await blob.text();
      return { object: new OBJLoader().parse(text) };
    }
    case 'stl': {
      const buffer = await blob.arrayBuffer();
      const geometry = new STLLoader().parse(buffer);
      geometry.computeVertexNormals();
      return { object: new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x9aa7b8, metalness: 0.15, roughness: 0.6 })) };
    }
    case 'ply': {
      const buffer = await blob.arrayBuffer();
      const geometry = new PLYLoader().parse(buffer);
      if (geometry.hasAttribute && geometry.hasAttribute('position')) geometry.computeVertexNormals();
      const hasColor = !!geometry.getAttribute('color');
      return { object: new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: hasColor, color: hasColor ? 0xffffff : 0x9aa7b8, metalness: 0.1, roughness: 0.7 })) };
    }
    case 'fbx': {
      const buffer = await blob.arrayBuffer();
      const object = new FBXLoader().parse(buffer, '');
      return { object, animations: object.animations || [] };
    }
    default:
      return null;
  }
}

/* ============================================================
   APP STATE
   ============================================================ */

const state = {
  files: [],
  query: '',
  sort: 'new',
  activeId: null,
  selectMode: false,
  selected: new Set(),
  currentUser: null,
};

const listEl = $('list');
const searchEl = $('search');
const hudEl = $('hud');
const emptyCard = $('emptyCard');
const fbCard = $('fallbackCard');
const fbName = $('fbName');
const fbMsg = $('fbMsg');
const fbDownload = $('fbDownload');
const selBar = $('selBar');
const selCount = $('selCount');
const selAll = $('selAll');

let hudTimer = null;

function setStatus(msg){
  clearTimeout(hudTimer);
  hudEl.classList.remove('error');
  if (!msg){ hudEl.classList.remove('show'); return; }
  hudEl.textContent = msg;
  hudEl.classList.add('show');
}

function flash(msg, ms = 2400){
  setStatus(msg);
  hudTimer = setTimeout(() => hudEl.classList.remove('show'), ms);
}

function flashError(msg, ms = 4200){
  clearTimeout(hudTimer);
  hudEl.textContent = msg;
  hudEl.classList.add('show');
  hudEl.classList.add('error');
  hudTimer = setTimeout(() => { hudEl.classList.remove('show'); hudEl.classList.remove('error'); }, ms);
}

function showEmpty(){ emptyCard.classList.remove('hidden'); fbCard.classList.add('hidden'); }

function showFallback(meta, msg){
  emptyCard.classList.add('hidden');
  fbCard.classList.remove('hidden');
  fbName.textContent = meta.name;
  fbMsg.textContent = msg;
  fbDownload.onclick = () => downloadFile(meta);
}

function canCurrentUserDelete(){
  const u = state.currentUser;
  return !!u && (u.role === 'owner' || u.canDelete);
}

/* ============================================================
   SORT / FILTER / RENDER
   ============================================================ */

function sortedFiles(files){
  const array = files.slice();
  switch (state.sort){
    case 'old': array.sort((a, b) => a.date - b.date); break;
    case 'name': array.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })); break;
    case 'namez': array.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true })); break;
    case 'big': array.sort((a, b) => b.size - a.size); break;
    case 'small': array.sort((a, b) => a.size - b.size); break;
    default: array.sort((a, b) => b.date - a.date);
  }
  return array;
}

function visibleFiles(){
  const query = state.query.trim().toLowerCase();
  const files = state.files.filter(file => !query || file.name.toLowerCase().includes(query));
  return sortedFiles(files);
}

function renderList(){
  const files = visibleFiles();
  const canDelete = canCurrentUserDelete();

  if (!files.length){
    listEl.innerHTML = `<div class="empty-list">${
      state.files.length ? 'No files match your search.' : 'The shared library is empty.<br>Add or drop some files to get started.'
    }</div>`;
  } else {
    listEl.innerHTML = files.map(file => {
      const ext = getExt(file.name).toUpperCase().slice(0, 4) || 'FILE';
      const selected = state.selected.has(file.id);

      const actions = state.selectMode
        ? `<div class="check ${selected ? 'on' : ''}">${selected ? '✓' : ''}</div>`
        : `<button data-act="download" title="Download">↓</button>
           <button data-act="rename" title="Rename">✎</button>
           <button data-act="del" title="${canDelete ? 'Delete' : 'You do not have delete permission'}" ${canDelete ? '' : 'disabled'}>✕</button>`;

      return `
        <div class="item ${file.id === state.activeId ? 'active' : ''} ${selected ? 'sel' : ''}" data-id="${file.id}">
          <div class="badge">${file.thumb ? `<img src="${esc(file.thumb)}" alt="" loading="lazy">` : esc(ext)}</div>
          <div class="info">
            <div class="fname" title="${esc(file.name)}">${esc(file.name)}</div>
            <div class="fsub">
              ${fmtSize(file.size)} · ${fmtDate(file.date)}
              ${file.optimized ? `<span class="tag">${esc(presetLabel(file.optimizePreset))}</span>` : ''}
              <br><span class="uploader">by ${esc(file.uploaderName || 'Unknown')}</span>
            </div>
          </div>
          <div class="acts">${actions}</div>
        </div>
      `;
    }).join('');
  }

  $('count').textContent = state.files.length + (state.files.length === 1 ? ' file' : ' files');
  updateSelBar();
}

function updateSelBar(){
  selCount.textContent = state.selected.size + ' selected';
  const visible = visibleFiles();
  selAll.checked = visible.length > 0 && visible.every(file => state.selected.has(file.id));
  selAll.indeterminate = !selAll.checked && visible.some(file => state.selected.has(file.id));
  $('selDelete').disabled = state.selected.size === 0 || !canCurrentUserDelete();
  $('selDownload').disabled = state.selected.size === 0;
}

/* ============================================================
   STORAGE METER (workspace-wide, from the server)
   ============================================================ */

async function updateUsage(){
  try {
    const stats = await api.stats();
    const fill = $('usageFill');
    if (stats.quotaBytes){
      const pct = (stats.totalBytes / stats.quotaBytes) * 100;
      fill.style.width = Math.min(pct, 100).toFixed(2) + '%';
      fill.classList.toggle('warn', pct > 80);
      $('usage').textContent = `${fmtSize(stats.totalBytes)} of ${fmtSize(stats.quotaBytes)}`;
    } else {
      fill.style.width = '100%';
      fill.classList.remove('warn');
      $('usage').textContent = `${fmtSize(stats.totalBytes)} used`;
    }
  } catch { /* non-critical */ }
}

/* ============================================================
   OPEN MODEL / PREVIEW
   ============================================================ */

async function openModel(meta){
  const token = ++previewToken;
  emptyCard.classList.add('hidden');
  fbCard.classList.add('hidden');
  setStatus('Loading ' + meta.name + '…');

  let blob;
  try {
    blob = await api.fetchRaw(meta.id);
  } catch (error){
    if (token !== previewToken) return;
    showFallback(meta, error.message || 'Could not download this file from the server.');
    setStatus('');
    return;
  }

  if (token !== previewToken) return;

  let result = null; let error = null;
  try {
    result = await parseModel(blob, meta.name, meta);
  } catch (err){
    error = err;
    console.error('Preview failed:', meta.name, err);
  }

  if (token !== previewToken) return;

  if (error || !result){
    clearModel();
    state.activeId = meta.id;
    renderList();
    showFallback(meta, error ? error.message : `.${getExt(meta.name)} files can't be previewed here, but they're stored safely and can be downloaded.`);
    setStatus('');
    return;
  }

  clearModel();
  const object = result.object;
  normalize(object);
  scene.add(object);
  current = object;

  if (result.animations && result.animations.length){
    mixer = new THREE.AnimationMixer(object);
    for (const clip of result.animations) mixer.clipAction(clip).play();
  }

  frameCamera(object);
  state.activeId = meta.id;
  renderList();
  setStatus('');
  needsRender = true;

  // Thumbnails are shared with the whole workspace, so only the uploader (or
  // the owner) may create/replace one — the API enforces the same rule.
  if (!meta.thumb && canManageThumbnail(meta)){
    requestAnimationFrame(async () => {
      if (token !== previewToken) return;
      try {
        const thumb = captureThumb(200);
        await api.saveThumbnail(meta.id, thumb);
        meta.thumb = thumb;
        meta.updatedAt = Date.now();
        renderThumbBadge(meta.id, thumb);
      } catch (error){
        console.warn('Thumbnail upload failed:', error);
        if (error && error.status !== 401){
          flash('Preview thumbnail was not saved: ' + (error.message || 'unknown error'));
        }
      }
    });
  }
}

function canManageThumbnail(meta){
  const u = state.currentUser;
  if (!u || !meta) return false;
  return u.role === 'owner' || (!!meta.uploaderId && meta.uploaderId === u.id);
}

/** Repaints just one list item's thumbnail instead of re-rendering the list. */
function renderThumbBadge(id, url){
  const item = Array.from(listEl.querySelectorAll('.item')).find(el => el.dataset.id === id);
  if (!item) return;
  const wrap = item.querySelector('.badge');
  if (wrap) wrap.innerHTML = `<img src="${esc(url)}" alt="" loading="lazy">`;
}

/* ============================================================
   DOWNLOAD / RENAME / DELETE
   ============================================================ */

function downloadFile(meta){
  const anchor = document.createElement('a');
  anchor.href = `/api/files/${meta.id}/download`;
  anchor.download = getDownloadName(meta);
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

async function renameFile(meta){
  const originalExt = meta.ext || getExt(meta.name);
  const originalBase = originalExt && getExt(meta.name) === originalExt
    ? meta.name.slice(0, -(originalExt.length + 1))
    : meta.name;

  const entered = prompt('Rename file', originalBase);
  if (entered === null) return;

  let base = sanitizeBaseName(entered);
  if (!base){ flashError('Invalid file name'); return; }

  const newName = originalExt ? `${base}.${originalExt}` : base;
  if (newName === meta.name) return;

  try {
    const result = await api.rename(meta.id, base);
    meta.name = result.file.name;
    meta.path = result.file.path;
    meta.mime = result.file.mime;
    meta.updatedAt = result.file.updatedAt;
    renderList();
    flash('Renamed to ' + meta.name);
  } catch (err){
    flashError(err.message || 'Could not rename this file.');
  }
}

async function deleteFile(meta){
  if (!canCurrentUserDelete()){ flashError("You don't have permission to delete files."); return; }
  if (!confirm(`Delete "${meta.name}"?\nThis cannot be undone.`)) return;

  try {
    await api.remove(meta.id);
    removeFilesFromState([meta.id]);
    flash(`Deleted "${meta.name}"`);
  } catch (err){
    flashError(err.message || 'Could not delete this file.');
  }
}

function removeFilesFromState(ids){
  const idSet = new Set(ids);
  state.files = state.files.filter(file => !idSet.has(file.id));
  for (const id of ids) state.selected.delete(id);

  if (state.activeId && idSet.has(state.activeId)){
    state.activeId = null;
    clearModel();
    resetCamera();
    $('wireBtn').classList.remove('on');
    showEmpty();
  }

  renderList();
  updateUsage();
}

async function deleteSelected(){
  if (!canCurrentUserDelete()){ flashError("You don't have permission to delete files."); return; }
  const ids = [...state.selected];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} file${ids.length > 1 ? 's' : ''}?\nThis cannot be undone.`)) return;

  setStatus('Deleting…');
  try {
    const result = await apiFetch('/api/files/batch-delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids })
    });
    removeFilesFromState(result.deleted);
    exitSelectMode();
    setStatus('');
    flash(`Deleted ${result.deleted.length} file${result.deleted.length === 1 ? '' : 's'}`);
  } catch (err){
    setStatus('');
    flashError(err.message || 'Could not delete the selected files.');
  }
}

async function downloadSelected(){
  const metas = state.files.filter(file => state.selected.has(file.id));
  if (!metas.length) return;
  if (!confirm(`Download ${metas.length} file${metas.length > 1 ? 's' : ''}?\n\nYour browser may ask permission for multiple downloads.`)) return;

  for (const meta of metas){
    downloadFile(meta);
    await new Promise(resolve => setTimeout(resolve, 350));
  }
}

/* ============================================================
   SELECT MODE
   ============================================================ */

function enterSelectMode(){
  state.selectMode = true;
  state.selected.clear();
  selBar.classList.remove('hidden');
  $('selectBtn').classList.add('on');
  $('selectBtn').textContent = 'Cancel';
  renderList();
}

function exitSelectMode(){
  state.selectMode = false;
  state.selected.clear();
  selBar.classList.add('hidden');
  $('selectBtn').classList.remove('on');
  $('selectBtn').textContent = 'Select';
  renderList();
}

/* ============================================================
   UPLOAD (with optimize prompt) -> shared backend
   ============================================================ */

function mapServerFile(f){
  return {
    id: f.id,
    name: f.name,
    ext: f.ext,
    mime: f.mime,
    size: f.size,
    path: f.path,
    date: f.uploadedAt,
    updatedAt: f.updatedAt,
    uploaderId: f.uploaderId,
    uploaderName: f.uploaderName,
    optimized: f.optimized,
    optimizePreset: f.optimizePreset,
    thumb: f.hasThumbnail ? `/api/files/${f.id}/thumbnail?v=${f.updatedAt}` : null,
  };
}

async function addFiles(fileList, relativePaths){
  const fileArray = Array.from(fileList || []);
  if (!fileArray.length) return;

  const added = [];
  let skipped = 0;
  let cancelledCount = 0;
  let failed = 0;

  for (let i = 0; i < fileArray.length; i++){
    let file = fileArray[i];

    const duplicate = state.files.some(stored => stored.name === file.name && stored.size === file.size);
    if (duplicate){ skipped++; continue; }

    let wasOptimized = false;
    let optimizePresetUsed = null;

    if (getExt(file.name) === 'glb'){
      const result = await askToOptimize(file);
      if (!result.file){ cancelledCount++; continue; }
      file = result.file;
      wasOptimized = result.optimized;
      optimizePresetUsed = result.preset;
    }

    setStatus(`Uploading ${i + 1} / ${fileArray.length}…`);

    try {
      // Relative paths matter for .gltf files: they are how companion .bin /
      // texture references are resolved in the shared library. They come from
      // the folder drag-and-drop walk, or from a webkitdirectory input.
      const relPath = (relativePaths && relativePaths.get(file)) || file.webkitRelativePath || file.name;
      const serverMeta = await api.upload(file, relPath, wasOptimized ? { optimized: true, optimizePreset: optimizePresetUsed } : {}, (pct) => {
        setStatus(`Uploading ${i + 1} / ${fileArray.length}… ${Math.round(pct * 100)}%`);
      });
      added.push(mapServerFile(serverMeta));
    } catch (error){
      console.error('Upload failed:', file.name, error);
      failed++;
      flashError(`"${file.name}" failed to upload: ${error.message}`);
    }
  }

  for (const meta of added) upsertFile(meta);
  renderList();
  updateUsage();
  setStatus('');

  let message = `Uploaded ${added.length} file${added.length === 1 ? '' : 's'}`;
  if (skipped) message += ` · skipped ${skipped} duplicate${skipped === 1 ? '' : 's'} (same name and size already in the library)`;
  if (cancelledCount) message += ` · cancelled ${cancelledCount}`;
  if (failed) message += ` · ${failed} failed`;

  if (added.length || skipped || cancelledCount || failed) flash(message, failed ? 5000 : 2600);

  if (added.length) openModel(added[added.length - 1]);
}

function upsertFile(meta){
  const idx = state.files.findIndex(f => f.id === meta.id);
  if (idx >= 0) state.files[idx] = Object.assign({}, state.files[idx], meta);
  else state.files.unshift(meta);
}

/* ============================================================
   REAL-TIME SYNC (Server-Sent Events)
   ============================================================ */

let eventSource = null;

function setConn(status, text){
  const dot = $('connDot');
  dot.classList.remove('ok', 'bad', 'warn');
  if (status) dot.classList.add(status);
  $('connText').textContent = text;
}

async function syncFileList(){
  try {
    const files = await api.listFiles();
    state.files = files.map(mapServerFile);
    if (state.activeId && !state.files.some(f => f.id === state.activeId)){
      state.activeId = null;
      clearModel();
      resetCamera();
      showEmpty();
    }
    renderList();
    updateUsage();
  } catch (err){
    if (err.status !== 401) flashError('Could not refresh the library from the server.');
  }
}

function connectEvents(){
  if (eventSource) eventSource.close();

  eventSource = new EventSource('/api/events');

  eventSource.onopen = () => {
    setOffline(false);
    setConn('ok', 'Live sync connected');
    // The stream may have been down while other people changed the library,
    // so the full list is re-read from the server on every (re)connect.
    resyncAfterReconnect();
  };

  eventSource.onerror = () => {
    if (!state.currentUser) return;
    // readyState CLOSED means the browser gave up (e.g. the server answered
    // 401), as opposed to a transient drop where it reconnects on its own.
    if (eventSource && eventSource.readyState === EventSource.CLOSED){
      setConn('bad', 'Live sync offline');
      handleStreamClosed();
    } else {
      setConn('warn', 'Reconnecting…');
    }
  };

  // The server closes the stream when a session is revoked (password change,
  // removed account) so a stale tab cannot keep receiving live updates.
  eventSource.addEventListener('session-expired', () => {
    disconnectEvents();
    onSessionExpired('Your session is no longer valid. Please log in again.');
  });

  eventSource.addEventListener('file-added', (e) => {
    const payload = JSON.parse(e.data);
    upsertFile(mapServerFile(payload));
    renderList();
    updateUsage();
    if (payload.uploaderId !== (state.currentUser && state.currentUser.id)){
      // flash() writes via textContent — escaping here would show raw entities.
      flash(`${payload.uploaderName || 'Someone'} added "${payload.name}"`);
    }
  });

  eventSource.addEventListener('file-updated', (e) => {
    const payload = JSON.parse(e.data);
    const existing = state.files.find(f => f.id === payload.id);
    if (!existing) return;
    Object.assign(existing, {
      name: payload.name ?? existing.name,
      path: payload.path ?? existing.path,
      mime: payload.mime ?? existing.mime,
      updatedAt: payload.updatedAt ?? existing.updatedAt,
    });
    if (payload.hasThumbnail){
      existing.thumb = `/api/files/${existing.id}/thumbnail?v=${payload.updatedAt}`;
    }
    renderList();
  });

  eventSource.addEventListener('file-deleted', (e) => {
    const payload = JSON.parse(e.data);
    removeFilesFromState([payload.id]);
  });

  eventSource.addEventListener('files-deleted', (e) => {
    const payload = JSON.parse(e.data);
    removeFilesFromState(payload.ids);
  });

  eventSource.addEventListener('member-changed', () => {
    if (!$('membersModal').classList.contains('show')) return;
    loadMembersList();
  });
}

function disconnectEvents(){
  if (eventSource){ eventSource.close(); eventSource = null; }
}

let sessionCheckInFlight = false;

/**
 * Called when the event stream closes for good. Re-checks the session: if it
 * is gone we return to the login screen, otherwise we reconnect (a server
 * restart drops the stream but the session in Postgres is still valid).
 */
async function handleStreamClosed(){
  if (sessionCheckInFlight || !state.currentUser) return;
  sessionCheckInFlight = true;
  try {
    const response = await api.me();
    if (response.status === 401){
      onSessionExpired('Your session expired. Please log in again.');
      return;
    }
    if (response.ok){
      setConn('warn', 'Reconnecting…');
      connectEvents();
    }
  } catch {
    setConn('warn', 'Reconnecting…');
  } finally {
    sessionCheckInFlight = false;
  }
}

/** Re-syncs the whole library from the server (used after reconnects). */
async function resyncAfterReconnect(){ await syncFileList(); }

/* ============================================================
   MEMBERS / PERMISSIONS UI
   ============================================================ */

async function loadMembersList(){
  const wrap = $('membersList');
  wrap.innerHTML = '<div class="empty-list">Loading…</div>';

  try {
    const members = await api.listUsers();
    const isOwner = state.currentUser && state.currentUser.role === 'owner';

    $('inviteBox').classList.toggle('hidden', !isOwner);

    wrap.innerHTML = members.map(m => {
      const isSelf = m.id === state.currentUser.id;
      if (!isOwner){
        return `<div class="member-row">
          <div class="mname">${esc(m.username)}${isSelf ? ' (you)' : ''}</div>
          <span class="role-badge ${m.role === 'owner' ? 'owner' : ''}">${esc(m.role)}</span>
        </div>`;
      }
      return `<div class="member-row" data-id="${m.id}">
        <div class="mname">${esc(m.username)}${isSelf ? ' (you)' : ''}<div class="mmeta">joined ${fmtDate(new Date(m.createdAt).getTime())}</div></div>
        <select data-field="role" ${isSelf ? 'disabled' : ''}>
          <option value="member" ${m.role === 'member' ? 'selected' : ''}>Member</option>
          <option value="owner" ${m.role === 'owner' ? 'selected' : ''}>Owner</option>
        </select>
        <label class="del-toggle"><input type="checkbox" data-field="canDelete" ${m.canDelete ? 'checked' : ''}> Can delete</label>
        <button class="btn sm danger" data-act="remove-member" ${isSelf ? 'disabled' : ''}>Remove</button>
      </div>`;
    }).join('') || '<div class="empty-list">No members yet.</div>';
  } catch (err){
    wrap.innerHTML = `<div class="empty-list">Could not load members: ${esc(err.message || 'unknown error')}</div>`;
  }
}

$('membersList').addEventListener('change', async (e) => {
  const row = e.target.closest('.member-row');
  if (!row) return;
  const id = row.dataset.id;
  const field = e.target.dataset.field;
  if (!field) return;

  try {
    if (field === 'role') await api.updateUser(id, { role: e.target.value });
    if (field === 'canDelete') await api.updateUser(id, { canDelete: e.target.checked });
    flash('Updated member permissions');
  } catch (err){
    flashError(err.message || 'Could not update this member.');
    loadMembersList();
  }
});

$('membersList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act="remove-member"]');
  if (!btn) return;
  const row = e.target.closest('.member-row');
  const id = row.dataset.id;
  if (!confirm('Remove this member? Their uploaded files will stay in the library.')) return;

  try {
    await api.deleteUser(id);
    loadMembersList();
    flash('Member removed');
  } catch (err){
    flashError(err.message || 'Could not remove this member.');
  }
});

$('membersBtn').addEventListener('click', () => {
  $('membersModal').classList.add('show');
  loadMembersList();
});
$('membersCloseBtn').addEventListener('click', () => $('membersModal').classList.remove('show'));
$('membersCloseBtn2').addEventListener('click', () => $('membersModal').classList.remove('show'));

$('inviteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('inviteUsername').value.trim();
  const password = $('invitePassword').value;
  const canDelete = $('inviteCanDelete').checked;
  const errorEl = $('inviteError');
  errorEl.classList.add('hidden');

  try {
    await api.createUser(username, password, canDelete);
    $('inviteUsername').value = '';
    $('invitePassword').value = '';
    loadMembersList();
    flash(`Invited "${username}"`);
  } catch (err){
    errorEl.textContent = err.message || 'Could not create this member.';
    errorEl.classList.remove('hidden');
  }
});

/* ============================================================
   AUTH FLOW
   ============================================================ */

function showAuthOverlay(pane){
  $('authOverlay').classList.remove('hidden');
  $('setupPane').classList.add('hidden');
  $('loginPane').classList.add('hidden');
  $('authLoadingPane').classList.add('hidden');
  $(pane).classList.remove('hidden');
}

function hideAuthOverlay(){
  $('authOverlay').classList.add('hidden');
}

function applyCurrentUser(user){
  state.currentUser = user;
  $('userBox').classList.remove('hidden');
  $('usernameLabel').textContent = user.username;
  const badge = $('roleBadge');
  badge.textContent = user.role;
  badge.classList.toggle('owner', user.role === 'owner');
}

/**
 * Returns the UI to a logged-out state and shows the login screen. Shared by
 * explicit logout, an expired/revoked session, and a password change.
 */
function resetToLoggedOut(message){
  disconnectEvents();
  state.currentUser = null;
  state.files = [];
  state.activeId = null;
  state.selected.clear();
  state.selectMode = false;
  clearModel();
  resetCamera();
  showEmpty();
  renderList();
  $('userBox').classList.add('hidden');
  $('selBar').classList.add('hidden');
  setConn('bad', 'Logged out');
  $('loginUsername').value = '';
  $('loginPassword').value = '';
  showAuthOverlay('loginPane');
  if (message) flashError(message, 6000);
}

function onSessionExpired(message){
  if (sessionExpiredHandled) return;
  sessionExpiredHandled = true;
  resetToLoggedOut(message || 'Your session expired. Please log in again.');
}

async function startApp(user){
  sessionExpiredHandled = false;
  applyCurrentUser(user);
  hideAuthOverlay();
  connectEvents();
  await syncFileList();
  showEmpty();
}

$('setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('setupUsername').value.trim();
  const password = $('setupPassword').value;
  const errorEl = $('setupError');
  errorEl.classList.add('hidden');

  try {
    const result = await api.setup(username, password);
    await startApp(result.user);
  } catch (err){
    errorEl.textContent = err.message || 'Could not create the owner account.';
    errorEl.classList.remove('hidden');
  }
});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('loginUsername').value.trim();
  const password = $('loginPassword').value;
  const errorEl = $('loginError');
  errorEl.classList.add('hidden');

  try {
    const result = await api.login(username, password);
    await startApp(result.user);
  } catch (err){
    errorEl.textContent = err.message || 'Invalid username or password.';
    errorEl.classList.remove('hidden');
  }
});

$('logoutBtn').addEventListener('click', async () => {
  try { await api.logout(); } catch { /* ignore — we log out locally regardless */ }
  resetToLoggedOut('Logged out.');
});

/* ---------- change own password ---------- */

$('pwForm').addEventListener('submit', async (event) => {
  event.preventDefault();

  const errorEl = $('pwError');
  const currentPassword = $('pwCurrent').value;
  const newPassword = $('pwNew').value;
  errorEl.classList.add('hidden');

  if (newPassword.length < 8){
    errorEl.textContent = 'New password must be at least 8 characters.';
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    await api.changePassword(currentPassword, newPassword);
    $('pwCurrent').value = '';
    $('pwNew').value = '';
    $('membersModal').classList.remove('show');
    // Changing a password revokes every session for this account, including
    // this one — so log in again with the new password.
    resetToLoggedOut('Password changed. Please log in again with your new password.');
  } catch (err){
    errorEl.textContent = err.message || 'Could not change your password.';
    errorEl.classList.remove('hidden');
  }
});

/* ============================================================
   GENERIC UI EVENTS
   ============================================================ */

$('addBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', event => { addFiles(event.target.files); event.target.value = ''; });

searchEl.addEventListener('input', event => { state.query = event.target.value; renderList(); });
$('sortSel').addEventListener('change', event => { state.sort = event.target.value; renderList(); });

$('selectBtn').addEventListener('click', () => { state.selectMode ? exitSelectMode() : enterSelectMode(); });
$('selCancel').addEventListener('click', exitSelectMode);
$('selDelete').addEventListener('click', deleteSelected);
$('selDownload').addEventListener('click', downloadSelected);

selAll.addEventListener('change', () => {
  const visible = visibleFiles();
  if (selAll.checked) for (const file of visible) state.selected.add(file.id);
  else for (const file of visible) state.selected.delete(file.id);
  renderList();
});

listEl.addEventListener('click', event => {
  const item = event.target.closest('.item');
  if (!item) return;
  const meta = state.files.find(file => file.id === item.dataset.id);
  if (!meta) return;

  if (state.selectMode){
    if (state.selected.has(meta.id)) state.selected.delete(meta.id);
    else state.selected.add(meta.id);
    renderList();
    return;
  }

  const button = event.target.closest('button[data-act]');
  if (button){
    event.stopPropagation();
    if (button.disabled) return;
    const action = button.dataset.act;
    if (action === 'download') downloadFile(meta);
    else if (action === 'rename') renameFile(meta);
    else if (action === 'del') deleteFile(meta);
    return;
  }

  openModel(meta);
});

$('resetBtn').addEventListener('click', () => { if (current) frameCamera(current); else resetCamera(); });

const wireframeInvisibleMaterial = new THREE.MeshBasicMaterial({ colorWrite: false });

function setWireframeMode(enabled){
  if (!current) return;
  current.traverse(obj => {
    if (!obj.isMesh) return;
    if (enabled){
      if (!obj.userData._wireLine){
        const edges = new THREE.EdgesGeometry(obj.geometry, 25);
        const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x8fb4ff }));
        line.renderOrder = 1;
        obj.add(line);
        obj.userData._wireLine = line;
      }
      if (!obj.userData._origMaterial) obj.userData._origMaterial = obj.material;
      obj.material = wireframeInvisibleMaterial;
    } else {
      if (obj.userData._wireLine){
        obj.remove(obj.userData._wireLine);
        obj.userData._wireLine.geometry.dispose();
        obj.userData._wireLine.material.dispose();
        delete obj.userData._wireLine;
      }
      if (obj.userData._origMaterial){ obj.material = obj.userData._origMaterial; delete obj.userData._origMaterial; }
    }
  });
  needsRender = true;
}

$('wireBtn').addEventListener('click', event => {
  if (!current) return;
  wireframeOn = !wireframeOn;
  setWireframeMode(wireframeOn);
  event.currentTarget.classList.toggle('on', wireframeOn);
});

/* ---------- drag & drop ---------- */

const dropOverlay = $('dropOverlay');
let dragDepth = 0;

window.addEventListener('dragenter', event => {
  if (!state.currentUser) return;
  event.preventDefault();
  dragDepth++;
  dropOverlay.classList.add('show');
});
window.addEventListener('dragover', event => { if (state.currentUser) event.preventDefault(); });
window.addEventListener('dragleave', event => {
  event.preventDefault();
  dragDepth--;
  if (dragDepth <= 0){ dragDepth = 0; dropOverlay.classList.remove('show'); }
});
window.addEventListener('drop', event => {
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove('show');
  if (!state.currentUser) return;

  const transfer = event.dataTransfer;
  if (!transfer) return;
  if (!transfer.files || !transfer.files.length){
    if (transfer.items && transfer.items.length) flashError('No files were found in what you dropped.');
    return;
  }

  // Snapshot synchronously: webkitGetAsEntry() and the file list are only
  // valid during the drop event itself.
  const flatFiles = Array.from(transfer.files);
  const entries = collectEntryRoots(transfer);

  // Plain files: upload exactly as before.
  if (!entries.length || !entries.some(entry => entry.isDirectory)){
    addFiles(flatFiles, null);
    return;
  }

  // A folder was dropped: walk it so .gltf companion files keep their real
  // relative paths (textures/albedo.png, barrel.bin, …) in the library.
  setStatus('Reading dropped folder…');
  resolveEntries(entries)
    .then(result => {
      setStatus('');
      if (result && result.files.length) addFiles(result.files, result.paths);
      else addFiles(flatFiles, null);
    })
    .catch(err => {
      console.warn('Folder drop failed, falling back to the flat file list:', err);
      setStatus('');
      addFiles(flatFiles, null);
    });
});

function collectEntryRoots(transfer){
  const roots = [];
  try {
    for (const item of transfer.items){
      if (!item || item.kind !== 'file' || typeof item.webkitGetAsEntry !== 'function') continue;
      const entry = item.webkitGetAsEntry();
      if (entry) roots.push(entry);
    }
  } catch { /* fall back to the plain file list */ }
  return roots;
}

async function resolveEntries(roots){
  const collected = [];
  let failed = 0;

  const walk = (entry, prefix) => new Promise(resolve => {
    if (entry.isFile){
      entry.file(
        file => { collected.push({ file, path: prefix + entry.name }); resolve(); },
        () => { failed++; resolve(); }
      );
      return;
    }
    if (!entry.isDirectory){ resolve(); return; }

    const reader = entry.createReader();
    const readBatch = () => reader.readEntries(async batch => {
      if (!batch.length){ resolve(); return; }
      for (const child of batch) await walk(child, prefix + entry.name + '/');
      readBatch(); // readEntries returns at most ~100 entries per call
    }, () => resolve());
    readBatch();
  });

  for (const root of roots) await walk(root, '');
  if (failed || !collected.length) return null;

  const paths = new Map();
  for (const item of collected) paths.set(item.file, item.path);
  return { files: collected.map(item => item.file), paths };
}

/* ---------- keyboard shortcuts ---------- */

window.addEventListener('keydown', event => {
  const typing = event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT' || event.target.tagName === 'TEXTAREA';
  if (event.key === 'Escape' && state.selectMode && !typing){ exitSelectMode(); return; }
  if (typing || !state.currentUser) return;

  if ((event.key === 'Delete' || event.key === 'Backspace') && state.activeId && !state.selectMode){
    const meta = state.files.find(file => file.id === state.activeId);
    if (meta) deleteFile(meta);
  }
});

/* ============================================================
   BOOT
   ============================================================ */

(async function init(){
  setConn(null, 'Connecting…');

  try {
    const status = await api.authStatus();

    if (!status.hasUsers){
      showAuthOverlay('setupPane');
      return;
    }

    const meResponse = await api.me();
    if (meResponse.status === 200){
      const body = await meResponse.json();
      await startApp(body.user);
    } else {
      showAuthOverlay('loginPane');
    }
  } catch (err){
    console.error(err);
    setOffline(true, "Can't reach the Model Vault server. Retrying…");
    showAuthOverlay('loginPane');

    // Retry the initial handshake a few times in case the server is still
    // starting up (e.g. right after a deploy or restart).
    let attempts = 0;
    const retry = setInterval(async () => {
      attempts++;
      try {
        const status = await api.authStatus();
        clearInterval(retry);
        setOffline(false);
        if (!status.hasUsers) showAuthOverlay('setupPane');
      } catch {
        if (attempts > 20) clearInterval(retry);
      }
    }, 4000);
  }
})();
