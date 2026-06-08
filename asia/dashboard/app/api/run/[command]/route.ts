import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { registerChild, clearChild } from "@/lib/running-child";

/**
 * Streams a whitelisted asia/ script's stdout/stderr back to the browser as
 * Server-Sent Events. The dashboard lives in `asia/dashboard`, scripts live
 * in `asia/scripts` — this route spawns them with cwd set to `asia/`.
 *
 * Whitelisted commands only — NO arbitrary input is ever passed as args.
 * Bound to localhost in dev/prod by default.
 */

const ASIA_ROOT = path.join(process.cwd(), "..");

type CommandSpec = {
  cmd: string;
  args: string[];
  label: string;
};

const COMMANDS: Record<string, CommandSpec> = {
  // Unified entry point — runs cleanup + calendar + premarket + (a50 + orb if
  // ≥09:45 SGT) + verify in one go. Primary daily action.
  "premarket-asia": {
    cmd: "node",
    args: ["scripts/premarket_asia.mjs"],
    label: "Pre-market Asia (unified)",
  },
  "premarket-hsi": {
    cmd: "node",
    args: ["scripts/premarket_hsi.mjs"],
    label: "Pre-market HSI",
  },
  "orb-hsi": {
    cmd: "node",
    args: ["scripts/post_open_orb.mjs"],
    label: "ORB triggers (post-09:45 SGT)",
  },
  "check-correlation": {
    cmd: "node",
    args: ["scripts/check_a50_correlation.mjs"],
    label: "A50 correlation check",
  },
  "refresh-calendar": {
    cmd: "node",
    args: ["scripts/refresh_calendar.mjs"],
    label: "Refresh policy calendar",
  },
  "verify-drawings": {
    cmd: "node",
    args: ["scripts/verify_drawings.mjs"],
    label: "Verify chart drawings",
  },

  // ─── HK watcher (one tile per instrument) ─────────────────────────────────
  // Spawns trade_window_hk.mjs with the instrument key as the single arg.
  // Hard-blocked behind manual_yn until the Y/N toggle UI ships.
  "watcher-hsi": {
    cmd: "node",
    args: ["scripts/trade_window_hk.mjs", "HSI"],
    label: "Watcher · HSI",
  },
  "watcher-tencent": {
    cmd: "node",
    args: ["scripts/trade_window_hk.mjs", "TENCENT"],
    label: "Watcher · Tencent (700)",
  },
  "watcher-alibaba": {
    cmd: "node",
    args: ["scripts/trade_window_hk.mjs", "ALIBABA"],
    label: "Watcher · Alibaba (9988)",
  },
  "watcher-xiaomi": {
    cmd: "node",
    args: ["scripts/trade_window_hk.mjs", "XIAOMI"],
    label: "Watcher · Xiaomi (1810)",
  },

  // Verification — run once before first live watcher cycle.
  "test-hk-contracts": {
    cmd: "node",
    args: ["scripts/test_hk_contract_resolve.mjs"],
    label: "Verify HK contract symbology",
  },
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SSEEvent =
  | { type: "start"; label: string; command: string }
  | { type: "stdout"; line: string }
  | { type: "stderr"; line: string }
  | { type: "exit"; code: number | null; durationMs: number }
  | { type: "error"; message: string };

function sseLine(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ command: string }> }
) {
  const { command } = await ctx.params;
  const spec = COMMANDS[command];
  const encoder = new TextEncoder();

  if (!spec) {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sseLine({ type: "error", message: `Unknown command: ${command}` })
          )
        );
        controller.close();
      },
    });
    return new Response(stream, {
      status: 404,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  const started = Date.now();

  const stream = new ReadableStream({
    start(controller) {
      let child: ChildProcess | null = null;
      let closed = false;

      const safeEnqueue = (event: SSEEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseLine(event)));
        } catch {
          // Controller already closed (client disconnected). Ignore.
        }
      };

      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      safeEnqueue({ type: "start", label: spec.label, command });

      try {
        child = spawn(spec.cmd, spec.args, {
          cwd: ASIA_ROOT,
          env: { ...process.env, FORCE_COLOR: "0" },
        });
        registerChild({ child, command, startedAt: started });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        safeEnqueue({ type: "error", message: `spawn failed: ${message}` });
        safeClose();
        return;
      }

      const emitLines = (chunk: Buffer, type: "stdout" | "stderr") => {
        const text = chunk.toString("utf8");
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.length === 0) continue;
          safeEnqueue({ type, line });
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => emitLines(chunk, "stdout"));
      child.stderr?.on("data", (chunk: Buffer) => emitLines(chunk, "stderr"));

      child.on("error", (err) => {
        safeEnqueue({ type: "error", message: `child error: ${err.message}` });
        safeClose();
      });

      child.on("exit", (code, signal) => {
        if (signal) {
          safeEnqueue({ type: "error", message: `aborted (killed by ${signal})` });
        }
        safeEnqueue({
          type: "exit",
          code: code ?? -1,
          durationMs: Date.now() - started,
        });
        if (child) clearChild(command, child);
        safeClose();
      });
    },

    cancel() {
      // Stream cancelled by client. Child cleanup happens via process exit.
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
}
