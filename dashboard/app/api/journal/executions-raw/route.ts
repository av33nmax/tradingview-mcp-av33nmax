/**
 * Read raw watcher-execution fills from journal/executions-raw/<date>-<ticker>.jsonl
 *
 * Why this exists: live IBKR's reqExecutions can drop fills after a TWS
 * reconnect or a Next.js hot-reload mid-session (real failure 2026-04-30).
 * The watcher process appends every fill it sees to a JSONL file as orders
 * fill — that file survives reconnects since it's on disk and append-only.
 *
 * trade-history-tab.tsx merges THREE sources by execId:
 *   1. /api/ibkr/executions          — live, current-session, includes manual
 *   2. /api/journal/executions-raw   — THIS, watcher fills only, durable
 *   3. /api/journal/executions       — end-of-day snapshots, post-rollover
 *
 * Watcher fills appear in 1+2; manual fills only in 1; older days only in 3.
 * Live wins on conflict (most recent fields), raw fills the gaps.
 *
 * Time normalization: the JSONL stores `time` as "YYYYMMDD-HH:MM:SS" in UTC,
 * while live IBKR returns "YYYYMMDD HH:MM:SS US/Eastern" (ET). We convert
 * the JSONL time to ET so the merged tab displays consistent timestamps.
 */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import type { ExecutionRow } from "@/lib/ibkr-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// journal/ lives at repo root, one level above the dashboard/.
const RAW_DIR = path.join(process.cwd(), "..", "journal", "executions-raw");
const FILE_RE = /^(\d{4}-\d{2}-\d{2})-([A-Z]{1,5})\.jsonl$/;

// Format a Date in America/New_York as "YYYYMMDD HH:MM:SS US/Eastern"
// to match the live IBKR execution time format.
const ET_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function normalizeJsonlTimeToLiveFormat(jsonlTime: string): string {
  // JSONL: "20260429-13:50:08" (UTC, dash separator, no timezone)
  const m = jsonlTime.match(/^(\d{4})(\d{2})(\d{2})-(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return jsonlTime; // Unknown format — pass through
  const [, y, mo, d, hh, mm, ss] = m;
  const utcMs = Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss);
  const parts = ET_FMT.formatToParts(new Date(utcMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}${get("month")}${get("day")} ${get("hour")}:${get("minute")}:${get("second")} US/Eastern`;
}

type JsonlRow = {
  execId?: string;
  orderId?: number;
  permId?: number;
  symbol?: string;
  secType?: string;
  expiry?: string;
  strike?: number;
  right?: string;
  side?: string;
  qty?: number;
  price?: number;
  time?: string;
  account?: string;
  exchange?: string;
};

function jsonlToExecutionRow(j: JsonlRow): ExecutionRow | null {
  if (!j.execId || !j.symbol) return null;
  return {
    execId: j.execId,
    orderId: Number(j.orderId ?? 0),
    permId: j.permId,
    symbol: j.symbol,
    secType: j.secType ?? "?",
    expiry: j.expiry,
    strike: j.strike,
    right: j.right,
    side: j.side ?? "?",
    qty: Number(j.qty ?? 0),
    price: Number(j.price ?? 0),
    time: j.time ? normalizeJsonlTimeToLiveFormat(j.time) : "",
    account: j.account ?? "",
    exchange: j.exchange,
  };
}

export type JournalExecutionsRawResponse =
  | {
      ok: true;
      executions: ExecutionRow[];
      files: string[];   // filenames read (for debugging)
      fetchedAt: number;
    }
  | { ok: false; error: string };

export async function GET(): Promise<NextResponse<JournalExecutionsRawResponse>> {
  try {
    if (!fs.existsSync(RAW_DIR)) {
      return NextResponse.json({ ok: true, executions: [], files: [], fetchedAt: Date.now() });
    }
    const files = fs.readdirSync(RAW_DIR).filter((f) => FILE_RE.test(f));
    const all: ExecutionRow[] = [];
    const filesRead: string[] = [];
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(RAW_DIR, f), "utf8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const row = jsonlToExecutionRow(JSON.parse(trimmed) as JsonlRow);
            if (row) all.push(row);
          } catch {
            // Single malformed line — skip without failing the whole file.
          }
        }
        filesRead.push(f);
      } catch (e) {
        console.warn(`[journal/executions-raw] skipped ${f}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return NextResponse.json({ ok: true, executions: all, files: filesRead, fetchedAt: Date.now() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
