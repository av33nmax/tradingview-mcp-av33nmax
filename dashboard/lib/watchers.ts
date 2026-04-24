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

export type WatcherRecord = {
  ticker: string;
  child: ChildProcess;
  startedAt: number;
  untilStr: string;
  status: "starting" | "running" | "pending-confirm" | "exited" | "error";
  exitCode: number | null;
  pendingPrompt: PendingPrompt | null;
  lastCheck: LastCheck | null;
  output: OutputLine[];
  subscribers: Set<(line: OutputLine) => void>;
};

const watchers = new Map<string, WatcherRecord>();
let lineIdCounter = 0;

export function getWatcher(ticker: string): WatcherRecord | undefined {
  return watchers.get(ticker);
}

export function getAllWatchers(): WatcherRecord[] {
  return [...watchers.values()];
}

export function registerWatcher(r: Omit<WatcherRecord, "output" | "subscribers" | "status" | "exitCode" | "pendingPrompt" | "lastCheck">): WatcherRecord {
  const full: WatcherRecord = {
    ...r,
    status: "starting",
    exitCode: null,
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
  for (const fn of w.subscribers) {
    try { fn(line); } catch { /* subscriber crashed — ignore */ }
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
    pendingPrompt: w.pendingPrompt,
    lastCheck: w.lastCheck,
    recentOutput: w.output.slice(-50),
  };
}

export function snapshotAll() {
  return getAllWatchers().map(w => snapshot(w.ticker)).filter(Boolean);
}
