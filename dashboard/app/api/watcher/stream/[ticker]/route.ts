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

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const safeSend = (event: SSEEvent) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(sseLine(event))); }
        catch { /* stream already closed */ }
      };

      // Send initial snapshot (includes recent output so client can catch up)
      safeSend({ type: "snapshot", snapshot: snapshot(ticker) });

      // If no watcher yet, still keep the stream open — watcher might start soon
      const w = getWatcher(ticker);
      let unsubscribe: (() => void) | null = null;
      if (w) {
        unsubscribe = subscribe(ticker, (line) => {
          safeSend({ type: "line", line });
        });
      }

      // Heartbeat every 20s to keep connection alive through proxies
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": heartbeat\n\n")); }
        catch { /* closed */ }
      }, 20000);

      // Cleanup — no explicit cancel signal in Next.js streaming, but the
      // controller.enqueue will throw when the client disconnects.
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe?.();
        try { controller.close(); } catch { /* already */ }
      };

      // Arbitrary long timeout — watchers can run for hours. This just
      // prevents truly abandoned streams from leaking forever.
      setTimeout(cleanup, 12 * 3600 * 1000);
    },

    cancel() {
      // Client disconnected (browser tab closed). No action needed; the
      // start() closure's cleanup runs when subscribers set is next
      // iterated by appendLine, which will throw the dead controller.
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
