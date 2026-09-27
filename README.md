# Model Vault — Shared 3D Library

Model Vault is a private, shared 3D model library for a small group of people.
Anyone in the workspace can upload `.glb`/`.gltf`/`.obj`/`.stl`/`.fbx`/`.ply`
(and any other file type), preview it in an in-browser Three.js viewer,
optionally optimize GLBs before sharing them, and see everyone else's
uploads/renames/deletes/thumbnails appear live — no manual refresh required.

It is deliberately a *small* app with a boring, durable shape: one Next.js app,
one Postgres database for metadata, one private Backblaze B2 bucket for bytes
(any S3-compatible object store works — B2 is what the deployment instructions
below use). That shape is exactly what the app deploys as — on Vercel, on a VPS,
or on your laptop — and the few places where the deployment model shows are
called out under [Limitations](#limitations).

```
Browser ──► Next.js (Vercel) ──┬──► PostgreSQL      metadata (users, sessions, files)
                               └──► Backblaze B2    model binaries + thumbnails (private bucket)
```

---

## Contents

- [Quick start](#quick-start)
- [Sharing a library with a few people](#sharing-a-library-with-a-few-people)
- [The viewer](#the-viewer)
- [Configuration](#configuration)
- [Setting up Backblaze B2](#setting-up-backblaze-b2)
- [Deploying on Vercel](#deploying-on-vercel)
- [Local development](#local-development)
- [Project structure](#project-structure)
- [The library model](#the-library-model)
- [Storage architecture](#storage-architecture)
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

You need a Postgres database and a Backblaze B2 bucket (both have free tiers —
see [Setting up Backblaze B2](#setting-up-backblaze-b2)).

```bash
cp .env.example .env          # then set DATABASE_URL + the R2_* variables
npm install
npm run db:push               # create/upgrade the tables (drizzle-kit push)
npm run build
npm run start                 # or: npm run dev
```

Open `http://localhost:3000`. With no accounts in the database the app shows
**"Create the owner account"** — the first account created is the workspace
owner. Afterwards only the owner can invite more members (Members → Invite).

Point every computer/phone at the **same URL** — they all share one Postgres
database and one bucket, so they are looking at the same library.

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
- **Preview loading is direct and deduplicated**: the API answers an
  authorized preview request with a 120-second presigned GET for exactly one
  private object key, and the browser fetches the bytes straight from the
  bucket (no serverless proxy hop for multi-MB models). Repeated or rapid
  clicks share one network request per file, an in-memory LRU cache serves
  files you flip back to, a finished upload previews from the bytes the
  browser already holds (no re-download), and switching models cancels only
  the fetches nobody needs anymore. The concurrency rules are pinned by unit
  tests (`tests/preview-cache.test.mjs`).
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
| Source of truth | Browser IndexedDB | PostgreSQL (metadata) + Backblaze B2 (bytes) |
| Multi-user | Not possible | Any number of accounts on one shared library |
| Live updates | None | Server-Sent Events pushed to every open tab |
| Auth | None | Username + password (bcrypt), server-side sessions |
| Permissions | None | Owner / member, per-member delete permission |
| Thumbnails | Local data URL | Generated in the browser, stored in the bucket, served to everyone |
| Downloads | From a local blob | Streamed from the bucket through the authenticated API with the original filename + MIME type |
| Storage limits | None | `MAX_UPLOAD_MB` per file, optional `LIBRARY_QUOTA_BYTES` for the workspace |

### Why Next.js + Postgres + object storage, and SSE rather than WebSockets

Model Vault is a Next.js (App Router) application: the backend is route handlers
with Postgres via Drizzle for metadata and Backblaze B2 (S3-compatible object
storage) for bytes. That split is what makes the app deployable to Vercel —
serverless functions have no persistent disk, so bytes live in the bucket while
the database stays the source of truth for everything else.

Real-time sync uses **Server-Sent Events**: Next.js route handlers can return a
streaming `Response` with no custom server, `EventSource` reconnects by itself
in the browser, and this app only ever needs server→client push. Cross-instance
fan-out on serverless goes over Postgres `LISTEN`/`NOTIFY` (see
[Real-time sync](#real-time-sync)) — still no extra infrastructure.

## Configuration

Everything is environment-driven — see [`.env.example`](.env.example) for the
full list. The important ones:

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | *(required)* | Postgres connection string. The app refuses to boot without it. |
| `R2_ACCESS_KEY_ID` | *(required)* | S3 access key — a Backblaze B2 application key ID (read/write on the bucket). |
| `R2_SECRET_ACCESS_KEY` | *(required)* | S3 secret — the B2 application key value. Never committed, never sent to the browser. |
| `R2_BUCKET_NAME` | *(required)* | Private bucket for model binaries + thumbnails. |
| `R2_ENDPOINT` | *(required)* | The provider's actual S3-compatible endpoint, no bucket in it — e.g. `https://s3.us-west-004.backblazeb2.com`. |
| `MAX_UPLOAD_MB` | `300` | Per-file upload limit, enforced server-side. |
| `LIBRARY_QUOTA_BYTES` | *(unset)* | Workspace storage cap. When set, uploads that would exceed it are rejected with 413. |
| `PENDING_UPLOAD_TTL_MINUTES` | `30` | How long a presigned upload reservation stays valid. |
| `SESSION_TTL_DAYS` | `30` | Login lifetime. |
| `LOGIN_MAX_FAILURES_PER_ACCOUNT` | `8` | Failed logins per account before throttling. |
| `LOGIN_MAX_FAILURES_PER_IP` | `40` | Failed logins per client address before throttling. |
| `TRUST_PROXY` | `false` | Honour `X-Forwarded-For` for rate-limit keys (`true` recommended on Vercel). |
| `PUBLIC_ORIGIN` | *(unset)* | Optional extra allowed origin for the CSRF check when running behind a proxy. |

No secret is hard-coded anywhere. Sessions are opaque 256-bit random tokens
stored in Postgres, so there is deliberately **no session signing secret** to
configure, rotate or leak.

`.env` / `.env.local` are git-ignored. On Vercel, set variables in the project
settings instead of committing a file.

## Setting up Backblaze B2

Model Vault talks to storage through the standard S3 API, so any
S3-compatible provider works; the steps below use Backblaze B2.

1. **Create the bucket.** In the Backblaze console (**B2 → Buckets → Add a
   Bucket**), pick a name (e.g. `model-vault`) and leave it **private** — do
   *not* enable public access or a custom domain. The app authorizes every
   byte through its own API; the bucket must never be world-readable.
2. **Create an application key.** Go to **App Keys → Add a New Application
   Key** and scope it to that bucket with read/write capability. Copy the
   **keyID** into `R2_ACCESS_KEY_ID` and the **applicationKey** into
   `R2_SECRET_ACCESS_KEY` (the application key value is shown only once). The
   account's *master* application key does not work with the S3-compatible
   API — always use a dedicated application key.
3. **Set the endpoint.** Copy the bucket's **Endpoint** (shown on the bucket
   page, e.g. `s3.us-west-004.backblazeb2.com`) into `R2_ENDPOINT`,
   including the `https://` scheme:

   ```bash
   R2_ENDPOINT=https://s3.us-west-004.backblazeb2.com
   ```

   A B2 account lives in a single region, so all of its buckets share one
   endpoint — copy the value from the console rather than guessing.
4. **Configure CORS** so browsers can `PUT` uploads directly to the bucket.
   Save this as `rules.json` and apply it with the
   [B2 command-line tool](https://www.backblaze.com/docs/cloud-storage-enable-cors-with-the-cli)
   (authorize it with a key that has bucket-write capability, e.g. your
   account's master application key):

   ```json
   [
     {
       "corsRuleName": "model-vault-uploads",
       "allowedOrigins": ["https://your-app.vercel.app", "http://localhost:3000"],
       "allowedHeaders": ["content-type"],
       "allowedOperations": ["s3_put", "s3_get", "s3_head"],
       "exposeHeaders": ["ETag"],
       "maxAgeSeconds": 3600
     }
   ]
   ```

   ```bash
   b2 bucket update --cors-rules "$(cat ./rules.json)" model-vault allPrivate
   ```

   `s3_put` is what permits browser uploads over the S3-compatible API, and
   `s3_get` is what permits preview downloads (authorized short-lived
   presigned GET URLs — see [Storage
   architecture](#storage-architecture)). Previews degrade gracefully: if the
   bucket's CORS rules do not (yet) allow `s3_get`, the browser automatically
   falls back to streaming the bytes through the authenticated Next.js API,
   so the viewer keeps working either way. Replace the origins with your
   Vercel domain and `http://localhost:3000` while developing.

That's it — no lifecycle rules, no public custom domains, no CDN in front of
the bucket. Back up the bucket together with the database: jointly they are
the entire library.

## Deploying on Vercel

Nothing hard-codes `localhost`; the frontend only calls relative paths
(`/api/...`), so it works under any domain.

1. Push this repo to GitHub and **import it in Vercel** (Framework: Next.js,
   everything else default — no build/output overrides needed).
2. Add the **Environment Variables** in the Vercel project settings:
   `DATABASE_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_BUCKET_NAME`, `R2_ENDPOINT`, plus any optional tuning
   (`MAX_UPLOAD_MB`, `LIBRARY_QUOTA_BYTES`, `TRUST_PROXY=true`,
   `PUBLIC_ORIGIN`). Any Postgres provider works (Neon, Supabase, RDS, …).
3. Create the tables once, from your machine with the same `DATABASE_URL`:
   `npm run db:push` (or run it wherever you prefer — it only needs the
   connection string).
4. Deploy. Set the bucket's CORS rules to include your
   `https://<app>.vercel.app` origin (see above), otherwise browser uploads
   are blocked by the browser — the app will say it can't reach storage.
   Without `s3_get` in the CORS rules previews still work, but they stream
   through the API instead of loading directly from the bucket.
5. Open the app and create the owner account.

Notes:

- `NODE_ENV=production` is set by Vercel automatically, so session cookies get
  the `secure` flag and the app is served over HTTPS.
- There is intentionally **no `STORAGE_DIR` anymore**: Vercel functions have no
  persistent disk, uploads never touch the local filesystem, and restarts /
  redeploys lose nothing (bytes are in the bucket, metadata in Postgres).
- Vercel ends long-lived function executions, which is what the SSE stream is —
  the browser reconnects automatically and resyncs, so nothing is lost (see
  [Real-time sync](#real-time-sync) and [Limitations](#limitations)).

## Local development

```bash
cp .env.example .env          # DATABASE_URL + R2_* (a real B2 bucket is fine — free tier)
npm install
npm run db:push
npm run dev
```

Local dev uses the same bucket mechanics as production. If you prefer to
develop fully offline, point `R2_ENDPOINT` at a local S3-compatible server such
as MinIO and create the bucket there; everything else is unchanged.

The single-request multipart endpoint (`POST /api/files`) also works locally
for small files and scripts, but the browser UI always uses the presigned
direct-to-bucket flow, so UI uploads behave identically in dev and on Vercel.

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
      files/presign/        # step 1 of browser uploads: authorize + mint a PUT URL
      files/complete/       # step 3 of browser uploads: verify + commit the row
      files/batch-delete/   # multi-select delete
      stats/                # storage usage for the sidebar meter
      events/               # Server-Sent Events stream (live sync)
      health/
  db/
    schema.ts               # users, sessions, files, pending_uploads
    index.ts
  lib/
    auth.ts                 # sessions, password hashing, CSRF, revocation (+ permission re-exports)
    permissions.ts          # pure permission rules (unit-tested)
    config.ts               # env-driven configuration (limits, quota, sessions, rate limits)
    r2.ts                   # the ONLY R2 client: keys, put/get/delete/presign, error mapping
    storage.ts              # bytes+metadata consistency, presigned flow, thumbnails, quota, sweeps
    uploads.ts              # pure upload validation + quota math (unit-tested)
    files.ts                # filename sanitizing, MIME map, image sniffing, wire format
    rate-limit.ts           # in-memory login brute-force protection
    serve-file.ts           # authenticated streaming responses with correct headers
    events.ts               # in-process bus + Postgres LISTEN/NOTIFY fan-out for SSE
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
  r2-storage.test.mjs       # R2 keys, validation, permissions, quota, rollback, errors
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
  size, logical relative path, uploader, timestamps, thumbnail info — plus the
  short-lived `pending_uploads` reservations described below.
- **The bucket is the source of truth for bytes**, always at
  `files/<server-generated-uuid>/<sanitized-name>` for models and
  `thumbnails/<uuid>.<ext>` for thumbnails. A client-supplied filename or path
  never decides where bytes land.
- Every page load and every SSE (re)connect re-reads the full list from
  `GET /api/files`. Nothing is cached in `localStorage`, IndexedDB or
  `BroadcastChannel`; a browser that has been offline simply resyncs.
- A rename updates the metadata (and therefore the download filename and the
  path used to resolve glTF companions) but never moves the object, so
  a rename cannot break anything and cannot escape the key scope.

## Storage architecture

```
Upload (browser UI):
  browser ──POST /api/files/presign──► Next.js ──► Postgres (pending_uploads reservation)
  browser ──PUT bytes directly to the bucket──► (presigned URL, single key, 5 min, no credentials)
  browser ──POST /api/files/complete──► Next.js verifies object, commits files row

Preview (browser UI):
  browser ──GET /api/files/:id/raw──► Next.js checks session ──► 120 s presigned GET (one key)
  browser ──GET bytes directly from the bucket──► (no credentials; MIME + disposition pinned by the signature)

Download / thumbnail / fallback preview:
  browser ──GET /api/files/:id/{download,thumbnail} or /raw?proxy=1──► Next.js checks session
      ──► streams the private object back with correct MIME + disposition
```

- **The bucket is private and stays private.** Nothing is publicly readable.
  Two authorized shapes exist, both minted only after the session check and
  the database lookup succeed:
  - *Preview downloads* return a presigned GET URL that grants exactly one
    object key for **120 seconds**, with the response's Content-Type and
    inline Content-Disposition baked into the signature. The browser fetches
    bytes straight from the bucket — no credentials or cookies are ever sent
    there — which keeps multi-MB model payloads off the serverless function
    and makes previews noticeably faster. A leaked URL is a nearly worthless
    capability: one key, two minutes, model bytes only (active-content MIME
    types such as HTML/SVG/XML are never presigned — they keep streaming
    through the API route, which adds `Content-Security-Policy: sandbox` +
    `nosniff`; and a network-level failure falls back to the streamed path
    automatically, so buckets without `s3_get` CORS still preview).
  - *Downloads, thumbnails and the fallback path* stream through the
    authenticated API exactly as before, preserving cookie auth, headers and
    behaviour bit-for-bit.
- **Uploads go direct to the bucket** because Vercel caps serverless request
  bodies at a few MB — a 300 MB model could never pass through the function.
  The server still makes every security decision: session, CSRF, size limits,
  sanitizing, quota reservation and the object key are all fixed at presign
  time; the browser only fills the bytes in, and completion verifies
  existence + exact size before the row is committed.
- **A legacy single-request `POST /api/files`** (multipart) is kept for small
  files, scripts and the E2E suite; it buffers, writes to the bucket, verifies
  and commits with the same rollback guarantees. It is subject to the
  platform's request-body cap, so the UI never uses it.
- **No local disk is involved anywhere.** The app writes zero bytes to the
  server filesystem; restarts, redeploys and instance churn lose nothing.

## Storage consistency

Uploads and deletes are ordered so the database and the bucket can never
disagree:

**Presigned upload**
1. The session and CSRF token are checked; the input is validated
   (`MAX_UPLOAD_MB`, name/path lengths, preset whitelist).
2. Quota is checked against Postgres (committed files + live reservations) and
   a `pending_uploads` reservation is inserted — this is the cross-instance
   quota hold.
3. A presigned PUT URL is minted for exactly `files/<uuid>/<sanitized-name>`
   with the file's MIME type baked into the signature. If minting fails, the
   reservation is removed.
4. The browser PUTs the bytes. Completion then HEADs the object (must exist,
   must be exactly the declared size), re-checks quota, and inserts the
   `files` row. If the insert fails, the object is deleted — **no orphaned
   objects, no phantom rows**. Completion is idempotent: retries return the
   committed file.
5. Reservations expire (`PENDING_UPLOAD_TTL_MINUTES`); expiry deletes the
   reservation and any bytes the browser uploaded without completing.

**Delete**
1. The `files` rows are deleted first. If that fails, nothing was removed —
   bytes untouched, request fails loudly.
2. The stored objects (model key + every thumbnail variant) are deleted.
   Object storage has no atomic rename-to-trash, so row-first ordering is the
   recoverable order: a failure here can only leave orphaned *invisible* bytes
   (Postgres is the source of truth), never a visible row pointing at missing
   bytes.
3. Orphaned objects are reclaimed by a best-effort sweep (old objects under
   `files/`/`thumbnails/` referenced by neither table), which runs
   probabilistically after uploads.

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
  PNG, WebP, GIF) and stores it as `thumbnails/<id>.<real-ext>` with the
  matching `Content-Type`. A PNG is never written to `<id>.jpg` and never served
  as `image/jpeg`; a data URL that lies about its type is corrected and logged.
- **Content that is not an image is rejected** (`415`) before it reaches
  storage.
- Mislabelled objects are repaired on read: a PNG found at `<id>.jpg` is copied
  to `<id>.png`, the DB metadata is corrected, and it is served as `image/png`.
- Thumbnails are served only to authenticated members, with
  `X-Content-Type-Options: nosniff` and `Cache-Control: private`.
- Replacing a thumbnail writes the new object and removes stale variants, so a
  JPEG→PNG change never leaves both behind. If the metadata write fails, the
  new object is removed again (rollback).

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
(`textures/albedo.png`) by relative path. Model Vault preserves that structure
in **Postgres logical-path metadata** — there is no physical directory layout
anymore, and resolution never depended on one:

- When files are added with drag & drop, folders are walked (not flattened), so
  a dropped `scene/` folder keeps paths like `scene/textures/albedo.png`; the
  `path` column stores them verbatim (sanitized against `..` escapes).
- A `.gltf` is loaded by resolving each reference against the *shared library*:
  exact relative path → exact file name → unique basename. If two files share a
  basename the app refuses to guess and tells you to keep assets together.
- Companion files remain ordinary library entries with their own rows and
  stored objects — the same record-per-file behaviour as before, so they can be
  downloaded, renamed or deleted individually.
- The resolution algorithm lives in `public/vault/shared.js` and is unit tested
  (`tests/paths.test.mjs`, plus the R2-metadata cases in
  `tests/r2-storage.test.mjs`); the E2E test uploads a real `.gltf` + `.bin` +
  texture bundle and asserts every reference resolves to the right file id.

## Real-time sync

The server is the source of truth; the event stream is only a notification
channel.

- `GET /api/events` is an authenticated Server-Sent Events stream. Uploads,
  renames, deletes, thumbnail changes and member changes are broadcast to every
  connected browser, which applies them to the list immediately.
- Broadcasts fan out **in-process and over Postgres `LISTEN`/`NOTIFY`**, so on
  Vercel an upload handled by one instance still reaches streams held by other
  instances — with no extra infrastructure. If `LISTEN` is unavailable (e.g. a
  transaction-mode pooler), the stream transparently falls back to in-process
  delivery plus the resync below.
- Every (re)connect re-fetches the full library, so events missed while a tab
  was closed — or while a serverless platform ended an idle stream — are picked
  up on the next connection. The server also sends `retry: 5000` so reconnects
  are polite, and the client re-reads the library every 30 s *only while the
  stream is down* as a fallback. Nothing is ever lost; at worst it arrives on
  the next resync.
- A heartbeat every 25 s both keeps proxies from closing the stream and
  re-checks session liveness: if the account's sessions were revoked (password
  changed, account removed), the stream sends `session-expired` and closes, and
  the tab returns to the login screen.
- If the browser cannot reach the server, the header shows the connection state
  and the tab retries automatically (SSE reconnect, or an explicit re-check when
  the browser gives up on the stream).

There is no `localStorage` state and no fake refresh anywhere; the only polling
is the invisible disconnected-fallback described above.

## Permissions

| Action | Owner | Member |
|---|---|---|
| Upload / preview / download / rename | ✅ | ✅ |
| Delete single files / batch delete | ✅ | only with "Can delete files" |
| Replace a file's thumbnail | ✅ (any file) | only files they uploaded |
| Complete a presigned upload | ✅ (own reservations, or any as owner) | only reservations they started |
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
  clears that account's counters. No database table, no external service. (On
  serverless the counters are per-instance — see [Limitations](#limitations).)
- **Object keys**: file ids must match `^[A-Za-z0-9_-]{1,64}$`, stored names are
  sanitized and re-validated when a key is built, and keys are always exactly
  `files/<id>/<name>` or `thumbnails/<id>.<ext>` — client input can never become
  an arbitrary key. Client-supplied paths are only used as a *logical* string
  for glTF resolution, with `..` segments removed.
- **Storage credentials (`R2_*`)** live only in server-side environment
  variables. They are
  never committed (see `.env.example`), never imported by browser code, and
  never appear in presigned URLs (which carry a signature for one key, not the
  keys themselves). The bucket is private; SDK error detail is logged
  server-side and never echoed to clients.
- **Uploads**: `MAX_UPLOAD_MB` is enforced at presign time and at completion
  (declared size vs stored bytes, byte-exact); empty files and oversized
  payloads get explicit `400`/`413` responses. Quota is reserved at presign
  time and re-checked at completion.
- **Serving user content**: downloads, thumbnails and previews of
  active-content MIME types (HTML/SVG/XML) are streamed from the private
  bucket through the authenticated API with the stored MIME type, an RFC 5987
  `Content-Disposition`, `X-Content-Type-Options: nosniff` and a
  `default-src 'none'; sandbox` CSP; responses are `private, no-cache`.
  Previews of inert model/asset MIME types instead return a presigned GET
  that is minted only after authentication + authorization, grants exactly
  one object key, expires in 120 seconds, and pins Content-Type + inline
  disposition in the signature — the bucket never serves active content
  inline and never serves anything without a signature it minted for that
  key.
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
| Not allowed (delete/thumbnail/members/complete) | `403` with the specific rule that blocked it |
| Oversized upload | `413` naming the configured limit |
| Over quota | `413` naming the limit, current usage and the upload size |
| Empty/missing file | `400 The uploaded file is empty.` / `No file was provided.` |
| Unknown or deleted id | `404 File not found. It may have been deleted…` |
| Missing bytes in storage | `404 This file's data is missing from storage on the server.` |
| Expired upload session | `404 This upload session has expired. Please upload the file again.` |
| Completed without bytes | `400 No bytes were received for this upload…` |
| Storage not configured | `503 Object storage is not configured…` (operator action required) |
| Storage temporarily failing | `502 Object storage is temporarily unavailable…` |
| Corrupt/unsupported model | stored normally; the viewer shows a card explaining it can't be previewed + a download button |
| Invalid `.gltf` JSON | `"<name>" is not valid glTF JSON.` |
| Missing `.gltf` companion | `Missing companion file "x.bin". Add that file to the library along with …` |
| Ambiguous companion match | explains that several files match and to keep assets together |
| Database unavailable | `503 The database is unavailable…` |
| Storage write/delete failure | `500` naming the failure, with a guarantee that nothing was half-saved |
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
- `tests/preview-cache.test.mjs` pins the viewer's download concurrency: duplicate opens share one request, a superseded caller's abort never kills a request another caller joined (including the join-before-release ordering `openModel` must use), rapid A→B→A ends on the newest model, failures/aborts are never cached, and the LRU bounds + upload handoff behave.
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
- `tests/r2-storage.test.mjs` covers the object-storage layer without network
  or database access: R2 key generation (including hostile filenames through
  sanitize → key), presign input validation, the permission matrix (delete,
  thumbnail, upload completion), thumbnail keying + repair, R2 error mapping
  (including that messages never carry credentials), quota boundary math, glTF
  resolution from Postgres logical paths, and rollback behaviour (failed writes
  and verification mismatches leave nothing behind; deletes report per-key
  failures and fall back to key-by-key removal).
- `scripts/e2e-test.mjs` drives the real HTTP API with two real accounts: setup
  race, CSRF/origin, invites, uploads, SSE delivery in both directions, preview
  and download bytes, filenames/MIME types, the presigned upload flow
  (validation, direct-to-bucket round-trip, completion auth, idempotent retry,
  complete-without-bytes), thumbnails (including a lying data URL and a
  non-image payload), rename/delete sync, authorization failures, quota, rate
  limiting, password-change revocation, logout, and — in phase 2 — persistence
  of sessions, metadata, bytes, thumbnails and companion resolution across a
  server restart.

## Limitations

- **Serverless request bodies are small.** Vercel caps function request bodies
  at a few MB, so the legacy single-request `POST /api/files` cannot accept
  large files there. The browser UI always uses the presigned direct-to-bucket
  flow instead, which works up to `MAX_UPLOAD_MB` everywhere.
- **SSE streams don't live forever on serverless.** Vercel ends idle function
  executions, so a stream is periodically cut and the browser reconnects (with
  a 5 s back-off) and re-reads the full library — updates are never lost, at
  worst they arrive on the next resync, and a 30 s fallback poll covers the
  client while disconnected. Cross-instance delivery uses Postgres
  `LISTEN`/`NOTIFY`; transaction-mode poolers don't support `LISTEN`, in which
  case delivery degrades gracefully to in-process events plus the resync.
- **Login rate limiting is per-instance on serverless.** Each instance keeps
  its own counters, so a distributed guessing attack is throttled less
  strictly than on a single server. The per-account limit still bites as soon
  as attempts concentrate, and bcrypt cost 12 keeps each guess expensive — but
  treat the limiter as mitigation, not a vault door, and use strong passwords.
- **No public sign-up** — by design. Only an owner can create accounts.
- **Optimization is GLB-only and client-side** (as in the original app). If the
  optimized result would be larger than the original, the original is uploaded.
- **`.obj`/`.mtl`, `.stl`, `.ply`, `.fbx`** have no companion-file resolution
  (only `.gltf` does), matching the original behaviour.
- **Thumbnails are generated lazily**: a file has no thumbnail until its
  uploader (or an owner) previews it once.
