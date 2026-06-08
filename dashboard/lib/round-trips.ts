/**
 * Round-trip pairing for execution rows.
 *
 * Walks each contract's executions in time order and emits a "trip" whenever
 * net position returns to zero. Handles split fills (e.g. 5x BOT followed by
 * 4+1 SLD across SAPPHIRE/PSE = one trip of 5). Open positions render as
 * unclosed half-trips.
 *
 * Used by both Trade History and Day P&L tabs.
 */
import type { ExecutionRow } from "@/lib/ibkr-account";

export type Trip = {
  key: string;
  contractLabel: string;       // "SPY 710P · 2026-04-28"
  contractCompact: string;     // "SPY 710 P 28 APR" — IBKR-mobile style
  source: "manual" | "watcher";
  fills: ExecutionRow[];
  qtyTraded: number;           // total qty on the opening side
  avgEntryPrice: number;
  avgExitPrice: number | null;  // null if still open
  grossPnl: number | null;      // null if still open. In `currency`, using the contract multiplier
  currency: string;             // contract currency (USD, HKD, ...) — grossPnl/prices are denominated in this
  multiplier: number;           // contract multiplier applied to grossPnl (US opt 100, HSI 50, stock 1)
  pnlPercent: number | null;    // grossPnl / (avgEntryPrice × qty × multiplier)
  holdMinutes: number | null;
  status: "closed" | "open";
  entryTime: string;            // raw IBKR time string ("YYYYMMDD HH:MM:SS [tz]")
  dateET: string;               // YYYY-MM-DD parsed from entryTime
  ticker: string;
  strike?: number;
  right?: string;
  expiry?: string;
};

function isOption(e: ExecutionRow): boolean {
  return e.secType === "OPT" || e.secType === "FOP";
}

// FX conversions IBKR auto-runs to fund non-base trades (secType CASH) are not
// trades — they surface as unpaired half-trips ("STILL OPEN"). Exclude them.
function isCash(e: ExecutionRow): boolean {
  return e.secType === "CASH";
}

function multiplier(e: ExecutionRow): number {
  // Prefer the real contract multiplier captured from IBKR (HSI=50, US opt=100).
  // Fall back to the US-options assumption for legacy journal rows that predate
  // the multiplier field.
  if (typeof e.multiplier === "number" && Number.isFinite(e.multiplier) && e.multiplier > 0) {
    return e.multiplier;
  }
  return isOption(e) ? 100 : 1;
}

/** Parse the IBKR time string ("20260428 09:49:23 US/Eastern" or similar). */
function parseTime(raw: string): Date | null {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss] = m;
  return new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss}`);
}

function dateETFromTime(raw: string): string {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return "";
  return `${m[1]}-${m[2]}-${m[3]}`;
}

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

function compactExpiry(yyyymmdd: string | undefined): string {
  if (!yyyymmdd || yyyymmdd.length !== 8) return "";
  const month = MONTHS[parseInt(yyyymmdd.slice(4, 6), 10) - 1] ?? "?";
  const day = String(parseInt(yyyymmdd.slice(6, 8), 10));
  const yr = yyyymmdd.slice(2, 4);
  return `${day} ${month} '${yr}`;
}

export function buildTrips(execs: ExecutionRow[]): Trip[] {
  // Group by contract key (symbol + strike + right + expiry).
  const groups = new Map<string, ExecutionRow[]>();
  for (const e of execs) {
    if (isCash(e)) continue; // skip FX-conversion legs
    const k = `${e.symbol}|${e.secType}|${e.strike ?? ""}|${e.right ?? ""}|${e.expiry ?? ""}`;
    const arr = groups.get(k) ?? [];
    arr.push(e);
    groups.set(k, arr);
  }

  const trips: Trip[] = [];

  for (const [, fills] of groups) {
    // Time-sorted within the group.
    const sorted = [...fills].sort((a, b) => a.time.localeCompare(b.time));

    let net = 0;
    let openingSide: "BOT" | "SLD" | null = null;
    let bucket: ExecutionRow[] = [];

    for (const f of sorted) {
      if (bucket.length === 0) openingSide = f.side as "BOT" | "SLD";
      bucket.push(f);
      net += f.side === "BOT" ? f.qty : -f.qty;

      if (net === 0 && bucket.length > 0) {
        trips.push(finalizeTrip(bucket, openingSide ?? "BOT", "closed"));
        bucket = [];
        openingSide = null;
      }
    }

    if (bucket.length > 0) {
      trips.push(finalizeTrip(bucket, openingSide ?? "BOT", "open"));
    }
  }

  // Most recent first.
  trips.sort((a, b) => b.entryTime.localeCompare(a.entryTime));
  return trips;
}

function finalizeTrip(
  fills: ExecutionRow[],
  openingSide: "BOT" | "SLD",
  status: "closed" | "open",
): Trip {
  const opens = fills.filter((f) => f.side === openingSide);
  const closes = fills.filter((f) => f.side !== openingSide);
  const qtyOpen = opens.reduce((s, f) => s + f.qty, 0);
  const qtyClose = closes.reduce((s, f) => s + f.qty, 0);

  const avgPrice = (rows: ExecutionRow[]) => {
    const tq = rows.reduce((s, f) => s + f.qty, 0);
    if (tq === 0) return 0;
    return rows.reduce((s, f) => s + f.qty * f.price, 0) / tq;
  };

  const avgEntry = avgPrice(opens);
  const avgExit = closes.length ? avgPrice(closes) : null;
  const mult = multiplier(fills[0]);
  const grossPnl =
    avgExit != null && qtyOpen === qtyClose
      ? (openingSide === "BOT" ? (avgExit - avgEntry) : (avgEntry - avgExit)) * qtyOpen * mult
      : null;
  const pnlPercent =
    grossPnl != null && avgEntry > 0
      ? (grossPnl / (avgEntry * qtyOpen * mult)) * 100
      : null;

  const tEntry = parseTime(fills[0].time);
  const tExit = closes.length ? parseTime(closes[closes.length - 1].time) : null;
  const holdMinutes =
    tEntry && tExit ? Math.round((tExit.getTime() - tEntry.getTime()) / 60000) : null;

  const hasWatcherFill = fills.some((f) => f.orderId > 0);
  const source: "manual" | "watcher" = hasWatcherFill ? "watcher" : "manual";

  const exp = fills[0].expiry
    ? `${fills[0].expiry.slice(0, 4)}-${fills[0].expiry.slice(4, 6)}-${fills[0].expiry.slice(6, 8)}`
    : null;
  const contractLabel = isOption(fills[0])
    ? `${fills[0].symbol} ${fills[0].strike}${fills[0].right}${exp ? ` · ${exp}` : ""}`
    : fills[0].symbol;
  const contractCompact = isOption(fills[0])
    ? `${fills[0].symbol} ${fills[0].strike} ${fills[0].right} · ${compactExpiry(fills[0].expiry)}`
    : fills[0].symbol;

  return {
    key: fills.map((f) => f.execId).join("+"),
    contractLabel,
    contractCompact,
    source,
    fills,
    qtyTraded: qtyOpen,
    avgEntryPrice: avgEntry,
    avgExitPrice: avgExit,
    grossPnl,
    currency: fills[0].currency ?? "USD",
    multiplier: mult,
    pnlPercent,
    holdMinutes,
    status,
    entryTime: fills[0].time,
    dateET: dateETFromTime(fills[0].time),
    ticker: fills[0].symbol,
    strike: fills[0].strike,
    right: fills[0].right,
    expiry: fills[0].expiry,
  };
}

/** Today's date in ET as YYYY-MM-DD. */
export function todayET(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Pick the most recent trading day that has any trips. Falls back to today
 * if every trip is from before today (e.g. weekend) or there are no trips.
 */
export function latestTripDate(trips: Trip[]): string {
  const today = todayET();
  if (trips.length === 0) return today;
  const sorted = [...trips].map((t) => t.dateET).filter(Boolean).sort();
  return sorted[sorted.length - 1] || today;
}
