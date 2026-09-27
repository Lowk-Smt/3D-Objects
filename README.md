# Model Vault — Shared 3D Library

Model Vault is a private, shared 3D model library for a small team. Anyone in
the workspace can upload `.glb`/`.gltf`/`.obj`/`.stl`/`.fbx`/`.ply` (and any
other file type), preview it in an in-browser Three.js viewer, optimize GLBs
before sharing them, and see everyone else's uploads/renames/deletes update
live — no manual refresh required.

## What changed from the original single-file app

The original app was a single static HTML file that stored everything in the
browser's IndexedDB — great for one person, useless for a team, since nothing
left the uploader's browser.

This version keeps the exact same UI, the same Three.js viewer, the same
client-side GLB optimization pipeline, and the same search/sort/select
behavior — but replaces the local-only storage layer with a **real backend**:

| Concern | Before | Now |
|---|---|---|
| Source of truth | Browser IndexedDB | PostgreSQL (metadata) + server filesystem (binaries) |
| Multi-user | Not possible | Any number of accounts, shared library |
| Real-time updates | N/A | Server-Sent Events (SSE) pushed to every connected browser |
| Auth | None | Username/password, bcrypt-hashed, server-side sessions |
| Permissions | None | Owner / Member roles, per-member delete permission |
| Thumbnails | Stored as a local data: URL | Rendered client-side, uploaded to the server, served to everyone |
| Downloads | From local blob | Streamed from the server with the original filename + correct MIME type |

### Why this stack instead of the requested FastAPI/SQLite

This project runs inside a platform that provisions a **Next.js (App
Router) + PostgreSQL** application and validates it with `next build` /
`next start`. There is no ability to run a separate Python process
alongside it in this environment, so the "backend" described in the brief
was implemented as **Next.js Route Handlers** instead of FastAPI, and
**PostgreSQL via Drizzle ORM** instead of SQLite. Every other requirement
(hashed passwords, server-side sessions, permissions, filesystem-based
binary storage, real-time sync, path-traversal protection, CSRF
protection, etc.) is implemented exactly as specified — only the specific
web framework/database engine differ from the suggested default, and both
are just as simple to self-host. If you deploy this yourself outside of
this platform, the same architecture works unchanged with any Postgres
instance (local, Docker, or managed).

Real-time sync uses **Server-Sent Events** rather than raw WebSockets.
Next.js Route Handlers can return a long-lived streaming `Response`
natively (no custom server required), `EventSource` reconnects
automatically in the browser, and this app only ever needs server → client
push (uploads/deletes/renames), never client → server messaging over the
socket. This keeps the implementation dependency-free and reliable.

## Project structure

```
model-vault/
  src/
    app/
      page.tsx                # Renders the app shell + loads /vault/app.js
      layout.tsx
      api/
        auth/                 # status, setup, login, logout, me
        users/                # list/invite/update/remove members (owner-only writes)
        files/                # list/upload, [id] rename/delete, raw, download, thumbnail
        files/batch-delete/   # multi-select delete
        stats/                # storage usage for the sidebar meter
        events/                # Server-Sent Events stream (real-time sync)
        health/
    db/
      schema.ts                # users, sessions, files (Drizzle/Postgres)
      index.ts
    lib/
      auth.ts                  # sessions, password hashing, CSRF, permissions
      config.ts                # storage dir / upload limits / env config
      events.ts                # in-process pub/sub for SSE
      files.ts                 # filename sanitizing, MIME map
      serve-file.ts             # streams files with correct headers
      api-helpers.ts
  public/
    vault/
      styles.css                # the original dark "Model Vault" visual design
      app.js                    # the frontend app: auth UI, viewer, optimizer, sync
  data/                         # created automatically — never commit this
    files/<id>/<name>            # uploaded binaries, one folder per file id
    thumbnails/<id>.jpg          # generated thumbnails
  drizzle.config.json
  .env
```

The frontend is intentionally still a plain JS module (`public/vault/app.js`)
loaded via a native `<script type="module">` + import map, exactly like the
original file — this let us reuse the Three.js viewer, DRACO/KTX2/Meshopt
loaders, and the `@gltf-transform` optimization pipeline essentially
unchanged, instead of rewriting them into a bundled React component.

## Running locally

1. Make sure PostgreSQL is running and `.env` has a valid `DATABASE_URL`.
2. Install dependencies: `npm install`
3. Push the schema: `npx drizzle-kit push`
4. `npm run build && npm run start` (or `npm run dev` while developing)
5. Open `http://localhost:3000`

On first load, since no accounts exist yet, you'll see **"Create the owner
account"**. Whoever fills this in becomes the workspace owner.

### Creating the first owner account

Just open the app in a browser — if the library has no users yet, it shows
the setup screen automatically. Pick a username and a password (min 8
characters) and submit. That account is the **owner** and can invite
everyone else.

### Adding friends / teammates

As the owner, click **Members** in the header → **Invite a member** → set a
username + temporary password (they can't self-register; only an owner can
create accounts, since this is a private workspace, not a public site).
Share the username/password with your friend out-of-band (chat, etc.) and
tell them the URL of your server. They can change their behavior via the
member's "Can delete files" checkbox at any time.

### How two computers connect to the same server

Point both browsers at the **same URL** — e.g. `http://<your-machine-ip>:3000`
or a deployed domain. Both browsers log in (with their own accounts) against
the same Next.js server and the same Postgres database/`data/` folder, so
they're looking at the same shared library. There is nothing to "sync"
manually — uploads/renames/deletes are pushed to every open browser tab over
Server-Sent Events the moment they happen on the server.

## Deploying it later

Nothing in the code hard-codes `localhost`:

- The frontend only ever calls **relative** paths (`/api/...`), so it works
  under any domain you deploy to.
- Configure via environment variables (see `.env`):
  - `DATABASE_URL` — your Postgres connection string.
  - `STORAGE_DIR` — where uploaded files/thumbnails are written (defaults to
    `./data`). Point this at a persistent volume/disk.
  - `MAX_UPLOAD_MB` — per-file upload limit (default 300MB).
  - `SESSION_TTL_DAYS` — how long a login stays valid (default 30 days).
  - `LIBRARY_QUOTA_BYTES` — optional soft cap shown in the storage meter.
- Cookies are marked `secure` automatically when `NODE_ENV=production`, so
  deploy behind HTTPS in production (required for cookies to work over the
  public internet safely).
- `npm run build && npm run start` behind any reverse proxy (nginx, Caddy,
  Fly.io, Render, a VPS, etc.) works unmodified. Just make sure `STORAGE_DIR`
  points at a disk that persists across deploys/restarts.

## Security

- Passwords are hashed with **bcrypt** (`bcryptjs`, 12 rounds) — plaintext
  passwords are never stored or logged.
- Sessions are opaque random tokens stored server-side in Postgres
  (httpOnly, `sameSite=lax`, `secure` in production) — not JWTs, so they can
  be revoked instantly (e.g. on logout) and can't be forged or decoded by
  the client.
- CSRF protection uses the double-submit pattern: a second, non-httpOnly
  cookie carries a CSRF token that the frontend must echo back as an
  `x-csrf-token` header on every state-changing request, plus an
  `Origin`/`Host` header check as defense in depth.
- Every file/user API route re-checks the session and permissions
  server-side — the frontend's UI hints (disabled buttons, hidden actions)
  are only a UX convenience, never the actual enforcement.
- Uploaded binaries are always written under `STORAGE_DIR/files/<generated-id>/`
  — the on-disk filename is derived from a fresh UUID directory, never from a
  client-controlled path, so path traversal via a crafted filename is not
  possible. Display names are still sanitized before being used in the
  `Content-Disposition` header.
- Upload size is capped (`MAX_UPLOAD_MB`, default 300MB) and enforced both
  from the `Content-Length` header and the actual received size.
- Only an owner can create/edit/remove member accounts or promote/demote
  roles; the API refuses to remove the last remaining owner.

## Permissions model

- **Owner**: upload, download, preview, rename, delete, manage members
  (invite/remove, change roles, grant/revoke delete permission). There must
  always be at least one owner.
- **Member**: upload, download, preview, and rename are always allowed.
  Deleting requires the "Can delete files" permission, which an owner grants
  or revokes per-member at any time.

This is intentionally simple but easy to extend — permissions live on the
`users` table (`role`, `canDelete`) and are checked in one place
(`src/lib/auth.ts`) per API route.

## The 3D viewer, thumbnails, and optimization pipeline

All of this is unchanged in *behavior* from the original app — only *where
the bytes come from* changed (server instead of IndexedDB):

- **Viewer**: Three.js with OrbitControls, camera auto-framing, wireframe
  toggle, and animation playback — same code as the original.
- **Formats**: `.glb`, `.gltf` (+ companion `.bin`/textures), `.obj`, `.stl`,
  `.fbx`, `.ply` preview natively. Any other file type is stored/downloadable
  but shows a "can't preview, but it's stored safely" card, exactly like
  before.
- **Draco / KTX2 / Meshopt**: still supported via the same three.js loaders,
  decoding wasm/js assets from the `unpkg`/`three` CDN build (same as the
  original file — these are static third-party decoder assets, not part of
  your backend, so this does not conflict with "no hardcoded backend URLs").
- **GLTF companion files**: `.gltf` files reference `.bin`/textures by
  relative path. The uploader's relative path (`path` field) is preserved in
  the database, and the same dependency-resolution algorithm from the
  original app (exact path match → exact name match → unique basename match)
  now scans the *shared* library instead of local IndexedDB, then fetches
  the matched file from `/api/files/:id/raw`. If more than one file in the
  library shares a basename, the app still (as before) asks you to keep a
  model and its assets together rather than silently guessing.
- **Thumbnails**: generated client-side after the first preview (same
  render-to-texture approach as before), then uploaded via
  `PUT /api/files/:id/thumbnail` so every other member — and the uploader
  after a reload/logout/restart — sees the same image, not a local blob URL.
- **Optimization**: the exact same `@gltf-transform` pipeline (simplify →
  texture resize → prune/dedup) runs in the browser before upload, with a
  choice of High/Balanced/Small presets, a cancel button, and a progress
  bar. The original file on your disk is **never** touched — only the
  chosen result (optimized or original) is uploaded. One important fix
  versus the original file: the old code renamed every node/mesh/material to
  `part_0`/`mesh_0`/`material_0`, destroying meaningful names. This version
  only fills in a name when one is missing, and instead strips actual
  non-essential metadata (the `asset.generator` string and `extras` blocks
  that tools like Blender/Sketchfab embed), which is what "removes AI-tool
  metadata" should actually mean.
- **Batch operations**: multi-select download and delete are preserved
  (delete is gated by the same delete permission as single-file delete).
  Batch *optimization* is intentionally not implemented — optimizing GLBs
  one at a time with a visible progress bar and a cancel button is the safe,
  honest version; silently queuing many multi-hundred-MB WASM transforms in
  the background in a browser tab is not something we'd want to fake.

## Known limitations

- **Single-process real-time bus**: the SSE fan-out uses an in-process
  event emitter. This is correct and sufficient for one server process
  (the normal way to run this app). If you ever horizontally scale to
  multiple server instances behind a load balancer, you'd need to swap this
  for a shared pub/sub (e.g. Postgres `LISTEN`/`NOTIFY` or Redis) so events
  from one instance reach clients connected to another.
- **No public self-registration**: by design — this is a private workspace.
  Only an owner can create accounts.
- **FBX/OBJ/STL/PLY** don't carry companion-file references the way glTF
  does, so the "keep assets together" logic is specific to `.gltf`.
- Very large uploads (multi-GB) are read fully into memory once during
  upload (Node `formData()`); for a small private team's models this is
  fine, but extremely large files may need chunked upload support if you
  outgrow `MAX_UPLOAD_MB`.
