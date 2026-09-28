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

/* ---- preview download orchestrator (cache + in-flight dedup + refcounted
        abort), pure logic shared with tests/preview-cache.test.mjs ---- */
import { createPreviewDownloader } from './preview-cache.js';

/* ---- transfer measurement helpers (pure, shared with
        tests/transfer-stats.test.mjs) — make every byte transfer report
        which transport carried it, who served it, and how fast it was ---- */
import {
  describeResourceTiming, findResourceTiming, formatBytes, hostOf,
  pickReadableHeaders, redactUrl, throughputMbps,
  XHR_READABLE_HEADERS,
} from './transfer-stats.js';

/* ---- wireframe edge extraction, shared with the worker and the tests ---- */
import {
  DEFAULT_THRESHOLD_ANGLE, WORKER_FILE_URL, buildWorkerPayload
} from './wireframe.js';

/* ---- browser optimizer upload entry: shares the exact production CDN
       dependency graph with the browser regression test. ---- */
import {
  CANCEL_MESSAGE, optimizeGLBBlob, resolvePreset, shouldUseOptimized,
} from './optimizer-upload.mjs';

/* ============================================================
   Model Vault — shared multi-user library frontend.

   The backend (Next.js API routes + Postgres + R2 object storage) is the
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
   PERFORMANCE INSTRUMENTATION
   ============================================================ */

let perfSeq = 0;
const perf = {
  time(label){
    const seq = ++perfSeq;
    const startMark = `vault:${label}:${seq}:start`;
    const endMark = `vault:${label}:${seq}:end`;
    const measureName = `vault:${label}`;
    const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    try {
      if (typeof performance !== 'undefined' && performance.mark){
        performance.mark(startMark);
      }
    } catch { /* never throw */ }

    let ended = false;
    return {
      end(extra){
        if (ended) return 0;
        ended = true;
        const end = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const duration = Math.round((end - start) * 10) / 10;
        try {
          if (typeof performance !== 'undefined' && performance.mark){
            performance.mark(endMark);
            if (performance.measure){
              performance.measure(measureName, startMark, endMark);
            }
          }
        } catch { /* never throw */ }
        const extraStr = extra ? ` (${extra})` : '';
        console.debug(`[perf] ${label}: ${duration}ms${extraStr}`);
        return duration;
      }
    };
  }
};

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

  const serverTiming = response.headers.get('server-timing');
  if (serverTiming){
    console.debug(`[perf:server] ${method} ${url}: ${serverTiming}`);
  }

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

/* ============================================================
   PREVIEW BYTE LOADER
   ============================================================ */

// One presigned-GET round trip per file, then bytes are cached in-memory.
// The raw endpoint authorizes the session and answers with a 120-second
// presigned GET URL for exactly one private bucket key — the fetch below is
// the only request that ever goes straight to storage (no cookies, no
// credentials; the signature is the authorization and it expires quickly).

function nowMs(){
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

/**
 * Prints one [perf:transfer] line (plus a details object) for a completed
 * byte transfer. This is the production evidence that answers: which
 * transport carried the bytes (direct from the bucket vs proxied through
 * the API), which host served them, the status, size, duration, throughput,
 * whatever response headers the origin exposed cross-origin, and the
 * resource-timing breakdown when the browser allows one. All reads are
 * best-effort — cross-origin responses only expose what the bucket's CORS
 * rules allow, and this must never break the transfer it describes.
 */
function reportTransfer(kind, name, url, getHeader, status, bytes, startedAt, extra, headerNames){
  try {
    const ms = Math.max(1, Math.round(nowMs() - startedAt));
    const mbps = throughputMbps(bytes, ms);
    const details = Object.assign({
      kind,
      name,
      host: hostOf(url) || null,
      // Presigned storage URLs carry their authorization in the query
      // string (X-Amz-Signature, AuthorizationToken, …). Only the redacted
      // URL (scheme + host + path, no query, no fragment) may reach
      // diagnostics; the full url below is used solely to locate the
      // matching PerformanceResourceTiming entry in this same tick.
      url: redactUrl(url || ''),
      status: status === null || status === undefined ? null : status,
      bytes: Number(bytes) || 0,
      ms,
      mbps,
      headers: pickReadableHeaders(getHeader, headerNames),
      resourceTiming: (() => {
        const rt = findResourceTiming(url, typeof performance !== 'undefined' ? performance : null);
        return rt ? describeResourceTiming(rt) : null;
      })(),
    }, extra || {});
    // Defense in depth: `extra` (or a future caller) must never be able to
    // smuggle a signed URL into diagnostics. Re-apply redaction AFTER the
    // merge so details.url is redacted no matter where it came from. The
    // full signed URL was used above ONLY for the findResourceTiming
    // lookup; it never reaches console output.
    details.url = redactUrl(details.url || url || '');
    console.info(
      `[perf:transfer] ${kind} ${name}: ${formatBytes(bytes)} in ${ms}ms`
        + (mbps ? ` (~${mbps} Mbps)` : '')
        + ` host=${details.host || '?'} status=${details.status === null ? '?' : details.status}`,
      details,
    );
  } catch { /* diagnostics must never break the transfer */ }
}

async function fetchDirectBlob(url, name, signal){
  let response;
  const startedAt = nowMs();
  try {
    // Cross-origin request to object storage. No credentials: presigned GET
    // authorization travels in the signed query string, and none of the
    // app's cookies may ever reach the storage origin.
    response = await fetch(url, { signal, credentials: 'omit', redirect: 'error' });
  } catch (err){
    if (signal && signal.aborted) throw err; // caller cancelled — propagate AbortError
    // Network/CORS-level failure of the direct fetch. Handled by the caller
    // with an automatic fallback through the authenticated API route.
    throw new ApiClientError(0, 'Could not reach object storage for this file.');
  }
  if (!response.ok){
    // 403 from storage almost always means the short-lived URL expired
    // (e.g. the tab sat on it for over 120 s) — a retry mints a fresh one.
    const message = response.status === 403
      ? 'The preview link expired. Open the file again to fetch a fresh one.'
      : `Could not download this file from storage (${response.status}).`;
    throw new ApiClientError(response.status, message);
  }
  const blob = await response.blob();
  // response.url is the URL the bytes actually came from (after any
  // redirect); headers beyond the CORS-exposed subset read as null.
  reportTransfer('preview direct', name, response.url || url,
    (h) => response.headers.get(h), response.status, blob.size, startedAt);
  return blob;
}

async function fetchProxiedBlob(meta, signal){
  // Same authorization as every other API call (session cookie); the server
  // streams the bytes with the sandbox/nosniff headers the bucket can't add.
  const startedAt = nowMs();
  const response = await apiFetch(`/api/files/${encodeURIComponent(meta.id)}/raw?proxy=1`, { signal });
  if (response instanceof Response){
    const blob = await response.blob();
    reportTransfer('preview proxied', meta.name, response.url || `/api/files/${meta.id}/raw?proxy=1`,
      (h) => response.headers.get(h), response.status, blob.size, startedAt,
      { note: 'bytes streamed through the API (server-side), NOT direct from storage' });
    return blob;
  }
  throw new ApiClientError(0, 'Unexpected preview response from the server.');
}

async function fetchModelBytes(meta, signal){
  // Leg 1 — envelope: the authenticated /raw call. Session auth, the file
  // lookup and presigning all happen here (the route reports each under
  // Server-Timing, logged by apiFetch). Timed separately so that
  // preview:transfer below measures ONLY the byte leg — previously a single
  // preview:fetch timer lumped this server round trip into the transfer,
  // overstating it by the envelope cost on every load.
  const envelopeTimer = perf.time(`preview:envelope:${meta.name}`);
  const info = await apiFetch(`/api/files/${encodeURIComponent(meta.id)}/raw`, { signal });
  envelopeTimer.end();

  if (info && typeof info.url === 'string'){
    // Leg 2 — bytes. Direct-to-bucket first (one attempt), proxied fallback
    // only on network/CORS-level failure. The transport choice is logged
    // loudly either way: a silent fallback is indistinguishable from a
    // working direct path, and the two have completely different speeds.
    const transferTimer = perf.time(`preview:transfer:${meta.name}`);
    let blob;
    try {
      blob = await fetchDirectBlob(info.url, meta.name, signal);
    } catch (err){
      // Only network-level failures fall back; storage's own answers
      // (403 expired link, 404 missing object, …) must surface as-is so the
      // user sees the real cause instead of a silent second request.
      if ((signal && signal.aborted) || (err instanceof ApiClientError && err.status !== 0)){
        transferTimer.end('failed');
        throw err;
      }
      console.warn('[perf:transfer] preview direct fetch failed ('
        + ((err && err.message) || 'network error')
        + '); retrying via /raw?proxy=1 — bytes will stream through the server, not direct from storage.'
        + ' If this keeps happening, the bucket CORS rules likely do not allow s3_get for this origin.');
      try {
        blob = await fetchProxiedBlob(meta, signal);
      } catch (fallbackErr){
        transferTimer.end('fallback failed');
        throw fallbackErr;
      }
      transferTimer.end('proxied fallback');
      return blob;
    }
    transferTimer.end(`${blob.size}B`);
    return blob;
  }

  // The server streamed the bytes itself (active-content MIME types are
  // never presigned — they need the route's CSP sandbox headers).
  if (info instanceof Response) return info.blob();

  throw new ApiClientError(0, 'Unexpected preview response from the server.');
}

/**
 * Cache + in-flight de-duplication + reference-counted abort for preview
 * downloads (logic in preview-cache.js, rules pinned by
 * tests/preview-cache.test.mjs):
 *   - concurrent/duplicate openModel() calls for one file share a single
 *     network request;
 *   - aborting one caller never aborts a request another caller joined —
 *     the request is cancelled only when the last interested caller leaves;
 *   - loaded blobs are kept in a bounded LRU (model bytes are immutable) and
 *     evicted when files are deleted; uploads seed it directly (handoff).
 */
const previewLoader = createPreviewDownloader({ fetch: fetchModelBytes });

function uploadWithProgress(file, relPath, extra, onProgress){
  // Presigned upload flow (same signature, same progress reporting, same
  // result shape as before — only the transport changed):
  //   1. POST /api/files/presign authorizes the upload and mints a
  //      short-lived PUT URL for one server-generated object key;
  //   2. the bytes go directly to object storage with an XHR PUT so the
  //      progress bar keeps working (the file never passes through the
  //      serverless function body, which is capped at a few MB);
  //   3. POST /api/files/complete verifies the object and commits the row.
  // No storage credentials ever reach the browser: the PUT URL only permits
  // that single key for a few minutes.
  const presignBody = {
    name: file.name,
    path: relPath || file.name,
    size: file.size,
    optimized: !!(extra && extra.optimized),
    preset: (extra && extra.optimizePreset) || null,
  };

  const putToStorage = (uploadUrl, contentType) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    // Cross-origin request to object storage: no cookies needed (the
    // signature is in the URL) and none are sent.
    xhr.withCredentials = false;
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);

    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300){
        // Evidence for the upload leg: this PUT goes straight from the
        // browser to the bucket (no server in the path), so its duration is
        // purely browser<->storage network time. responseURL shows the URL
        // the bytes actually landed on (differs from uploadUrl only if
        // storage redirected).
        reportTransfer('upload PUT', file.name, xhr.responseURL || uploadUrl,
          (h) => { try { return xhr.getResponseHeader(h); } catch { return null; } },
          xhr.status, file.size, putStartedAt, undefined, XHR_READABLE_HEADERS);
        resolve();
      }
      else reject(new ApiClientError(xhr.status, `The direct upload to storage failed (${xhr.status}). Please try again.`));
    };

    xhr.onerror = () => {
      reject(new ApiClientError(0, "Can't reach object storage to upload this file. Check your connection and try again."));
    };

    const putStartedAt = nowMs();
    xhr.send(file);
  });

  return (async () => {
    const totalUploadTimer = perf.time(`upload:${file.name}`);
    try {
      const presignTimer = perf.time('upload:presign');
      let presigned;
      try {
        presigned = await apiFetch('/api/files/presign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(presignBody),
        });
      } finally {
        presignTimer.end();
      }

      const putTimer = perf.time('upload:put');
      try {
        await putToStorage(presigned.uploadUrl, presigned.contentType);
      } finally {
        putTimer.end(`${file.size}B`);
      }

      if (onProgress) onProgress(1);

      const completeTimer = perf.time('upload:complete');
      let completed;
      try {
        completed = await apiFetch('/api/files/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: presigned.id }),
        });
      } finally {
        completeTimer.end();
      }

      // Upload -> preview handoff: the browser is still holding exactly the
      // bytes it PUT to storage, so the automatic preview after the upload
      // is served from the preview cache instead of downloading them again.
      previewLoader.seed(completed.file.id, file, file.size);

      totalUploadTimer.end(`${file.size}B`);
      return completed.file;
    } catch (err){
      totalUploadTimer.end('failed');
      throw err;
    }
  })();
}

/**
 * Opt-in production diagnostic (console only — the app never calls this):
 * `await __vaultTransferProbe(fileIdOrUrl, 3)` re-fetches one resource N
 * times and prints a table with per-attempt status, final URL, host, bytes,
 * duration, throughput and whatever cache headers the origin exposed, so
 * "do repeated requests behave differently?" can be answered in the exact
 * environment that matters. Pass a file id to probe its preview bytes via a
 * freshly minted presigned GET, or an absolute URL to probe it directly.
 */
if (typeof window !== 'undefined'){
  window.__vaultTransferProbe = async function __vaultTransferProbe(target, attempts = 3){
    let url = String(target);
    if (!/^https?:\/\//i.test(url)){
      const info = await apiFetch(`/api/files/${encodeURIComponent(url)}/raw`, {});
      if (!(info && typeof info.url === 'string')){
        console.warn('[perf:transfer] probe: no presigned URL for', redactUrl(target), '— is this a file id?');
        return null;
      }
      url = info.url;
    }
    const rows = [];
    for (let i = 0; i < attempts; i++){
      const startedAt = nowMs();
      let response;
      try {
        response = await fetch(url, { credentials: 'omit', redirect: 'error' });
      } catch (err){
        rows.push({ attempt: i + 1, error: String((err && err.message) || err) });
        continue;
      }
      const blob = await response.blob();
      const ms = Math.max(1, Math.round(nowMs() - startedAt));
      const rt = findResourceTiming(response.url || url, typeof performance !== 'undefined' ? performance : null);
      rows.push({
        attempt: i + 1,
        status: response.status,
        host: hostOf(response.url || url),
        bytes: blob.size,
        ms,
        mbps: throughputMbps(blob.size, ms),
        headers: pickReadableHeaders((h) => response.headers.get(h)),
        resourceTiming: rt ? describeResourceTiming(rt) : null,
      });
    }
    console.table(rows.map((r) => ({
      attempt: r.attempt,
      status: r.status,
      host: r.host,
      bytes: r.bytes,
      ms: r.ms,
      mbps: r.mbps,
      'cache-control': r.headers && r.headers['cache-control'],
      'x-vercel-cache': r.headers && r.headers['x-vercel-cache'],
      via: r.headers && r.headers.via,
      error: r.error,
    })));
    console.info('[perf:transfer] probe details:', rows);
    console.info('[perf:transfer] probe of', hostOf(url) || redactUrl(url),
      '— bytes is the decoded Blob size, NOT cache evidence (it reflects the'
      + ' full object either way). Cache evidence lives in each row\'s'
      + ' resourceTiming.fromCache / transferSize when the browser exposes'
      + ' PerformanceResourceTiming body sizes; cross-origin responses without'
      + ' Timing-Allow-Origin leave cache status unknown (fromCache: null).'
      + ' Wildly different durations across attempts suggest congestion or'
      + ' throttling on the network path, not the application.');
    return rows;
  };
}

/* ============================================================
   OPTIMIZATION PIPELINE (client-side, WASM-based) — thin browser wrapper
   around the shared core in optimizer-core.mjs, which runs the exact same
   code the unit tests and the real-crate benchmark run:

     validate GLB → read → prune → dedup → simplify → textures → dedup
                  → prune → metadata → write

   Stages are adaptive (no meshes → no simplify, no textures → no texture
   pass) and textures take the dual-path treatment: the upload entry supplies
   the browser half (canvas decode, per-texture alpha scan, WebP/JPEG/PNG
   encoder choice — optimizer-browser-textures.mjs); the headless half is
   the dependency-free pure-JS PNG path used by the benchmark.
   ============================================================ */

async function optimizeSelectedUpload(blob, onProgress, presetKey = 'balanced', cancelToken = null){
  const totalTimer = perf.time(`optimize:${resolvePreset(presetKey).key}`);
  try {
    const outBlob = await optimizeGLBBlob(blob, onProgress, presetKey, cancelToken, (label, run) => {
      const stageTimer = perf.time(`optimize:${label}`);
      return run().finally(() => stageTimer.end());
    });
    totalTimer.end(`${fmtSize(blob.size)} → ${fmtSize(outBlob.size)}`);
    return outBlob;
  } catch (err){
    totalTimer.end('cancelled or failed');
    throw err;
  }
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
        const optimizedBlob = await optimizeSelectedUpload(file, (step, pct) => {
          progressText.textContent = step;
          fillEl.style.width = pct + '%';
        }, presetKey, cancelToken);

        // Never make a file bigger by "optimizing" it — the original is the
        // safe fallback, and the user is told why.
        if (!shouldUseOptimized(file.size, optimizedBlob.size)){
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
        if (err && err.message === CANCEL_MESSAGE){ cleanup(); resolve({ file: null, optimized: false, preset: null }); return; }
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
let isFirstRender = false;
let currentModelName = '';
/** 'normal' | 'wireframe' — which overlay the last render reported on. */
let lastRenderMode = null;
/* Declared here (not with the model state below) because animate() runs its
   first frame synchronously during module evaluation and reads it. */
let wireframeOn = false;

controls.addEventListener('change', () => { needsRender = true; });

function animate(){
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  let mixerDuration = 0;
  if (mixer){
    const mixerStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    mixer.update(dt);
    const mixerEnd = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    mixerDuration = Math.round((mixerEnd - mixerStart) * 10) / 10;
    needsRender = true;
  }
  controls.update();
  if (needsRender){
    const renderStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const wasFirst = isFirstRender;
    if (wasFirst){
      try {
        if (typeof performance !== 'undefined' && performance.mark){
          performance.mark('vault:render:first:start');
        }
      } catch { /* never throw */ }
    }

    renderer.render(scene, camera);
    needsRender = false;

    const renderEnd = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const renderDuration = Math.round((renderEnd - renderStart) * 10) / 10;

    // Report the first frame in each mode: [perf] render:normal:... and
    // [perf] render:wireframe:... make the two costs directly comparable
    // around a toggle, which is exactly what the overlay must not regress.
    const renderMode = wireframeOn ? 'wireframe' : 'normal';
    if (renderMode !== lastRenderMode){
      lastRenderMode = renderMode;
      console.debug(`[perf] render:${renderMode}: ${renderDuration}ms${wasFirst ? ' (first frame)' : ''}`);
    }

    if (wasFirst){
      isFirstRender = false;
      try {
        if (typeof performance !== 'undefined' && performance.mark){
          performance.mark('vault:render:first:end');
          if (performance.measure){
            performance.measure('vault:render:first', 'vault:render:first:start', 'vault:render:first:end');
          }
        }
      } catch { /* never throw */ }
      const rnd = renderer.info ? renderer.info.render : null;
      const mem = renderer.info ? renderer.info.memory : null;
      const extra = rnd ? `calls: ${rnd.calls}, triangles: ${rnd.triangles}` : '';
      console.debug(`[perf] render:first${currentModelName ? `:${currentModelName}` : ''}: ${renderDuration}ms${extra ? ` (${extra})` : ''}`);
      if (mixer && mixerDuration > 0){
        console.debug(`[perf] mixer:first: ${mixerDuration}ms`);
      }
      if (renderer.info){
        console.debug(`[perf] renderer.info: render={calls: ${rnd?.calls ?? 0}, triangles: ${rnd?.triangles ?? 0}, points: ${rnd?.points ?? 0}, lines: ${rnd?.lines ?? 0}}, memory={geometries: ${mem?.geometries ?? 0}, textures: ${mem?.textures ?? 0}}`);
      }
    } else if (renderDuration >= 50 || mixerDuration >= 50){
      const rnd = renderer.info ? renderer.info.render : null;
      const mem = renderer.info ? renderer.info.memory : null;
      const extra = rnd ? `calls: ${rnd.calls}, triangles: ${rnd.triangles}` : '';
      console.debug(`[perf] render:slow-frame: ${renderDuration}ms${mixerDuration > 0 ? ` (mixer: ${mixerDuration}ms)` : ''}${extra ? ` (${extra})` : ''}`);
      if (renderer.info){
        console.debug(`[perf] renderer.info: render={calls: ${rnd?.calls ?? 0}, triangles: ${rnd?.triangles ?? 0}}, memory={geometries: ${mem?.geometries ?? 0}, textures: ${mem?.textures ?? 0}}`);
      }
    }
  }
}
animate();

let current = null;
let previewToken = 0;
/** { id, controller } of the preview load in flight, if any. */
let previewAbortCtl = null;

/**
 * Invalidate + cancel the in-flight preview load — but only when the file it
 * is loading is among `ids` (a delete of some unrelated file must never
 * disturb a preview the user is waiting for). Bumping the token makes every
 * in-flight openModel() checkpoint bail; aborting the controller releases
 * the loader reference so unneeded bytes stop flowing.
 */
function cancelPreviewLoad(ids){
  if (!previewAbortCtl) return;
  if (ids && !ids.includes(previewAbortCtl.id)) return;
  previewToken++;
  previewAbortCtl.controller.abort();
  previewAbortCtl = null;
}

/* ============================================================
   WIREFRAME MATERIALS (module-level, shared, never disposed)

   Both materials are created once and reused by every mesh of every model.
   They are intentionally excluded from disposeTree() so a model teardown
   can never dispose a material the next model still needs.
   ============================================================ */

const wireframeInvisibleMaterial = new THREE.MeshBasicMaterial({ colorWrite: false });
const wireframeLineMaterial = new THREE.LineBasicMaterial({ color: 0x8fb4ff });
const WIREFRAME_SHARED_MATERIALS = new Set([wireframeInvisibleMaterial, wireframeLineMaterial]);

function inspectModel(root){
  try {
    let objectCount = 0;
    let meshCount = 0;
    let skinnedMeshCount = 0;
    const uniqueMaterials = new Set();
    const uniqueTextures = new Set();

    root.traverse(obj => {
      objectCount++;
      if (obj.isSkinnedMesh){
        skinnedMeshCount++;
      }
      if (obj.isMesh){
        meshCount++;
      }
      if (obj.material){
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of materials){
          if (!mat) continue;
          uniqueMaterials.add(mat);
          for (const key in mat){
            try {
              const val = mat[key];
              if (val && val.isTexture){
                uniqueTextures.add(val);
              }
            } catch { /* getters may throw */ }
          }
          if (mat.uniforms){
            try {
              for (const uKey in mat.uniforms){
                const uVal = mat.uniforms[uKey]?.value;
                if (uVal && uVal.isTexture){
                  uniqueTextures.add(uVal);
                }
              }
            } catch { /* ignore */ }
          }
        }
      }
    });

    let maxTextureW = 0;
    let maxTextureH = 0;
    let maxTextureDim = 0;
    let approxTextureBytes = 0;

    for (const tex of uniqueTextures){
      let w = 0;
      let h = 0;
      let bytes = 0;

      if (tex.image){
        w = tex.image.width || tex.image.naturalWidth || (tex.image.videoWidth || 0);
        h = tex.image.height || tex.image.naturalHeight || (tex.image.videoHeight || 0);
        if (tex.image.data && tex.image.data.byteLength){
          bytes = tex.image.data.byteLength;
        }
      } else if (tex.mipmaps && tex.mipmaps.length > 0 && tex.mipmaps[0]){
        w = tex.mipmaps[0].width || 0;
        h = tex.mipmaps[0].height || 0;
        for (const mip of tex.mipmaps){
          if (mip && mip.data && mip.data.byteLength){
            bytes += mip.data.byteLength;
          }
        }
      }

      const dim = Math.max(w, h);
      if (dim > maxTextureDim){
        maxTextureDim = dim;
        maxTextureW = w;
        maxTextureH = h;
      }

      if (bytes === 0 && w > 0 && h > 0){
        const mipmapFactor = tex.generateMipmaps !== false ? 1.333 : 1;
        bytes = Math.round(w * h * 4 * mipmapFactor);
      }
      approxTextureBytes += bytes;
    }

    const maxTextureSize = maxTextureDim > 0 ? `${maxTextureW}x${maxTextureH}` : 'none';

    return {
      objects: objectCount,
      meshes: meshCount,
      skinnedMeshes: skinnedMeshCount,
      materials: uniqueMaterials.size,
      textures: uniqueTextures.size,
      maxTextureSize,
      approxTextureMemory: fmtSize(approxTextureBytes),
      approxTextureBytes
    };
  } catch (err){
    console.warn('Model inspection skipped:', err);
    return {
      objects: 0,
      meshes: 0,
      skinnedMeshes: 0,
      materials: 0,
      textures: 0,
      maxTextureSize: 'none',
      approxTextureMemory: '0 B',
      approxTextureBytes: 0
    };
  }
}

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
        // Module-level shared materials (see WIREFRAME MATERIALS above) must
        // survive model teardown — the wireframe overlay swaps meshes onto
        // wireframeInvisibleMaterial, and disposing it here would break every
        // model opened afterwards.
        if (material.isMaterial && !WIREFRAME_SHARED_MATERIALS.has(material)) material.dispose();
      }
    }
  });
}

function clearModel(){
  // In-flight wireframe preparation belongs to the outgoing model. Kill the
  // worker, drop pending tasks, and ignore any results already sitting in the
  // message queue so a stale callback can never modify the next model.
  terminateWireframeWorker();
  if (current){
    if (wireframeOn) setWireframeMode(false);
    disposeWireframeCache(current);
    scene.remove(current);
    disposeTree(current);
    current = null;
  }
  mixer = null;
  wireframeOn = false;
  isFirstRender = false;
  currentModelName = '';
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
  const renderTimer = perf.time('thumbnail:render');
  renderer.render(scene, camera);
  renderTimer.end();

  const readbackTimer = perf.time('thumbnail:readback');
  const pixels = new Uint8Array(size * size * 4);
  renderer.readRenderTargetPixels(renderTarget, 0, 0, size, size, pixels);
  readbackTimer.end();

  renderer.setRenderTarget(oldTarget);
  grid.visible = oldGrid;
  camera.aspect = oldAspect; camera.fov = oldFov;
  camera.updateProjectionMatrix();
  renderTarget.dispose();

  const encodeTimer = perf.time('thumbnail:encode');
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

  const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
  encodeTimer.end();

  return dataUrl;
}

async function createDependencyUrl(modelMeta, uri, cache, createdUrls){
  if (isInlineOrRemoteUri(uri)) return uri;
  const key = decodeUri(uri);
  if (cache.has(key)) return cache.get(key);

  const dependencyMeta = findReferencedFile(state.files, modelMeta, key);
  if (!dependencyMeta){
    throw new Error(`Missing companion file "${key}". Add that file to the library along with "${modelMeta.name}".`);
  }

  // Companion bytes go through the same preview loader as models: duplicate
  // fetches (a texture referenced by several buffers) collapse into one
  // request, and the blob is cached for the next .gltf open.
  const blob = retypeBlob(await previewLoader.load(dependencyMeta), dependencyMeta.name);
  const objectUrl = URL.createObjectURL(blob);
  createdUrls.push(objectUrl);
  cache.set(key, objectUrl);
  return objectUrl;
}

async function parseGLTF(rawBlob, name, meta){
  const gltfTimer = perf.time(`parse:gltf:${name}`);
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

    const result = await loader.parseAsync(JSON.stringify(json), '');
    gltfTimer.end('ok');
    return result;
  } catch (err){
    gltfTimer.end('failed');
    throw err;
  } finally {
    for (const objectUrl of createdUrls) URL.revokeObjectURL(objectUrl);
  }
}

async function parseModel(rawBlob, name, meta){
  const parseTimer = perf.time(`parse:${getExt(name) || 'unknown'}`);
  const blob = retypeBlob(rawBlob, name);
  const ext = getExt(name);

  try {
    switch (ext){
      case 'glb': {
        const abTimer = perf.time('parse:glb:arrayBuffer');
        let buffer;
        try {
          buffer = await blob.arrayBuffer();
        } finally {
          abTimer.end(`${buffer ? buffer.byteLength : 0}B`);
        }
        const loader = new GLTFLoader();
        loader.setDRACOLoader(dracoLoader);
        loader.setKTX2Loader(ktx2Loader);
        loader.setMeshoptDecoder(MeshoptDecoder);
        const glbLoadTimer = perf.time('parse:glb:loader');
        let result;
        try {
          result = await loader.parseAsync(buffer, '');
        } finally {
          glbLoadTimer.end();
        }
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
  } finally {
    parseTimer.end(ext);
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

  // ORDER MATTERS: the new caller joins the shared download FIRST, and only
  // then is the previous caller's controller aborted. Releasing before
  // joining would drop the last reference and cancel a duplicate
  // openModel()'s in-flight request instead of sharing it. With this order,
  // preview-cache.js refcounting guarantees:
  //   - duplicate openModel() calls for one file share ONE network request;
  //   - aborting a superseded caller never aborts a request another caller
  //     joined — the request dies only when the last interested caller leaves.
  const loadCtl = new AbortController();
  const loadPromise = previewLoader.load(meta, { signal: loadCtl.signal });
  if (previewAbortCtl) previewAbortCtl.controller.abort();
  previewAbortCtl = { id: meta.id, controller: loadCtl };

  emptyCard.classList.add('hidden');
  fbCard.classList.add('hidden');
  setStatus('Loading ' + meta.name + '…');

  const openTimer = perf.time(`preview:open:${meta.name}`);
  let blob;
  const fetchTimer = perf.time(`preview:fetch:${meta.name}`);
  try {
    blob = await loadPromise;
  } catch (error){
    fetchTimer.end('failed');
    openTimer.end('fetch failed');
    // Superseded (a newer openModel won) or deliberately cancelled (the file
    // was deleted mid-load): the newer UI state owns the screen — stay silent.
    if (token !== previewToken || loadCtl.signal.aborted) return;
    showFallback(meta, error.message || 'Could not download this file from the server.');
    setStatus('');
    return;
  }
  fetchTimer.end(`${blob.size}B`);

  if (token !== previewToken){
    openTimer.end('superseded');
    return;
  }

  let result = null; let error = null;
  const parseTimer = perf.time(`preview:parse:${meta.name}`);
  try {
    result = await parseModel(blob, meta.name, meta);
  } catch (err){
    error = err;
    console.error('Preview failed:', meta.name, err);
  } finally {
    parseTimer.end(error ? 'failed' : 'ok');
  }

  if (token !== previewToken){
    openTimer.end('superseded');
    return;
  }

  if (error || !result){
    clearModel();
    state.activeId = meta.id;
    renderList();
    showFallback(meta, error ? error.message : `.${getExt(meta.name)} files can't be previewed here, but they're stored safely and can be downloaded.`);
    setStatus('');
    openTimer.end('unsupported or error');
    return;
  }

  clearModel();
  const object = result.object;

  const normTimer = perf.time('preview:normalize');
  try {
    normalize(object);
  } finally {
    normTimer.end();
  }

  scene.add(object);
  current = object;
  isFirstRender = true;
  currentModelName = meta.name;

  // Kick off wireframe preparation immediately — off the main thread when a
  // worker is available. The shaded model renders and stays interactive while
  // the edges are produced. Failure here must never break the preview.
  prepareWireframe(object).catch(err => {
    console.warn('Wireframe preparation failed:', err);
  });

  const stats = inspectModel(object);
  console.debug(`[perf] model:stats:${meta.name}: ${stats.objects} objects, ${stats.meshes} meshes (${stats.skinnedMeshes} skinned), ${stats.materials} materials, ${stats.textures} textures (max: ${stats.maxTextureSize}, ~${stats.approxTextureMemory} texture memory)`);
  if (renderer.info){
    const mem = renderer.info.memory;
    console.debug(`[perf] renderer.info: memory={geometries: ${mem?.geometries ?? 0}, textures: ${mem?.textures ?? 0}}`);
  }

  if (result.animations && result.animations.length){
    mixer = new THREE.AnimationMixer(object);
    for (const clip of result.animations) mixer.clipAction(clip).play();
  }

  const frameTimer = perf.time('preview:frameCamera');
  try {
    frameCamera(object);
  } finally {
    frameTimer.end();
  }

  state.activeId = meta.id;
  renderList();
  setStatus('');
  needsRender = true;
  openTimer.end('ready');

  // Thumbnails are shared with the whole workspace, so only the uploader (or
  // the owner) may create/replace one — the API enforces the same rule.
  if (!meta.thumb && canManageThumbnail(meta)){
    requestAnimationFrame(async () => {
      if (token !== previewToken) return;
      const thumbTotalTimer = perf.time(`thumbnail:generateAndSave:${meta.name}`);
      try {
        const captureTimer = perf.time('thumbnail:capture');
        let thumb;
        try {
          thumb = captureThumb(200);
        } finally {
          captureTimer.end();
        }

        const saveTimer = perf.time('thumbnail:save');
        try {
          await api.saveThumbnail(meta.id, thumb);
        } finally {
          saveTimer.end();
        }

        meta.thumb = thumb;
        meta.updatedAt = Date.now();
        renderThumbBadge(meta.id, thumb);
        thumbTotalTimer.end('saved');
      } catch (error){
        thumbTotalTimer.end('failed');
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

  // The bytes are gone from the library: drop any cached preview blob, and
  // cancel an in-flight load of a deleted file (never of an unrelated one).
  for (const id of ids) previewLoader.evict(id);
  cancelPreviewLoad(ids);

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
    const knownIds = new Set(state.files.map(f => f.id));
    state.files = files.map(mapServerFile);

    // Reconcile the preview cache with the server's truth: blobs for files
    // that disappeared while the stream was down must not linger.
    let removed = false;
    for (const id of knownIds){
      if (!state.files.some(f => f.id === id)){ previewLoader.evict(id); removed = true; }
    }

    if (state.activeId && !state.files.some(f => f.id === state.activeId)){
      const removedActiveId = state.activeId;
      state.activeId = null;
      if (removed) cancelPreviewLoad([removedActiveId]);
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
  startFallbackPoll();

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

// Fallback poll for deployments where a serverless platform ends idle SSE
// streams (or cross-instance fan-out is unavailable): while the stream is
// not connected, the library is re-read every 30s so no change goes
// unnoticed for long. Invisible — no UI change — and a no-op whenever the
// live stream is healthy or the user is logged out.
let fallbackPoll = null;

function startFallbackPoll(){
  if (fallbackPoll) return;
  fallbackPoll = setInterval(() => {
    if (!state.currentUser) return;
    if (!eventSource || eventSource.readyState !== EventSource.OPEN){
      syncFileList();
    }
  }, 30000);
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

/* ============================================================
   WIREFRAME PREPARATION (Web Worker, with a synchronous fallback)

   THREE.EdgesGeometry on a large model is CPU-bound and blocks the main
   thread for seconds. Instead the edge segments are prepared up front — as
   soon as a model loads — inside a Web Worker, and the resulting
   THREE.LineSegments is cached on each mesh. Toggling wireframe then just
   attaches/detaches the cached line, so ON -> OFF -> ON never recomputes
   anything on the main thread.

   The worker runs the same shared algorithm as the synchronous fallback
   (both call extractWireframeEdges in ./wireframe.js). Its output matches
   THREE.EdgesGeometry@0.169.0 at the 25 degree threshold, validated by direct
   output-equivalence tests in tests/wireframe-edges.test.mjs, so the CAD-like
   appearance is preserved.

   Worker failures are always recoverable: any error drops every pending
   task, and a later preparation builds a fresh worker.
   ============================================================ */

const WIREFRAME_MODULE_URL = new URL('./wireframe.js', import.meta.url).href;

/**
 * The Blob URL the worker is constructed from.
 *
 * LIFETIME (by design, kept deliberately simple): exactly one blob URL is
 * created per page — lazily, the first time a model is prepared — and it is
 * reused for EVERY worker this page constructs, including a replacement worker
 * built after a failure. It is revoked on `pagehide`, and immediately before a
 * replacement URL is created (which currently only happens if this code runs
 * again after a revoke). So it is not one URL per worker.
 */
let wireframeWorkerBlobUrl = null;

/** The live worker, or null when none is running (created lazily). */
let wireframeWorker = null;
/** Monotonic id assigned to each preparation task. */
let wireframeTaskSeq = 0;
/** taskId -> { mesh, token } awaiting a worker result. */
const wireframePending = new Map();

/**
 * Resolves to the worker URL, or null when this browser cannot run a worker at
 * all (the emergency synchronous fallback then owns the feature).
 *
 * The worker is shipped as a Blob URL so the app stays a plain static module
 * with no bundler step. A module worker built from `blob:` has no meaningful
 * base URL, so its static import of ./wireframe.js is rewritten to the
 * absolute URL the module is actually served from.
 *
 * The URL outlives any single worker: see the lifetime note on
 * `wireframeWorkerBlobUrl`. It is created once per page here and released by
 * revokeWireframeWorkerBlobUrl() on `pagehide` (or before being replaced).
 */
const wireframeWorkerUrlPromise = (async () => {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined'
      || typeof URL === 'undefined' || !URL.createObjectURL) {
    return null;
  }
  try {
    const response = await fetch(WORKER_FILE_URL);
    if (!response.ok) throw new Error(`worker source fetch failed: HTTP ${response.status}`);
    const source = await response.text();
    const rewritten = source.replace(
      /(from\s*['"])\.\/wireframe\.js(['"])/g,
      (_match, before, after) => `${before}${WIREFRAME_MODULE_URL}${after}`
    );
    revokeWireframeWorkerBlobUrl();
    wireframeWorkerBlobUrl = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }));
    return wireframeWorkerBlobUrl;
  } catch (err) {
    console.warn('Wireframe worker unavailable — edges will be built synchronously', err);
    return null;
  }
})();

function revokeWireframeWorkerBlobUrl(){
  if (!wireframeWorkerBlobUrl) return;
  try { URL.revokeObjectURL(wireframeWorkerBlobUrl); } catch { /* already revoked */ }
  wireframeWorkerBlobUrl = null;
}

function createWireframeWorker(url){
  const worker = new Worker(url, { type: 'module' });
  worker.onmessage = onWireframeWorkerMessage;
  worker.onerror = onWireframeWorkerError;
  return worker;
}

/** Set when `new Worker(...)` itself is not usable, regardless of feature
    detection — after that every preparation uses the synchronous fallback. */
let wireframeWorkerUnavailable = false;

function getWireframeWorker(url){
  if (wireframeWorkerUnavailable) return null;
  if (!wireframeWorker){
    try {
      wireframeWorker = createWireframeWorker(url);
    } catch (err){
      wireframeWorkerUnavailable = true;
      console.warn('Wireframe worker could not be constructed; using synchronous edges', err);
      return null;
    }
  }
  return wireframeWorker;
}

/**
 * Idempotent one-shot completion signal for a queued wireframe task.
 *
 * Resolved when the task reaches a terminal state — worker result, worker
 * failure, cancellation/teardown, or emergency synchronous fallback. This is
 * what lets the preparation timer measure real elapsed preparation time
 * instead of queue time.
 */
function wireframeCompletion(){
  let done = false;
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {
    promise,
    settle(){
      if (done) return;
      done = true;
      resolve();
    }
  };
}

function settleWireframeTask(task){
  if (task && task.completion) task.completion.settle();
}

/**
 * Drop the worker and every in-flight task.
 *
 * Clearing `wireframePending` is what invalidates stale results: a result that
 * arrives afterwards finds no task and is ignored, so it can never touch the
 * model that replaced the one it was computed for. Pending tasks are settled
 * first so a preparation awaiting them can never hang.
 */
function terminateWireframeWorker(){
  if (wireframeWorker){
    try { wireframeWorker.terminate(); } catch { /* already gone */ }
    wireframeWorker = null;
  }
  for (const task of wireframePending.values()) settleWireframeTask(task);
  wireframePending.clear();
}

function onWireframeWorkerMessage(event){
  const message = event.data;
  if (!message) return;

  const task = wireframePending.get(message.id);
  if (!task) return; // cancelled or superseded — drop the stale result
  wireframePending.delete(message.id);
  if (task.token !== previewToken){
    settleWireframeTask(task); // the model switched while in flight
    return;
  }

  if (message.type !== 'result' || !message.positions){
    console.warn('Wireframe worker failed for one mesh; building its edges synchronously:', message.message);
    prepareWireframeEdgesSync(task.mesh);
    settleWireframeTask(task);
    return;
  }

  setWireframeLine(task.mesh, edgeGeometryFromPositions(message.positions));
  if (wireframeOn) applyWireframe(task.mesh);
  needsRender = true;
  settleWireframeTask(task);
}

/** LineSegments geometry from a flat XYZ buffer produced by the worker. */
function edgeGeometryFromPositions(positions){
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Worker-level error: no task can be trusted afterwards. Drop them all, kill
 * the worker (so a fresh one is created on the next preparation) and finish
 * the orphaned meshes on the main thread.
 */
function onWireframeWorkerError(event){
  console.warn('Wireframe worker failed; falling back to synchronous edges', event && event.message);
  const orphaned = Array.from(wireframePending.values());
  // terminate() settles these tasks; the fallback below still runs before the
  // awaiting preparation continues, so the reported preparation duration
  // includes the emergency synchronous work.
  terminateWireframeWorker();
  for (const task of orphaned){
    if (task.token === previewToken && task.mesh) prepareWireframeEdgesSync(task.mesh);
  }
  needsRender = true;
}

window.addEventListener('pagehide', () => {
  terminateWireframeWorker();
  revokeWireframeWorkerBlobUrl();
});

/** Cache a prepared edge geometry as this mesh's LineSegments. */
function setWireframeLine(mesh, geometry){
  if (!mesh) return;
  if (mesh.userData._wireLine){
    // Replacing an existing cache: the old geometry is genuinely dead now.
    if (mesh.userData._wireLine.parent) mesh.userData._wireLine.parent.remove(mesh.userData._wireLine);
    mesh.userData._wireLine.geometry.dispose();
    delete mesh.userData._wireLine;
  }
  if (typeof geometry.computeBoundingSphere === 'function') geometry.computeBoundingSphere();
  const line = new THREE.LineSegments(geometry, wireframeLineMaterial);
  line.renderOrder = 1;
  mesh.userData._wireLine = line;
  mesh.userData._wireframeReady = true;
}

/**
 * Release every cached edge geometry for a model being torn down.
 *
 * Toggling wireframe OFF deliberately keeps these cached (ON/OFF/ON must not
 * recompute), so a detached cache would otherwise leak when the model is
 * discarded. Only the geometry is disposed — the materials are shared
 * module-level singletons.
 */
function disposeWireframeCache(root){
  root.traverse(obj => {
    if (!obj.userData) return;
    if (obj.userData._wireLine){
      if (obj.userData._wireLine.parent) obj.userData._wireLine.parent.remove(obj.userData._wireLine);
      obj.userData._wireLine.geometry.dispose();
      delete obj.userData._wireLine;
    }
    delete obj.userData._wireframeReady;
  });
}

/**
 * EMERGENCY synchronous fallback — reached only when Workers are unavailable or
 * worker messaging genuinely failed.
 *
 * This is the only place EdgesGeometry is still constructed. It runs on the
 * main thread and therefore DOES block rendering for as long as the extraction
 * takes — the very freeze this feature removes. It exists so the overlay still
 * works without a worker, and its output matches THREE.EdgesGeometry@0.169.0 at
 * the 25 degree threshold (validated by tests/wireframe-edges.test.mjs).
 */
function prepareWireframeEdgesSync(mesh){
  if (!mesh || !mesh.geometry || mesh.userData._wireframeReady) return;
  // Nothing sensible to crease-detect without a position attribute; three.js
  // would throw. Models without one keep the shaded look only.
  if (!mesh.geometry.getAttribute || !mesh.geometry.getAttribute('position')) return;
  const timer = perf.time(`wireframe:prepare-sync:${currentModelName || 'model'}`);
  try {
    // The EdgesGeometry is only a source of positions here; the cached
    // LineSegments gets its own geometry so both paths have identical ownership.
    const edges = new THREE.EdgesGeometry(mesh.geometry, DEFAULT_THRESHOLD_ANGLE);
    const positions = edges.getAttribute('position');
    try {
      setWireframeLine(mesh, edgeGeometryFromPositions(positions ? positions.array : new Float32Array(0)));
    } finally {
      edges.dispose();
    }
    if (wireframeOn) applyWireframe(mesh);
    needsRender = true;
  } finally {
    timer.end();
  }
}

/**
 * Prepare the wireframe for a freshly loaded model. Nothing is shown yet: the
 * normal shaded model renders and stays interactive while the edges are built.
 */
async function prepareWireframe(root){
  if (!root) return;
  const token = previewToken;

  // "Preparation duration" is measured from here until EVERY mesh wireframe for
  // this model has been resolved — worker result, worker failure, or emergency
  // synchronous fallback. It is deliberately NOT the time spent queueing jobs.
  const totalTimer = perf.time(`wireframe:prepare:${currentModelName || 'model'}`);

  const url = await wireframeWorkerUrlPromise;
  if (token !== previewToken || current !== root){
    totalTimer.end('superseded');
    return;
  }

  if (!url){
    // No Worker support at all: the emergency synchronous path runs here and
    // DOES block the main thread for as long as it takes — which is exactly why
    // it is only reached when a worker is genuinely unavailable.
    root.traverse(obj => { if (obj.isMesh && obj.geometry) prepareWireframeEdgesSync(obj); });
    totalTimer.end('synchronous fallback');
    return;
  }

  const completions = [];
  const queueTimer = perf.time(`wireframe:queue:${currentModelName || 'model'}`);
  root.traverse(obj => {
    if (!obj.isMesh || !obj.geometry || obj.userData._wireframeReady) return;
    const id = ++wireframeTaskSeq;
    const { message, transfer } = buildWorkerPayload(obj.geometry, id);
    const completion = wireframeCompletion();
    completions.push(completion.promise);
    wireframePending.set(id, { mesh: obj, token, completion });
    try {
      const worker = getWireframeWorker(url);
      if (!worker){
        wireframePending.delete(id);
        prepareWireframeEdgesSync(obj);
        completion.settle();
        return;
      }
      worker.postMessage(message, transfer);
    } catch (err){
      wireframePending.delete(id);
      console.warn('Wireframe worker postMessage failed; using synchronous edges', err);
      prepareWireframeEdgesSync(obj);
      completion.settle();
    }
  });
  queueTimer.end(`${completions.length} mesh${completions.length === 1 ? '' : 'es'} queued`);

  if (!completions.length){
    totalTimer.end('nothing to prepare');
    return;
  }

  await Promise.all(completions);
  totalTimer.end(`${completions.length} resolved`);
}


/** Attach the cached wireframe line + hide the shaded material for one mesh. */
function applyWireframe(obj){
  if (!obj.userData._wireLine) return;
  if (obj.userData._wireLine.parent !== obj) obj.add(obj.userData._wireLine);
  if (!obj.userData._origMaterial) obj.userData._origMaterial = obj.material;
  obj.material = wireframeInvisibleMaterial;
}

/** Detach the cached wireframe line and restore the shaded material.

    The cached edge geometry is deliberately NOT disposed here: an
    ON -> OFF -> ON sequence reuses it instead of recomputing. It is only
    released by setWireframeLine (replacement) or disposeTree (teardown). */
function detachWireframe(obj){
  if (obj.userData._wireLine && obj.userData._wireLine.parent) obj.remove(obj.userData._wireLine);
  if (obj.userData._origMaterial){ obj.material = obj.userData._origMaterial; delete obj.userData._origMaterial; }
}

/**
 * Toggle the wireframe overlay.
 *
 * This function never builds edge geometry. All edge work already happened when
 * the model loaded (prepareWireframe): either off the main thread in the
 * worker, or — only when a worker was genuinely unavailable or failed — in the
 * emergency synchronous fallback, which does block the main thread for as long
 * as it takes (that work is triggered from the load path, never from here).
 *
 * A mesh with no cached line yet is simply still being prepared: the shaded
 * model keeps rendering and the line attaches itself when the result arrives.
 */
function setWireframeMode(enabled){
  if (!current) return;
  current.traverse(obj => {
    if (!obj.isMesh) return;
    if (enabled){
      if (obj.userData._wireLine) applyWireframe(obj);
    } else {
      detachWireframe(obj);
    }
  });
  needsRender = true;
}

$('wireBtn').addEventListener('click', event => {
  if (!current) return;
  wireframeOn = !wireframeOn;
  const timer = perf.time(wireframeOn ? 'wireframe:click-on' : 'wireframe:click-off');
  try {
    setWireframeMode(wireframeOn);
  } finally {
    timer.end();
  }
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
