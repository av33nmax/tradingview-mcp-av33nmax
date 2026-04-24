"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

export type OutputLine = {
  id: number;
  type: "stdout" | "stderr" | "info" | "error";
  text: string;
  at: number;
};

export type CommandState =
  | { kind: "idle" }
  | { kind: "running"; command: string; label: string; startedAt: number }
  | { kind: "done"; command: string; label: string; exitCode: number | null; durationMs: number }
  | { kind: "error"; command: string; label: string; message: string };

type CommandRunnerContextValue = {
  state: CommandState;
  output: OutputLine[];
  run: (command: string) => void;
  abort: () => Promise<void>;
  clear: () => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
};

const CommandRunnerContext = createContext<CommandRunnerContextValue | null>(null);

export function CommandRunnerProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<CommandState>({ kind: "idle" });
  const [output, setOutput] = useState<OutputLine[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef(0);

  const append = useCallback((line: Omit<OutputLine, "id" | "at">) => {
    setOutput((prev) => [...prev, { ...line, id: ++idRef.current, at: Date.now() }]);
  }, []);

  const clear = useCallback(() => {
    setOutput([]);
    setState({ kind: "idle" });
  }, []);

  const abort = useCallback(async () => {
    if (state.kind !== "running") return;
    append({ type: "info", text: "⏹ sending abort signal..." });
    try {
      // Kill the server-side child process
      await fetch("/api/run/abort", { method: "POST" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      append({ type: "error", text: `abort request failed: ${message}` });
    }
    // Also abort the client-side fetch stream so the reader loop exits
    abortRef.current?.abort();
    // The server's child.on("exit") handler will emit a final exit event
    // via SSE — state transitions to "done" or "error" there. As a fallback
    // we force the state to a clean done here if the server never confirms.
    setTimeout(() => {
      setState((prev) =>
        prev.kind === "running"
          ? {
              kind: "done",
              command: prev.command,
              label: prev.label,
              exitCode: -1,
              durationMs: Date.now() - prev.startedAt,
            }
          : prev,
      );
    }, 4000);
  }, [state, append]);

  const run = useCallback(
    async (command: string) => {
      // Prevent parallel runs
      if (state.kind === "running") return;

      // Cancel any previous run (should be done, but safety)
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setOutput([]);
      setDrawerOpen(true);
      setState({ kind: "running", command, label: command, startedAt: Date.now() });

      try {
        const res = await fetch(`/api/run/${command}`, {
          method: "GET",
          signal: controller.signal,
          headers: { Accept: "text/event-stream" },
        });

        if (!res.body) {
          setState({
            kind: "error",
            command,
            label: command,
            message: "no response body from server",
          });
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // SSE events are separated by double-newline
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";

          for (const evtBlock of events) {
            const line = evtBlock.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.type === "start") {
                setState({
                  kind: "running",
                  command: evt.command,
                  label: evt.label,
                  startedAt: Date.now(),
                });
                append({ type: "info", text: `▶ ${evt.label}` });
              } else if (evt.type === "stdout") {
                append({ type: "stdout", text: evt.line });
              } else if (evt.type === "stderr") {
                append({ type: "stderr", text: evt.line });
              } else if (evt.type === "exit") {
                const ok = evt.code === 0;
                const sec = (evt.durationMs / 1000).toFixed(1);
                append({
                  type: ok ? "info" : "error",
                  text: ok
                    ? `✓ completed in ${sec}s`
                    : `✗ exited with code ${evt.code} after ${sec}s`,
                });
                setState((prev) =>
                  prev.kind === "running"
                    ? {
                        kind: "done",
                        command: prev.command,
                        label: prev.label,
                        exitCode: evt.code,
                        durationMs: evt.durationMs,
                      }
                    : prev,
                );
              } else if (evt.type === "error") {
                append({ type: "error", text: evt.message });
                setState((prev) => ({
                  kind: "error",
                  command: prev.kind === "idle" ? command : (prev as { command: string }).command,
                  label: prev.kind === "idle" ? command : (prev as { label: string }).label,
                  message: evt.message,
                }));
              }
            } catch (err) {
              // malformed SSE event — skip
              console.warn("malformed SSE event", err);
            }
          }
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        const message = err instanceof Error ? err.message : String(err);
        append({ type: "error", text: message });
        setState({ kind: "error", command, label: command, message });
      }
    },
    [state.kind, append],
  );

  const value = useMemo(
    () => ({ state, output, run, abort, clear, drawerOpen, setDrawerOpen }),
    [state, output, run, abort, clear, drawerOpen],
  );

  return (
    <CommandRunnerContext.Provider value={value}>{children}</CommandRunnerContext.Provider>
  );
}

export function useCommandRunner() {
  const ctx = useContext(CommandRunnerContext);
  if (!ctx) throw new Error("useCommandRunner must be used within CommandRunnerProvider");
  return ctx;
}
