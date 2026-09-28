import type { Metadata } from "next";
import vaultImportMap from "@/lib/vault-import-map.json";

export const metadata: Metadata = {
  title: "Model Vault — Shared 3D Library",
  description: "A shared, private multi-user 3D model library with live sync.",
};

// This page renders the exact same "Model Vault" UI shell as the original
// single-file app. All interactivity (auth, the Three.js viewer, uploads,
// optimization, real-time sync) lives in the plain JS module at
// /vault/app.js — loaded below via a native <script type="module"> + an
// import map, exactly like the original file did. Keeping it as a static
// asset (instead of bundling through webpack) lets us reuse the existing
// three.js / gltf-transform pipeline verbatim, with an import map resolving
// bare specifiers to the CDN builds, unaffected by Next's bundler.
export default function HomePage() {
  return (
    <>
      {/* The app shell's stylesheet is a plain static asset (public/vault/),
          intentionally not imported through the bundler. */}
      {/* eslint-disable-next-line @next/next/no-css-tags */}
      <link rel="stylesheet" href="/vault/styles.css" />

      <div id="errorBanner" className="error-banner hidden" role="alert"></div>

      <header>
        <div className="logo">
          <span className="dot"></span> Model Vault
        </div>
        <div className="spacer"></div>

        <div className="conn" id="connIndicator" title="Real-time sync status">
          <span className="conn-dot" id="connDot"></span>
          <span id="connText">Connecting…</span>
        </div>

        <div className="userbox hidden" id="userBox">
          <span className="role-badge" id="roleBadge">member</span>
          <span id="usernameLabel"></span>
          <button className="btn sm" id="membersBtn">Members</button>
          <button className="btn sm" id="logoutBtn">Log out</button>
        </div>
      </header>

      <main>
        <aside className="sidebar">
          <div className="panel-head">
            <div className="search">
              <input id="search" type="text" placeholder="Search file names…" autoComplete="off" />
            </div>
            <button className="btn primary" id="addBtn">+ Add</button>
          </div>

          <div className="panel-tools">
            <select className="sortsel" id="sortSel">
              <option value="new">Newest first</option>
              <option value="old">Oldest first</option>
              <option value="name">Name A → Z</option>
              <option value="namez">Name Z → A</option>
              <option value="big">Largest first</option>
              <option value="small">Smallest first</option>
            </select>
            <button className="btn sm" id="selectBtn" title="Select multiple">Select</button>
          </div>

          <div className="selbar hidden" id="selBar">
            <label><input type="checkbox" id="selAll" /> All</label>
            <span id="selCount">0 selected</span>
            <div className="spacer"></div>
            <button className="btn sm" id="selDownload">↓</button>
            <button className="btn sm danger" id="selDelete">Delete</button>
            <button className="btn sm" id="selCancel">Cancel</button>
          </div>

          <div className="list" id="list"></div>

          <div className="sidebar-foot">
            <div className="usage-bar"><div className="usage-fill" id="usageFill"></div></div>
            <div className="usage-text">
              <span id="count">0 files</span>
              <span id="usage">—</span>
            </div>
          </div>
        </aside>

        <section className="viewer">
          <div id="viewport"></div>

          <div className="tools">
            <button className="btn" id="wireBtn">Wireframe</button>
            <button className="btn" id="resetBtn">Reset view</button>
          </div>

          <div className="overlay-card" id="emptyCard">
            <h2>No model selected</h2>
            <p>Drop <b>.glb</b>, <b>.gltf</b>, <b>.obj</b>, <b>.stl</b>, <b>.fbx</b> or <b>.ply</b> files anywhere on this page — or click <b>Add</b>.</p>
            <p style={{ marginTop: 6, fontSize: 12.5, opacity: 0.75 }}>
              Any other file type can still be stored and downloaded. Everything you add is shared with the whole workspace instantly.
            </p>
          </div>

          <div className="overlay-card hidden" id="fallbackCard">
            <h2 id="fbName"></h2>
            <p id="fbMsg"></p>
            <button className="btn primary" id="fbDownload">Download file</button>
          </div>

          <div className="hud" id="hud"></div>
        </section>
      </main>

      <div className="drop-overlay" id="dropOverlay">
        <div className="drop-inner">
          Drop your 3D files here
          <small>They&apos;ll be uploaded to the shared workspace library</small>
        </div>
      </div>

      {/* ---------- Optimize prompt modal ---------- */}
      <div className="modal-overlay" id="optimizeModal">
        <div className="modal-card">
          <h3>Optimize this file?</h3>
          <p>
            This reduces file size (mesh + textures) and strips the tool/export metadata that came with the
            model, re-tagging the result as a Model Vault export. Names you gave your objects, meshes,
            materials and textures are kept exactly as they are. Only the version you choose gets uploaded —
            your original local file on disk is never modified, and if optimizing would make the file larger
            the original is uploaded instead.
          </p>
          <div className="fname" id="optimizeFileName"></div>
          <select className="sortsel" id="optimizePreset" style={{ width: "100%", height: 34, marginBottom: 14 }}>
            <option value="high">High quality — keeps most detail</option>
            <option value="balanced">Balanced — recommended</option>
            <option value="small">Smallest file — most reduction</option>
          </select>
          <div className="modal-actions" id="optimizeActions">
            <button className="btn" id="optimizeSkip">Skip — upload as-is</button>
            <button className="btn primary" id="optimizeYes">Optimize</button>
          </div>
          <button
            className="btn sm"
            id="optimizeCancelUpload"
            style={{ width: "100%", marginTop: 8, background: "transparent", borderColor: "transparent", color: "var(--muted)" }}
          >
            Cancel — don&apos;t add this file
          </button>
          <div className="modal-progress" id="optimizeProgress" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="spinner"></div>
              <span id="optimizeProgressText">Optimizing…</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" id="optimizeProgressFill"></div>
            </div>
            <button className="btn sm danger" id="optimizeCancelRunning" style={{ marginTop: 10, alignSelf: "flex-start" }}>
              Cancel
            </button>
          </div>
        </div>
      </div>

      {/* ---------- Members / permissions modal ---------- */}
      <div className="modal-overlay" id="membersModal">
        <div className="modal-card" style={{ width: 480 }}>
          <h3>Workspace members</h3>
          <p>Owners can upload, download, preview, rename, delete and manage members. Members can always upload,
            download, preview and rename — deleting requires permission from an owner.</p>

          <div id="membersList" className="members-list"></div>

          <div id="inviteBox" className="invite-box hidden">
            <h4 style={{ margin: "14px 0 8px", fontSize: 13 }}>Invite a member</h4>
            <form id="inviteForm">
              <input className="text-input" id="inviteUsername" placeholder="Username" autoComplete="off" />
              <input className="text-input" id="invitePassword" type="password" placeholder="Temporary password (min 8 chars)" autoComplete="new-password" />
              <label className="checkbox-row">
                <input type="checkbox" id="inviteCanDelete" defaultChecked /> Can delete files
              </label>
              <div id="inviteError" className="form-error hidden"></div>
              <div className="modal-actions">
                <button type="button" className="btn" id="membersCloseBtn2">Close</button>
                <button type="submit" className="btn primary" id="inviteSubmit">Add member</button>
              </div>
            </form>
          </div>

          {/* Everyone (not just owners) can change their own password here.
              The API revokes all of that account's sessions afterwards. */}
          <div className="invite-box" id="passwordBox">
            <h4 style={{ margin: "14px 0 8px", fontSize: 13 }}>Your password</h4>
            <form id="pwForm">
              <input
                className="text-input"
                id="pwCurrent"
                type="password"
                placeholder="Current password"
                autoComplete="current-password"
              />
              <input
                className="text-input"
                id="pwNew"
                type="password"
                placeholder="New password (min 8 chars)"
                autoComplete="new-password"
              />
              <div id="pwError" className="form-error hidden"></div>
              <button type="submit" className="btn primary" style={{ width: "100%" }}>
                Change password
              </button>
              <p style={{ fontSize: 11.5, color: "var(--muted)", margin: "8px 0 0" }}>
                Changing your password signs you out everywhere and requires logging in again.
              </p>
            </form>
          </div>

          <div className="modal-actions" id="membersCloseWrap">
            <button className="btn" id="membersCloseBtn">Close</button>
          </div>
        </div>
      </div>

      {/* ---------- Auth overlay (login / first-run setup) ---------- */}
      <div className="auth-overlay" id="authOverlay">
        <div className="auth-card">
          <div className="logo" style={{ justifyContent: "center", marginBottom: 18 }}>
            <span className="dot"></span> Model Vault
          </div>

          <div id="setupPane" className="hidden">
            <h2>Create the owner account</h2>
            <p>No one has set up this workspace yet. Create the first account — it becomes the owner and can
              invite everyone else.</p>
            <form id="setupForm">
              <input className="text-input" id="setupUsername" placeholder="Username" autoComplete="username" />
              <input className="text-input" id="setupPassword" type="password" placeholder="Password (min 8 chars)" autoComplete="new-password" />
              <div id="setupError" className="form-error hidden"></div>
              <button type="submit" className="btn primary" style={{ width: "100%" }}>Create owner account</button>
            </form>
          </div>

          <div id="loginPane" className="hidden">
            <h2>Log in</h2>
            <p>Sign in to access the shared workspace library.</p>
            <form id="loginForm">
              <input className="text-input" id="loginUsername" placeholder="Username" autoComplete="username" />
              <input className="text-input" id="loginPassword" type="password" placeholder="Password" autoComplete="current-password" />
              <div id="loginError" className="form-error hidden"></div>
              <button type="submit" className="btn primary" style={{ width: "100%" }}>Log in</button>
            </form>
          </div>

          <div id="authLoadingPane">
            <div className="spinner" style={{ margin: "20px auto" }}></div>
          </div>
        </div>
      </div>

      <input type="file" id="fileInput" multiple hidden />

      <script
        type="importmap"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(vaultImportMap),
        }}
      />
      {/* `defer` is implicit for module scripts; it is spelled out here so the
          linter (and readers) see that this script never blocks rendering. */}
      <script type="module" src="/vault/app.js" defer />
    </>
  );
}
