import { NextRequest } from "next/server";
import { isSessionAlive, requireSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-helpers";
import { bus, subscribePgEvents } from "@/lib/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 25_000;

/**
 * Server-Sent Events stream used to push real-time library changes
 * (uploads, deletes, renames, thumbnail/optimization updates, member
 * changes) to every connected browser without polling.
 *
 * SSE was chosen over raw WebSockets because Next.js Route Handlers can
 * serve a long-lived streaming Response natively (no custom server needed),
 * it auto-reconnects in the browser via EventSource, and this app only ever
 * needs server -> client push, not client -> server messaging.
 *
 * On Vercel each stream lives only as long as the serverless function is
 * allowed to run; when the platform ends it, the browser reconnects
 * automatically and re-reads the full list (the database is always the
 * source of truth, this stream is only a notification channel). To keep
 * updates live across *instances* (not just within one process), broadcasts
 * are also fanned out over Postgres LISTEN/NOTIFY — see src/lib/events.ts.
 * When LISTEN is unavailable (e.g. a transaction-mode pooler), the stream
 * still works via the in-process bus plus the client's reconnect resync and
 * its fallback poll while disconnected.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireSession(req);

    const encoder = new TextEncoder();

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let listener: ((evt: { type: string; payload: unknown }) => void) | undefined;
    let pgUnsubscribe: (() => Promise<void>) | undefined;

    const stream = new ReadableStream({
      start(controller) {
        let closed = false;

        const send = (event: string, data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            /* controller may already be closed */
          }
        };

        const shutdown = () => {
          if (closed) return;
          if (listener) bus.off("broadcast", listener);
          if (heartbeat) clearInterval(heartbeat);
          closed = true;
          if (pgUnsubscribe) void pgUnsubscribe().catch(() => undefined);
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        };

        listener = (evt) => send(evt.type, evt.payload);
        bus.on("broadcast", listener);

        // Cross-instance hop: events broadcast by other server processes /
        // serverless instances arrive over Postgres NOTIFY. Best effort —
        // without it the stream still gets in-process events.
        subscribePgEvents((evt) => send(evt.type, evt.payload)).then(
          (unsubscribe) => {
            if (closed) {
              void unsubscribe().catch(() => undefined);
              return;
            }
            pgUnsubscribe = unsubscribe;
          },
          (err) => {
            console.warn("[events] Cross-instance live sync unavailable, using in-process bus only:", err);
          },
        );

        heartbeat = setInterval(async () => {
          if (closed) return;
          try {
            // A revoked session (password change, removed account) must stop
            // receiving live updates immediately, not at the next page load.
            if (!(await isSessionAlive(ctx.sessionId))) {
              send("session-expired", { reason: "revoked" });
              shutdown();
              return;
            }
            send("heartbeat", { at: Date.now() });
          } catch {
            /* transient database hiccup — keep the stream open */
          }
        }, HEARTBEAT_MS);

        // If a serverless platform ends the stream, wait 5s before the
        // browser reconnects (instead of hammering the endpoint), then the
        // client re-reads the full list on open — no update is ever lost.
        try {
          controller.enqueue(encoder.encode("retry: 5000\n\n"));
        } catch {
          /* ignore */
        }
        send("connected", { userId: ctx.user.id });

        req.signal.addEventListener("abort", shutdown);
      },
      cancel() {
        if (listener) bus.off("broadcast", listener);
        if (heartbeat) clearInterval(heartbeat);
        if (pgUnsubscribe) void pgUnsubscribe().catch(() => undefined);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
