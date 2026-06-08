import { type ChildProcess } from "node:child_process";

/**
 * Per-ticker watcher registry.
 *
 * Each ticker (SPY, QQQ) can have at most one active watcher at a time.
 * The watcher is a spawned `trade_window.mjs` child process. We keep its
 * recent output buffer server-side so the dashboard can reconnect to an
 * in-flight watcher (e.g. after a browser tab close/reopen) without
 * losing context.
 */

export type OutputLine = {
  id: number;
  type: "stdout" | "stderr" | "info" | "error" | "check" | "prompt" | "exit";
  text: string;
  at: number;
  // Parsed payload for structured events (from __CHECK__ / __PROMPT_YES__ markers)
  data?: unknown;
};

export type PendingPrompt = {
  ticker: string;
  triggerType?: "A" | "B" | "A_SNIPER";
  subType?: string | null; // 'VWAP' | 'EMA21_1H' for B, null for A
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

export type ExitReason = "trade_cap" | null;

/**
 * Watcher's runtime view of entry_notes (from `__LOADED_LEVELS__` marker
 * emitted at boot and on hot-reload). Dashboard prefers this over the
 * on-disk `latest_entry_notes.json` when rendering what the watcher will
 * actually fire on — fixes the chart-vs-watcher divergence that bit us
 * 2026-04-30 SPY (file said BULL/CALLS, watcher's memory still PUTS).
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

export type WatcherRecord = {
  ticker: string;
  child: ChildProcess;
  startedAt: number;
  untilStr: string;
  status: "starting" | "running" | "pending-confirm" | "exited" | "error";
  exitCode: number | null;
  /**
   * Set when the watcher emits a `__EXIT_REASON__ <reason>` marker before
   * exiting, so the dashboard can render structured exit states (e.g.
   * trade_cap → calm green pill instead of red "Exited (1)").
   */
  exitReason: ExitReason;
  /**
   * Latest `__LOADED_LEVELS__` marker payload — updated at watcher boot
   * and on every entry_notes hot-reload. Null until the boot marker arrives.
   */
  loadedLevels: LoadedLevels | null;
  pendingPrompt: PendingPrompt | null;
  lastCheck: LastCheck | null;
  output: OutputLine[];
  subscribers: Set<(line: OutputLine) => void>;
};

const watchers = new Map<string, WatcherRecord>();
let lineIdCounter = 0;

/**
 * Global subscribers — fired on EVERY appendLine across ALL tickers, with
 * the ticker name passed alongside the line. Lets a single SSE endpoint
 * (/api/watcher/stream — no ticker param) multiplex events from every
 * watcher into one connection. Replaces the previous design where the
 * dashboard opened one EventSource per ticker and saturated Safari's
 * 6-connection-per-host HTTP/1.1 limit (anchor case 2026-05-07: confirm
 * + stop fetches stalled forever waiting for a free slot).
 */
const globalSubscribers = new Set<(ticker: string, line: OutputLine) => void>();

export function getWatcher(ticker: string): WatcherRecord | undefined {
  return watchers.get(ticker);
}

export function getAllWatchers(): WatcherRecord[] {
  return [...watchers.values()];
}

export function registerWatcher(r: Omit<WatcherRecord, "output" | "subscribers" | "status" | "exitCode" | "exitReason" | "loadedLevels" | "pendingPrompt" | "lastCheck">): WatcherRecord {
  const full: WatcherRecord = {
    ...r,
    status: "starting",
    exitCode: null,
    exitReason: null,
    loadedLevels: null,
    pendingPrompt: null,
    lastCheck: null,
    output: [],
    subscribers: new Set(),
  };
  watchers.set(r.ticker, full);
  return full;
}

export function removeWatcher(ticker: string): void {
  watchers.delete(ticker);
}

/** Append a line to a watcher's buffer and broadcast to all subscribers. */
export function appendLine(
  ticker: string,
  type: OutputLine["type"],
  text: string,
  data?: unknown,
): OutputLine | null {
  const w = watchers.get(ticker);
  if (!w) return null;
  const line: OutputLine = {
    id: ++lineIdCounter,
    type,
    text,
    at: Date.now(),
    ...(data !== undefined ? { data } : {}),
  };
  w.output.push(line);
  // Cap buffer at 500 lines to avoid memory blowup on long sessions
  if (w.output.length > 500) w.output.splice(0, w.output.length - 500);
  // Iterate a snapshot of the Set so we can prune dead subscribers safely
  // mid-iteration. If a subscriber's callback throws (typically from an SSE
  // controller.enqueue on a disconnected client), remove it from the live
  // set so the next appendLine doesn't re-invoke a known-dead handler.
  // Belt-and-suspenders alongside the cancel()/tryEnqueue fix in
  // /api/watcher/stream/[ticker]/route.ts (2026-05-06 perf bug).
  for (const fn of [...w.subscribers]) {
    try {
      fn(line);
    } catch {
      w.subscribers.delete(fn);
    }
  }
  // Fan out to global multiplex subscribers too. Same dead-handler defense.
  for (const fn of [...globalSubscribers]) {
    try {
      fn(ticker, line);
    } catch {
      globalSubscribers.delete(fn);
    }
  }
  return line;
}

/** Subscribe to new lines for a ticker. Returns an unsubscribe function. */
export function subscribe(
  ticker: string,
  fn: (line: OutputLine) => void,
): () => void {
  const w = watchers.get(ticker);
  if (!w) return () => {};
  w.subscribers.add(fn);
  return () => { w.subscribers.delete(fn); };
}

/**
 * Subscribe to lines from ALL tickers (current and future). Used by the
 * multiplexed /api/watcher/stream endpoint to deliver every watcher's
 * events over one SSE connection. Returns an unsubscribe function.
 */
export function subscribeAll(
  fn: (ticker: string, line: OutputLine) => void,
): () => void {
  globalSubscribers.add(fn);
  return () => { globalSubscribers.delete(fn); };
}

/** Serializable snapshot for /api/watcher/status */
export function snapshot(ticker: string) {
  const w = watchers.get(ticker);
  if (!w) return null;
  return {
    ticker: w.ticker,
    startedAt: w.startedAt,
    untilStr: w.untilStr,
    status: w.status,
    exitCode: w.exitCode,
    exitReason: w.exitReason,
    loadedLevels: w.loadedLevels,
    pendingPrompt: w.pendingPrompt,
    lastCheck: w.lastCheck,
    recentOutput: w.output.slice(-50),
  };
}

export function snapshotAll() {
  return getAllWatchers().map(w => snapshot(w.ticker)).filter(Boolean);
}
