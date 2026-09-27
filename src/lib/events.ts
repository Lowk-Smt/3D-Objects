import { EventEmitter } from "node:events";

// A single in-process event bus used to fan out real-time updates to all
// connected Server-Sent Events clients. This works because `next start`
// runs as one long-lived Node process in this deployment. If this app is
// ever horizontally scaled across multiple server processes/machines, this
// in-memory bus would need to be swapped for a shared pub/sub backend
// (e.g. Postgres LISTEN/NOTIFY or Redis) — see README "Limitations".
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

export function broadcast(type: VaultEventType, payload: unknown) {
  bus.emit("broadcast", { type, payload });
}
