# Model Vault — hardening & verification report

Code and documentation live in this repo; this file records what was changed,
why, and exactly what was run to prove it. Nothing here is projected or
estimated: every result below is a command that was executed and its real
output.

---

## 1. Summary

The existing Model Vault application (Next.js route handlers + Drizzle/Postgres
+ a plain-ES-module Three.js frontend) was **kept as-is architecturally**. No
part of it was rebuilt, no stack was swapped, and no working feature was
removed: the viewer, the import map, the optimizer, the drag-and-drop UI, the
"Model Vault" visual design, search/sort/selection, batch actions, the SSE
transport and the permission model are all still the ones that shipped before.

Work done:

- **Storage layer was consolidated** into `src/lib/storage.ts` (write → verify →
  insert, park → delete → purge, quota reservation, thumbnail normalization,
  trash sweep) so uploads and deletes can no longer leave the database and the
  disk disagreeing.
- **Thumbnail pipeline was made honest**: the bytes now decide the format and
  the MIME type, older PNG-under-`.jpg` rows are repaired on read, and only the
  uploader or an owner may set one.
- **Security gaps were closed**: password changes revoke every session for that
  account (including open SSE streams), login brute-force throttling was added,
  the first-owner creation race is now transaction + advisory-lock + partial
  unique index, the CSRF origin check tolerates reverse proxies, and quota is
  enforced server-side with an in-process reservation.
- **Failure modes were made explicit**: `src/lib/api-helpers.ts` is the single
  exit point for API errors — expected failures keep their status and message,
  Postgres errors are translated (`23505` → `409`, `23503` → `409`, `08xxx` →
  `503 database unavailable`), everything unexpected becomes a generic `500`
  with the detail logged server-side. Every upload/delete cleanup failure is
  logged rather than swallowed.
- **The optimizer's promises are now testable**: `tests/optimizer.test.mjs` runs
  the identical `@gltf-transform@4.5.0` pipeline the browser uses and asserts
  name preservation and metadata removal.
- **Verification infrastructure was added and run**: `npm run test:e2e`
  (two-phase acceptance test over real HTTP), the unit suites, and a chaos
  harness that injects real database/filesystem failures.

## 2. Bugs and security issues fixed

| # | Issue | Fix |
|---|-------|-----|
| 1 | Thumbnails were stored under a `.jpg` name regardless of their real format and served as `image/jpeg`, so PNG bytes were mislabelled everywhere. | `src/lib/storage.ts` sniffs the decoded bytes (`sniffImageType`), derives extension **and** MIME from the bytes, writes atomically, removes the stale file for the other extension, and persists `thumb_ext` / `thumb_mime` (`src/db/schema.ts`). Mislabelled data URLs are corrected and logged. Legacy rows are repaired on read (`GET …/thumbnail` renames + updates the row). |
| 2 | Non-image payloads could be stored as thumbnails. | Payload must decode as an image and sniff to JPEG/PNG/WebP/GIF, otherwise `415`. |
| 3 | Any authenticated member could replace any file's thumbnail (no server check). | `canUserManageThumbnail()` (`src/lib/auth.ts`): uploader **or** owner only, enforced in the route, mirrored (not replaced) in the UI. The whole thumbnail write path (auth check → decode → sniff → write → DB update) lives in the route plus `src/lib/storage.ts`, with one stale-extension cleanup. |
| 4 | A failed DB insert after the bytes were written left orphaned files on disk. | Upload writes → verifies size → inserts; on insert failure the stored bytes are deleted and the request fails with a clear 500. |
| 5 | A failed DB delete could leave the row and the bytes in an unknown state, and cleanup errors were swallowed. | Deletes park the bytes in `trash/` first, delete the row, then purge; if the row delete fails the bytes are restored and the request fails with "nothing was removed". Dirty trash is swept at startup. |
| 6 | `LIBRARY_QUOTA_BYTES` was only a frontend meter; concurrent uploads could both pass the check. | `reserveUploadBytes()` reserves in-process before accepting bytes; the reservation is released on any failure. Two simultaneous quota-straddling uploads now yield exactly one `201` and one `413`. |
| 7 | Changing a password left old sessions (and open SSE streams) valid. | Both password paths call `revokeUserSessions()`; `GET /api/events` re-checks liveness on a 25 s heartbeat and sends `session-expired`, then closes. |
| 8 | No brute-force protection on login. | `src/lib/rate-limit.ts`: per-account and per-address counters with lockout + `Retry-After`; a successful login clears the account counter; unknown usernames compare a dummy hash to avoid enumeration timing. |
| 9 | Two simultaneous `/api/auth/setup` requests could both create an owner. | The emptiness check and the insert now happen in one transaction that first takes a transaction-scoped Postgres advisory lock (`pg_advisory_xact_lock`), so concurrent setups serialize and the loser gets `409 Setup already completed`; the `users.username` unique index is the second line of defence. (A "one owner" unique index is deliberately **not** used — owners may legitimately promote a member to owner later.) Verified with 5 concurrent requests → exactly one winner. |
| 10 | The CSRF `Origin` check rejected legitimate requests behind a TLS-terminating proxy that rewrites `Host` (and mislabelled them "Invalid origin header"). | `candidateRequestHosts()` accepts `Host`, `X-Forwarded-Host` and an explicitly configured `PUBLIC_ORIGIN`; the error message now names the real reason. |
| 11 | Download filenames could degrade to `file` / `blob` / `download` and lose the extension. | `getDownloadName()` (shared by browser and server) always yields the stored name with a real extension; verified for `.glb`, `.gltf`, `.bin`, `.png`. |
| 12 | The optimizer renamed every node/mesh/material to `part_0`/`mesh_0`/… and claimed metadata removal it did not perform. | Names are preserved (only nameless properties get a neutral placeholder); `asset.generator` is set to a Model Vault tag and every `extras` block really is stripped — all asserted by `tests/optimizer.test.mjs`. |
| 13 | "Optimizing" could make a file larger before upload. | If the result is not smaller, the original is uploaded and the user is told the sizes. |
| 14 | Client-supplied ids, filenames and paths were trusted in places. | Every route re-checks the session and derives the acting user from it; ids must match `^[A-Za-z0-9_-]{1,64}$`; display names/stored names/relative paths are sanitized (`sanitizeDisplayName`, `sanitizeStoredName`, `sanitizeRelativePath`); every path is re-resolved under `STORAGE_DIR/files/<id>/` in `src/lib/serve-file.ts`. |
| 15 | SSRF-ish data URLs and arbitrary `image/*` data were accepted for thumbnails. | Only `image/(png|jpeg|webp|gif)` data URLs decode; anything else is `415`. |
| 16 | SSE streams could silently die without the UI recovering, and reconnect behaviour was unclear. | `app.js` distinguishes transient drops (`Reconnecting…`) from a closed stream, re-checks the session, reconnects, and resyncs the whole library on every (re)connect. |
| 17 | Error responses leaked internals or were generic. | `api-helpers.ts` maps expected failures to specific statuses/messages and everything unexpected to a generic 500 with the detail logged server-side; users never receive password hashes; `AuthError.headers` keeps `Retry-After`/`401` semantics. |

## 3. Exact commands and exact results

Environment: Node/Next 16.2.6, PostgreSQL 18.4 (`app_db`), storage at
`./data`, `MAX_UPLOAD_MB=5`, `LIBRARY_QUOTA_BYTES=2000000` (small values chosen
so limits are exercisable).

```bash
npm install                 # → added 24 packages (dev-only @gltf-transform@4.5.0)
npm run db:push -- --force   # → [✓] Changes applied
npm run typecheck            # → tsc --noEmit, no output (clean)
npm run lint                 # → eslint ., no output (clean)
npm test                     # → # tests 23  # pass 23  # fail 0
npm run build                # → ✓ Compiled successfully in 5.5s / Finished TypeScript in 4.0s
npm run start                # → ✓ Ready in 146ms on 0.0.0.0:3000
```

End-to-end acceptance (real HTTP, two accounts, real SSE connections, against a
freshly dropped/created database and empty storage):

```bash
E2E_BASE_URL=http://127.0.0.1:3000 E2E_MAX_UPLOAD_MB=5 npm run test:e2e -- --phase=1
# → 52/52 checks passed

# server restarted with the same database and storage directory, then:
E2E_BASE_URL=http://127.0.0.1:3000 npm run test:e2e -- --phase=2
# → 7/7 checks passed
```

Phase 1 covers: setup race (5 concurrent requests → one owner), login/CSRF
(including "same-origin accepted, cross-origin blocked"), member invite,
permission denial, no password hashes in responses, dual SSE live sync
(`Barrel.glb` and `Lantern.glb` seen by the other user without refresh),
spoofed uploader ignored, raw/download filename + MIME + byte equality, `.gltf`
bundle upload with relative paths resolving to the right ids, missing companion
error, thumbnail authorization + "lying" data URL + non-image rejection, rename
and delete sync, upload validation (empty/missing/oversized/any type/corrupt),
quota `413`, usage meter equals the sum of stored files, password-change
revocation (owner reset, self-service change, wrong current password),
brute-force `429` + `Retry-After`, logout, unknown-id `404`, traversal probes.

Phase 2 covers: sessions survive a restart, metadata survives, bytes survive,
thumbnails survive with the right content type, live sync works after the
restart, logout/login preserves the library, `.gltf` companions still resolve.

Failure-mode suite (injects real database triggers and filesystem permissions,
then removes them):

```bash
node /tmp/chaos.mjs     # → 17/17 failure-mode checks passed
```

- DB insert rejection → `500` with a "database" message, **no orphaned bytes**.
- `chmod 500` on the storage directory → `500` with a "storage" message, **no
  phantom row, no leftover bytes**.
- DB delete rejection → `500` "nothing was removed", row **and** bytes intact,
  and a retried delete then succeeds.
- Legacy PNG-in-`.jpg` thumbnail → served as `image/png`, file renamed, DB
  repaired, delete still works.
- Two concurrent quota-straddling uploads → exactly one `201`, one `413`, quota
  never exceeded.
- Owner resets a member's password → the member's open SSE stream receives
  `session-expired` and closes within 35 s.

Storage consistency audit (`node /tmp/consistency.mjs`, database vs disk):

```
DB rows: 8 | disk dirs: 8
orphaned dirs (on disk, no DB row): none
missing dirs (DB row, no bytes): none
thumbnails without a matching row: none
CONSISTENT: every row has exactly its bytes, every byte has its row
```

Origin/CSRF behaviour (curl, explicit headers — same scenarios the platform
preview proxy produces):

```
direct same-origin                        -> 201 (created + cleaned up)
preview origin, Host rewritten            -> 201 (created + cleaned up)
preview origin, Host preserved            -> 201 (created + cleaned up)
attacker origin https://evil.example.com  -> 403 Cross-origin request blocked.
no Origin header (CLI/tools)              -> 201
valid Origin, wrong CSRF token            -> 403 Missing or invalid CSRF token.
```

## 4. Known limitations

1. **Single-process assumptions.** The SSE fan-out (`src/lib/events.ts`) and the
   login rate limiter keep state in process memory. Correct for one server
   process — which is how this app is meant to run — but horizontal scaling
   would need shared pub/sub and a shared rate-limit store.
2. **Uploads are buffered once in memory** while Node parses the multipart body,
   so a file near `MAX_UPLOAD_MB` needs comparable free RAM. Chunked uploads
   were not added (out of scope, and the limit is configurable).
3. **Thumbnails are generated lazily** in the browser: a file gets one when its
   uploader or an owner previews it. Uploading a thumbnail without a browser is
   not supported (by design — it is a WebGL render of the model).
4. **`.obj`/`.mtl`, `.fbx`, `.stl`, `.ply` companion references are not
   resolved** (only `.gltf` is), matching the behaviour this app already had.
5. **No browser-side runtime verification inside this sandbox.** The viewer,
   optimizer and thumbnail capture import Three.js / glTF-Transform / decoders
   from public CDNs (`unpkg`, `esm.sh`), which are not reachable from the
   verification sandbox (SSL error, no egress). All server/API behaviour was
   verified over real HTTP as shown above, and the optimizer's document-level
   behaviour was verified in Node with the exact same library version — but
   "the 3D viewer renders correctly in a browser" is **not** something that was
   run here. Please open the app once and confirm visually.
6. **Optimization is GLB-only**, chosen per file in the UI (unchanged from
   before). If the optimized result would be larger, the original is uploaded.
7. `PUBLIC_ORIGIN` is optional; it is only needed when a proxy both rewrites
   `Host` and drops `X-Forwarded-Host`.

## 5. Files added / modified

Added:

```
.env.example                          environment template (no secrets)
.gitignore                            keeps .env* and data/ out of git
drizzle.config.ts                     replaces drizzle.config.json; env-driven
public/vault/shared.js                pure helpers shared by browser + tests
src/lib/storage.ts                    all filesystem/DB consistency + quota logic
src/lib/rate-limit.ts                 login brute-force protection
src/app/api/auth/password/route.ts    self-service password change
tests/paths.test.mjs                  path/MIME/download-name resolution
tests/server-helpers.test.mjs         sanitizers, id validation, image sniffing
tests/optimizer.test.mjs              what the optimizer may do to a model
scripts/e2e-test.mjs                  two-phase end-to-end acceptance test
```

Modified (largest changes first): `README.md`, `public/vault/app.js`,
`src/app/api/files/route.ts`, `src/lib/files.ts`, `src/lib/auth.ts`,
`src/app/api/files/[id]/thumbnail/route.ts`, `src/app/api/auth/setup/route.ts`,
`src/app/api/files/[id]/route.ts`, `src/app/api/events/route.ts`,
`src/lib/config.ts`, `src/app/api/files/batch-delete/route.ts`,
`src/app/api/users/[id]/route.ts`, `src/lib/api-helpers.ts`,
`src/lib/serve-file.ts`, `src/app/api/auth/login/route.ts`,
`src/app/api/stats/route.ts`, `src/app/api/files/[id]/download/route.ts`,
`src/app/api/files/[id]/raw/route.ts`, `src/db/schema.ts`,
`src/app/page.tsx`, `src/app/layout.tsx`, `next.config.ts`, `package.json`.

Removed: `drizzle.config.json` (superseded by `drizzle.config.ts`).
