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

const IDLE: CommandState = { kind: "idle" };

type CommandRunnerContextValue = {
  stateOf: (command: string) => CommandState;
  outputOf: (command: string) => OutputLine[];
  run: (command: string) => void;
  abort: (command: string) => Promise<void>;
  clear: (command: string) => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  activeCommand: string | null;
  setActiveCommand: (command: string | null) => void;
};

const CommandRunnerContext = createContext<CommandRunnerContextValue | null>(null);

/**
 * Multi-command runner. Each command has its OWN state + output buffer and its
 * own SSE stream, so DIFFERENT commands run concurrently (all HK watchers at
 * once). The same command is single-flight (re-arm ignored while running). The
 * output drawer shows whichever command is `activeCommand`.
 *
 * Was single-flight globally until 2026-06-04 — that capped the dashboard at one
 * watcher at a time.
 */
export function CommandRunnerProvider({ children }: { children: React.ReactNode }) {
  const [states, setStates] = useState<Record<string, CommandState>>({});
  const [outputs, setOutputs] = useState<Record<string, OutputLine[]>>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeCommand, setActiveCommand] = useState<string | null>(null);
  const controllers = useRef<Map<string, AbortController>>(new Map());
  const idRef = useRef(0);

  const stateOf = useCallback(
    (command: string): CommandState => states[command] ?? IDLE,
    [states],
  );
  const outputOf = useCallback(
    (command: string): OutputLine[] => outputs[command] ?? [],
    [outputs],
  );

  const setCmdState = useCallback((command: string, s: CommandState) => {
    setStates((prev) => ({ ...prev, [command]: s }));
  }, []);

  const appendTo = useCallback((command: string, line: Omit<OutputLine, "id" | "at">) => {
    setOutputs((prev) => ({
      ...prev,
      [command]: [...(prev[command] ?? []), { ...line, id: ++idRef.current, at: Date.now() }],
    }));
  }, []);

  const clear = useCallback(
    (command: string) => {
      setOutputs((prev) => ({ ...prev, [command]: [] }));
      setCmdState(command, IDLE);
    },
    [setCmdState],
  );

  const abort = useCallback(
    async (command: string) => {
      appendTo(command, { type: "info", text: "⏹ sending abort signal..." });
      try {
        await fetch(`/api/run/abort?command=${encodeURIComponent(command)}`, { method: "POST" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendTo(command, { type: "error", text: `abort request failed: ${message}` });
      }
      controllers.current.get(command)?.abort();
      // Fallback: if the server never confirms exit via SSE, force a clean done.
      setTimeout(() => {
        setStates((prev) => {
          const s = prev[command];
          if (s?.kind !== "running") return prev;
          return {
            ...prev,
            [command]: { kind: "done", command: s.command, label: s.label, exitCode: -1, durationMs: Date.now() - s.startedAt },
          };
        });
      }, 4000);
    },
    [appendTo],
  );

  const run = useCallback(
    async (command: string) => {
      // Same command is single-flight; different commands run concurrently.
      if (controllers.current.has(command)) {
        console.warn(`[runner] ${command}: ignored — already running`);
        // Still focus the drawer on it so the click feels responsive.
        setActiveCommand(command);
        setDrawerOpen(true);
        return;
      }

      const controller = new AbortController();
      controllers.current.set(command, controller);

      setOutputs((prev) => ({ ...prev, [command]: [] }));
      setCmdState(command, { kind: "running", command, label: command, startedAt: Date.now() });
      setActiveCommand(command);
      setDrawerOpen(true);

      let terminalReceived = false;
      let firstChunkReceived = false;

      const NO_EVENT_TIMEOUT_MS = 15000;
      const watchdog = setTimeout(() => {
        if (firstChunkReceived) return;
        console.error(`[runner] ${command}: no SSE chunk within ${NO_EVENT_TIMEOUT_MS}ms — aborting`);
        controller.abort();
      }, NO_EVENT_TIMEOUT_MS);

      console.log(`[runner] ${command}: starting`);

      try {
        const res = await fetch(`/api/run/${command}`, {
          method: "GET",
          signal: controller.signal,
          headers: { Accept: "text/event-stream" },
        });

        if (!res.body) {
          terminalReceived = true;
          setCmdState(command, { kind: "error", command, label: command, message: `no response body from server (status ${res.status})` });
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!firstChunkReceived) firstChunkReceived = true;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";

          for (const evtBlock of events) {
            const line = evtBlock.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.type === "start") {
                setCmdState(command, { kind: "running", command: evt.command, label: evt.label, startedAt: Date.now() });
                appendTo(command, { type: "info", text: `▶ ${evt.label}` });
              } else if (evt.type === "stdout") {
                appendTo(command, { type: "stdout", text: evt.line });
              } else if (evt.type === "stderr") {
                appendTo(command, { type: "stderr", text: evt.line });
              } else if (evt.type === "exit") {
                terminalReceived = true;
                const ok = evt.code === 0;
                const sec = (evt.durationMs / 1000).toFixed(1);
                appendTo(command, {
                  type: ok ? "info" : "error",
                  text: ok ? `✓ completed in ${sec}s` : `✗ exited with code ${evt.code} after ${sec}s`,
                });
                setStates((prev) => {
                  const s = prev[command];
                  if (s?.kind !== "running") return prev;
                  return { ...prev, [command]: { kind: "done", command: s.command, label: s.label, exitCode: evt.code, durationMs: evt.durationMs } };
                });
              } else if (evt.type === "error") {
                terminalReceived = true;
                appendTo(command, { type: "error", text: evt.message });
                setStates((prev) => {
                  const s = prev[command];
                  const label = s && s.kind !== "idle" ? s.label : command;
                  return { ...prev, [command]: { kind: "error", command, label, message: evt.message } };
                });
              }
            } catch (err) {
              console.warn("[runner] malformed SSE event", err);
            }
          }
        }

        // Stream closed without a terminal event — force a transition so the UI
        // can recover without a refresh.
        if (!terminalReceived) {
          const message = firstChunkReceived
            ? "stream ended without exit/error event (server may have crashed mid-run)"
            : "no SSE chunks received before stream closed (route mismatch, server crashed, or response was buffered)";
          appendTo(command, { type: "error", text: message });
          setStates((prev) => {
            const s = prev[command];
            if (s?.kind !== "running") return prev;
            return { ...prev, [command]: { kind: "error", command, label: s.label, message } };
          });
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          if (!terminalReceived) {
            const message = firstChunkReceived
              ? "run aborted (manual or watchdog after stream stalled)"
              : `no SSE chunks within ${NO_EVENT_TIMEOUT_MS / 1000}s — aborted by client watchdog. Check the server log.`;
            appendTo(command, { type: "error", text: message });
            setStates((prev) => {
              const s = prev[command];
              if (s?.kind !== "running") return prev;
              return { ...prev, [command]: { kind: "error", command, label: s.label, message } };
            });
          }
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[runner] ${command}: fetch threw`, err);
        appendTo(command, { type: "error", text: message });
        setCmdState(command, { kind: "error", command, label: command, message });
      } finally {
        clearTimeout(watchdog);
        controllers.current.delete(command);
      }
    },
    [appendTo, setCmdState],
  );

  const value = useMemo(
    () => ({ stateOf, outputOf, run, abort, clear, drawerOpen, setDrawerOpen, activeCommand, setActiveCommand }),
    [stateOf, outputOf, run, abort, clear, drawerOpen, activeCommand],
  );

  return <CommandRunnerContext.Provider value={value}>{children}</CommandRunnerContext.Provider>;
}

export function useCommandRunner() {
  const ctx = useContext(CommandRunnerContext);
  if (!ctx) throw new Error("useCommandRunner must be used within CommandRunnerProvider");
  return ctx;
}
