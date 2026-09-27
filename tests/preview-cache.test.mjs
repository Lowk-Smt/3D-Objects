import test from "node:test";
import assert from "node:assert/strict";

// The preview download orchestrator is plain logic with no DOM/three.js
// imports, so the exact concurrency rules the viewer depends on can be
// exercised under Node: in-flight de-duplication, reference-counted abort,
// rapid switching, stale-preview protection hooks, cache hits and eviction,
// and the upload -> preview handoff (seed).
import { createPreviewDownloader } from "../public/vault/preview-cache.js";

/** Minimal Blob stand-in with a `size` (Node's global Blob works too). */
function fakeBlob(bytes) {
  return { size: bytes ?? 1, tag: Math.random().toString(36).slice(2) };
}

/**
 * A controllable fetch() for the downloader: each call registers a deferred
 * the test can resolve/reject/inspect. Records every request so tests can
 * assert exactly how many network requests happened.
 */
function trackedFetch() {
  const calls = [];
  const fn = (meta, signal) =>
    new Promise((resolve, reject) => {
      const call = {
        meta,
        signal,
        settled: false,
        aborted: false,
        resolve(blob) {
          if (call.settled) return;
          call.settled = true;
          resolve(blob);
        },
        reject(err) {
          if (call.settled) return;
          call.settled = true;
          reject(err);
        },
      };
      signal.addEventListener("abort", () => {
        call.aborted = true;
        call.reject(new Error("AbortError"));
      });
      calls.push(call);
    });
  fn.calls = calls;
  return fn;
}

const meta = (id) => ({ id, name: `${id}.glb` });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Marks a load promise as "will be rejections expected / ignored" so an
 * intentionally cancelled request never surfaces as an unhandled rejection.
 * (In the app, openModel() always awaits inside try/catch, so this is purely
 * a test-harness concern.)
 */
const swallowed = (promise) => { promise.catch(() => {}); return promise; };

test("CRITICAL: duplicate openModel(A) while the first load is in flight shares ONE network request", async () => {
  const fetch = trackedFetch();
  const dl = createPreviewDownloader({ fetch });

  const p1 = dl.load(meta("A"));
  const p2 = dl.load(meta("A"));

  assert.equal(fetch.calls.length, 1, "second load must join the in-flight request");
  assert.equal(dl.stats().inflight, 1);

  const blob = fakeBlob(10);
  fetch.calls[0].resolve(blob);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, blob);
  assert.equal(r2, blob, "both callers receive the same Blob");
  assert.equal(fetch.calls.length, 1, "still exactly one network request");
});

test("CRITICAL: aborting the first caller must NOT abort the shared request a second caller joined", async () => {
  const fetch = trackedFetch();
  const dl = createPreviewDownloader({ fetch });

  const ctl1 = new AbortController();
  const p1 = dl.load(meta("A"), { signal: ctl1.signal });
  const p2 = dl.load(meta("A")); // second caller, no signal of its own

  // First caller is superseded while the request is in flight.
  ctl1.abort();
  await tick();

  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].aborted, false, "shared request must stay alive for caller 2");

  const blob = fakeBlob(5);
  fetch.calls[0].resolve(blob);
  assert.equal(await p2, blob, "the remaining caller still gets its Blob");
  // Caller 1 also observes the (successful) shared promise; it is its own
  // job to ignore results whose preview token went stale.
  assert.equal(await p1, blob);
  assert.equal(dl.stats().inflight, 0);
  assert.equal(dl.stats().entries, 1, "result is cached for everyone");
});

test("CRITICAL: openModel ordering — join BEFORE releasing the previous caller keeps one request alive across duplicate opens", async () => {
  // Pins the exact sequence app.js must use: the new caller joins the shared
  // download first, then the superseded caller's signal aborts. Releasing
  // first would drop the last reference and kill the very request the
  // duplicate openModel() is about to join (2 requests instead of 1).
  const fetch = trackedFetch();
  const dl = createPreviewDownloader({ fetch });

  const ctl1 = new AbortController();
  const p1 = dl.load(meta("A"), { signal: ctl1.signal });
  await tick();

  const ctl2 = new AbortController();
  const p2 = dl.load(meta("A"), { signal: ctl2.signal }); // join first…
  ctl1.abort(); // …then supersede the first caller
  await tick();

  assert.equal(fetch.calls.length, 1, "one shared network request");
  assert.equal(fetch.calls[0].aborted, false, "request survives the first caller's abort");

  const blob = fakeBlob(11);
  fetch.calls[0].resolve(blob);
  assert.equal(await p2, blob);
  assert.equal(dl.stats().entries, 1);

  // When the last caller leaves, the request is finally cancelled.
  const p3 = dl.load(meta("B"), { signal: new AbortController().signal });
  fetch.calls[1].resolve(fakeBlob(1));
  await p3;
});

test("CRITICAL: A -> B cancels A when nobody else needs it (last reference released)", async () => {
  const fetch = trackedFetch();
  const dl = createPreviewDownloader({ fetch });

  const ctlA = new AbortController();
  swallowed(dl.load(meta("A"), { signal: ctlA.signal }));
  await tick();
  assert.equal(fetch.calls.length, 1);

  ctlA.abort(); // A is no longer needed
  await tick();
  assert.equal(fetch.calls[0].aborted, true, "sole caller aborting cancels the network request");
  assert.equal(dl.stats().inflight, 0, "torn-down entry must leave the in-flight map");

  const pB = dl.load(meta("B"));
  fetch.calls[1].resolve(fakeBlob(3));
  await pB;
  assert.equal(fetch.calls.length, 2, "B starts its own fresh request");
});

test("CRITICAL: rapid A -> B -> A ends with A displayed, B cancelled, no stale state", async () => {
  const fetch = trackedFetch();
  const dl = createPreviewDownloader({ fetch });

  // Mirrors openModel(): each click aborts the previous click's controller.
  // Rejection expectations attach eagerly so cancelled loads are handled
  // from the moment they are created (as openModel's try/catch does).
  const ctlA1 = new AbortController();
  const pA1 = dl.load(meta("A"), { signal: ctlA1.signal });
  const expectA1Abort = assert.rejects(pA1, /AbortError/);

  const ctlB = new AbortController();
  const pB = dl.load(meta("B"), { signal: ctlB.signal });
  const expectBAbort = assert.rejects(pB, /AbortError/);
  ctlA1.abort(); // openModel(B) supersedes A
  await tick();
  assert.equal(fetch.calls[0].aborted, true, "A's request cancelled when superseded");

  const ctlA2 = new AbortController();
  const pA2 = dl.load(meta("A"), { signal: ctlA2.signal });
  ctlB.abort(); // openModel(A) again supersedes B
  await tick();

  assert.equal(fetch.calls.length, 3);
  assert.equal(fetch.calls[0].aborted, true);
  assert.equal(fetch.calls[1].aborted, true, "B's request cancelled");
  assert.equal(fetch.calls[2].aborted, false, "the second A request is the live one");
  assert.equal(fetch.calls[2].meta.id, "A");

  const blobA = fakeBlob(7);
  fetch.calls[2].resolve(blobA);
  assert.equal(await pA2, blobA, "the live caller receives A's bytes");

  // Superseded callers see rejections, never wrong-model successes.
  await expectA1Abort;
  await expectBAbort;
  assert.equal(dl.stats().inflight, 0);
  assert.equal(dl.stats().entries, 1, "only A's (good) bytes are cached");
});

test("a caller arriving while an entry is being torn down starts fresh, never joins a dying request", async () => {
  const fetch = trackedFetch();
  const dl = createPreviewDownloader({ fetch });

  const ctl = new AbortController();
  swallowed(dl.load(meta("A"), { signal: ctl.signal }));
  await tick();

  ctl.abort(); // tears down synchronously (map delete before abort)
  // Same tick: a new caller must not observe the dying entry.
  const p2 = dl.load(meta("A"));
  await tick();
  assert.equal(fetch.calls.length, 2, "fresh request started instead of joining the aborted one");
  assert.equal(fetch.calls[1].aborted, false);

  fetch.calls[1].resolve(fakeBlob(2));
  const blob = await p2;
  assert.equal(fetch.calls[1].aborted, false);
  assert.ok(blob, "the fresh request completes normally");
});

test("release after settlement is a no-op and still caches the good bytes", async () => {
  const fetch = trackedFetch();
  const dl = createPreviewDownloader({ fetch });

  const ctl = new AbortController();
  const p = dl.load(meta("A"), { signal: ctl.signal });
  fetch.calls[0].resolve(fakeBlob(4));
  const blob = await p;

  ctl.abort(); // arrives after success
  await tick();
  assert.equal(dl.stats().entries, 1, "good bytes stay cached");
  assert.equal(await dl.load(meta("A")), blob, "next load is a cache hit");
  assert.equal(fetch.calls.length, 1);
});

test("cache hits: repeat loads after completion never touch the network", async () => {
  const fetch = trackedFetch();
  const dl = createPreviewDownloader({ fetch });

  const first = dl.load(meta("A"));
  fetch.calls[0].resolve(fakeBlob(9));
  const blob = await first;

  assert.equal(await dl.load(meta("A")), blob);
  assert.equal(await dl.load(meta("A")), blob);
  assert.equal(fetch.calls.length, 1, "three loads, one network request");
  assert.equal(dl.stats().bytes, 9);
});

test("failures are not cached — the next load retries", async () => {
  const fetch = trackedFetch();
  const dl = createPreviewDownloader({ fetch });

  const p1 = dl.load(meta("A"));
  fetch.calls[0].reject(new Error("502 bad gateway"));
  await assert.rejects(p1);
  assert.equal(dl.stats().entries, 0, "failed bytes must not be cached");
  assert.equal(dl.stats().inflight, 0);

  const p2 = dl.load(meta("A"));
  assert.equal(fetch.calls.length, 2, "fresh request after failure");
  fetch.calls[1].resolve(fakeBlob(6));
  const blob = await p2;
  assert.ok(blob);
  assert.equal(dl.stats().entries, 1, "successful retry is cached");
});

test("an aborted request is not cached and does not poison later loads", async () => {
  const fetch = trackedFetch();
  const dl = createPreviewDownloader({ fetch });

  const ctl = new AbortController();
  const p = dl.load(meta("A"), { signal: ctl.signal });
  await tick();
  ctl.abort();
  await assert.rejects(p, /AbortError/);
  assert.equal(dl.stats().entries, 0);

  const p2 = dl.load(meta("A"));
  fetch.calls[1].resolve(fakeBlob(8));
  const blob = await p2;
  assert.ok(blob, "later load after an aborted one works");
  assert.equal(dl.stats().entries, 1);
});

test("LRU eviction by entry count", () => {
  const fetch = trackedFetch();
  const dl = createPreviewDownloader({ fetch, maxEntries: 2, maxBytes: 1000 });

  dl.seed("A", fakeBlob(1), 1);
  dl.seed("B", fakeBlob(1), 1);
  dl.seed("C", fakeBlob(1), 1); // evicts A (oldest)
  assert.equal(dl.stats().entries, 2);
  assert.equal(dl.has("A"), false);
  assert.equal(dl.has("B"), true);
  assert.equal(dl.has("C"), true);
});

test("LRU eviction by total bytes, and a touch keeps a hot entry alive", () => {
  const fetch = trackedFetch();
  const dl = createPreviewDownloader({ fetch, maxEntries: 10, maxBytes: 10 });

  dl.seed("A", fakeBlob(5), 5);
  dl.seed("B", fakeBlob(4), 4);
  dl.load(meta("A")); // touch A -> A becomes newest (cache hit; no fetch)
  dl.seed("C", fakeBlob(5), 5); // needs 5 bytes; only 4 free -> evict B (oldest)
  assert.equal(dl.has("B"), false);
  assert.equal(dl.has("A"), true, "recently used entry survives");
  assert.equal(dl.has("C"), true);
  assert.equal(dl.stats().bytes, 10);
});

test("a blob larger than the whole cache budget is never cached (but still loads)", async () => {
  const fetch = trackedFetch();
  const dl = createPreviewDownloader({ fetch, maxEntries: 4, maxBytes: 10 });

  const p = dl.load(meta("A"));
  const giant = fakeBlob(100);
  fetch.calls[0].resolve(giant);
  assert.equal(await p, giant, "load succeeds regardless of caching");
  assert.equal(dl.stats().entries, 0, "oversized blob not cached");

  const p2 = dl.load(meta("A"));
  assert.equal(fetch.calls.length, 2, "next load re-fetches");
  fetch.calls[1].resolve(giant);
  await p2;
});

test("evict(id) removes exactly one entry; clear() empties the cache", () => {
  const dl = createPreviewDownloader({ fetch: trackedFetch() });
  dl.seed("A", fakeBlob(2), 2);
  dl.seed("B", fakeBlob(3), 3);

  assert.equal(dl.evict("A"), true);
  assert.equal(dl.evict("A"), false, "second eviction of the same id is a no-op");
  assert.equal(dl.has("B"), true);
  assert.equal(dl.stats().bytes, 3);

  dl.clear();
  assert.equal(dl.stats().entries, 0);
  assert.equal(dl.stats().bytes, 0);
});

test("seed() performs the upload -> preview handoff with zero network requests", async () => {
  const fetch = trackedFetch();
  const dl = createPreviewDownloader({ fetch });

  const uploaded = fakeBlob(42);
  assert.equal(dl.seed("fresh-id", uploaded, 42), true, "seeding right after upload succeeds");
  assert.equal(await dl.load(meta("fresh-id")), uploaded, "preview load is a cache hit on the uploaded bytes");
  assert.equal(fetch.calls.length, 0, "no re-download after upload");
});

test("seed() is skipped while a request for the same id is in flight", async () => {
  const fetch = trackedFetch();
  const dl = createPreviewDownloader({ fetch });

  const p = dl.load(meta("A"));
  assert.equal(dl.seed("A", fakeBlob(1), 1), false, "in-flight request owns the id");
  fetch.calls[0].resolve(fakeBlob(5));
  const blob = await p;
  assert.equal(await dl.load(meta("A")), blob);
  assert.equal(fetch.calls.length, 1);
});

test("load() without meta.id rejects instead of throwing synchronously", async () => {
  const dl = createPreviewDownloader({ fetch: trackedFetch() });
  await assert.rejects(dl.load(null), TypeError);
  await assert.rejects(dl.load({}), TypeError);
});

test("createPreviewDownloader requires a fetch implementation", () => {
  assert.throws(() => createPreviewDownloader({}), TypeError);
});
