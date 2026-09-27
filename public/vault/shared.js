/* ============================================================
   Model Vault — shared helpers.

   Pure functions with no DOM, network or Node dependencies, used by the
   browser app (public/vault/app.js, imported as ./shared.js) *and* by the
   Node test suite (tests/paths.test.mjs). Keeping one implementation means
   the client and the server can never disagree about extensions, MIME types,
   download names, or how a .gltf's companion files are resolved.

   The server-side mirror of the MIME table lives in src/lib/files.ts.
   ============================================================ */

export const MIME_BY_EXT = {
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'text/plain', mtl: 'text/plain',
  stl: 'model/stl', fbx: 'application/octet-stream', ply: 'application/octet-stream', bin: 'application/octet-stream',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  bmp: 'image/bmp', svg: 'image/svg+xml', json: 'application/json', zip: 'application/zip', txt: 'text/plain',
  ktx2: 'image/ktx2',
};

export function getExt(name){
  const i = String(name == null ? '' : name).lastIndexOf('.');
  return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
}

export function getMimeForName(name){ return MIME_BY_EXT[getExt(name)] || 'application/octet-stream'; }

/* ---------- path helpers (used for glTF companion-file resolution) ---------- */

export function normalizePath(path){
  const parts = String(path || '').replace(/\\/g, '/').split('/');
  const out = [];
  for (const part of parts){
    if (!part || part === '.') continue;
    if (part === '..'){ out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

export function basename(path){
  const p = normalizePath(path);
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

export function dirname(path){
  const p = normalizePath(path);
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function decodeUri(uri){ try { return decodeURIComponent(uri); } catch { return uri; } }

export function isInlineOrRemoteUri(uri){ return /^(?:data:|blob:|https?:|file:|ftp:)/i.test(uri); }

/** Keeps a rename prompt's input in the same shape the server accepts. */
export function sanitizeBaseName(name){
  return String(name == null ? '' : name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
}

/**
 * Resolves an asset referenced by a .gltf file against every file currently in
 * the shared library, using the same strategy as the original single-user app:
 * exact relative path -> exact file name -> unique basename.
 *
 * `files` is the library's metadata array (each entry having `name` and
 * `path`); `modelMeta` is the metadata of the .gltf being loaded.
 *
 * Throws when several library files share the basename, because silently
 * guessing between them would load the wrong texture or mesh data.
 */
export function findReferencedFile(files, modelMeta, uri){
  const decoded = decodeUri(uri);
  const cleaned = normalizePath(decoded);
  const modelPath = normalizePath(modelMeta.path || modelMeta.name);
  const modelDir = dirname(modelPath);
  const relativeCandidate = normalizePath(modelDir ? `${modelDir}/${cleaned}` : cleaned);

  const exact = files.find(f => normalizePath(f.path || f.name) === relativeCandidate);
  if (exact) return exact;

  const exactName = files.find(f => normalizePath(f.name) === cleaned);
  if (exactName) return exactName;

  const base = basename(cleaned);
  const basenameMatches = files.filter(f => basename(f.path || f.name) === base);

  if (basenameMatches.length === 1) return basenameMatches[0];
  if (basenameMatches.length > 1){
    throw new Error(
      `Multiple library files match "${uri}". Keep the model and its assets in the same folder when importing.`
    );
  }
  return null;
}

/**
 * The name a download must use: the stored display name, never a generic
 * "file"/"download"/"unknown" placeholder unless no name exists at all.
 */
export function getDownloadName(meta){
  let name = String((meta && meta.name) || '').trim();
  if (!name) name = meta && meta.id ? `model-${meta.id}` : 'download';
  if (!getExt(name) && meta && meta.ext) name += '.' + String(meta.ext).replace(/^\./, '');
  return name;
}
