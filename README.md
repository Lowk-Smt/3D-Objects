# Model Vault — Shared 3D Library

Model Vault is a private, shared 3D model library for a small group of people.
Anyone in the workspace can upload `.glb`/`.gltf`/`.obj`/`.stl`/`.fbx`/`.ply`
(and any other file type), preview it in an in-browser Three.js viewer,
optionally optimize GLBs before sharing them, and see everyone else's
uploads/renames/deletes/thumbnails appear live — no manual refresh required.

It is deliberately a *small* app: one Next.js server process, one Postgres
database, one storage directory. Everything below is written for that
deployment shape, and the few places where that assumption shows are called out
under [Limitations](#limitations).

---

## Contents

- [Quick start](#quick-start)
- [Sharing a library with a few people](#sharing-a-library-with-a-few-people)
- [The viewer](#the-viewer)
- [Configuration](#configuration)
- [Deploying it later](#deploying-it-later)
- [Project structure](#project-structure)
- [The library model](#the-library-model)
- [Storage consistency](#storage-consistency)
- [Thumbnails](#thumbnails)
- [Optimization](#optimization)
- [glTF companion files](#gltf-companion-files)
- [Real-time sync](#real-time-sync)
- [Permissions](#permissions)
- [Security](#security)
- [Error handling](#error-handling)
- [Tests](#tests)
- [Limitations](#limitations)

---

## Quick start

```bash
cp .env.example .env          # then edit DATABASE_URL
npm install
npm run db:push               # create/upgrade the tables (drizzle-kit push)
npm run build
npm run start                 # or: npm run dev
```

Open `http://localhost:3000`. With no accounts in the database the app shows
**"Create the owner account"** — the first account created is the workspace
owner. Afterwards only the owner can invite more members (Members → Invite).

Point every computer/phone at the **same URL** — they all share one Postgres
database and one `STORAGE_DIR`, so they are looking at the same library.

## Sharing a library with a few people

1. **First run**: with no accounts in the database the app shows *"Create the
   owner account"*. Whoever fills that in becomes the workspace **owner**.
2. **Invite people**: owner → **Members** → **Invite a member** → username +
   temporary password. The invitee can't self-register (this is a private
   workspace, not a public site), so share the credentials and the URL
   out-of-band. Tick **Can delete files** per member if they should be able to
   remove things; otherwise they can upload, rename and download only.
3. **Everyone else** opens the same URL, logs in with their own account, and
   sees the same library. There is nothing to sync manually: uploads, renames,
   deletes and new thumbnails are pushed to every open browser tab through
   Server-Sent Events the moment they happen on the server.
4. Anyone can change their own password (header → **Password**), which signs
   that account out of every device it was logged in on.

The last remaining owner cannot be demoted or deleted — there is always
somebody who can administer the workspace.

## The viewer

The Three.js viewer is the original app's viewer, unchanged:

- **Formats**: `.glb`, `.gltf` (with companion `.bin`/textures), `.obj`, `.stl`,
  `.fbx` and `.ply` preview natively. Anything else is stored and downloadable,
  and shows a "can't be previewed" card with a download button instead of
  failing silently.
- **Controls**: OrbitControls, camera auto-framing on load, **Reset view**
  (reframes the selected model), **Wireframe** toggle, and animation playback
  for animated models — every clip in the file plays automatically.
- **Draco / KTX2 / Meshopt compressed models** load through the same three.js
  loaders as before; the decoder wasm/js assets are fetched from the same
  public CDN build as the original file (third-party static decoder assets, not
  backend URLs).
- **Batch operations**: multi-select download and multi-select delete are
  preserved (delete is gated by the same delete permission as a single delete).
  Batch *optimization* is deliberately not implemented — optimizing one GLB at
  a time with a progress bar and a cancel button is the honest version of a
  multi-hundred-MB in-browser WASM transform.

## What changed from the original single-file app

The original app was one static HTML file that kept everything in the browser's
IndexedDB — great for one person, useless for a team, because nothing ever left
the uploader's browser. The UI, the Three.js viewer, the optimization pipeline,
and the search/sort/select behaviour are unchanged; only the storage layer was
replaced with a real backend:

| Concern | Original file | Model Vault |
|---|---|---|
| Source of truth | Browser IndexedDB | PostgreSQL (metadata) + server filesystem (bytes) |
| Multi-user | Not possible | Any number of accounts on one shared library |
| Live updates | None | Server-Sent Events pushed to every open tab |
| Auth | None | Username + password (bcrypt), server-side sessions |
| Permissions | None | Owner / member, per-member delete permission |
| Thumbnails | Local data URL | Generated in the browser, stored on the server, served to everyone |
| Downloads | From a local blob | Streamed from the server with the original filename + MIME type |
| Storage limits | None | `MAX_UPLOAD_MB` per file, optional `LIBRARY_QUOTA_BYTES` for the workspace |

### Why Next.js + Postgres, and SSE rather than WebSockets

Model Vault runs on a platform that provisions a Next.js (App Router) +
PostgreSQL application and validates it with `next build` / `next start`, so the
backend is implemented as Next.js route handlers with Postgres via Drizzle
instead of a separate Python process with SQLite. If you self-host it, the same
architecture works unchanged against any Postgres instance and any platform
that can run `npm run start` behind a reverse proxy.

Real-time sync uses **Server-Sent Events**: Next.js route handlers can return a
long-lived streaming `Response` with no custom server, `EventSource` reconnects
by itself in the browser, and this app only ever needs server→client push. That
keeps the implementation dependency-free and reliable.

## Configuration

Everything is environment-driven — see [`.env.example`](.env.example) for the
full list. The important ones:

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | *(required)* | Postgres connection string. The app refuses to boot without it. |
| `STORAGE_DIR` | `./data` | Where uploaded bytes + thumbnails live. **Must be persistent.** |
| `MAX_UPLOAD_MB` | `300` | Per-file upload limit, enforced server-side. |
| `LIBRARY_QUOTA_BYTES` | *(unset)* | Workspace storage cap. When set, uploads that would exceed it are rejected with 413. |
| `SESSION_TTL_DAYS` | `30` | Login lifetime. |
| `LOGIN_MAX_FAILURES_PER_ACCOUNT` | `8` | Failed logins per account before throttling. |
| `LOGIN_MAX_FAILURES_PER_IP` | `40` | Failed logins per client address before throttling. |
| `TRUST_PROXY` | `false` | Honour `X-Forwarded-For` for rate-limit keys. |
| `PUBLIC_ORIGIN` | *(unset)* | Optional extra allowed origin for the CSRF check when running behind a proxy. |

No secret is hard-coded anywhere. Sessions are opaque 256-bit random tokens
stored in Postgres, so there is deliberately **no session signing secret** to
configure, rotate or leak.

`.env` / `.env.local` are git-ignored; the repo does not ship a `data/`
directory, and `.gitignore` keeps uploaded models out of version control.

## Deploying it later

Nothing hard-codes `localhost`; the frontend only calls relative paths
(`/api/...`), so it works under any domain.

1. Point `DATABASE_URL` at your Postgres and `STORAGE_DIR` at a **persistent
   volume** — the database and the storage directory are the entire state of
   the library. Back up both.
2. `npm run build && npm run start` behind any reverse proxy (nginx, Caddy, a
   VPS, a container platform, …).
3. Set `NODE_ENV=production` so session cookies get the `secure` flag, and
   serve the app over HTTPS.
4. If the proxy rewrites the `Host` header, the CSRF origin check already
   accepts `X-Forwarded-Host` and `PUBLIC_ORIGIN`, so no extra configuration is
   needed; set `TRUST_PROXY=true` if you also want per-IP rate limiting to see
   real client addresses.

## Project structure

```
src/
  app/
    page.tsx                # App shell (markup) + loads /vault/app.js
    layout.tsx
    api/
      auth/                 # status, setup, login, logout, me, password
      users/                # list/invite/update/remove members (owner-only writes)
      files/                # list/upload, [id] rename/delete, raw, download, thumbnail
      files/batch-delete/   # multi-select delete
      stats/                # storage usage for the sidebar meter
      events/               # Server-Sent Events stream (live sync)
      health/
  db/
    schema.ts               # users, sessions, files
    index.ts
  lib/
    auth.ts                 # sessions, password hashing, CSRF, permissions, revocation
    config.ts               # env-driven configuration (storage, limits, quota, rate limits)
    storage.ts              # every filesystem operation + DB/disk consistency + quota
    files.ts                # filename sanitizing, MIME map, image sniffing, wire format
    rate-limit.ts           # in-memory login brute-force protection
    serve-file.ts           # streaming responses with correct headers
    events.ts               # in-process pub/sub for SSE
    api-helpers.ts          # ApiError + one error-to-response mapping
public/vault/
  styles.css                # the original dark "Model Vault" visual design
  shared.js                 # pure helpers shared by the browser app and the tests
  app.js                    # frontend: auth UI, viewer, optimizer, live sync
scripts/
  e2e-test.mjs              # end-to-end acceptance test (two phases)
tests/
  paths.test.mjs            # glTF path/MIME/download-name resolution
  server-helpers.test.mjs   # server-side sanitizers, sniffers, wire format
data/                       # created automatically, never committed
  files/<id>/<name>         # uploaded bytes, one directory per file id
  thumbnails/<id>.<ext>     # generated thumbnails
  trash/                    # transient: bytes parked during a delete
```

The frontend is still a plain ES module (`public/vault/app.js`) loaded through a
native `<script type="module">` + import map, exactly like the original file.
That is what lets the Three.js viewer, the DRACO/KTX2/Meshopt loaders and the
`@gltf-transform` pipeline stay unchanged instead of being rewritten into a
bundled React component. Pure helpers (path normalization, companion-file
resolution, MIME/ext lookup, download names) live in `public/vault/shared.js`
so the browser and the Node test suite run the *same* code.

## The library model

- **Postgres is the source of truth** for metadata: name, extension, MIME type,
  size, logical relative path, uploader, timestamps, thumbnail info.
- **The filesystem is the source of truth for bytes**, always at
  `STORAGE_DIR/files/<server-generated-uuid>/<sanitized-name>`. A client-supplied
  filename or path never decides where bytes land.
- Every page load and every SSE (re)connect re-reads the full list from
  `GET /api/files`. Nothing is cached in `localStorage`, IndexedDB or
  `BroadcastChannel`; a browser that has been offline simply resyncs.
- A rename updates the metadata (and therefore the download filename and the
  path used to resolve glTF companions) but never renames the bytes on disk, so
  a rename cannot break anything and cannot be used to escape the storage root.

## Storage consistency

Uploads and deletes are ordered so the database and the disk can never disagree:

**Upload**
1. The session and CSRF token are checked.
2. Size is validated against `MAX_UPLOAD_MB`, then quota bytes are *reserved*
   (an in-process reservation, so two simultaneous uploads cannot both pass the
   quota check with the same free space).
3. Bytes are written to `files/<uuid>/<name>`, and the file size is verified
   after the write.
4. Only then is the row inserted. If the insert fails, the bytes are deleted
   and the caller gets a clear 500 — **no orphaned files, no phantom rows**.

**Delete**
1. The bytes (and any thumbnail) are moved to `STORAGE_DIR/trash/` with an
   atomic `rename` — nothing is unlinked yet.
2. The row is deleted.
3. The trashed bytes are purged. If a purge fails, the delete still succeeded
   and the leftovers are swept on the next server start.
4. If step 2 fails, the bytes are renamed back and the request fails with
   "nothing was removed" — never a half-deleted file.

Failures are never swallowed: storage errors, database errors and cleanup
problems are logged server-side and surfaced as explicit HTTP errors.

## Thumbnails

The viewer renders a thumbnail in the browser (same render-to-texture approach
as the original app) and uploads it so every member — and the uploader after a
reload or a server restart — sees it.

- **Server-side authorization**: only the member who uploaded a file, or an
  owner, may create or replace its thumbnail. Anyone else gets `403`, whether or
  not the UI showed them the button.
- **The bytes decide the format**: the server sniffs the decoded image (JPEG,
  PNG, WebP, GIF) and stores it as `<id>.<real-ext>` with the matching
  `Content-Type`. A PNG is never written to `<id>.jpg` and never served as
  `image/jpeg`; a data URL that lies about its type is corrected and logged.
- **Content that is not an image is rejected** (`415`) before it reaches disk.
- Legacy rows created before this rule existed are repaired on read: a PNG
  found in `<id>.jpg` is renamed to `<id>.png`, the DB metadata is corrected,
  and it is served as `image/png`.
- Thumbnails are served only to authenticated members, with
  `X-Content-Type-Options: nosniff` and `Cache-Control: private`.
- Writing is atomic (temp file + rename) and the stale file for a different
  extension is removed afterwards, so a JPEG→PNG change never leaves both.

## Optimization

Optimizing is optional and always runs **in your browser** before upload
(`Optimize this file?` → High / Balanced / Smallest). The exact same
`@gltf-transform` pipeline is used as in the original app: simplify → texture
resize → prune → dedup, with a progress bar and a cancel button.

What is actually verified to happen to the written file (checked against
`@gltf-transform/core@4.5.0` and asserted by the E2E/model checks):

- **Names are preserved.** Nodes, meshes, materials, textures and scenes that
  have names keep them byte-for-byte — `dedup()` does *not* merge differently
  named properties, and nothing is renamed to `part_0` / `mesh_0`. Only a
  property that was saved **without any name** gets a neutral placeholder so it
  stays identifiable.
- **Tool/export metadata does not survive**: every `extras` block on the asset,
  root, nodes, meshes, materials, textures and scenes is dropped from the output.
- **The file is re-tagged**: glTF's `asset.generator` always exists in a written
  file (glTF-Transform's writer emits one unconditionally, and its reader never
  loads the original exporter's string). The optimizer therefore *sets* it to
  `Model Vault 1.0 (glTF-Transform)` instead of pretending it can be deleted.
- **Your original file is never touched.** Only the chosen result is uploaded;
  the local file on disk is untouched. If optimizing would make a file *larger*,
  the original is uploaded instead and you are told why.

## glTF companion files

`.gltf` files reference buffers (`barrel.bin`) and textures
(`textures/albedo.png`) by relative path. Model Vault preserves that structure:

- When files are added with drag & drop, folders are walked (not flattened), so
  a dropped `scene/` folder keeps paths like `scene/textures/albedo.png`; the
  `path` column stores them verbatim (sanitized against `..` escapes).
- A `.gltf` is loaded by resolving each reference against the *shared library*:
  exact relative path → exact file name → unique basename. If two files share a
  basename the app refuses to guess and tells you to keep assets together.
- Companion files remain ordinary library entries with their own rows and bytes
  — the same record-per-file behaviour as before, so they can be downloaded,
  renamed or deleted individually.
- The resolution algorithm lives in `public/vault/shared.js` and is unit tested
  (`tests/paths.test.mjs`); the E2E test uploads a real `.gltf` + `.bin` +
  texture bundle and asserts every reference resolves to the right file id.

## Real-time sync

The server is the source of truth; the event stream is only a notification
channel.

- `GET /api/events` is an authenticated Server-Sent Events stream. Uploads,
  renames, deletes, thumbnail changes and member changes are broadcast to every
  connected browser, which applies them to the list immediately.
- Every (re)connect re-fetches the full library, so events missed while a tab
  was closed are picked up on the next connection.
- A heartbeat every 25 s both keeps proxies from closing the stream and
  re-checks session liveness: if the account's sessions were revoked (password
  changed, account removed), the stream sends `session-expired` and closes, and
  the tab returns to the login screen.
- If the browser cannot reach the server, the header shows the connection state
  and the tab retries automatically (SSE reconnect, or an explicit re-check when
  the browser gives up on the stream).

There is no polling, no `localStorage` state and no fake refresh anywhere.

## Permissions

| Action | Owner | Member |
|---|---|---|
| Upload / preview / download / rename | ✅ | ✅ |
| Delete single files / batch delete | ✅ | only with "Can delete files" |
| Replace a file's thumbnail | ✅ (any file) | only files they uploaded |
| Invite / remove members, change roles or delete permission | ✅ | ❌ |
| Change own password | ✅ | ✅ |

The last remaining owner can neither be demoted nor deleted, so the workspace
always keeps an administrator. A member cannot change another member's password
or role — the API answers `403`.

The server checks the session on every request and determines the acting user
from the session — never from a value in the request body. Uploader ids,
usernames, file ids and paths sent by the browser are treated as untrusted
input. The UI's hidden/disabled controls are convenience only.

## Security

- **Passwords**: bcrypt (`bcryptjs`, cost 12); plaintext is never stored or
  logged. A static dummy hash is compared for unknown usernames to avoid
  user enumeration via timing.
- **Sessions**: opaque 256-bit random ids in Postgres behind an `httpOnly`,
  `SameSite=Lax`, `Secure`-in-production cookie. Logout deletes the row.
  Changing a password (self-service or an owner reset) revokes **every** session
  for that account, including open SSE streams. Expired rows are purged on login.
- **CSRF**: a double-submit token (`mv_csrf` cookie, echoed in the
  `x-csrf-token` header) is required for every state-changing request, plus an
  `Origin` vs `Host`/`X-Forwarded-Host`/`PUBLIC_ORIGIN` check as defence in
  depth. The check works behind a reverse proxy that rewrites `Host`.
- **Login brute force**: failed logins are counted per account and per client
  address in memory (see `LOGIN_MAX_FAILURES_*`); past the limit the endpoint
  answers `429` with `Retry-After` and does no password work. A successful login
  clears that account's counters. No database table, no external service.
- **Path traversal**: file ids must match `^[A-Za-z0-9_-]{1,64}$`, stored names
  are sanitized and re-sanitized when a path is built, and every path is
  resolved under `STORAGE_DIR/files/<id>/`. Client-supplied paths are only used
  as a *logical* string for glTF resolution, with `..` segments removed.
- **Uploads**: `MAX_UPLOAD_MB` is enforced from `Content-Length` and from the
  received bytes; empty files, missing fields and oversized payloads get
  explicit `400`/`413` responses. Quota enforcement happens before the bytes are
  accepted.
- **Serving user content**: downloads are streamed with the stored MIME type,
  an RFC 5987 `Content-Disposition`, `X-Content-Type-Options: nosniff` and a
  `default-src 'none'; sandbox` CSP; responses are `private, no-cache`.
- **Error leakage**: unexpected exceptions are logged server-side and returned
  as a generic 500; expected failures carry a specific, user-readable message.
  The users endpoint never returns password hashes.

## Error handling

| Situation | What the user sees |
|---|---|
| Wrong credentials | `401 Invalid username or password.` |
| Too many attempts | `429 Too many failed login attempts… Try again in N minutes.` (+ `Retry-After`) |
| Expired/revoked session | `401`, the tab returns to the login screen, live stream closed |
| Missing/invalid CSRF | `403 Missing or invalid CSRF token.` |
| Cross-origin state change | `403 Cross-origin request blocked.` |
| Not allowed (delete/thumbnail/members) | `403` with the specific rule that blocked it |
| Oversized upload | `413` naming the configured limit |
| Over quota | `413` naming the limit, current usage and the upload size |
| Empty/missing file | `400 The uploaded file is empty.` / `No file was provided.` |
| Unknown or deleted id | `404 File not found. It may have been deleted…` |
| Missing bytes on disk | `404 This file's data is missing from storage on the server.` |
| Corrupt/unsupported model | stored normally; the viewer shows a card explaining it can't be previewed + a download button |
| Invalid `.gltf` JSON | `"<name>" is not valid glTF JSON.` |
| Missing `.gltf` companion | `Missing companion file "x.bin". Add that file to the library along with …` |
| Ambiguous companion match | explains that several files match and to keep assets together |
| Database unavailable | `503 The database is unavailable…` |
| Filesystem write/delete failure | `500` naming the failure, with a guarantee that nothing was half-saved |
| Server restart / dropped SSE | connection indicator shows "Reconnecting…", then reconnects and re-syncs |
| Duplicate filename | both files are kept as separate entries (uploader is shown); the UI reports skipped duplicates of the *same name and size* |

## Tests

```bash
npm run typecheck        # tsc --noEmit
npm run lint             # eslint .
npm test                 # unit tests (Node's built-in runner, no extra deps)
npm run build            # production build

# end-to-end against a running server (fresh database for phase 1):
E2E_MAX_UPLOAD_MB=5 npm run test:e2e -- --phase=1
# restart the server, then:
npm run test:e2e -- --phase=2
```

- `tests/paths.test.mjs` covers path normalization, glTF companion resolution
  (exact/relative/ambiguous/missing), MIME + extension lookup and download-name
  generation.
- `tests/optimizer.test.mjs` runs the *same* `@gltf-transform` pipeline the
  browser uses (the devDependency must match the version pinned in the import
  map, and the test fails if it drifts) and asserts what the optimizer promises:
  existing node/mesh/material/texture/scene names survive, only nameless
  properties get a placeholder, every `extras` block is really gone from the
  written GLB, the original exporter's `generator` string does not survive, and
  `dedup()` does not merge differently named properties.
- `tests/server-helpers.test.mjs` covers the server-side sanitizers,
  path-traversal neutralization, id validation, image sniffing and data-URL
  validation, and asserts the client and server MIME tables stay identical.
- `scripts/e2e-test.mjs` drives the real HTTP API with two real accounts: setup
  race, CSRF/origin, invites, uploads, SSE delivery in both directions, preview
  and download bytes, filenames/MIME types, thumbnails (including a lying data
  URL and a non-image payload), rename/delete sync, authorization failures,
  quota, rate limiting, password-change revocation, logout, and — in phase 2 —
  persistence of sessions, metadata, bytes, thumbnails and companion resolution
  across a server restart.

## Limitations

- **Single-process by design.** The SSE fan-out and the login rate limiter keep
  their state in process memory. That is correct and sufficient for one server
  process (the way this app is meant to run). If you ever run several instances
  behind a load balancer you would need shared pub/sub (e.g. Postgres
  `LISTEN`/`NOTIFY`) and a shared rate-limit store.
- **Large uploads are buffered in memory once** while the multipart body is
  parsed (Node's `request.formData()`), so a multi-GB file needs matched RAM.
  `MAX_UPLOAD_MB` is the guard rail; chunked uploads would be the next step.
- **No public sign-up** — by design. Only an owner can create accounts.
- **Optimization is GLB-only and client-side** (as in the original app). If the
  optimized result would be larger than the original, the original is uploaded.
- **`.obj`/`.mtl`, `.stl`, `.ply`, `.fbx`** have no companion-file resolution
  (only `.gltf` does), matching the original behaviour.
- **Thumbnails are generated lazily**: a file has no thumbnail until its
  uploader (or an owner) previews it once.
