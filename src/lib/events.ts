import { EventEmitter } from "node:events";
import { Client } from "pg";
import { pool } from "@/db";

// Real-time fan-out for the Server-Sent Events stream.
//
// Two layers, both best effort on top of the database (which is always the
// source of truth — this is only a notification channel, and clients resync
// the full list from GET /api/files on every reconnect):
//
//  1. an in-process bus (instant, works everywhere including `next start`);
//  2. Postgres LISTEN/NOTIFY on the `vault_events` channel, so a broadcast
//     from one serverless instance reaches SSE streams held by other
//     instances on Vercel.
//
// NOTIFY payloads are capped at 8000 bytes by Postgres; our event payloads
// are small metadata objects (a few hundred bytes), and anything larger is
// skipped for the cross-instance hop (the in-process hop still fires).
const globalForBus = globalThis as typeof globalThis & {
  __modelVaultBus?: EventEmitter;
};

export const bus = globalForBus.__modelVaultBus ?? new EventEmitter();
bus.setMaxListeners(0);

if (!globalForBus.__modelVaultBus) {
  globalForBus.__modelVaultBus = bus;
}

export type VaultEventType =
  | "file-added"
  | "file-updated"
  | "file-deleted"
  | "files-deleted"
  | "member-changed"
  | "connected";

export const PG_EVENT_CHANNEL = "vault_events";
const PG_NOTIFY_MAX_BYTES = 7000;

export function broadcast(type: VaultEventType, payload: unknown) {
  bus.emit("broadcast", { type, payload });

  // Cross-instance hop. Fire-and-forget: a notification failure must never
  // fail the request that triggered it.
  void notifyInstances(type, payload).catch(() => {
    /* already logged inside */
  });
}

async function notifyInstances(type: VaultEventType, payload: unknown): Promise<void> {
  let body: string;
  try {
    body = JSON.stringify({ type, payload });
  } catch {
    return;
  }
  if (Buffer.byteLength(body, "utf8") > PG_NOTIFY_MAX_BYTES) {
    console.warn(`[events] Skipping cross-instance notify for oversized ${type} event.`);
    return;
  }
  try {
    await pool.query("SELECT pg_notify($1, $2)", [PG_EVENT_CHANNEL, body]);
  } catch (err) {
    console.error("[events] pg_notify failed (in-process delivery already happened):", err);
  }
}

export type PgUnsubscribe = () => Promise<void>;

/**
 * Subscribes to cross-instance events via a dedicated LISTEN connection.
 * Throws when LISTEN is unavailable (e.g. a transaction-mode pooler, which
 * does not support it) — callers fall back to the in-process bus plus the
 * client's reconnect resync, and everything still works, only less live.
 */
export async function subscribePgEvents(
  onEvent: (evt: { type: string; payload: unknown }) => void,
): Promise<PgUnsubscribe> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const client = new Client({ connectionString });
  await client.connect();

  let closed = false;
  const onNotification = (msg: { channel?: string; payload?: string }) => {
    if (closed || msg.channel !== PG_EVENT_CHANNEL || !msg.payload) return;
    try {
      const parsed = JSON.parse(msg.payload) as { type: string; payload: unknown };
      if (parsed && typeof parsed.type === "string") onEvent(parsed);
    } catch {
      /* ignore malformed notifications */
    }
  };

  client.on("notification", onNotification);
  client.on("error", () => {
    /* the SSE heartbeat keeps the stream honest; a dead listener just goes quiet */
  });
  await client.query(`LISTEN "${PG_EVENT_CHANNEL}"`);

  return async () => {
    if (closed) return;
    closed = true;
    client.off("notification", onNotification);
    try {
      await client.query(`UNLISTEN "${PG_EVENT_CHANNEL}"`);
    } catch {
      /* ignore */
    }
    await client.end().catch(() => undefined);
  };
}
