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

test("transfer functions have no unreachable or duplicated statements (final-source guards)", () => {
  // fetchModelBytes: exactly ONE direct attempt before the network/CORS
  // fallback; the fallback is reachable only from its catch.
  const fnStart = source.indexOf("async function fetchModelBytes");
  const fnBody = source.slice(fnStart, source.indexOf("\n}\n", fnStart) + 3);
  assert.equal((fnBody.match(/fetchDirectBlob\(/g) || []).length, 1, "exactly one direct fetch attempt");
  assert.equal((fnBody.match(/fetchProxiedBlob\(/g) || []).length, 1, "exactly one fallback call, in the catch");

  // fetchProxiedBlob: read the body, then report, then return the blob —
  // never an unconditional `return response.blob()` that would skip reporting.
  const proxiedStart = source.indexOf("async function fetchProxiedBlob");
  const proxiedBody = source.slice(proxiedStart, source.indexOf("\n}\n", proxiedStart) + 3);
  assert.doesNotMatch(proxiedBody, /return response\.blob\(\)/, "no unconditional early return before reporting");
  const pRead = proxiedBody.indexOf("await response.blob()");
  const pReport = proxiedBody.indexOf("reportTransfer('preview proxied'");
  const pReturn = proxiedBody.indexOf("return blob;");
  assert.ok(pRead !== -1 && pReport !== -1 && pReturn !== -1);
  assert.ok(pRead < pReport && pReport < pReturn, "order: read body -> reportTransfer -> return blob");

  // fetchDirectBlob: same order on its success path.
  const directStart = source.indexOf("async function fetchDirectBlob");
  const directBody = source.slice(directStart, source.indexOf("\n}\n", directStart) + 3);
  const dRead = directBody.indexOf("await response.blob()");
  const dReport = directBody.indexOf("reportTransfer('preview direct'");
  assert.ok(dRead !== -1 && dReport !== -1 && dRead < dReport, "read body -> reportTransfer");
  assert.ok(directBody.indexOf("return blob;", dReport) > dReport, "blob returned after reporting");

  // preview:envelope covers ONLY the authenticated /raw envelope call, and
  // preview:transfer starts only after the envelope has fully ended — so the
  // transfer number is pure byte-leg time.
  const envStart = fnBody.indexOf("const envelopeTimer = perf.time(`preview:envelope:");
  const envCall = fnBody.indexOf("await apiFetch(`/api/files/${encodeURIComponent(meta.id)}/raw`");
  const envEnd = fnBody.indexOf("envelopeTimer.end();");
  const transferStart = fnBody.indexOf("const transferTimer = perf.time(`preview:transfer:");
  assert.ok(envStart !== -1 && envCall !== -1 && envEnd !== -1 && transferStart !== -1);
  assert.ok(envStart < envCall && envCall < envEnd, "envelope timer wraps only the /raw call");
  assert.ok(envEnd < transferStart, "byte-transfer timer starts after the envelope ended");
});

test("tests read the actual final source from disk (not a copy)", () => {
  // Guard against drift between what is tested and what ships: every source
  // assertion in this file loads public/vault/app.js via readFileSync at run
  // time — same file the dev server serves from public/.
  assert.match(
    readFileSync(new URL("./transfer-observability.test.mjs", import.meta.url), "utf8"),
    /readFileSync\(appJsPath, "utf8"\)/,
  );
  assert.equal(appJsPath, path.join(__dirname, "..", "public", "vault", "app.js"));
});

test("reported URLs are redacted — signed query strings never reach diagnostics", () => {
  // The helper exists in the pure module…
  assert.match(statsSource, /export function redactUrl\(url\)/);
  // …and is the ONLY path by which a URL enters the diagnostic details:
  // reportTransfer must store the redacted form, never the raw transfer URL
  // (presigned GETs and upload URLs carry X-Amz-Signature/AuthorizationToken
  // in the query — those must never appear in console diagnostics).
  assert.match(source, /url: redactUrl\(url \|\| ''\)/);
  assert.doesNotMatch(source, /url: String\(url \|\| ''\)/);
  // The PerformanceResourceTiming lookup still uses the full URL (it must
  // match the browser's exact resource entry); redaction is output-only.
  assert.match(source, /findResourceTiming\(url,/);
  // The one-line console summary prints host/status but never a URL…
  const rtStart = source.indexOf("function reportTransfer(");
  const rtBody = source.slice(rtStart, source.indexOf("\n}", rtStart) + 3);
  assert.ok(!rtBody.includes("details.url"), "reportTransfer must not print the URL inline");
  assert.match(rtBody, /host=\$\{details\.host/);
  // …and the probe echoes redacted targets only.
  assert.match(source, /console\.warn\('\[perf:transfer\] probe: no presigned URL for', redactUrl\(target\)/);
  assert.match(source, /hostOf\(url\) \|\| redactUrl\(url\)/);
});

test("transfer-stats.js stays pure: no imports, no network, no DOM", () => {
  assert.doesNotMatch(statsSource, /^import /m, "must remain dependency-free");
  assert.doesNotMatch(statsSource, /\bfetch\(/, "must not perform network calls");
  assert.doesNotMatch(statsSource, /XMLHttpRequest/);
  assert.doesNotMatch(statsSource, /\bwindow\b/, "must not touch browser globals");
  assert.doesNotMatch(statsSource, /\bdocument\b/);
});
