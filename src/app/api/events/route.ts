import { NextRequest } from "next/server";
import { isSessionAlive, requireSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-helpers";
import { bus } from "@/lib/events";

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
 * Clients that have fallen behind (or reconnect after a restart) resync by
 * calling GET /api/files — the database is always the source of truth, this
 * stream is only a notification channel.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireSession(req);

    const encoder = new TextEncoder();

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let listener: ((evt: { type: string; payload: unknown }) => void) | undefined;

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
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        };

        listener = (evt) => send(evt.type, evt.payload);
        bus.on("broadcast", listener);

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

        send("connected", { userId: ctx.user.id });

        req.signal.addEventListener("abort", shutdown);
      },
      cancel() {
        if (listener) bus.off("broadcast", listener);
        if (heartbeat) clearInterval(heartbeat);
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
