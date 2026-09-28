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
  // The one-line console summary prints host/status but never a URL: check
  // the console.info arguments themselves (comments may discuss details.url;
  // the printed template may not).
  const infoAt = rtBody.indexOf("console.info(");
  const infoArgs = rtBody.slice(infoAt, rtBody.indexOf(", details,", infoAt));
  assert.ok(infoArgs.length > 0, "console.info summary line must exist");
  assert.ok(!infoArgs.includes("details.url"), "reportTransfer must not print the URL inline");
  assert.match(infoArgs, /host=\$\{details\.host/);
  // …and the probe echoes redacted targets only.
  assert.match(source, /console\.warn\('\[perf:transfer\] probe: no presigned URL for', redactUrl\(target\)/);
  assert.match(source, /hostOf\(url\) \|\| redactUrl\(url\)/);

  // Defense in depth: redaction is RE-APPLIED after `extra` is merged, so an
  // extra.url (from any caller) can never smuggle a signed URL into
  // diagnostics. The full signed URL may only feed findResourceTiming.
  const assignAt = rtBody.indexOf("Object.assign({");
  const reRedactAt = rtBody.indexOf("details.url = redactUrl(details.url || url || '')");
  const timingLookupAt = rtBody.indexOf("findResourceTiming(url,");
  assert.ok(assignAt !== -1 && reRedactAt !== -1, "details.url must be re-redacted after the extra merge");
  assert.ok(assignAt < reRedactAt, "re-redaction must happen AFTER Object.assign(..., extra)");
  assert.ok(timingLookupAt !== -1 && timingLookupAt < reRedactAt,
    "resource-timing matching keeps the full URL; it is not affected by the re-redaction");
});

test("probe cache guidance never treats small bytes as cache evidence", () => {
  // bytes is the decoded Blob size — identical for cached and network
  // responses of the same object — so the old "tiny byte count suggests a
  // cache hit" claim was wrong and must stay gone.
  assert.doesNotMatch(source, /tiny bytes? suggests a cache hit/);
  assert.doesNotMatch(source, /tiny byte count/);
  // The corrected explanation points at the real evidence and its limits.
  assert.match(source, /resourceTiming\.fromCache/);
  assert.match(source, /NOT cache evidence/);
  assert.match(source, /fromCache: null/);
});

test("transfer-stats.js stays pure: no imports, no network, no DOM", () => {
  assert.doesNotMatch(statsSource, /^import /m, "must remain dependency-free");
  assert.doesNotMatch(statsSource, /\bfetch\(/, "must not perform network calls");
  assert.doesNotMatch(statsSource, /XMLHttpRequest/);
  assert.doesNotMatch(statsSource, /\bwindow\b/, "must not touch browser globals");
  assert.doesNotMatch(statsSource, /\bdocument\b/);
});

test("XHR diagnostics use XHR_READABLE_HEADERS (cleanup wiring)", () => {
  // The pure module must export the XHR-specific header list.
  assert.match(statsSource, /export const XHR_READABLE_HEADERS/);
  assert.match(statsSource, /\"etag\"/, "XHR set must include etag");
  // app.js must import it and use it for the upload PUT path only.
  assert.match(source, /XHR_READABLE_HEADERS/, "app.js must reference XHR_READABLE_HEADERS");
  assert.match(source, /from '\.\/transfer-stats\.js'/, "import must come from transfer-stats.js");
  // Upload PUT reporting must pass XHR_READABLE_HEADERS to reportTransfer.
  const uploadReportIdx = source.indexOf("reportTransfer('upload PUT'");
  assert.ok(uploadReportIdx !== -1, "upload PUT reportTransfer call must exist");
  const uploadSnippet = source.slice(uploadReportIdx, uploadReportIdx + 500);
  assert.match(uploadSnippet, /XHR_READABLE_HEADERS/, "upload PUT must use XHR_READABLE_HEADERS");
  // reportTransfer must accept a headerNames argument and forward it to pickReadableHeaders.
  assert.match(source, /function reportTransfer\(.*headerNames/);
  assert.match(source, /pickReadableHeaders\(getHeader, headerNames\)/);
  // Preview paths must NOT use XHR_READABLE_HEADERS — they keep the full REPORTED_HEADERS set
  // (default behavior of pickReadableHeaders).
  const directIdx = source.indexOf("reportTransfer('preview direct'");
  const proxiedIdx = source.indexOf("reportTransfer('preview proxied'");
  assert.ok(directIdx !== -1 && proxiedIdx !== -1);
  const directSnippet = source.slice(directIdx, directIdx + 300);
  const proxiedSnippet = source.slice(proxiedIdx, proxiedIdx + 400);
  assert.doesNotMatch(directSnippet, /XHR_READABLE_HEADERS/, "preview direct must not use XHR_READABLE_HEADERS");
  assert.doesNotMatch(proxiedSnippet, /XHR_READABLE_HEADERS/, "preview proxied must not use XHR_READABLE_HEADERS");
});

test("XHR_READABLE_HEADERS is documented and stays minimal", () => {
  // Guard against the XHR set growing back to the full list: it must be defined as a small array
  // and must be a subset of REPORTED_HEADERS (enforced in transfer-stats.test.mjs as well, but
  // this file guards the wiring side).
  const xhrMatch = statsSource.match(/export const XHR_READABLE_HEADERS = \[([\s\S]*?)\];/);
  assert.ok(xhrMatch, "XHR_READABLE_HEADERS definition must be found");
  const body = xhrMatch[1];
  const headers = body.split(",").map((s) => s.trim().replace(/['\"]/g, "")).filter(Boolean);
  assert.ok(headers.length >= 1 && headers.length <= 5, `XHR set should stay minimal (1-5 entries), got ${headers.length}`);
  assert.ok(headers.includes("etag"), "must include etag");
  // Ensure the file still defines REPORTED_HEADERS as the comprehensive set.
  assert.match(statsSource, /export const REPORTED_HEADERS = \[/);
});
