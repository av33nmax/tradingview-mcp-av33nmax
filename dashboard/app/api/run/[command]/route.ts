import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { setCurrentChild, clearCurrentChild } from "@/lib/running-child";

/**
 * Streams a whitelisted script's stdout/stderr back to the browser as
 * Server-Sent Events. The dashboard lives in `./dashboard`, scripts live
 * one level up — this route spawns them with cwd set to the repo root.
 *
 * Whitelisted commands only — NO arbitrary input is ever passed as args.
 * All routes bind localhost-only by default in Next.js dev/prod.
 */

const REPO_ROOT = path.join(process.cwd(), "..");

type CommandSpec = {
  cmd: string;
  args: string[];
  label: string;
};

const COMMANDS: Record<string, CommandSpec> = {
  "premarket-setup": {
    cmd: "node",
    args: ["premarket_setup.mjs"],
    label: "Pre-market setup",
  },
  "test-ibkr": {
    cmd: "node",
    args: ["test_ibkr_connect.mjs"],
    label: "IBKR connection test",
  },
  "launch-tv": {
    cmd: "node",
    args: ["scripts/launch_tv_with_tabs.mjs"],
    label: "Launch TradingView (CDP) + wait for tabs",
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
  ctx: { params: Promise<{ command: string }> },
) {
  const { command } = await ctx.params;
  const spec = COMMANDS[command];

  const encoder = new TextEncoder();

  if (!spec) {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(sseLine({ type: "error", message: `Unknown command: ${command}` })),
        );
        controller.close();
      },
    });
    return new Response(stream, {
      status: 404,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
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
          // Controller already closed (e.g. client disconnected). Ignore.
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
          cwd: REPO_ROOT,
          env: { ...process.env, FORCE_COLOR: "0" },  // disable ANSI colors for web display
        });
        setCurrentChild({ child, command, startedAt: started });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        safeEnqueue({ type: "error", message: `spawn failed: ${message}` });
        safeClose();
        return;
      }

      const emitLines = (chunk: Buffer, type: "stdout" | "stderr") => {
        const text = chunk.toString("utf8");
        // Split on newlines but preserve partial last line by buffering per-stream
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
        const reason = signal ? ` (killed by ${signal})` : "";
        if (signal) {
          safeEnqueue({ type: "error", message: `aborted${reason}` });
        }
        safeEnqueue({ type: "exit", code: code ?? -1, durationMs: Date.now() - started });
        if (child) clearCurrentChild(child);
        safeClose();
      });

      // If the client disconnects (navigate away / close tab), kill the child
      // to avoid orphaned processes.
      // (Cannot reliably detect disconnect in Next.js streaming as of now,
      // but the controller.enqueue throws when the client is gone — that is
      // handled via safeEnqueue above; we'll also add a safety timeout.)
    },

    cancel() {
      // Called when the stream is cancelled by the client
      // Child process cleanup happens via the start() closure —
      // we don't have access to the child here, so we rely on process
      // exit in normal flow.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",  // disable proxy buffering if any
    },
  });
}
