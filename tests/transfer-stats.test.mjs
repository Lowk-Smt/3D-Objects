import test from "node:test";
import assert from "node:assert/strict";

// Unit tests for the browser transfer-diagnostics helpers. These functions
// produce every [perf:transfer] number the console prints, so the math and
// the cross-origin caveats are pinned here rather than trusted in prod.

import {
  REPORTED_HEADERS,
  describeResourceTiming,
  findResourceTiming,
  formatBytes,
  hostOf,
  pickReadableHeaders,
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
