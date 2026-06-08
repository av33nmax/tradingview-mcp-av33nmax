import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  appendLine,
  getWatcher,
  registerWatcher,
  removeWatcher,
} from "@/lib/watchers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REPO_ROOT = path.join(process.cwd(), "..");
const ALLOWED_TICKERS = new Set(["SPY", "QQQ", "IWM", "AAPL", "NVDA", "AMZN"]);

function parseMarker(line: string): { type: "check" | "prompt" | "loaded_levels"; data: unknown } | null {
  const checkPrefix = "__CHECK__ ";
  const promptPrefix = "__PROMPT_YES__ ";
  const loadedLevelsPrefix = "__LOADED_LEVELS__ ";
  if (line.startsWith(checkPrefix)) {
    try { return { type: "check", data: JSON.parse(line.slice(checkPrefix.length)) }; }
    catch { return null; }
  }
  if (line.startsWith(promptPrefix)) {
    try { return { type: "prompt", data: JSON.parse(line.slice(promptPrefix.length)) }; }
    catch { return null; }
  }
  if (line.startsWith(loadedLevelsPrefix)) {
    try { return { type: "loaded_levels", data: JSON.parse(line.slice(loadedLevelsPrefix.length)) }; }
    catch { return null; }
  }
  return null;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const ticker = String(body?.ticker ?? "").toUpperCase();
  // Default = 02:00 SGT = 14:00 ET, matches trade_window.mjs internal
  // TIME_STOP_ET. Updated 2026-05-18 from "23:00" (= 11:00 ET, way too
  // short — only 1h15m after RTH open).
  const untilStr = String(body?.until ?? "02:00");
  const testFire = body?.testFire === true;
  // Auto-fire suppresses the YES gate at trigger time — order is placed
  // immediately and user manages exits from TWS. Resolution order:
  //   1. body.autoFire (per-arm explicit toggle, when UI exposes one)
  //   2. WATCHER_AUTO_FIRE env var (server-wide default, set in .env.local)
  //   3. false (preserves prior behavior)
  // User request 2026-05-09: stop the active-management leakage by removing
  // the human-confirm step entirely; let OCA bracket and TWS handle exits.
  const autoFire =
    body?.autoFire === true ||
    process.env.WATCHER_AUTO_FIRE === "1" ||
    process.env.WATCHER_AUTO_FIRE === "true";
  // Confirmation filter: after Trigger A or A_SNIPER fires, wait 60s and
  // check the next 1m bar closed in the breakout direction. Same resolution
  // pattern as autoFire: body param > env var > false. See user request
  // 2026-05-12 + the 9-session retrospective in
  // journal/1m-confirmation-analysis-2026-05-12.md.
  const confirmFire =
    body?.confirmFire === true ||
    process.env.WATCHER_CONFIRM_FIRE === "1" ||
    process.env.WATCHER_CONFIRM_FIRE === "true";
  // Trailing-runner mode: after fill, place ONE TRAIL SELL on the option
  // instead of the OCA bracket (T1/T2/stop). Resolution: body param > env
  // var > false. Per-ticker — the UI persists a localStorage toggle per
  // ticker and sends body.trailingRunner only when armed with that
  // ticker's toggle on. User decision 2026-05-13: replace T1/T2 capped
  // exits with a trailing stop so winners can run; TV chart still draws
  // T1/T2 lines as mental map. Width is hardcoded per-ticker in
  // trade_window.mjs's TRAIL_WIDTH_USD dict (ETFs $0.40, stocks $0.70).
  const trailingRunner =
    body?.trailingRunner === true ||
    process.env.WATCHER_TRAILING_RUNNER === "1" ||
    process.env.WATCHER_TRAILING_RUNNER === "true";

  if (!ALLOWED_TICKERS.has(ticker)) {
    return NextResponse.json(
      { ok: false, error: `ticker must be one of ${[...ALLOWED_TICKERS].join(", ")}` },
      { status: 400 },
    );
  }

  // If there's already a running watcher for this ticker, refuse (one-per-ticker)
  const existing = getWatcher(ticker);
  if (existing && (existing.status === "running" || existing.status === "starting" || existing.status === "pending-confirm")) {
    return NextResponse.json(
      { ok: false, error: `${ticker} watcher already running (status=${existing.status})` },
      { status: 409 },
    );
  }
  // If it's an old exited/error record, clear it so we can start fresh
  if (existing) removeWatcher(ticker);

  let child;
  try {
    const args = ["trade_window.mjs", ticker, "--until", untilStr];
    if (testFire) args.push("--test-fire");
    if (autoFire) args.push("--auto-fire");
    if (confirmFire) args.push("--confirm-fire");
    if (trailingRunner) args.push("--trailing-runner");
    child = spawn("node", args, {
      cwd: REPO_ROOT,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `spawn failed: ${message}` }, { status: 500 });
  }

  const record = registerWatcher({
    ticker,
    child,
    startedAt: Date.now(),
    untilStr,
  });
  record.status = "running";

  // Per-stream line splitter (chunks can contain partial lines)
  const makeLineSplitter = (onLine: (line: string) => void) => {
    let buf = "";
    return (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const line of parts) onLine(line);
    };
  };

  const onStdout = makeLineSplitter((line) => {
    if (!line) return;
    // Structured exit-reason marker — lets the dashboard render exit states
    // distinctly (e.g. trade_cap → calm green pill, not angry red "Exited").
    const exitReasonPrefix = "__EXIT_REASON__ ";
    if (line.startsWith(exitReasonPrefix)) {
      const reason = line.slice(exitReasonPrefix.length).trim();
      if (reason === "trade_cap") record.exitReason = "trade_cap";
      appendLine(ticker, "info", line);
      return;
    }
    const marker = parseMarker(line);
    if (marker) {
      if (marker.type === "check") {
        const d = marker.data as {
          triggered?: boolean; reason?: string; close?: number; rVol?: number; barTime?: string;
          triggerType?: "A" | "B";
        };
        record.lastCheck = {
          triggered: !!d.triggered,
          reason: String(d.reason ?? ""),
          triggerType: d.triggerType === "A" || d.triggerType === "B" ? d.triggerType : undefined,
          close: typeof d.close === "number" ? d.close : undefined,
          rVol: typeof d.rVol === "number" ? d.rVol : undefined,
          barTime: typeof d.barTime === "string" ? d.barTime : undefined,
          at: Date.now(),
        };
        appendLine(ticker, "check", line, d);
      } else if (marker.type === "loaded_levels") {
        // Watcher's runtime entry_notes snapshot — what it WILL fire on,
        // independent of the on-disk file. Fixes the chart-vs-watcher
        // display divergence that bit us 2026-04-30 when premarket re-ran
        // mid-session and the file changed but the watcher's memory didn't.
        record.loadedLevels = marker.data as LoadedLevelsPayload;
        appendLine(ticker, "info", line, marker.data);
        return;
      } else if (marker.type === "prompt") {
        const d = marker.data as PromptPayload;
        record.pendingPrompt = {
          ticker,
          triggerType: d.triggerType ?? "A", // default to A for backward compat
          subType: d.subType ?? null,
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
          createdAt: Date.now(),
        };
        record.status = "pending-confirm";
        appendLine(ticker, "prompt", line, d);
      }
      return;
    }
    appendLine(ticker, "stdout", line);
  });

  const onStderr = makeLineSplitter((line) => {
    if (line) appendLine(ticker, "stderr", line);
  });

  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);

  child.on("error", (err) => {
    appendLine(ticker, "error", `child error: ${err.message}`);
    record.status = "error";
  });

  child.on("exit", (code) => {
    appendLine(ticker, "exit", `process exited with code ${code}`);
    record.status = "exited";
    record.exitCode = code;
  });

  return NextResponse.json({
    ok: true,
    ticker,
    startedAt: record.startedAt,
    untilStr,
  });
}

type PromptPayload = {
  triggerType?: "A" | "B";
  subType?: string | null;
  direction: "CALLS" | "PUTS";
  strike: number;
  expiry: string;
  qty: number;
  premiumEst: number;
  underlyingEntry: number;
  stop: number;
  T1: number;
  T2?: number;
  bracket?: { t1: number; stop: number };
};

// Watcher's runtime view of entry_notes — emitted at boot and on every
// hot-reload. Dashboard prefers this over the on-disk file when rendering
// what the watcher will fire on.
type LoadedLevelsPayload = {
  ticker: string;
  direction: "CALLS" | "PUTS";
  entry: number;
  trigger_a: { entry: number; stop: number; T1: number; T2: number | null } | null;
  trigger_b: { entry_vwap?: number; entry_ema21_1H?: number; stop?: number; T1?: number; T2?: number | null } | null;
  auroraZoneCount: number;
  generatedAt: string | null;
};
