import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression guards for the transfer diagnostics added while investigating
// slow production uploads/downloads. The app must never change transports or
// caching behavior silently — every byte transfer has to announce which path
// it took, who served it, and how fast it was, because the direct-to-bucket
// path and the proxied-through-API fallback perform completely differently.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appJsPath = path.join(__dirname, "..", "public", "vault", "app.js");
const source = readFileSync(appJsPath, "utf8");
const statsJsPath = path.join(__dirname, "..", "public", "vault", "transfer-stats.js");
const statsSource = readFileSync(statsJsPath, "utf8");

test("preview download is split into envelope vs transfer timers", () => {
  // preview:fetch (outer, unchanged) previously included the authenticated
  // /raw round trip (auth + db + presign ≈ seconds) in the "fetch" number;
  // the envelope and byte legs must be timed separately so the reported
  // transfer time is really transfer time.
  assert.match(source, /perf\.time\(`preview:envelope:\$\{meta\.name\}`\)/);
  assert.match(source, /perf\.time\(`preview:transfer:\$\{meta\.name\}`\)/);
  assert.match(source, /perf\.time\(`preview:fetch:\$\{meta\.name\}`\)/, "outer preview:fetch timer must stay for continuity");
});

test("every completed transfer prints one [perf:transfer] line via reportTransfer", () => {
  assert.match(source, /function reportTransfer\(/);
  assert.match(source, /reportTransfer\('preview direct'/);
  assert.match(source, /reportTransfer\('preview proxied'/);
  assert.match(source, /reportTransfer\('upload PUT'/);
  assert.match(source, /\[perf:transfer\]/);
  assert.match(source, /throughputMbps\(/, "throughput must be part of the report");
});

test("proxied fallback is loud, not silent", () => {
  // The fallback streams the same bytes through the API route instead of
  // direct from the bucket. If that ever happens in production it MUST be
  // visible in the console, otherwise a misconfigured bucket CORS rule
  // looks exactly like a working direct path.
  assert.match(source, /console\.warn\('\[perf:transfer\] preview direct fetch failed/);
  assert.match(source, /raw\?proxy=1 — bytes will stream through the server, not direct from storage/);
  assert.match(source, /s3_get/);
  assert.match(source, /transferTimer\.end\('proxied fallback'\)/);
});

test("upload PUT reports the final URL it landed on (xhr.responseURL)", () => {
  assert.match(source, /xhr\.responseURL \|\| uploadUrl/);
});

test("opt-in repeated-request probe is registered on window", () => {
  assert.match(source, /__vaultTransferProbe/);
  assert.match(source, /console\.table\(/);
});

test("transfer transports and credentials are unchanged (behavior preservation)", () => {
  // Preview direct fetch: still credential-free, still refuses redirects.
  assert.match(source, /credentials: 'omit', redirect: 'error'/);
  // Upload PUT: still a direct XHR to the presigned URL, no credentials.
  assert.match(source, /xhr\.withCredentials = false;/);
  assert.match(source, /xhr\.send\(file\);/);
  // Preview cache orchestration (dedup, refcounted abort, upload seeding)
  // is untouched.
  assert.match(source, /createPreviewDownloader\(\{ fetch: fetchModelBytes \}\)/);
  assert.match(source, /previewLoader\.seed\(completed\.file\.id, file, file\.size\)/);
});

test("transfer-stats.js stays pure: no imports, no network, no DOM", () => {
  assert.doesNotMatch(statsSource, /^import /m, "must remain dependency-free");
  assert.doesNotMatch(statsSource, /\bfetch\(/, "must not perform network calls");
  assert.doesNotMatch(statsSource, /XMLHttpRequest/);
  assert.doesNotMatch(statsSource, /\bwindow\b/, "must not touch browser globals");
  assert.doesNotMatch(statsSource, /\bdocument\b/);
});
