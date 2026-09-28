import test from "node:test";
import assert from "node:assert/strict";

// Unit tests for the browser transfer-diagnostics helpers. These functions
// produce every [perf:transfer] number the console prints, so the math and
// the cross-origin caveats are pinned here rather than trusted in prod.

import {
  REPORTED_HEADERS,
  XHR_READABLE_HEADERS,
  describeResourceTiming,
  findResourceTiming,
  formatBytes,
  hostOf,
  pickReadableHeaders,
  redactUrl,
  throughputMbps,
} from "../public/vault/transfer-stats.js";

test("throughputMbps uses one formula: bytes*8/1e6/seconds", () => {
  // The four production observations that motivated this investigation.
  assert.equal(throughputMbps(25162268, 32827), 6.13); // 24MB preview download
  assert.equal(throughputMbps(3124456, 11312), 2.21); // 3.1MB preview download
  assert.equal(throughputMbps(3523216, 26146), 1.08); // 3.5MB upload PUT
  assert.equal(throughputMbps(2924788, 3759), 6.22); // 2.9MB upload PUT
});

test("throughputMbps returns null for non-measurable inputs, never NaN/Infinity", () => {
  for (const [bytes, ms] of [[0, 100], [100, 0], [-1, 100], [100, -1], [NaN, 100], [100, NaN], [undefined, 100], [100, undefined]]) {
    assert.equal(throughputMbps(bytes, ms), null, `${bytes}/${ms} must be null`);
  }
});

test("hostOf extracts the serving hostname from transfer URLs", () => {
  assert.equal(
    hostOf("https://s3.us-west-004.backblazeb2.com/model-vault/files/abc/x.glb?AuthorizationToken=secret"),
    "s3.us-west-004.backblazeb2.com",
  );
  assert.equal(hostOf("https://app.vercel.app/api/files/x/raw?proxy=1"), "app.vercel.app");
  assert.equal(hostOf("not a url"), null);
  assert.equal(hostOf("/api/files/x/raw"), null);
  assert.equal(hostOf(""), null);
  assert.equal(hostOf(undefined), null);
});

test("redactUrl strips the signed query string — presigned URLs are never reported whole", () => {
  // The exact case called out in review: the signature must not survive.
  const signed = "https://s3.us-west-004.backblazeb2.com/file.glb?X-Amz-Signature=SECRET";
  assert.equal(redactUrl(signed), "https://s3.us-west-004.backblazeb2.com/file.glb");
  assert.ok(!redactUrl(signed).includes("X-Amz-Signature"), "signature param must be gone");
  assert.ok(!redactUrl(signed).includes("SECRET"), "signature value must be gone");

  // Every query parameter is stripped, along with any fragment, from any
  // presigned storage URL shape the app produces.
  const b2 = redactUrl(
    "https://s3.us-west-004.backblazeb2.com/model-vault/files/abc/model.glb"
    + "?AuthorizationToken=SECRET&X-Amz-Algorithm=AWS4-HMAC-SHA256&response-content-type=model%2Fgltf-binary#frag",
  );
  assert.equal(b2, "https://s3.us-west-004.backblazeb2.com/model-vault/files/abc/model.glb");
  assert.ok(!b2.includes("SECRET") && !b2.includes("#frag") && !b2.includes("?"));

  // Clean URLs pass through unchanged (still scheme + host + path).
  assert.equal(
    redactUrl("https://s3.us-west-004.backblazeb2.com/file.glb"),
    "https://s3.us-west-004.backblazeb2.com/file.glb",
  );
});

test("redactUrl keeps the hostname and pathname, handles relative and unparsable inputs", () => {
  assert.equal(redactUrl("https://app.vercel.app/api/files/x/raw?proxy=1"), "https://app.vercel.app/api/files/x/raw");
  assert.equal(redactUrl("/api/files/x/raw?proxy=1"), "/api/files/x/raw");
  assert.equal(redactUrl("/api/files/x/raw"), "/api/files/x/raw");
  assert.equal(redactUrl(""), "");
  assert.equal(redactUrl(undefined), "");
  assert.equal(redactUrl(null), "");
  // Unparsable strings: best-effort cut at the first ? or #.
  assert.equal(redactUrl("weird-url?q=1#f"), "weird-url");
  assert.equal(redactUrl("weird-url"), "weird-url");
  // Credentials in a URL never survive either (only origin + path do).
  assert.equal(redactUrl("https://user:pass@b2.example/file?q=1"), "https://b2.example/file");
});

test("formatBytes gives compact, stable log labels", () => {
  assert.equal(formatBytes(0), "0B");
  assert.equal(formatBytes(999), "999B");
  assert.equal(formatBytes(1024), "1.0KB");
  assert.equal(formatBytes(3124456), "3.0MB");
  assert.equal(formatBytes(25162268), "24.0MB");
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), "2.0GB");
  assert.equal(formatBytes(-5), "?");
  assert.equal(formatBytes(NaN), "?");
});

test("pickReadableHeaders returns only headers the origin actually exposed", () => {
  const exposed = new Map([
    ["content-type", "model/gltf-binary"],
    ["content-length", "25162268"],
    ["cache-control", "private, max-age=0, no-cache"],
    ["x-vercel-cache", "MISS"],
    ["empty-but-present", ""], // empty values are treated as absent
  ]);
  const out = pickReadableHeaders((name) => exposed.get(name) ?? null);
  assert.deepEqual(out, {
    "content-type": "model/gltf-binary",
    "content-length": "25162268",
    "cache-control": "private, max-age=0, no-cache",
    "x-vercel-cache": "MISS",
  });
});

test("pickReadableHeaders never throws — unexposed/cross-origin getters degrade to {}", () => {
  assert.deepEqual(pickReadableHeaders(() => null), {});
  assert.deepEqual(
    pickReadableHeaders(() => {
      throw new TypeError("opaque response");
    }),
    {},
  );
  assert.deepEqual(pickReadableHeaders(null), {});
});

test("pickReadableHeaders probes the documented header set (incl. proxy fingerprints)", () => {
  const asked = [];
  pickReadableHeaders((name) => {
    asked.push(name);
    return null;
  });
  for (const expected of ["content-type", "cache-control", "server-timing", "x-vercel-cache", "via", "timing-allow-origin"]) {
    assert.ok(asked.includes(expected), `getter should be asked for ${expected}`);
  }
  assert.ok(REPORTED_HEADERS.length >= 15, "reported header set should stay comprehensive");
});

test("findResourceTiming prefers the exact URL, falls back to the query-less path", () => {
  const direct = { name: "https://b2.example/file.glb?sig=1", duration: 10 };
  const other = { name: "https://b2.example/other.glb", duration: 99 };
  const perf = { getEntriesByType: () => [other, direct] };
  assert.equal(findResourceTiming("https://b2.example/file.glb?sig=1", perf), direct);

  const byPath = { name: "https://b2.example/file.glb?sig=2", duration: 11 };
  const perf2 = { getEntriesByType: () => [other, byPath] };
  assert.equal(findResourceTiming("https://b2.example/file.glb?sig=1", perf2), byPath);

  assert.equal(findResourceTiming("https://b2.example/missing.glb", perf), null);
  assert.equal(findResourceTiming("https://b2.example/file.glb", null), null);
  assert.equal(findResourceTiming(null, perf), null);
  assert.equal(findResourceTiming("https://b2.example/x", {}), null);
});

test("describeResourceTiming reports phases only when the browser allows them", () => {
  const full = describeResourceTiming({
    name: "https://b2.example/x",
    initiatorType: "fetch",
    nextHopProtocol: "h2",
    domainLookupStart: 0,
    domainLookupEnd: 10,
    connectStart: 10,
    secureConnectionStart: 50,
    connectEnd: 90,
    requestStart: 100,
    responseStart: 200,
    responseEnd: 300,
    duration: 300,
    transferSize: 25162268,
    encodedBodySize: 25162268,
    decodedBodySize: 25162268,
  });
  assert.equal(full.phasesAvailable, true);
  assert.equal(full.dnsMs, 10);
  assert.equal(full.tcpMs, 40); // connect total 80 minus the TLS portion 40
  assert.equal(full.tlsMs, 40);
  assert.equal(full.ttfbMs, 100);
  assert.equal(full.downloadMs, 100);
  assert.equal(full.bodySizesAvailable, true);
  assert.equal(full.fromCache, false);

  // Cross-origin WITHOUT Timing-Allow-Origin: phases and body sizes are
  // zeroed by the browser and must be reported as unavailable, not 0.
  const restricted = describeResourceTiming({
    name: "https://b2.example/x",
    duration: 32827,
    requestStart: 0,
    responseStart: 0,
    transferSize: 0,
    encodedBodySize: 0,
    decodedBodySize: 0,
  });
  assert.equal(restricted.phasesAvailable, false);
  assert.equal("dnsMs" in restricted, false);
  assert.equal(restricted.durationMs, 32827);
  assert.equal(restricted.bodySizesAvailable, false);
  assert.equal(restricted.fromCache, null); // unknown, not "no"
});

test("describeResourceTiming detects cache hits (transferSize 0 with a decoded body)", () => {
  const cached = describeResourceTiming({
    name: "https://b2.example/x",
    duration: 12,
    requestStart: 1,
    responseStart: 5,
    transferSize: 0,
    encodedBodySize: 0,
    decodedBodySize: 5000,
  });
  assert.equal(cached.fromCache, true);
  assert.equal(describeResourceTiming(null), null);
});

test("XHR_READABLE_HEADERS is a small, lowercase subset for XHR PUT diagnostics", () => {
  assert.ok(Array.isArray(XHR_READABLE_HEADERS), "XHR_READABLE_HEADERS must be an array");
  assert.ok(XHR_READABLE_HEADERS.length >= 1, "must contain at least one header");
  assert.ok(XHR_READABLE_HEADERS.length < REPORTED_HEADERS.length, "XHR set must be smaller than REPORTED_HEADERS");
  // All entries must be lowercase strings, no duplicates, and part of REPORTED_HEADERS.
  const seen = new Set();
  for (const h of XHR_READABLE_HEADERS) {
    assert.equal(typeof h, "string", `header ${h} must be a string`);
    assert.equal(h, h.toLowerCase(), `header ${h} must be lowercase`);
    assert.ok(h.length > 0, "header must not be empty");
    assert.ok(!seen.has(h), `duplicate header ${h}`);
    seen.add(h);
    assert.ok(REPORTED_HEADERS.includes(h), `XHR header ${h} must be part of REPORTED_HEADERS`);
  }
  // The documented B2 CORS rule only exposes ETag for PUT — that must be present.
  assert.ok(XHR_READABLE_HEADERS.includes("etag"), "XHR set must include etag (the only header B2 CORS exposes for PUT)");
  // Proxy/CDN fingerprints and cache-diagnostic headers are never readable via XHR PUT
  // with the current CORS config and must not be probed on the upload path.
  for (const notExpected of ["x-vercel-cache", "x-vercel-id", "x-vercel-h", "via", "cf-cache-status", "x-cache", "server-timing", "timing-allow-origin"]) {
    assert.ok(!XHR_READABLE_HEADERS.includes(notExpected), `XHR set must not include ${notExpected} — not readable via XHR PUT`);
  }
});

test("pickReadableHeaders with XHR_READABLE_HEADERS only probes the XHR subset", () => {
  const asked = [];
  const exposed = new Map([
    ["etag", '"abc123"'],
    ["content-type", "model/gltf-binary"], // not in XHR set, should not be asked
    ["x-vercel-cache", "MISS"], // not in XHR set
  ]);
  const out = pickReadableHeaders((name) => {
    asked.push(name);
    return exposed.get(name) ?? null;
  }, XHR_READABLE_HEADERS);
  // Only XHR headers should have been asked.
  assert.deepEqual(new Set(asked), new Set(XHR_READABLE_HEADERS), "getter must be asked exactly for XHR_READABLE_HEADERS");
  assert.deepEqual(out, { etag: '"abc123"' }, "only etag should be returned for the XHR subset");
  // Probing the full set would ask for many more headers — the cleanup avoids that.
  const fullAsked = [];
  pickReadableHeaders((name) => {
    fullAsked.push(name);
    return null;
  }, REPORTED_HEADERS);
  assert.ok(fullAsked.length > XHR_READABLE_HEADERS.length, "full set must be larger than XHR set");
});
