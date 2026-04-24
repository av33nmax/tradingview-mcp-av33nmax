"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export type PendingPrompt = {
  ticker: string;
  direction: "CALLS" | "PUTS";
  strike: number;
  expiry: string;
  qty: number;
  premiumEst: number;
  underlyingEntry: number;
  stop: number;
  T1: number;
  T2: number | null;
  bracket: { t1: number; stop: number } | null;
  createdAt: number;
};

export type LastCheck = {
  triggered: boolean;
  reason: string;
  close?: number;
  rVol?: number;
  barTime?: string;
  at: number;
};

export type WatcherStatus =
  | "idle"
  | "starting"
  | "running"
  | "pending-confirm"
  | "exited"
  | "error";

export type WatcherState = {
  ticker: string;
  status: WatcherStatus;
  startedAt: number | null;
  untilStr: string | null;
  exitCode: number | null;
  lastCheck: LastCheck | null;
  pendingPrompt: PendingPrompt | null;
  recentLines: RecentLine[];
  isSimulated?: boolean;
};

export type RecentLine = {
  id: number;
  type: string;
  text: string;
  at: number;
};

type WatcherMap = Record<string, WatcherState>;

type StartOpts = { until?: string; testFire?: boolean };

type WatcherRunnerContextValue = {
  watchers: WatcherMap;
  start: (ticker: string, opts?: StartOpts) => Promise<void>;
  stop: (ticker: string) => Promise<void>;
  confirm: (ticker: string, answer: "YES" | "no") => Promise<void>;
  simulateTrigger: (ticker: string) => void;
};

const WatcherRunnerContext = createContext<WatcherRunnerContextValue | null>(null);

const idleState = (ticker: string): WatcherState => ({
  ticker,
  status: "idle",
  startedAt: null,
  untilStr: null,
  exitCode: null,
  lastCheck: null,
  pendingPrompt: null,
  recentLines: [],
});

export function WatcherRunnerProvider({ children }: { children: React.ReactNode }) {
  const [watchers, setWatchers] = useState<WatcherMap>({});
  const streamsRef = useRef<Map<string, EventSource>>(new Map());

  const mutate = useCallback((ticker: string, patch: Partial<WatcherState>) => {
    setWatchers((prev) => ({
      ...prev,
      [ticker]: { ...(prev[ticker] ?? idleState(ticker)), ...patch },
    }));
  }, []);

  const attachStream = useCallback((ticker: string) => {
    // Don't double-attach
    if (streamsRef.current.has(ticker)) return;

    const es = new EventSource(`/api/watcher/stream/${ticker}`);
    streamsRef.current.set(ticker, es);

    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        if (evt.type === "snapshot") {
          const snap = evt.snapshot;
          if (!snap) return;
          setWatchers((prev) => ({
            ...prev,
            [ticker]: {
              ticker,
              status: snap.status ?? "idle",
              startedAt: snap.startedAt ?? null,
              untilStr: snap.untilStr ?? null,
              exitCode: snap.exitCode ?? null,
              lastCheck: snap.lastCheck ?? null,
              pendingPrompt: snap.pendingPrompt ?? null,
              recentLines: (snap.recentOutput ?? []).map((l: { id: number; type: string; text: string; at: number }) => ({
                id: l.id, type: l.type, text: l.text, at: l.at,
              })),
            },
          }));
        } else if (evt.type === "line") {
          const line = evt.line as { id: number; type: string; text: string; at: number; data?: unknown };
          setWatchers((prev) => {
            const cur = prev[ticker] ?? idleState(ticker);
            const recentLines = [...cur.recentLines, { id: line.id, type: line.type, text: line.text, at: line.at }].slice(-80);
            let update: Partial<WatcherState> = { recentLines };
            if (line.type === "check" && line.data) {
              const d = line.data as { triggered: boolean; reason: string; close?: number; rVol?: number; barTime?: string };
              update.lastCheck = {
                triggered: !!d.triggered,
                reason: d.reason,
                close: d.close,
                rVol: d.rVol,
                barTime: d.barTime,
                at: line.at,
              };
            } else if (line.type === "prompt" && line.data) {
              const d = line.data as Omit<PendingPrompt, "ticker" | "createdAt"> & { ticker?: string };
              update.status = "pending-confirm";
              update.pendingPrompt = {
                ticker,
                direction: d.direction,
                strike: d.strike,
                expiry: d.expiry,
                qty: d.qty,
                premiumEst: d.premiumEst,
                underlyingEntry: d.underlyingEntry,
                stop: d.stop,
                T1: d.T1,
                T2: d.T2 ?? null,
                bracket: d.bracket ?? null,
                createdAt: line.at,
              };
            } else if (line.type === "exit") {
              update.status = "exited";
            } else if (line.type === "error") {
              update.status = "error";
            }
            return { ...prev, [ticker]: { ...cur, ...update } };
          });
        }
      } catch (err) {
        console.warn("malformed watcher SSE event", err);
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects. If permanently closed, we'll get an
      // error burst — that's fine, the reconnect will handle it.
    };
  }, []);

  const detachStream = useCallback((ticker: string) => {
    const es = streamsRef.current.get(ticker);
    if (es) {
      es.close();
      streamsRef.current.delete(ticker);
    }
  }, []);

  // On mount, fetch /api/watcher/status to discover any in-flight watchers
  // and auto-attach SSE streams so user doesn't lose state across tab reloads.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch("/api/watcher/status", { cache: "no-store" });
        const json = await res.json();
        if (!mounted || !json?.ok) return;
        for (const snap of json.watchers ?? []) {
          if (!snap?.ticker) continue;
          const isActive = snap.status === "running" || snap.status === "starting" || snap.status === "pending-confirm";
          setWatchers((prev) => ({
            ...prev,
            [snap.ticker]: {
              ticker: snap.ticker,
              status: snap.status,
              startedAt: snap.startedAt,
              untilStr: snap.untilStr,
              exitCode: snap.exitCode,
              lastCheck: snap.lastCheck,
              pendingPrompt: snap.pendingPrompt,
              recentLines: (snap.recentOutput ?? []).map((l: { id: number; type: string; text: string; at: number }) => ({
                id: l.id, type: l.type, text: l.text, at: l.at,
              })),
            },
          }));
          if (isActive) attachStream(snap.ticker);
        }
      } catch {
        // ignore — just means dashboard loads with no watchers
      }
    })();
    const streams = streamsRef.current;
    return () => {
      mounted = false;
      // Don't close streams on unmount — user may still want them when they
      // re-mount in a different render cycle
      void streams;
    };
  }, [attachStream]);

  const start = useCallback(async (ticker: string, opts: StartOpts = {}) => {
    const untilStr = opts.until ?? "23:00";
    const testFire = !!opts.testFire;
    mutate(ticker, { status: "starting" });
    try {
      const res = await fetch("/api/watcher/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, until: untilStr, testFire }),
      });
      const json = await res.json();
      if (!json.ok) {
        mutate(ticker, { status: "error", recentLines: [{ id: Date.now(), type: "error", text: json.error ?? "start failed", at: Date.now() }] });
        return;
      }
      mutate(ticker, {
        status: "running",
        startedAt: json.startedAt,
        untilStr: json.untilStr,
      });
      attachStream(ticker);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      mutate(ticker, { status: "error", recentLines: [{ id: Date.now(), type: "error", text: message, at: Date.now() }] });
    }
  }, [mutate, attachStream]);

  const stop = useCallback(async (ticker: string) => {
    try {
      await fetch("/api/watcher/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
      });
      // Stream will emit "exit" line and detach itself via server cleanup
      // Detach local ES too so we don't reconnect on reattach
      setTimeout(() => detachStream(ticker), 1000);
    } catch (err) {
      console.warn("stop failed", err);
    }
  }, [detachStream]);

  const confirm = useCallback(async (ticker: string, answer: "YES" | "no") => {
    const current = watchers[ticker];
    const isSim = !!current?.isSimulated;

    // For simulated triggers, just clear the modal locally — no server call
    if (isSim) {
      setWatchers((prev) => {
        const cur = prev[ticker];
        if (!cur) return prev;
        return {
          ...prev,
          [ticker]: {
            ...cur,
            pendingPrompt: null,
            status: "exited",
            exitCode: 0,
            recentLines: [
              ...cur.recentLines,
              {
                id: Date.now(),
                type: "info",
                text: answer === "YES"
                  ? "✓ SIMULATED: YES confirmed (no real order placed)"
                  : "✗ SIMULATED: aborted",
                at: Date.now(),
              },
            ],
            isSimulated: false,
          },
        };
      });
      return;
    }

    try {
      await fetch(`/api/watcher/confirm/${ticker}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      });
      // Optimistically clear the prompt — server will send line events that
      // reconfirm this via the SSE stream.
      setWatchers((prev) => {
        const cur = prev[ticker];
        if (!cur) return prev;
        return {
          ...prev,
          [ticker]: {
            ...cur,
            pendingPrompt: null,
            status: answer === "YES" ? "running" : "running",
          },
        };
      });
    } catch (err) {
      console.warn("confirm failed", err);
    }
  }, [watchers]);

  const simulateTrigger = useCallback((ticker: string) => {
    const fakePrompt: PendingPrompt = {
      ticker,
      direction: "CALLS",
      strike: ticker === "SPY" ? 713 : 660,
      expiry: "20260424",
      qty: 3,
      premiumEst: 0.89,
      underlyingEntry: ticker === "SPY" ? 710.40 : 649.09,
      stop: ticker === "SPY" ? 707.07 : 646.79,
      T1: ticker === "SPY" ? 711.98 : 652.28,
      T2: ticker === "SPY" ? 713.36 : 655.47,
      bracket: {
        t1: ticker === "SPY" ? 711.98 : 652.28,
        stop: ticker === "SPY" ? 707.07 : 646.79,
      },
      createdAt: Date.now(),
    };
    setWatchers((prev) => ({
      ...prev,
      [ticker]: {
        ...(prev[ticker] ?? idleState(ticker)),
        ticker,
        status: "pending-confirm",
        startedAt: Date.now(),
        untilStr: "23:00",
        pendingPrompt: fakePrompt,
        isSimulated: true,
      },
    }));
  }, []);

  const value = useMemo(
    () => ({ watchers, start, stop, confirm, simulateTrigger }),
    [watchers, start, stop, confirm, simulateTrigger],
  );

  return <WatcherRunnerContext.Provider value={value}>{children}</WatcherRunnerContext.Provider>;
}

export function useWatcherRunner() {
  const ctx = useContext(WatcherRunnerContext);
  if (!ctx) throw new Error("useWatcherRunner must be used within WatcherRunnerProvider");
  return ctx;
}

export function useWatcher(ticker: string): WatcherState {
  const { watchers } = useWatcherRunner();
  return watchers[ticker] ?? idleState(ticker);
}
