import { snapshotAll, subscribeAll, type OutputLine } from "@/lib/watchers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Multiplexed watcher stream — one SSE connection delivers events for ALL
 * tickers, instead of one per-ticker EventSource each holding a connection
 * slot. Frees up Safari's HTTP/1.1 6-per-host pool so confirm/stop fetches
 * don't queue forever (anchor case 2026-05-07: confirm modal stuck on
 * "Firing…" with all 6 watchers armed).
 *
 * Wire format:
 *   { type: "snapshot-all", snapshots: [<per-ticker snapshot>, ...] }
 *   { type: "line", ticker: "SPY", line: <OutputLine> }
 *
 * Mirrors the per-ticker route's lifecycle defenses: dead-controller
 * detection via tryEnqueue, heartbeat every 20s, cleanup-on-cancel, and
 * a 12-hour backstop. The legacy /api/watcher/stream/[ticker] route
 * remains in place but no production client should be opening it after
 * this change.
 */

type SnapshotItem = NonNullable<ReturnType<typeof snapshotAll>[number]>;

type SSEEvent =
  | { type: "snapshot-all"; snapshots: SnapshotItem[] }
  | { type: "line"; ticker: string; line: OutputLine };

function sseLine(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function GET() {
  const encoder = new TextEncoder();

  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const tryEnqueue = (chunk: Uint8Array): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          // Controller is dead — disconnect happened, cancel didn't fire.
          // Synchronous cleanup so subsequent watcher lines skip this stream.
          cleanup?.();
          return false;
        }
      };

      const safeSend = (event: SSEEvent) => {
        tryEnqueue(encoder.encode(sseLine(event)));
      };

      // Initial: send snapshots for every registered watcher so the client
      // can populate its full state on connect (no per-ticker fetch needed).
      const snaps = snapshotAll().filter((s): s is SnapshotItem => s != null);
      safeSend({ type: "snapshot-all", snapshots: snaps });

      // Subscribe globally — every appendLine for any ticker delivers here.
      const unsubscribe = subscribeAll((ticker, line) => {
        safeSend({ type: "line", ticker, line });
      });

      const heartbeat = setInterval(() => {
        tryEnqueue(encoder.encode(": heartbeat\n\n"));
      }, 20000);

      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };

      // 12-hour backstop — long sessions are normal; only kicks in if every
      // other cleanup path somehow misses.
      setTimeout(() => cleanup?.(), 12 * 3600 * 1000);
    },

    cancel() {
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
