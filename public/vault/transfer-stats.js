/* ============================================================
   Model Vault — transfer measurement helpers.

   Pure logic: no DOM, no fetch, no three.js, no imports at all. Imported by
   public/vault/app.js in the browser and by tests/transfer-stats.test.mjs
   under Node (same pattern as shared.js / preview-cache.js), so the numbers
   the console diagnostics print can be unit-tested rather than hoped for.

   Why this exists: production timing showed multi-MB transfers taking tens
   of seconds while the server's own work (auth + db + presign) stayed under
   two seconds, but nothing could say WHICH leg was slow — the browser can
   fetch preview bytes directly from the private bucket (presigned GET) or,
   after a network/CORS-level failure, fall back to streaming the same bytes
   through the authenticated API route. Those two transports have completely
   different performance profiles, and without instrumentation they are
   indistinguishable. These helpers standardize what we report for every
   transfer attempt:

     - which transport actually carried the bytes (direct vs proxied);
     - the host that served them (bucket endpoint vs app origin);
     - final URL / status / readable response headers (cross-origin
       responses only expose what the bucket's CORS rules allow, so every
       header read is best-effort and never throws);
     - throughput (bytes and milliseconds, always the same formula);
     - the PerformanceResourceTiming entry when one is available — noting
       that for cross-origin resources without a Timing-Allow-Origin header
       the phase breakdown (DNS/TCP/TLS/TTFB) is zeroed by the browser and
       only total duration remains reliable.
   ============================================================ */

/**
 * Headers worth reporting on a transfer, grouped by what they explain.
 * The list is deliberately small: B2/CDN responses only expose a subset of
 * headers cross-origin, and the point is to answer "who served this, how
 * long can it be cached, was a proxy involved" — not to dump everything.
 */
export const REPORTED_HEADERS = [
  // Body + content negotiation.
  "content-length",
  "content-type",
  "content-encoding",
  "content-disposition",
  // Cache behavior: does a repeat request re-transfer or hit a cache?
  "cache-control",
  "etag",
  "expires",
  "last-modified",
  "age",
  "vary",
  // Range support (the app never sends Range, but B2 advertises it).
  "accept-ranges",
  "content-range",
  // Proxy / CDN fingerprints: presence of these on a "direct" fetch means
  // something sat between the browser and the bucket.
  "x-vercel-cache",
  "x-vercel-id",
  "x-vercel-h",
  "via",
  "cf-cache-status",
  "x-cache",
  "server",
  // Diagnostics the server and bucket may expose.
  "server-timing",
  "access-control-allow-origin",
  "timing-allow-origin",
];

/**
 * Headers that are actually readable via XHR.getResponseHeader() after a
 * cross-origin PUT to B2 with the documented CORS rules. B2's CORS config
 * only exposes ETag for PUT (see README), and simple response headers are
 * always readable but not meaningful for a PUT with an empty body. Limiting
 * the probe to this small set avoids asking for 20+ headers that will always
 * be null on the upload path and makes the diagnostics match what the
 * browser can actually see.
 */
export const XHR_READABLE_HEADERS = [
  "etag",
];

/**
 * Throughput in megabits per second — one formula everywhere so console
 * numbers and tests agree. Returns null for non-measurable inputs instead
 * of Infinity/NaN.
 */
export function throughputMbps(bytes, ms) {
  const b = Number(bytes);
  const t = Number(ms);
  if (!Number.isFinite(b) || !Number.isFinite(t) || b <= 0 || t <= 0) return null;
  return Math.round(((b * 8) / 1e6 / (t / 1000)) * 100) / 100;
}

/** Hostname of an absolute URL, null when it cannot be parsed. */
export function hostOf(url) {
  try {
    return new URL(String(url)).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Strips the ENTIRE query string and fragment from a URL, keeping the
 * origin (scheme + host) and pathname. Presigned storage URLs carry their
 * authorization in the query (X-Amz-Signature, AuthorizationToken, …), so a
 * full transfer URL must never be stored in diagnostic objects or printed
 * to the console. Absolute URLs are normalized to scheme + host + path
 * (dropping query, fragment and any embedded credentials); relative URLs
 * and unparsable strings are cut textually at the first `?` or `#`.
 */
export function redactUrl(url) {
  const raw = String(url ?? "");
  if (!raw) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    // Absolute: normalize to origin + path; query, fragment and any
    // credentials never survive.
    try {
      const parsed = new URL(raw);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch {
      /* unparsable absolute URL — fall through to the textual cut */
    }
  }
  const queryAt = raw.indexOf("?");
  const hashAt = raw.indexOf("#");
  let cut = raw.length;
  if (queryAt !== -1) cut = Math.min(cut, queryAt);
  if (hashAt !== -1) cut = Math.min(cut, hashAt);
  return raw.slice(0, cut);
}

/** Compact byte count for log lines: 25162268 -> "24.0MB". */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1024) return `${Math.round(n)}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/**
 * Reads the REPORTED_HEADERS subset through a caller-supplied getter so the
 * same code works for fetch Responses (`h => res.headers.get(h)`), XHR
 * (`h => xhr.getResponseHeader(h)`) and test doubles. Cross-origin responses
 * simply answer null for non-exposed headers, and a getter that throws
 * (opaque responses, aborted XHRs) yields a missing entry — never an error.
 * Returns a plain object with only the headers that had a value.
 */
export function pickReadableHeaders(getHeader, names = REPORTED_HEADERS) {
  const out = {};
  if (typeof getHeader !== "function") return out;
  for (const name of names) {
    let value = null;
    try {
      value = getHeader(name);
    } catch {
      value = null;
    }
    if (value !== null && value !== undefined && value !== "") {
      out[name] = String(value);
    }
  }
  return out;
}

/**
 * Finds the PerformanceResourceTiming entry for a fetch/XHR of `url`.
 * Browsers key resource entries by the exact response URL, which for a
 * presigned GET includes the signature query — match that first, then fall
 * back to the query-less URL (covers redirects and response.url variants).
 * Returns the newest match, or null when the performance timeline is not
 * available or has no entry (e.g. cross-origin reads blocked entirely).
 */
export function findResourceTiming(url, perf) {
  if (!perf || typeof perf.getEntriesByType !== "function" || !url) return null;
  let entries;
  try {
    entries = perf.getEntriesByType("resource");
  } catch {
    return null;
  }
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const target = String(url);
  const path = target.split("?")[0];
  let exact = null;
  let samePath = null;
  for (const entry of entries) {
    if (!entry || !entry.name) continue;
    if (entry.name === target) exact = entry;
    else if (entry.name.split("?")[0] === path) samePath = entry;
  }
  return exact || samePath;
}

/**
 * Summarizes a resource-timing entry for logging. Cross-origin resources
 * without `Timing-Allow-Origin` have their phase timings zeroed by the
 * browser; in that case only `durationMs` is trustworthy and
 * `phasesAvailable` is false. Cache detection: a transferSize of 0 with a
 * non-zero decoded body means the bytes came from a cache; when all body
 * sizes are zeroed the answer is reported as null (unknown), not guessed.
 */
export function describeResourceTiming(entry) {
  if (!entry) return null;
  const round = (v) => Math.round((Number(v) || 0) * 10) / 10;

  const out = {
    durationMs: round(entry.duration),
    initiatorType: entry.initiatorType || null,
    nextHopProtocol: entry.nextHopProtocol || null,
  };

  const phasesZeroed = !entry.requestStart && !entry.responseStart;
  out.phasesAvailable = !phasesZeroed;
  if (out.phasesAvailable) {
    out.dnsMs = round(entry.domainLookupEnd - entry.domainLookupStart);
    out.tcpMs = round(
      entry.connectEnd - entry.connectStart - ((entry.secureConnectionStart && (entry.connectEnd - entry.secureConnectionStart)) || 0),
    );
    if (entry.secureConnectionStart) {
      out.tlsMs = round(entry.connectEnd - entry.secureConnectionStart);
    }
    out.ttfbMs = round(entry.responseStart - entry.requestStart);
    out.downloadMs = round(entry.responseEnd - entry.responseStart);
  }

  const bodySizesKnown = Number(entry.transferSize) > 0 || Number(entry.decodedBodySize) > 0;
  out.bodySizesAvailable = bodySizesKnown;
  if (bodySizesKnown) {
    out.transferSize = Number(entry.transferSize) || 0;
    out.encodedBodySize = Number(entry.encodedBodySize) || 0;
    out.decodedBodySize = Number(entry.decodedBodySize) || 0;
    out.fromCache = Number(entry.transferSize) === 0 && Number(entry.decodedBodySize) > 0;
  } else {
    // Cross-origin without TAO zeroes these too — do not pretend 0 means 0.
    out.fromCache = null;
  }
  return out;
}
