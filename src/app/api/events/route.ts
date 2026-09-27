import { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-helpers";
import { bus } from "@/lib/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-Sent Events stream used to push real-time library changes
 * (uploads, deletes, renames, thumbnail/optimization updates, member
 * changes) to every connected browser without polling.
 *
 * SSE was chosen over raw WebSockets because Next.js Route Handlers can
 * serve a long-lived streaming Response natively (no custom server needed),
 * it auto-reconnects in the browser via EventSource, and this app only ever
 * needs server -> client push, not client -> server messaging.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireSession(req);

    const encoder = new TextEncoder();

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let listener: ((evt: { type: string; payload: unknown }) => void) | undefined;

    const stream = new ReadableStream({
      start(controller) {
        const send = (event: string, data: unknown) => {
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            /* controller may already be closed */
          }
        };

        listener = (evt) => send(evt.type, evt.payload);
        bus.on("broadcast", listener);

        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            /* ignore */
          }
        }, 25000);

        send("connected", { userId: ctx.user.id });

        req.signal.addEventListener("abort", () => {
          if (listener) bus.off("broadcast", listener);
          if (heartbeat) clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        });
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
