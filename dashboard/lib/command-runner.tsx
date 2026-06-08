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
      if (state.kind === "running") {
        console.warn(`[runner] ${command}: ignored — already running`);
        return;
      }

      // Cancel any previous run (should be done, but safety)
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setOutput([]);
      setDrawerOpen(true);
      setState({ kind: "running", command, label: command, startedAt: Date.now() });

      // Track whether we received a terminal event (exit/error). Without this,
      // a clean stream end with no exit/error left the UI stuck on "running"
      // forever — the only recovery was a hard refresh. Now we force a state
      // transition in every exit path of the reader loop.
      let terminalReceived = false;
      let firstChunkReceived = false;

      // Watchdog: if no chunk arrives within 15s, abort. Catches Safari
      // ReadableStream buffering quirks, server hangs before "start", proxy
      // weirdness, etc. — failure cases that previously hung silently.
      const NO_EVENT_TIMEOUT_MS = 15000;
      const watchdog = setTimeout(() => {
        if (firstChunkReceived) return;
        console.error(
          `[runner] ${command}: no SSE chunk within ${NO_EVENT_TIMEOUT_MS}ms — aborting`,
        );
        controller.abort();
      }, NO_EVENT_TIMEOUT_MS);

      console.log(`[runner] ${command}: starting`);

      try {
        const res = await fetch(`/api/run/${command}`, {
          method: "GET",
          signal: controller.signal,
          headers: { Accept: "text/event-stream" },
        });
        console.log(
          `[runner] ${command}: response status=${res.status} hasBody=${!!res.body} ct=${res.headers.get("content-type")}`,
        );

        if (!res.body) {
          terminalReceived = true;
          setState({
            kind: "error",
            command,
            label: command,
            message: `no response body from server (status ${res.status})`,
          });
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          if (!firstChunkReceived) {
            firstChunkReceived = true;
            console.log(`[runner] ${command}: first chunk received`);
          }

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
                terminalReceived = true;
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
                terminalReceived = true;
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
              console.warn("[runner] malformed SSE event", err);
            }
          }
        }

        console.log(
          `[runner] ${command}: stream ended (terminalReceived=${terminalReceived}, firstChunk=${firstChunkReceived})`,
        );

        // Stream closed without a terminal event — the bug that left the UI
        // stuck on "running · Ns". Force a state transition so the user can
        // recover without refreshing.
        if (!terminalReceived) {
          const message = firstChunkReceived
            ? "stream ended without exit/error event (server may have crashed mid-run)"
            : "no SSE chunks received before stream closed (route mismatch, server crashed, or response was buffered)";
          append({ type: "error", text: message });
          setState((prev) =>
            prev.kind === "running"
              ? { kind: "error", command, label: command, message }
              : prev,
          );
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          // Aborted by user OR by the watchdog. Either way, if we never got
          // a terminal event, leave the UI with a clear error — not stuck on
          // "running".
          if (!terminalReceived) {
            const message = firstChunkReceived
              ? "run aborted (manual or watchdog after stream stalled)"
              : `no SSE chunks within ${NO_EVENT_TIMEOUT_MS / 1000}s — aborted by client watchdog. Server-side may have errored before sending any event; check the server log.`;
            append({ type: "error", text: message });
            setState((prev) =>
              prev.kind === "running"
                ? { kind: "error", command, label: command, message }
                : prev,
            );
          }
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[runner] ${command}: fetch threw`, err);
        append({ type: "error", text: message });
        setState({ kind: "error", command, label: command, message });
      } finally {
        clearTimeout(watchdog);
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
