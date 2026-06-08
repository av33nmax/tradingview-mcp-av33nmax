"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export type PendingPrompt = {
  ticker: string;
  triggerType?: "A" | "B" | "A_SNIPER";
  subType?: string | null; // 'VWAP' | 'EMA21_1H' for B
  direction: "CALLS" | "PUTS";
  strike: number;
  expiry: string;
  qty: number;
  premiumEst: number;        // fresh option mid (re-queried at fire time)
  premiumCached?: number;    // pre-warm cache value, for drift visibility
  premiumStale?: boolean;    // true if fresh re-query failed; premiumEst fell back to cached
  underlyingEntry: number;
  stop: number;
  T1: number;
  T2: number | null;
  atr15?: number | null;     // 15m ATR at fire time — context for stop width
  stopDistance?: number;     // |entry - stop| on the underlying
  atrMultiple?: number | null; // stopDistance / atr15
  riskUsd?: number;          // qty × premiumEst × 100
  bracket: { t1: number; stop: number } | null;
  createdAt: number;
};

export type LastCheck = {
  triggered: boolean;
  reason: string;
  triggerType?: "A" | "B" | "A_SNIPER";
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

export type ExitReason = "trade_cap" | null;

/**
 * Watcher's runtime view of entry_notes (from the `__LOADED_LEVELS__`
 * marker emitted at boot and on hot-reload). Use this — not the on-disk
 * file — when rendering "what the watcher will fire on" to avoid the
 * 2026-04-30 SPY-style chart-vs-watcher divergence.
 */
export type LoadedLevels = {
  ticker: string;
  direction: "CALLS" | "PUTS";
  entry: number;
  trigger_a: { entry: number; stop: number; T1: number; T2: number | null } | null;
  trigger_b: { entry_vwap?: number; entry_ema21_1H?: number; stop?: number; T1?: number; T2?: number | null } | null;
  auroraZoneCount: number;
  generatedAt: string | null;
};

export type WatcherState = {
  ticker: string;
  status: WatcherStatus;
  startedAt: number | null;
  untilStr: string | null;
  exitCode: number | null;
  exitReason: ExitReason;
  loadedLevels: LoadedLevels | null;
  lastCheck: LastCheck | null;
  /**
   * Rolling buffer of every __CHECK__ marker the watcher has emitted this
   * session, oldest first, capped at 30. Used by WatcherTape to show the
   * full validation history. lastCheck is just the most recent of these.
   */
  checks: LastCheck[];
  pendingPrompt: PendingPrompt | null;
  recentLines: RecentLine[];
  isSimulated?: boolean;
};

const MAX_CHECKS = 30;

function deriveChecks(recentOutput: Array<{ type: string; at: number; data?: unknown }> | undefined): LastCheck[] {
  if (!recentOutput) return [];
  const out: LastCheck[] = [];
  for (const l of recentOutput) {
    if (l.type !== "check" || !l.data) continue;
    const d = l.data as { triggered?: boolean; reason?: string; close?: number; rVol?: number; barTime?: string; triggerType?: "A" | "B" | "A_SNIPER" };
    out.push({
      triggered: !!d.triggered,
      reason: String(d.reason ?? ""),
      triggerType: d.triggerType === "A" || d.triggerType === "B" || d.triggerType === "A_SNIPER" ? d.triggerType : undefined,
      close: typeof d.close === "number" ? d.close : undefined,
      rVol: typeof d.rVol === "number" ? d.rVol : undefined,
      barTime: typeof d.barTime === "string" ? d.barTime : undefined,
      at: l.at,
    });
  }
  return out.slice(-MAX_CHECKS);
}

export type RecentLine = {
  id: number;
  type: string;
  text: string;
  at: number;
};

type WatcherMap = Record<string, WatcherState>;

type StartOpts = { until?: string; testFire?: boolean; trailingRunner?: boolean };

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
  exitReason: null,
  loadedLevels: null,
  lastCheck: null,
  checks: [],
  pendingPrompt: null,
  recentLines: [],
});

export function WatcherRunnerProvider({ children }: { children: React.ReactNode }) {
  const [watchers, setWatchers] = useState<WatcherMap>({});
  // Single multiplexed EventSource for ALL tickers. Replaces the previous
  // Map<ticker, EventSource> pattern that opened one stream per active
  // watcher and pinned all of Safari's HTTP/1.1 6-per-host connection slots,
  // causing confirm/stop POSTs to queue forever (anchor 2026-05-07).
  const streamRef = useRef<EventSource | null>(null);

  const mutate = useCallback((ticker: string, patch: Partial<WatcherState>) => {
    setWatchers((prev) => ({
      ...prev,
      [ticker]: { ...(prev[ticker] ?? idleState(ticker)), ...patch },
    }));
  }, []);

  // Apply a server-side snapshot to a single ticker's client state. Shared
  // by both the multiplex stream's snapshot-all event and the 15s status
  // poll's reconciliation path.
  type ServerSnapshot = {
    ticker: string;
    status?: WatcherStatus;
    startedAt?: number;
    untilStr?: string;
    exitCode?: number | null;
    exitReason?: ExitReason;
    loadedLevels?: LoadedLevels | null;
    lastCheck?: LastCheck | null;
    pendingPrompt?: PendingPrompt | null;
    recentOutput?: Array<{ id: number; type: string; text: string; at: number; data?: unknown }>;
  };
  const applySnapshot = useCallback((snap: ServerSnapshot) => {
    if (!snap?.ticker) return;
    setWatchers((prev) => ({
      ...prev,
      [snap.ticker]: {
        ticker: snap.ticker,
        status: snap.status ?? "idle",
        startedAt: snap.startedAt ?? null,
        untilStr: snap.untilStr ?? null,
        exitCode: snap.exitCode ?? null,
        exitReason: snap.exitReason ?? null,
        loadedLevels: snap.loadedLevels ?? null,
        lastCheck: snap.lastCheck ?? null,
        checks: deriveChecks(snap.recentOutput),
        pendingPrompt: snap.pendingPrompt ?? null,
        recentLines: (snap.recentOutput ?? []).map((l) => ({
          id: l.id, type: l.type, text: l.text, at: l.at,
        })),
      },
    }));
  }, []);

  // Apply an incremental line event to a ticker's client state. Same
  // logic as before but now driven by a `ticker` parameter instead of a
  // closure variable, since the multiplex stream delivers events for every
  // ticker through a single handler.
  const applyLine = useCallback(
    (ticker: string, line: { id: number; type: string; text: string; at: number; data?: unknown }) => {
      setWatchers((prev) => {
        const cur = prev[ticker] ?? idleState(ticker);
        const recentLines = [...cur.recentLines, { id: line.id, type: line.type, text: line.text, at: line.at }].slice(-80);
        const update: Partial<WatcherState> = { recentLines };
        if (line.type === "check" && line.data) {
          const d = line.data as { triggered: boolean; reason: string; close?: number; rVol?: number; barTime?: string; triggerType?: "A" | "B" | "A_SNIPER" };
          const check: LastCheck = {
            triggered: !!d.triggered,
            reason: d.reason,
            triggerType: d.triggerType === "A" || d.triggerType === "B" || d.triggerType === "A_SNIPER" ? d.triggerType : undefined,
            close: d.close,
            rVol: d.rVol,
            barTime: d.barTime,
            at: line.at,
          };
          update.lastCheck = check;
          update.checks = [...cur.checks, check].slice(-MAX_CHECKS);
        } else if (line.type === "prompt" && line.data) {
          const d = line.data as Omit<PendingPrompt, "ticker" | "createdAt"> & { ticker?: string };
          update.status = "pending-confirm";
          update.pendingPrompt = {
            ticker,
            triggerType: d.triggerType ?? "A",
            subType: d.subType ?? null,
            direction: d.direction,
            strike: d.strike,
            expiry: d.expiry,
            qty: d.qty,
            premiumEst: d.premiumEst,
            premiumCached: d.premiumCached,
            premiumStale: d.premiumStale,
            underlyingEntry: d.underlyingEntry,
            stop: d.stop,
            T1: d.T1,
            T2: d.T2 ?? null,
            atr15: d.atr15 ?? null,
            stopDistance: d.stopDistance,
            atrMultiple: d.atrMultiple ?? null,
            riskUsd: d.riskUsd,
            bracket: d.bracket ?? null,
            createdAt: line.at,
          };
        } else if (line.type === "info" && line.data && typeof line.text === "string" && line.text.startsWith("__LOADED_LEVELS__ ")) {
          // Watcher's runtime entry_notes snapshot — refresh client view
          // so ticker cards can render what the watcher will fire on,
          // not what's on disk. Fixes 2026-04-30 SPY divergence bug.
          update.loadedLevels = line.data as LoadedLevels;
        } else if (line.type === "exit") {
          update.status = "exited";
        } else if (line.type === "error") {
          update.status = "error";
        }
        return { ...prev, [ticker]: { ...cur, ...update } };
      });
    },
    [],
  );

  // Open the single multiplexed stream that delivers events for every
  // ticker. Idempotent — safe to call multiple times.
  const attachMultiplexStream = useCallback(() => {
    if (streamRef.current) return;
    const es = new EventSource("/api/watcher/stream");
    streamRef.current = es;

    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        if (evt.type === "snapshot-all" && Array.isArray(evt.snapshots)) {
          for (const snap of evt.snapshots) applySnapshot(snap as ServerSnapshot);
        } else if (evt.type === "line" && typeof evt.ticker === "string" && evt.line) {
          applyLine(evt.ticker, evt.line);
        }
      } catch (err) {
        console.warn("[watcher stream] malformed SSE event", err);
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects. If permanently closed, we'll get an
      // error burst — that's fine, the reconnect will handle it.
    };
  }, [applySnapshot, applyLine]);

  // On mount, open the multiplex SSE stream and start the 15s status poll
  // safety net. Anchor case 2026-04-30 QQQ: server transitioned to
  // status=exited after trade_cap was hit, but the dashboard ticker card
  // kept showing "Watching · 31m 20s" — SSE exit event was missed/dropped
  // client-side. Periodic reconciliation catches that.
  useEffect(() => {
    let mounted = true;

    // Single multiplex stream for all tickers — replaces the prior per-ticker
    // EventSource pool that saturated Safari's HTTP/1.1 connection limit.
    attachMultiplexStream();

    type StatusSnap = {
      ticker: string;
      status: WatcherStatus;
      startedAt?: number;
      untilStr?: string;
      exitCode?: number | null;
      exitReason?: ExitReason;
      loadedLevels?: LoadedLevels | null;
      lastCheck?: LastCheck | null;
      pendingPrompt?: PendingPrompt | null;
      recentOutput?: Array<{ id: number; type: string; text: string; at: number; data?: unknown }>;
    };

    const reconcileFromSnapshot = (snap: StatusSnap) => {
      if (!snap?.ticker) return;
      setWatchers((prev) => {
        const cur = prev[snap.ticker];
        // If client thinks watcher is active but server says exited/error,
        // ALWAYS overwrite — this is the bug-fix path. Otherwise, only
        // overwrite if we don't already have this state (avoid clobbering
        // SSE-streamed updates).
        const clientThinksActive = cur && (cur.status === "running" || cur.status === "starting" || cur.status === "pending-confirm");
        const serverExited = snap.status === "exited" || snap.status === "error";
        const shouldUpdate = !cur || (clientThinksActive && serverExited) || cur.status !== snap.status;
        if (!shouldUpdate) return prev;
        return {
          ...prev,
          [snap.ticker]: {
            ticker: snap.ticker,
            status: snap.status,
            startedAt: snap.startedAt ?? null,
            untilStr: snap.untilStr ?? null,
            exitCode: snap.exitCode ?? null,
            exitReason: snap.exitReason ?? null,
            loadedLevels: snap.loadedLevels ?? cur?.loadedLevels ?? null,
            lastCheck: snap.lastCheck ?? cur?.lastCheck ?? null,
            checks: deriveChecks(snap.recentOutput) ?? cur?.checks ?? [],
            pendingPrompt: snap.pendingPrompt ?? null,
            recentLines: (snap.recentOutput ?? []).map((l: { id: number; type: string; text: string; at: number }) => ({
              id: l.id, type: l.type, text: l.text, at: l.at,
            })),
          },
        };
      });
    };

    const pollOnce = async () => {
      try {
        const res = await fetch("/api/watcher/status", { cache: "no-store" });
        const json = await res.json();
        if (!mounted || !json?.ok) return;
        for (const snap of json.watchers ?? []) {
          reconcileFromSnapshot(snap as StatusSnap);
        }
      } catch {
        // ignore — transient fetch failure, next poll will retry
      }
    };

    pollOnce();                                         // initial fetch
    const id = setInterval(pollOnce, 15_000);           // 15s safety-net poll

    return () => {
      mounted = false;
      clearInterval(id);
      // Don't close the stream on unmount — user may still want it when
      // they re-mount in a different render cycle. The 12-hour server-side
      // backstop and dead-controller detection keep abandoned streams from
      // leaking forever.
    };
  }, [attachMultiplexStream]);

  const start = useCallback(async (ticker: string, opts: StartOpts = {}) => {
    // Default = 02:00 SGT = 14:00 ET, matches trade_window.mjs internal
    // TIME_STOP_ET (=14:00). Previous default "23:00 SGT" = 11:00 ET cut
    // the firing window 2h45m short. Change 2026-05-18 after user noticed
    // SPY watcher would exit ~1h15m after RTH open.
    const untilStr = opts.until ?? "02:00";
    const testFire = !!opts.testFire;
    const trailingRunner = !!opts.trailingRunner;
    mutate(ticker, { status: "starting" });
    try {
      const res = await fetch("/api/watcher/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, until: untilStr, testFire, trailingRunner }),
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
      // No per-ticker attachStream — the multiplex stream opened on mount
      // already delivers events for every newly-registered watcher via the
      // server-side globalSubscribers fan-out.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      mutate(ticker, { status: "error", recentLines: [{ id: Date.now(), type: "error", text: message, at: Date.now() }] });
    }
  }, [mutate]);

  // Helper: append a visible error line to a ticker's recent output so the
  // user sees fetch failures instead of staring at silently-stuck UI.
  // Used by stop() and confirm() to surface timeouts/errors that previously
  // only logged to console.warn (invisible to most users).
  const appendErrorLine = useCallback((ticker: string, message: string) => {
    setWatchers((prev) => {
      const cur = prev[ticker];
      if (!cur) return prev;
      return {
        ...prev,
        [ticker]: {
          ...cur,
          recentLines: [
            ...cur.recentLines,
            { id: Date.now(), type: "error", text: `⚠ ${message}`, at: Date.now() },
          ].slice(-80),
        },
      };
    });
  }, []);

  const stop = useCallback(async (ticker: string) => {
    // 5s timeout via AbortController. Without it, Safari's 6-connection-per-host
    // HTTP/1.1 limit can stall this fetch indefinitely once 6 watcher
    // EventSource streams are open — the POST queues forever waiting for a
    // free slot, the await never returns, and the Stop button stays stuck on
    // "Stopping…" forever (anchor case 2026-05-07 night session).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch("/api/watcher/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`server returned ${res.status} ${body.slice(0, 80)}`);
      }
      // No detach needed — the multiplex stream stays open for the lifetime
      // of the page; the watcher's "exit" line will arrive through it and
      // the client state transitions accordingly.
    } catch (err) {
      const isAbort = (err as Error)?.name === "AbortError";
      const message = isAbort
        ? "stop request timed out after 5s — try hard-refresh (Cmd-Shift-R), or curl POST /api/watcher/stop from a terminal as fallback"
        : `stop failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error("[watcher stop]", ticker, message);
      appendErrorLine(ticker, message);
    } finally {
      clearTimeout(timer);
    }
  }, [appendErrorLine]);

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

    // 5s timeout via AbortController. Same connection-limit hazard as stop():
    // with 6 EventSource streams open, the confirm POST can queue forever and
    // leave the modal stuck on "Firing…" — anchor case 2026-05-07 morning,
    // AAPL + IWM both stuck waiting on this fetch. On timeout, surface a
    // visible error to the user and *do not* clear pendingPrompt — they need
    // to know whether to retry or check TWS to see if the trade actually
    // placed. The 15s status poll will reconcile real state shortly.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`/api/watcher/confirm/${ticker}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`server returned ${res.status} ${body.slice(0, 80)}`);
      }
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
      const isAbort = (err as Error)?.name === "AbortError";
      const message = isAbort
        ? `confirm timed out after 5s. CHECK TWS to see if the order actually placed before retrying — a duplicate retry could fire a second order. The 15s poll will sync UI shortly. Hard-refresh (Cmd-Shift-R) clears stale connections.`
        : `confirm failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error("[watcher confirm]", ticker, answer, message);
      appendErrorLine(ticker, message);
      // Do NOT clear pendingPrompt on error — user might need to retry, or
      // the server might still be processing. Modal stays open intentionally.
    } finally {
      clearTimeout(timer);
    }
  }, [watchers, appendErrorLine]);

  const simulateTrigger = useCallback((ticker: string) => {
    const fakePrompt: PendingPrompt = {
      ticker,
      triggerType: "A",
      subType: null,
      direction: "CALLS",
      strike: ticker === "SPY" ? 713 : 660,
      expiry: "20260424",
      qty: 3,
      premiumEst: 0.89,
      underlyingEntry: ticker === "SPY" ? 710.40 : 649.09,
      stop: ticker === "SPY" ? 707.07 : 646.79,
      T1: ticker === "SPY" ? 711.98 : 652.28,
      T2: ticker === "SPY" ? 713.36 : 655.47,
      atr15: ticker === "SPY" ? 1.85 : 1.20,
      stopDistance: ticker === "SPY" ? 3.33 : 2.30,
      atrMultiple: ticker === "SPY" ? 1.80 : 1.92,
      riskUsd: 267,
      premiumCached: 0.85,
      premiumStale: false,
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
        untilStr: "02:00",
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
