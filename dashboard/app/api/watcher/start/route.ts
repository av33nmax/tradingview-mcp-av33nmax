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
const ALLOWED_TICKERS = new Set(["SPY", "QQQ"]);

function parseMarker(line: string): { type: "check" | "prompt"; data: unknown } | null {
  const checkPrefix = "__CHECK__ ";
  const promptPrefix = "__PROMPT_YES__ ";
  if (line.startsWith(checkPrefix)) {
    try { return { type: "check", data: JSON.parse(line.slice(checkPrefix.length)) }; }
    catch { return null; }
  }
  if (line.startsWith(promptPrefix)) {
    try { return { type: "prompt", data: JSON.parse(line.slice(promptPrefix.length)) }; }
    catch { return null; }
  }
  return null;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const ticker = String(body?.ticker ?? "").toUpperCase();
  const untilStr = String(body?.until ?? "23:00");

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
    child = spawn("node", ["trade_window.mjs", ticker, "--until", untilStr], {
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
    const marker = parseMarker(line);
    if (marker) {
      if (marker.type === "check") {
        const d = marker.data as {
          triggered?: boolean; reason?: string; close?: number; rVol?: number; barTime?: string;
        };
        record.lastCheck = {
          triggered: !!d.triggered,
          reason: String(d.reason ?? ""),
          close: typeof d.close === "number" ? d.close : undefined,
          rVol: typeof d.rVol === "number" ? d.rVol : undefined,
          barTime: typeof d.barTime === "string" ? d.barTime : undefined,
          at: Date.now(),
        };
        appendLine(ticker, "check", line, d);
      } else if (marker.type === "prompt") {
        const d = marker.data as PromptPayload;
        record.pendingPrompt = {
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
