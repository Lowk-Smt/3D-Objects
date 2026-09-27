#!/usr/bin/env node
/**
 * Model Vault — end-to-end acceptance test.
 *
 * Drives the real HTTP API (auth, uploads, downloads, thumbnails, deletes,
 * authorization, quota, rate limiting, SSE) against a running server, exactly
 * the way two browsers would. Nothing is mocked: Postgres, Cloudflare R2
 * object storage and the SSE stream are all the real thing.
 *
 * Usage (fresh database required for phase 1):
 *   node scripts/e2e-test.mjs --phase=1        # everything, no restart
 *   #   ... restart the server here ...
 *   node scripts/e2e-test.mjs --phase=2        # persistence across a restart
 *
 * Env:
 *   E2E_BASE_URL        default http://127.0.0.1:3000
 *   E2E_STATE_FILE      default /tmp/model-vault-e2e-state.json
 *   E2E_MAX_UPLOAD_MB   set to the server's MAX_UPLOAD_MB to test oversize rejection
 */

import fs from "node:fs";
import assert from "node:assert/strict";

import { findReferencedFile } from "../public/vault/shared.js";

const BASE = (process.env.E2E_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const STATE_FILE = process.env.E2E_STATE_FILE || "/tmp/model-vault-e2e-state.json";
const MAX_UPLOAD_MB = Number(process.env.E2E_MAX_UPLOAD_MB || 0);

const args = process.argv.slice(2);
const phaseArg = args.find((a) => a.startsWith("--phase="));
const PHASE = phaseArg ? Number(phaseArg.split("=")[1]) : 1;

const OWNER = { username: "vaultowner", password: "owner-password-123" };
const MEMBER = { username: "vaulthost", password: "member-password-123" };

/* ----------------------------------------------------------------- harness */

const results = [];
let currentTest = null;

async function test(name, fn) {
  currentTest = name;
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split("\n").join("\n      ")}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/* --------------------------------------------------------------- http bits */

function newJar() {
  const cookies = new Map();
  return {
    cookies,
    store(response) {
      const list = response.headers.getSetCookie?.() ?? [];
      for (const raw of list) {
        const [pair] = raw.split(";");
        const index = pair.indexOf("=");
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1);
        if (value === "") cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    header() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    get(name) {
      return cookies.get(name);
    },
    serialize() {
      return Object.fromEntries(cookies.entries());
    },
    load(obj) {
      cookies.clear();
      for (const [k, v] of Object.entries(obj || {})) cookies.set(k, v);
    },
  };
}

async function request(jar, urlPath, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (jar) headers.Cookie = jar.header();

  const method = (options.method || "GET").toUpperCase();
  if (jar && !["GET", "HEAD"].includes(method) && !headers["x-csrf-token"]) {
    const csrf = jar.get("mv_csrf");
    if (csrf) headers["x-csrf-token"] = csrf;
  }

  const response = await fetch(`${BASE}${urlPath}`, {
    ...options,
    headers,
    redirect: options.redirect ?? "manual",
  });
  if (jar) jar.store(response);
  return response;
}

async function json(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text };
  }
}

async function login(credentials, jar = newJar()) {
  const response = await request(jar, "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
  return { response, jar, body: await json(response) };
}

function makeGlb(size = 4096, fill = 7) {
  const buffer = Buffer.alloc(size, fill);
  buffer.write("glTF", 0, "ascii"); // plausible GLB magic
  return buffer;
}

const JPEG_1PX = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function form(fields) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value && typeof value === "object" && "bytes" in value) {
      data.append(key, new Blob([value.bytes]), value.name);
    } else {
      data.append(key, String(value));
    }
  }
  return data;
}

async function upload(jar, { name, bytes, filePath, mime = "application/octet-stream", extra = {} }) {
  const fields = {
    file: { bytes, name, mime },
    name,
    path: filePath || name,
    ...extra,
  };
  const response = await request(jar, "/api/files", { method: "POST", body: form(fields) });
  return { response, body: await json(response) };
}

/* ------------------------------------------------------------- SSE reading */

async function openEventStream(jar) {
  const controller = new AbortController();
  const events = [];
  let status = null;

  const ready = (async () => {
    const response = await fetch(`${BASE}/api/events`, {
      headers: { Cookie: jar.header(), Accept: "text/event-stream" },
      signal: controller.signal,
    });
    status = response.status;
    if (!response.ok || !response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const parsed = parseEvent(chunk);
          if (parsed) events.push(parsed);
        }
      }
    } catch {
      /* aborted */
    }
  })();

  return {
    events,
    get status() {
      return status;
    },
    ready,
    close: () => controller.abort(),
    async waitFor(type, predicate = () => true, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find((e) => e.type === type && predicate(e.data));
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out waiting for SSE "${type}" (saw: ${events.map((e) => e.type).join(", ") || "nothing"})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
}

function parseEvent(chunk) {
  let type = "message";
  const dataLines = [];
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try {
    return { type, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return { type, data: dataLines.join("\n") };
  }
}

/* ---------------------------------------------------------------- fixtures */

async function uploadGltfBundle(jar, prefix) {
  const gltf = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0", generator: "e2e-test" },
      buffers: [{ uri: `${prefix}.bin`, byteLength: 4 }],
      images: [{ uri: `textures/${prefix}-albedo.png` }],
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name: "Barrel" }],
      meshes: [{ name: "BarrelMesh", primitives: [] }],
    }),
  );
  const bin = Buffer.from([1, 2, 3, 4]);
  const texture = PNG_1PX;

  const files = {};
  for (const [key, name, bytes, filePath] of [
    ["gltf", `${prefix}.gltf`, gltf, `${prefix}.gltf`],
    ["bin", `${prefix}.bin`, bin, `${prefix}.bin`],
    ["tex", `${prefix}-albedo.png`, texture, `textures/${prefix}-albedo.png`],
  ]) {
    const { response, body } = await upload(jar, { name, bytes, filePath });
    assert.equal(response.status, 201, `upload ${name} -> ${response.status}: ${JSON.stringify(body)}`);
    files[key] = body.file;
  }
  return files;
}

/* --------------------------------------------------------------- phase 1 */

async function phase1() {
  const state = { baseUrl: BASE, owner: OWNER, member: MEMBER, files: {}, thumbnails: {}, cookies: {} };

  section("First-run setup");
  const status = await json(await request(null, "/api/auth/status"));
  assert.equal(status.hasUsers, false, "phase 1 requires a database with no users yet (see scripts/db-reset.mjs)");

  await test("setup race: five simultaneous requests create exactly one owner", async () => {
    // All five requests are identical, so whichever one wins the race creates
    // exactly the account this suite then logs in with.
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(`${BASE}/api/auth/setup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(OWNER),
        }),
      ),
    );
    const codes = responses.map((r) => r.status);
    const created = codes.filter((c) => c === 201 || c === 200).length;
    assert.equal(created, 1, `expected exactly one successful setup, saw statuses ${codes.join(", ")}`);
    assert.equal(
      codes.filter((c) => c === 409).length,
      4,
      `the other four requests must be rejected with 409, saw ${codes.join(", ")}`,
    );

    // And there really is exactly one owner in the workspace.
    const winner = responses.find((r) => r.status < 300);
    const users = await json(
      await fetch(`${BASE}/api/users`, { headers: { Cookie: winner.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } }),
    );
    assert.equal(users.users.length, 1, "the race created more than one account");
  });

  const ownerJar = newJar();
  let ownerLogin = await login(OWNER, ownerJar);
  await test("owner can log in, and receives a session + csrf cookie", () => {
    assert.equal(ownerLogin.response.status, 200, JSON.stringify(ownerLogin.body));
    assert.ok(ownerJar.get("mv_session"), "session cookie missing");
    assert.ok(ownerJar.get("mv_csrf"), "csrf cookie missing");
    assert.equal(ownerLogin.body.user.role, "owner");
  });
  state.cookies.owner = ownerJar.serialize();

  section("Authentication & CSRF");
  await test("unauthenticated requests are rejected with 401", async () => {
    const response = await request(null, "/api/files");
    assert.equal(response.status, 401);
    assert.ok((await json(response)).error);
  });

  await test("state-changing requests without the CSRF header are rejected", async () => {
    const response = await fetch(`${BASE}/api/files`, {
      method: "POST",
      // Session cookie present, x-csrf-token deliberately absent.
      headers: { Cookie: `mv_session=${ownerJar.get("mv_session")}` },
      body: form({ file: { bytes: makeGlb(64), name: "csrf.glb" }, name: "csrf.glb" }),
    });
    assert.equal(response.status, 403, "a session alone must not authorize a state change");
  });

  await test("same-origin requests pass, cross-origin requests are blocked", async () => {
    const cookie = `mv_session=${ownerJar.get("mv_session")}`;
    const csrf = ownerJar.get("mv_csrf");

    const allowed = await fetch(`${BASE}/api/files`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrf, Origin: BASE, Host: new URL(BASE).host },
      body: form({ file: { bytes: makeGlb(64, 2), name: "origin-ok.glb" }, name: "origin-ok.glb" }),
    });
    assert.equal(allowed.status, 201, "a same-origin upload must be accepted");
    const created = await json(allowed);
    await request(ownerJar, `/api/files/${created.file.id}`, { method: "DELETE" });

    const blocked = await fetch(`${BASE}/api/files`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrf, Origin: "https://evil.example.com" },
      body: form({ file: { bytes: makeGlb(64, 2), name: "origin-bad.glb" }, name: "origin-bad.glb" }),
    });
    assert.equal(blocked.status, 403, "a cross-origin state change must be blocked");
  });

  await test("bad credentials are rejected with 401", async () => {
    const { response } = await login({ username: OWNER.username, password: "wrong-password" });
    assert.equal(response.status, 401);
  });

  section("Members");
  const ownerAsOwner = await request(ownerJar, "/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: MEMBER.username, password: MEMBER.password, canDelete: true }),
  });
  let memberRow = null;
  await test("owner can invite a member", async () => {
    assert.equal(ownerAsOwner.status, 201, JSON.stringify(await json(ownerAsOwner.clone())));
    memberRow = (await json(ownerAsOwner)).user;
    assert.equal(memberRow.role, "member");
  });

  const memberJar = newJar();
  let memberLogin = await login(MEMBER, memberJar);
  await test("member can log in", () => {
    assert.equal(memberLogin.response.status, 200, JSON.stringify(memberLogin.body));
    assert.ok(memberJar.get("mv_session"));
  });
  state.cookies.member = memberJar.serialize();

  await test("the user list never exposes password hashes", async () => {
    const body = await json(await request(ownerJar, "/api/users"));
    assert.ok(Array.isArray(body.users) && body.users.length === 2);
    for (const user of body.users) {
      assert.equal(user.passwordHash, undefined);
      assert.equal(user.password_hash, undefined);
    }
  });

  await test("a member cannot invite/remove members or change roles", async () => {
    const invite = await request(memberJar, "/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "sneaky", password: "password-123" }),
    });
    assert.equal(invite.status, 403);

    const patch = await request(memberJar, `/api/users/${memberRow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "owner" }),
    });
    assert.equal(patch.status, 403);

    const remove = await request(memberJar, `/api/users/${memberRow.id}`, { method: "DELETE" });
    assert.equal(remove.status, 403);
  });

  section("Uploads & live sync (SSE)");
  const ownerStream = await openEventStream(ownerJar);
  const memberStream = await openEventStream(memberJar);
  await new Promise((resolve) => setTimeout(resolve, 250));

  await test("both users hold a live SSE connection", async () => {
    assert.equal(ownerStream.status, 200, `owner stream status ${ownerStream.status}`);
    assert.equal(memberStream.status, 200, `member stream status ${memberStream.status}`);
    await ownerStream.waitFor("connected");
    await memberStream.waitFor("connected");
  });

  await test("user A uploads Barrel.glb", async () => {
    const { response, body } = await upload(ownerJar, {
      name: "Barrel.glb",
      bytes: makeGlb(4096, 1),
      mime: "model/gltf-binary",
    });
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.file.name, "Barrel.glb");
    assert.equal(body.file.ext, "glb");
    assert.equal(body.file.mime, "model/gltf-binary");
    assert.equal(body.file.uploaderName, OWNER.username);
    state.files.barrel = body.file;
  });

  await test("user B sees Barrel.glb over SSE without refreshing", async () => {
    const event = await memberStream.waitFor("file-added", (d) => d.name === "Barrel.glb");
    assert.equal(event.data.id, state.files.barrel.id);
    assert.equal(event.data.size, 4096);
  });

  await test("user B uploads Lantern.glb", async () => {
    const { response, body } = await upload(memberJar, {
      name: "Lantern.glb",
      bytes: makeGlb(2048, 2),
      mime: "model/gltf-binary",
    });
    assert.equal(response.status, 201, JSON.stringify(body));
    state.files.lantern = body.file;
  });

  await test("user A sees Lantern.glb over SSE without refreshing", async () => {
    await ownerStream.waitFor("file-added", (d) => d.name === "Lantern.glb");
  });

  await test("the server list is the source of truth for both users", async () => {
    const a = await json(await request(ownerJar, "/api/files"));
    const b = await json(await request(memberJar, "/api/files"));
    assert.deepEqual(
      a.files.map((f) => f.name).sort(),
      ["Barrel.glb", "Lantern.glb"],
      "owner list",
    );
    assert.deepEqual(
      b.files.map((f) => f.name).sort(),
      ["Barrel.glb", "Lantern.glb"],
      "member list",
    );
  });

  await test("the browser-supplied uploader id is ignored (session wins)", async () => {
    const { response, body } = await upload(memberJar, {
      name: "spoof.glb",
      bytes: makeGlb(256, 3),
      extra: { uploaderId: "00000000-0000-0000-0000-000000000000", uploaderName: "not-me" },
    });
    assert.equal(response.status, 201);
    assert.equal(body.file.uploaderName, MEMBER.username);
    assert.notEqual(body.file.uploaderId, "00000000-0000-0000-0000-000000000000");
    state.files.spoof = body.file;
  });

  await test("traversal-ish ids and unexpected input are rejected", async () => {
    const traversalIds = ["..%2F..%2Fpackage.json", "%2e%2e%2f%2e%2e%2fpackage.json", "....//....//package.json"];
    for (const id of traversalIds) {
      // Redirects are followed so we assert on the final outcome, not on
      // Next's path-normalisation shortcut.
      const raw = await request(ownerJar, `/api/files/${id}/raw`, { redirect: "follow" });
      assert.ok([400, 404].includes(raw.status), `raw ${id} -> ${raw.status}`);
      const body = await raw.text();
      assert.ok(!body.includes('"drizzle-orm"') && !body.includes("model-vault"), `raw ${id} leaked a server file`);

      const thumb = await request(ownerJar, `/api/files/${id}/thumbnail`, { redirect: "follow" });
      assert.ok([400, 404].includes(thumb.status), `thumbnail ${id} -> ${thumb.status}`);

      const del = await request(ownerJar, `/api/files/${id}`, { method: "DELETE", redirect: "follow" });
      assert.ok([400, 404].includes(del.status), `delete ${id} -> ${del.status}`);
    }
  });

  section("Previews & downloads");
  await test("both users can read the preview bytes of both models", async () => {
    for (const jar of [ownerJar, memberJar]) {
      for (const file of [state.files.barrel, state.files.lantern]) {
        const response = await request(jar, `/api/files/${file.id}/raw`);
        assert.equal(response.status, 200, `raw ${file.name} -> ${response.status}`);
        assert.equal(response.headers.get("content-type"), "model/gltf-binary");
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(bytes.length, file.size);
        assert.equal(bytes.subarray(0, 4).toString("ascii"), "glTF");
      }
    }
  });

  await test("downloads preserve the filename, extension and MIME type", async () => {
    for (const file of [state.files.barrel, state.files.lantern]) {
      const response = await request(memberJar, `/api/files/${file.id}/download`);
      assert.equal(response.status, 200);
      const disposition = response.headers.get("content-disposition") || "";
      assert.ok(disposition.startsWith("attachment;"), disposition);
      assert.ok(disposition.includes(`filename="${file.name}"`), disposition);
      assert.equal(response.headers.get("content-type"), file.mime);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, file.size);
    }
  });

  await test("models are stored under a server-generated id, never a client path", async () => {
    const { response, body } = await upload(ownerJar, {
      name: "../../escape.glb",
      bytes: makeGlb(512, 4),
      filePath: "../../escape.glb",
    });
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.file.name, "escape.glb", "display name must be a bare basename");
    assert.ok(!body.file.path.includes(".."), body.file.path);
    state.files.escape = body.file;
  });

  section("glTF companion files");
  let bundle = null;
  await test("a .gltf bundle can be uploaded with its relative paths intact", async () => {
    bundle = await uploadGltfBundle(ownerJar, "vintage-barrel");
    assert.equal(bundle.bin.path, "vintage-barrel.bin");
    assert.equal(bundle.tex.path, "textures/vintage-barrel-albedo.png");
  });

  await test("relative references resolve against the shared server-side library", async () => {
    const library = (await json(await request(memberJar, "/api/files"))).files;
    const model = library.find((f) => f.id === bundle.gltf.id);

    const bin = findReferencedFile(library, model, "vintage-barrel.bin");
    assert.ok(bin, "buffer reference did not resolve");
    assert.equal(bin.id, bundle.bin.id);

    const texture = findReferencedFile(library, model, "textures/vintage-barrel-albedo.png");
    assert.ok(texture, "texture reference did not resolve");
    assert.equal(texture.id, bundle.tex.id);

    // …and the resolved file is really fetchable by another member.
    const response = await request(memberJar, `/api/files/${texture.id}/raw`);
    assert.equal(response.status, 200);
    assert.equal(Buffer.from(await response.arrayBuffer()).equals(PNG_1PX), true);
  });

  await test("a missing companion file produces a clear client-side error", async () => {
    const library = (await json(await request(ownerJar, "/api/files"))).files;
    const model = library.find((f) => f.id === bundle.gltf.id);
    assert.equal(findReferencedFile(library, model, "not-in-the-library.bin"), null);
  });

  section("Thumbnails");
  await test("a member who did not upload a file cannot replace its thumbnail", async () => {
    const response = await request(memberJar, `/api/files/${state.files.barrel.id}/thumbnail`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: `data:image/jpeg;base64,${JPEG_1PX.toString("base64")}` }),
    });
    assert.equal(response.status, 403, "thumbnail write must be uploader/owner only");
    assert.match((await json(response)).error, /only/i);
  });

  await test("PNG bytes are stored as PNG and served as image/png (never as .jpg)", async () => {
    const response = await request(ownerJar, `/api/files/${state.files.barrel.id}/thumbnail`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: `data:image/png;base64,${PNG_1PX.toString("base64")}` }),
    });
    assert.equal(response.status, 200, JSON.stringify(await json(response.clone())));
    const saved = await json(response);
    assert.equal(saved.mime, "image/png");
    assert.equal(saved.ext, "png");

    const fetched = await request(memberJar, `/api/files/${state.files.barrel.id}/thumbnail`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get("content-type"), "image/png");
    const bytes = Buffer.from(await fetched.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString("hex"), "89504e47", "bytes on disk must be the PNG we uploaded");
  });

  await test("a JPEG thumbnail is stored and served as image/jpeg", async () => {
    const response = await request(ownerJar, `/api/files/${state.files.barrel.id}/thumbnail`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: `data:image/jpeg;base64,${JPEG_1PX.toString("base64")}` }),
    });
    assert.equal(response.status, 200, JSON.stringify(await json(response.clone())));
    const saved = await json(response);
    assert.equal(saved.mime, "image/jpeg");
    assert.equal(saved.ext, "jpg");

    const fetched = await request(memberJar, `/api/files/${state.files.barrel.id}/thumbnail`);
    assert.equal(fetched.headers.get("content-type"), "image/jpeg");
    const bytes = Buffer.from(await fetched.arrayBuffer());
    assert.equal(bytes.subarray(0, 3).toString("hex"), "ffd8ff");
    state.thumbnails.barrel = { id: state.files.barrel.id, sha: bytes.toString("base64") };
  });

  await test("a data URL that lies about its type is corrected by sniffing", async () => {
    const response = await request(ownerJar, `/api/files/${state.files.lantern.id}/thumbnail`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: `data:image/jpeg;base64,${PNG_1PX.toString("base64")}` }),
    });
    assert.equal(response.status, 200);
    const saved = await json(response);
    assert.equal(saved.mime, "image/png", "the bytes win over the declared mime type");
    const fetched = await request(memberJar, `/api/files/${state.files.lantern.id}/thumbnail`);
    assert.equal(fetched.headers.get("content-type"), "image/png");
  });

  await test("non-image thumbnail payloads are rejected", async () => {
    const response = await request(ownerJar, `/api/files/${state.files.barrel.id}/thumbnail`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: `data:image/jpeg;base64,${Buffer.from("<svg><script/></svg>").toString("base64")}` }),
    });
    assert.equal(response.status, 415);
  });

  await test("the other user is notified that a thumbnail appeared (live, no refresh)", async () => {
    const event = await memberStream.waitFor("file-updated", (d) => d.id === state.files.barrel.id && d.hasThumbnail);
    assert.equal(event.data.hasThumbnail, true);
  });

  await test("thumbnails are only served to authenticated users", async () => {
    const response = await request(null, `/api/files/${state.files.barrel.id}/thumbnail`);
    assert.equal(response.status, 401);
  });

  section("Rename & delete sync");
  await test("rename syncs to the other user and keeps the extension", async () => {
    const response = await request(ownerJar, `/api/files/${state.files.lantern.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Lantern Deluxe" }),
    });
    assert.equal(response.status, 200, JSON.stringify(await json(response.clone())));
    const body = await json(response);
    assert.equal(body.file.name, "Lantern Deluxe.glb");

    const event = await memberStream.waitFor("file-updated", (d) => d.id === state.files.lantern.id && !!d.name);
    assert.equal(event.data.name, "Lantern Deluxe.glb");

    const download = await request(memberJar, `/api/files/${state.files.lantern.id}/download`);
    assert.ok(
      (download.headers.get("content-disposition") || "").includes('filename="Lantern Deluxe.glb"'),
      download.headers.get("content-disposition"),
    );
    state.files.lantern.name = "Lantern Deluxe.glb";
  });

  await test("rename cannot escape its folder or change a model's type", async () => {
    const response = await request(ownerJar, `/api/files/${state.files.lantern.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "../../evil.exe" }),
    });
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.ok(!body.file.path.includes(".."), body.file.path);
    assert.equal(body.file.name.endsWith(".glb"), true, body.file.name);
  });

  await test("a member without delete permission is refused (403)", async () => {
    await request(ownerJar, `/api/users/${memberRow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ canDelete: false }),
    });
    const response = await request(memberJar, `/api/files/${state.files.spoof.id}`, { method: "DELETE" });
    assert.equal(response.status, 403);
    // …and the file is still there.
    assert.equal((await request(ownerJar, `/api/files/${state.files.spoof.id}/raw`)).status, 200);
  });

  await test("delete removes the row and the bytes, and syncs to everyone", async () => {
    const response = await request(ownerJar, `/api/files/${state.files.spoof.id}`, { method: "DELETE" });
    assert.equal(response.status, 200, JSON.stringify(await json(response.clone())));
    await memberStream.waitFor("file-deleted", (d) => d.id === state.files.spoof.id);

    const raw = await request(memberJar, `/api/files/${state.files.spoof.id}/raw`);
    assert.equal(raw.status, 404);
    assert.match((await json(raw)).error, /not found/i);
  });

  await test("deleting a file that is already gone reports 404 instead of failing silently", async () => {
    const response = await request(ownerJar, `/api/files/${state.files.spoof.id}`, { method: "DELETE" });
    assert.equal(response.status, 404);
    assert.match((await json(response)).error, /deleted/i);
  });

  await test("batch delete removes several files and syncs", async () => {
    const first = await upload(ownerJar, { name: "batch-1.glb", bytes: makeGlb(300, 5) });
    const second = await upload(ownerJar, { name: "batch-2.glb", bytes: makeGlb(300, 6) });
    const ids = [first.body.file.id, second.body.file.id];

    const response = await request(ownerJar, "/api/files/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [...ids, "00000000-0000-0000-0000-000000000000"] }),
    });
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.deepEqual(body.deleted.sort(), ids.sort());
    assert.deepEqual(body.missing, ["00000000-0000-0000-0000-000000000000"]);
    await memberStream.waitFor("files-deleted", (d) => ids.every((id) => d.ids.includes(id)));
  });

  section("Upload validation");
  await test("empty uploads are rejected", async () => {
    const { response } = await upload(ownerJar, { name: "empty.glb", bytes: Buffer.alloc(0) });
    assert.equal(response.status, 400);
  });

  await test("a missing file field is rejected", async () => {
    const response = await request(ownerJar, "/api/files", {
      method: "POST",
      body: form({ name: "nothing.glb" }),
    });
    assert.equal(response.status, 400);
  });

  if (MAX_UPLOAD_MB > 0) {
    await test(`uploads larger than MAX_UPLOAD_MB (${MAX_UPLOAD_MB}MB) are rejected with 413`, async () => {
      const { response, body } = await upload(ownerJar, {
        name: "too-big.glb",
        bytes: Buffer.alloc(MAX_UPLOAD_MB * 1024 * 1024 + 1024, 9),
      });
      assert.equal(response.status, 413, JSON.stringify(body));
      assert.match(body.error, /too large/i);
    });
  }

  await test("any file type may be stored (unsupported types are not lost)", async () => {
    const bytes = Buffer.from("this is not a model at all");
    const { response, body } = await upload(ownerJar, { name: "notes.weird", bytes });
    assert.equal(response.status, 201);
    assert.equal(body.file.mime, "application/octet-stream");
    const download = await request(ownerJar, `/api/files/${body.file.id}/download`);
    assert.ok((download.headers.get("content-disposition") || "").includes('filename="notes.weird"'));
    assert.equal(Buffer.from(await download.arrayBuffer()).equals(bytes), true);
  });

  await test("a corrupt model is stored faithfully (the viewer reports the parse error)", async () => {
    const bytes = Buffer.from("glTF this is definitely not valid");
    const { response, body } = await upload(ownerJar, { name: "corrupt.glb", bytes });
    assert.equal(response.status, 201);
    const raw = await request(memberJar, `/api/files/${body.file.id}/raw`);
    assert.equal(Buffer.from(await raw.arrayBuffer()).equals(bytes), true);
  });

  await test("unknown ids return 404 with a useful message", async () => {
    const response = await request(ownerJar, "/api/files/00000000-0000-0000-0000-000000000000/raw");
    assert.equal(response.status, 404);
    assert.match((await json(response)).error, /not found/i);
  });

  section("Presigned uploads (direct-to-R2 flow)");
  await test("presign requires authentication and a CSRF token", async () => {
    const anon = await request(null, "/api/files/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "a.glb", path: "a.glb", size: 64 }),
    });
    assert.equal(anon.status, 401);

    const noCsrf = await fetch(`${BASE}/api/files/presign`, {
      method: "POST",
      headers: {
        Cookie: `mv_session=${ownerJar.get("mv_session")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "a.glb", path: "a.glb", size: 64 }),
    });
    assert.equal(noCsrf.status, 403, "a session alone must not authorize a presign");
  });

  await test("presign validates its input before touching storage", async () => {
    const cases = [
      [{ name: "a.glb", path: "a.glb", size: 0 }, 400],
      [{ name: "a.glb", path: "a.glb", size: -5 }, 400],
      [{ name: "a.glb", path: "a.glb", size: "huge" }, 400],
      [{ name: "a.glb", path: "a.glb", size: 3.5 }, 400],
      [{ name: "a.glb", path: "a.glb", size: 10 * 1024 ** 4 }, 413], // 10TB always exceeds MAX_UPLOAD_MB
      [{ name: "", path: "a.glb", size: 64 }, 400],
      [{ name: "x".repeat(513), path: "a.glb", size: 64 }, 400],
      [{ name: "a.glb", path: "x".repeat(1025), size: 64 }, 400],
    ];
    for (const [payload, expected] of cases) {
      const response = await request(ownerJar, "/api/files/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, expected, `${JSON.stringify(payload)} -> ${response.status}`);
    }
  });

  await test("completing an unknown upload reports 404, a malformed id 400", async () => {
    const unknown = await request(ownerJar, "/api/files/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "00000000-0000-0000-0000-000000000000" }),
    });
    assert.equal(unknown.status, 404);

    const malformed = await request(ownerJar, "/api/files/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "not-an-id!!" }),
    });
    assert.equal(malformed.status, 400);
  });

  await test("the presigned flow round-trips bytes through object storage", async () => {
    const bytes = makeGlb(1024, 21);
    const presign = await request(ownerJar, "/api/files/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "presigned.glb", path: "presigned.glb", size: bytes.length }),
    });
    if (presign.status === 503) {
      console.log("    (skipped: R2 object storage is not configured on this server)");
      return;
    }
    assert.equal(presign.status, 201, JSON.stringify(await json(presign.clone())));
    const { id, uploadUrl, contentType } = await json(presign);
    assert.ok(id && uploadUrl && contentType);
    // The URL grants one key for a few minutes — never credentials.
    assert.ok(!/secret|accesskey|password/i.test(uploadUrl), uploadUrl);

    // Step 2: bytes go directly to R2, exactly like the browser's XHR PUT.
    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: bytes,
    });
    assert.ok(put.ok, `direct PUT to storage failed with ${put.status}`);

    // Another member cannot hijack the reservation — only the starter (or an
    // owner completing their own) may finish it.
    const hijack = await request(memberJar, "/api/files/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    assert.equal(hijack.status, 403);

    const complete = await request(ownerJar, "/api/files/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    assert.equal(complete.status, 201, JSON.stringify(await json(complete.clone())));
    const file = (await json(complete)).file;
    assert.equal(file.name, "presigned.glb");
    assert.equal(file.size, bytes.length);
    assert.equal(file.uploaderName, OWNER.username);

    // The committed bytes are really there, for every member.
    const raw = await request(memberJar, `/api/files/${file.id}/raw`);
    assert.equal(raw.status, 200);
    assert.equal(Buffer.from(await raw.arrayBuffer()).equals(bytes), true);

    // Completion is idempotent: a retried complete returns the same file.
    const retry = await request(ownerJar, "/api/files/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    assert.equal(retry.status, 201);

    await request(ownerJar, `/api/files/${file.id}`, { method: "DELETE" });
  });

  await test("completing without uploading any bytes is rejected cleanly", async () => {
    const presign = await request(ownerJar, "/api/files/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ghost.glb", path: "ghost.glb", size: 512 }),
    });
    if (presign.status === 503) {
      console.log("    (skipped: R2 object storage is not configured on this server)");
      return;
    }
    assert.equal(presign.status, 201);
    const { id } = await json(presign);

    // No PUT happened: completion must fail and release the reservation.
    const complete = await request(ownerJar, "/api/files/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    assert.equal(complete.status, 400);
    assert.match((await json(complete)).error, /no bytes/i);
  });

  section("Storage quota");
  const stats = await json(await request(ownerJar, "/api/stats"));
  if (stats.quotaBytes) {
    await test(`an upload that would exceed LIBRARY_QUOTA_BYTES (${stats.quotaBytes}) is rejected with 413`, async () => {
      const overshoot = stats.quotaBytes - stats.totalBytes + 1024;
      assert.ok(overshoot > 0, "test fixture assumes there is some free space");
      const { response, body } = await upload(ownerJar, {
        name: "over-quota.glb",
        bytes: Buffer.alloc(overshoot, 8),
      });
      assert.equal(response.status, 413, JSON.stringify(body));
      assert.match(body.error, /limit/i);
    });

    await test("the usage meter matches the sum of the stored files", async () => {
      const after = await json(await request(ownerJar, "/api/stats"));
      const library = await json(await request(ownerJar, "/api/files"));
      const sum = library.files.reduce((total, file) => total + file.size, 0);
      assert.equal(after.totalBytes, sum);
      assert.equal(after.fileCount, library.files.length);
    });
  } else {
    console.log("  (skipped: LIBRARY_QUOTA_BYTES is not configured on this server)");
  }

  section("Password changes revoke sessions");
  await test("owner resetting a password invalidates that user's sessions", async () => {
    const response = await request(ownerJar, `/api/users/${memberRow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "member-reset-9999" }),
    });
    assert.equal(response.status, 200, JSON.stringify(await json(response.clone())));
    const body = await json(response);
    assert.ok(body.sessionsRevoked >= 1, `expected >=1 revoked session, got ${body.sessionsRevoked}`);

    const stale = await request(memberJar, "/api/files");
    assert.equal(stale.status, 401, "the old session cookie must stop working immediately");
  });

  await test("the member can log in with the new password", async () => {
    const { response, jar } = await login({ username: MEMBER.username, password: "member-reset-9999" });
    assert.equal(response.status, 200);
    memberJar.load(jar.serialize());
    MEMBER.password = "member-reset-9999";
  });

  await test("a user changing their own password is signed out and must log in again", async () => {
    const response = await request(memberJar, "/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: MEMBER.password, newPassword: "member-final-2024" }),
    });
    assert.equal(response.status, 200, JSON.stringify(await json(response.clone())));
    const body = await json(response);
    assert.equal(body.reauthRequired, true);

    const stale = await request(memberJar, "/api/files");
    assert.equal(stale.status, 401);
  });

  await test("changing a password requires the current one", async () => {
    const { jar } = await login({ username: MEMBER.username, password: "member-final-2024" });
    const response = await request(jar, "/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: "definitely-wrong", newPassword: "another-password-1" }),
    });
    assert.equal(response.status, 403);

    // Put the working session back for phase 2.
    const fresh = await login({ username: MEMBER.username, password: "member-final-2024" });
    assert.equal(fresh.response.status, 200);
    memberJar.load(fresh.jar.serialize());
  });

  MEMBER.password = "member-final-2024";

  section("Login brute-force protection");
  await test("repeated bad logins are throttled with 429 + Retry-After", async () => {
    let sawLimited = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "brute-force-target", password: `guess-${attempt}` }),
      });
      if (response.status === 429) {
        sawLimited = response;
        break;
      }
      assert.equal(response.status, 401, `unexpected status ${response.status}`);
    }
    assert.ok(sawLimited, "12 consecutive failures were all accepted — no throttling");
    assert.ok(Number(sawLimited.headers.get("retry-after")) > 0);
  });

  await test("throttling one account does not lock out a valid login elsewhere", async () => {
    const { response } = await login(OWNER);
    assert.equal(response.status, 200);
  });

  section("Session lifecycle");
  const disposable = newJar();
  await test("logout destroys the server-side session immediately", async () => {
    const loggedIn = await login(OWNER, disposable);
    assert.equal(loggedIn.response.status, 200);
    assert.equal((await request(disposable, "/api/files")).status, 200);

    const out = await request(disposable, "/api/auth/logout", { method: "POST" });
    assert.equal(out.status, 200);
    assert.equal((await request(disposable, "/api/files")).status, 401);
  });

  ownerStream.close();
  memberStream.close();

  state.member = MEMBER;
  state.cookies.owner = ownerJar.serialize();
  state.cookies.member = memberJar.serialize();
  state.library = (await json(await request(ownerJar, "/api/files"))).files;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`\n\x1b[2mState written to ${STATE_FILE} — restart the server, then run --phase=2\x1b[0m`);
  return state;
}

/* --------------------------------------------------------------- phase 2 */

async function phase2() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  assert.equal(state.baseUrl, BASE, `state file was written for ${state.baseUrl}`);

  section("After a server restart");

  const ownerJar = newJar();
  ownerJar.load(state.cookies.owner);
  const memberJar = newJar();
  memberJar.load(state.cookies.member);

  await test("existing sessions survive a server restart", async () => {
    const response = await request(ownerJar, "/api/auth/me");
    assert.equal(response.status, 200, "the session cookie should still be valid after a restart");
  });

  await test("the library (metadata) survives a restart", async () => {
    const body = await json(await request(ownerJar, "/api/files"));
    const names = body.files.map((f) => f.name).sort();
    for (const expected of state.library.map((f) => f.name)) {
      assert.ok(names.includes(expected), `${expected} disappeared after the restart`);
    }
  });

  await test("uploaded bytes survive a restart", async () => {
    const response = await request(memberJar, `/api/files/${state.files.barrel.id}/raw`);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, state.files.barrel.size);
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "glTF");
  });

  await test("thumbnails survive a restart and keep their content type", async () => {
    const response = await request(memberJar, `/api/files/${state.files.barrel.id}/thumbnail`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.toString("base64"), state.thumbnails.barrel.sha, "thumbnail bytes changed across the restart");
  });

  await test("live sync still works after the restart", async () => {
    const stream = await openEventStream(memberJar);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(stream.status, 200);

    const { response, body } = await upload(ownerJar, {
      name: "after-restart.glb",
      bytes: makeGlb(700, 11),
    });
    assert.equal(response.status, 201, JSON.stringify(body));
    await stream.waitFor("file-added", (d) => d.name === "after-restart.glb");

    // Clean up after ourselves.
    await request(ownerJar, `/api/files/${body.file.id}`, { method: "DELETE" });
    stream.close();
  });

  await test("logout/login preserves the library", async () => {
    const fresh = newJar();
    const { response } = await login(state.member, fresh);
    assert.equal(response.status, 200);
    const body = await json(await request(fresh, "/api/files"));
    assert.equal(body.files.length, state.library.length);
  });

  await test("glTF companion files still resolve after a restart", async () => {
    const library = (await json(await request(ownerJar, "/api/files"))).files;
    const model = library.find((f) => f.name === "vintage-barrel.gltf");
    assert.ok(model, "the .gltf is still in the library");
    const texture = findReferencedFile(library, model, "textures/vintage-barrel-albedo.png");
    assert.ok(texture, "the texture reference still resolves");
    const response = await request(memberJar, `/api/files/${texture.id}/raw`);
    assert.equal(response.status, 200);
  });

  return state;
}

/* -------------------------------------------------------------------- run */

(async () => {
  console.log(`\x1b[1mModel Vault end-to-end test\x1b[0m — ${BASE} (phase ${PHASE})`);
  try {
    if (PHASE === 1) await phase1();
    else if (PHASE === 2) await phase2();
    else throw new Error(`unknown phase ${PHASE}`);
  } catch (err) {
    results.push({ name: `phase ${PHASE} aborted`, ok: false, error: err.message });
    console.log(`\n\x1b[31m✗ phase ${PHASE} aborted:\x1b[0m ${err.message}`);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n\x1b[1m${passed}/${results.length} checks passed\x1b[0m`);
  for (const failure of failed) console.log(`  \x1b[31m✗\x1b[0m ${failure.name}: ${failure.error}`);
  process.exit(failed.length ? 1 : 0);
})();
