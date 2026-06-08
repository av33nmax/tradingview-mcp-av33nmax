import { getWatcher, snapshot, subscribe, type OutputLine } from "@/lib/watchers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SSEEvent =
  | { type: "snapshot"; snapshot: ReturnType<typeof snapshot> }
  | { type: "line"; line: OutputLine };

function sseLine(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ ticker: string }> },
) {
  const { ticker: tickerRaw } = await ctx.params;
  const ticker = tickerRaw.toUpperCase();
  const encoder = new TextEncoder();

  // Hoisted out of start() so cancel() can also fire it. Previously cancel()
  // was a no-op and the `start()` closure's cleanup only ran on the 12-hour
  // backstop timer — leaving dead subscribers, dead heartbeat intervals, and
  // dead enqueue attempts alive across browser refreshes. Each refresh added
  // a zombie SSE connection that the watcher emit loop would still iterate
  // over, burning CPU. With 6 watchers × N zombies × heartbeat-every-20s the
  // dashboard pegged at 100%+ CPU. (Bug surfaced 2026-05-06.)
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      // Try to enqueue a chunk. If the underlying controller is dead (client
      // disconnected without firing cancel — happens on hard browser kills,
      // network blips, etc.), trigger cleanup so we stop trying.
      const tryEnqueue = (chunk: Uint8Array): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          // Controller is dead — disconnect happened, cancel didn't fire.
          // Cleanup synchronously so the next watcher line skips this stream.
          cleanup?.();
          return false;
        }
      };

      const safeSend = (event: SSEEvent) => {
        tryEnqueue(encoder.encode(sseLine(event)));
      };

      // Initial snapshot — includes recent output so client can catch up.
      safeSend({ type: "snapshot", snapshot: snapshot(ticker) });

      // Subscribe to new watcher lines (if a watcher is registered).
      const w = getWatcher(ticker);
      let unsubscribe: (() => void) | null = null;
      if (w) {
        unsubscribe = subscribe(ticker, (line) => {
          safeSend({ type: "line", line });
        });
      }

      // Heartbeat every 20s to keep connection alive through proxies. Uses
      // tryEnqueue so a dead controller triggers cleanup instead of silently
      // failing every 20s for 12 hours.
      const heartbeat = setInterval(() => {
        tryEnqueue(encoder.encode(": heartbeat\n\n"));
      }, 20000);

      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe?.();
        try { controller.close(); } catch { /* already closed */ }
      };

      // 12-hour backstop — watchers can run for hours; this just prevents
      // truly abandoned streams from leaking forever if every other cleanup
      // path (cancel, dead-enqueue) somehow misses.
      setTimeout(() => cleanup?.(), 12 * 3600 * 1000);
    },

    cancel() {
      // Browser tab closed / page refreshed / navigation away. Run cleanup
      // immediately so we unsubscribe from the watcher and stop heartbeating.
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
