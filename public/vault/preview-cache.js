/* ============================================================
   Model Vault — preview download orchestrator.

   Pure logic: no DOM, no three.js, no network calls of its own. Imported by
   public/vault/app.js in the browser and by tests/preview-cache.test.mjs
   under Node (same pattern as shared.js), so the concurrency rules can be
   unit-tested rather than hoped for.

   It owns three cooperating concerns whose interaction is the tricky part:

   1. LRU cache of preview blobs, bounded by entry count AND total bytes.
      Model bytes are immutable once committed (renames only change
      metadata; optimization creates a new file id), so a cached blob stays
      valid until its file is deleted. The app evicts explicitly on delete.

   2. In-flight de-duplication: concurrent loads of the same file id share
      ONE network request. The first caller creates it; later callers join
      the same Promise and get the same Blob.

   3. Reference-counted cancellation: each caller may pass its own
      AbortSignal ("I am no longer interested"). Releasing a caller's
      reference must NEVER abort a request other callers still need — the
      underlying AbortController fires only when the LAST reference goes
      away. Callers that pass no signal never cancel anything.

   Failure semantics:
   - A failed or aborted request is never cached; the next load() starts a
     fresh request.
   - Every caller observes the shared Promise's rejection and decides for
     itself (openModel() treats "superseded token or own signal aborted"
     as a silent no-op).
   - Releasing a caller whose request already settled is a harmless no-op;
     the result is still cached because the bytes themselves are good.
   ============================================================ */

export const DEFAULT_MAX_CACHE_ENTRIES = 8;
export const DEFAULT_MAX_CACHE_BYTES = 256 * 1024 * 1024; // per browser tab

export function createPreviewDownloader({
  fetch,
  maxEntries = DEFAULT_MAX_CACHE_ENTRIES,
  maxBytes = DEFAULT_MAX_CACHE_BYTES,
} = {}) {
  if (typeof fetch !== 'function'){
    throw new TypeError('createPreviewDownloader: a fetch(meta, signal) => Promise<Blob> is required');
  }

  const entryLimit = Math.max(1, maxEntries | 0);
  const byteLimit = Math.max(1, maxBytes | 0);

  /** id -> { blob, bytes }. Map iteration order = oldest to newest use (LRU). */
  const cache = new Map();
  /** id -> { id, controller, signal, refs, promise }. Live requests only. */
  const inflight = new Map();

  let cachedBytes = 0;

  function drop(id){
    const entry = cache.get(id);
    if (!entry) return false;
    cache.delete(id);
    cachedBytes -= entry.bytes;
    return true;
  }

  /** Make room for an insert; keeps at least the newest entry alive. */
  function makeRoom(bytes){
    while (cache.size >= entryLimit || (cachedBytes + bytes > byteLimit && cache.size > 0)){
      const oldest = cache.keys().next();
      if (oldest.done) break;
      drop(oldest.value);
    }
  }

  function blobSize(blob){
    return blob && typeof blob.size === 'number' && isFinite(blob.size) ? blob.size : 0;
  }

  function store(id, blob, bytes){
    if (bytes > byteLimit) return; // one giant blob must not own the cache
    drop(id);
    makeRoom(bytes);
    cache.set(id, { blob, bytes });
    cachedBytes += bytes;
  }

  /**
   * Give back one caller's reference. When the last reference goes, the
   * entry is removed from `inflight` BEFORE the controller aborts, so a
   * caller arriving in the same tick can never join a request that is
   * already being torn down — it starts a fresh one instead.
   */
  function release(entry){
    entry.refs -= 1;
    if (entry.refs <= 0 && inflight.get(entry.id) === entry){
      inflight.delete(entry.id);
      entry.controller.abort();
    }
  }

  /**
   * Resolve a Blob for `meta.id`, collapsing concurrent loads of the same
   * file into one network request and serving repeat loads from cache.
   * `opts.signal` marks the caller's own interest: aborting it releases this
   * caller's reference, and if it was the last one the request is cancelled.
   */
  function load(meta, opts = {}){
    const id = meta && meta.id;
    if (!id) return Promise.reject(new TypeError('preview load: meta.id is required'));

    const hit = cache.get(id);
    if (hit){
      cache.delete(id);
      cache.set(id, hit); // LRU touch
      return Promise.resolve(hit.blob);
    }

    let entry = inflight.get(id);
    if (!entry){
      const controller = new AbortController();
      entry = { id, controller, signal: controller.signal, refs: 0, promise: null };
      entry.promise = (async () => {
        try {
          const blob = await fetch(meta, entry.signal);
          // Publish + deregister inside the async body, before the promise
          // settles, so joiners and fresh callers always see consistent
          // state (no window where the entry is settled but still joinable).
          inflight.delete(id);
          store(id, blob, blobSize(blob));
          return blob;
        } catch (err){
          inflight.delete(id);
          throw err;
        }
      })();
      inflight.set(id, entry);
    }
    entry.refs += 1;

    const signal = opts.signal || null;
    if (signal){
      if (signal.aborted) release(entry);
      else signal.addEventListener('abort', () => release(entry), { once: true });
    }

    return entry.promise;
  }

  /**
   * Insert known-good bytes without a network round trip (used by the
   * upload -> preview handoff: the browser already holds exactly the bytes
   * it PUT to storage, so the immediate preview must not re-download them).
   * Skipped while a request for the same id is in flight — that request
   * will populate the cache itself.
   */
  function seed(id, blob, bytes){
    if (!id || !blob || inflight.has(id)) return false;
    store(id, blob, typeof bytes === 'number' ? bytes : blobSize(blob));
    return true;
  }

  /** Whether good bytes are currently cached for this id (LRU-touched). */
  function has(id){
    const hit = cache.get(id);
    if (!hit) return false;
    cache.delete(id);
    cache.set(id, hit);
    return true;
  }

  /** Explicit eviction — the app calls this when files are deleted. */
  function evict(id){ return drop(id); }

  /** Forget everything (logout, tests). */
  function clear(){
    cache.clear();
    cachedBytes = 0;
  }

  function stats(){
    return { entries: cache.size, bytes: cachedBytes, inflight: inflight.size };
  }

  return { load, seed, has, evict, clear, stats };
}
