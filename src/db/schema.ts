import { pgTable, text, boolean, timestamp, bigint, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Users of the shared Model Vault workspace.
 *
 * role: "owner" | "member"
 *   - owner: full control (upload/download/preview/rename/delete/manage members)
 *   - member: upload/download/preview/rename always; delete only if `canDelete` is true
 */
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("member"),
    canDelete: boolean("can_delete").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_username_unique").on(table.username)],
);

/**
 * Server-side sessions. The session id itself is the opaque bearer token
 * stored in an httpOnly cookie — it is never guessable and never exposed to
 * client JS. The csrfToken is handed to the browser in a non-httpOnly cookie
 * so client JS can echo it back as a header on state-changing requests
 * (double-submit CSRF protection).
 */
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  csrfToken: text("csrf_token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Shared library file metadata. The binary itself lives on disk under
 * STORAGE_DIR/files/<id>/<storedName> — never inside Postgres.
 */
export const files = pgTable("files", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ext: text("ext").notNull().default(""),
  mime: text("mime").notNull().default("application/octet-stream"),
  size: bigint("size", { mode: "number" }).notNull(),
  // Logical relative path (e.g. "textures/albedo.png") preserved so that
  // .gltf files can be resolved against their companion assets.
  path: text("path").notNull(),
  // Sanitized name actually used on disk (never trusted for traversal).
  storedName: text("stored_name").notNull(),
  uploaderId: text("uploader_id").references(() => users.id, { onDelete: "set null" }),
  // Denormalized so the uploader's name still displays after account removal.
  uploaderName: text("uploader_name").notNull().default("Unknown"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  hasThumbnail: boolean("has_thumbnail").notNull().default(false),
  optimized: boolean("optimized").notNull().default(false),
  optimizePreset: text("optimize_preset"),
});
