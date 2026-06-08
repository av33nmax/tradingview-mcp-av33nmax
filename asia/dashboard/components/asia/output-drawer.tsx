"use client";

import { useEffect, useRef } from "react";
import { useCommandRunner, type CommandState } from "@/lib/command-runner";
import { X, Trash2, Square, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Bottom drawer that auto-opens when a command starts and shows live streaming
 * output. User can manually close it or click "Clear". A trailing "Abort"
 * button kills the running child if still active.
 */
export function OutputDrawer() {
  const { stateOf, outputOf, abort, clear, drawerOpen, setDrawerOpen, activeCommand } =
    useCommandRunner();
  const endRef = useRef<HTMLDivElement>(null);
  const state: CommandState = activeCommand ? stateOf(activeCommand) : { kind: "idle" };
  const output = activeCommand ? outputOf(activeCommand) : [];

  // Auto-scroll to bottom on new output
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [output.length]);

  if (!drawerOpen) return null;

  const running = state.kind === "running";
  const statusBadge =
    state.kind === "running" ? (
      <span className="flex items-center gap-1.5 text-emerald-400 text-xs">
        <Loader2 className="h-3 w-3 animate-spin" />
        running · {state.label}
      </span>
    ) : state.kind === "done" ? (
      <span
        className={cn(
          "text-xs",
          state.exitCode === 0 ? "text-emerald-400" : "text-rose-400"
        )}
      >
        {state.exitCode === 0 ? "✓ done" : `✗ exit ${state.exitCode}`} ·{" "}
        {(state.durationMs / 1000).toFixed(1)}s · {state.label}
      </span>
    ) : state.kind === "error" ? (
      <span className="text-rose-400 text-xs">✗ error · {state.message}</span>
    ) : (
      <span className="text-muted-foreground text-xs">idle</span>
    );

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 max-h-[50vh] border-t border-border bg-card shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-3">
          <h4 className="text-sm font-semibold">Command Output</h4>
          {statusBadge}
        </div>
        <div className="flex items-center gap-1.5">
          {running && (
            <button
              onClick={() => activeCommand && abort(activeCommand)}
              className="flex items-center gap-1 rounded-md border border-rose-500/30 bg-rose-500/10 text-rose-400 px-2 py-1 text-xs hover:bg-rose-500/20"
            >
              <Square className="h-3 w-3" />
              Abort
            </button>
          )}
          <button
            onClick={() => activeCommand && clear(activeCommand)}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
          >
            <Trash2 className="h-3 w-3" />
            Clear
          </button>
          <button
            onClick={() => setDrawerOpen(false)}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
          >
            <X className="h-3 w-3" />
            Close
          </button>
        </div>
      </div>

      {/* Output body */}
      <div className="overflow-y-auto max-h-[40vh] px-4 py-2 font-mono text-xs leading-relaxed">
        {output.length === 0 ? (
          <div className="text-muted-foreground italic py-4">
            No output yet.
          </div>
        ) : (
          output.map((line) => (
            <div
              key={line.id}
              className={cn(
                "whitespace-pre-wrap",
                line.type === "stderr" && "text-yellow-400",
                line.type === "error" && "text-rose-400",
                line.type === "info" && "text-sky-400"
              )}
            >
              {line.text}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
