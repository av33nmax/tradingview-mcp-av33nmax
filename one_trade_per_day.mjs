/**
 * one_trade_per_day.mjs — persistent "I've already traded X today" guard.
 *
 * Stores state in ./traded_today.json (gitignored) keyed by the ET trading
 * date (not SGT local date — US markets define the trading day). Any script
 * that places orders must check hasTradedToday(ticker) BEFORE placing, and
 * call recordTrade(ticker, meta) AFTER a successful placement.
 *
 * Date reset: automatic. When the file's `date` field no longer matches
 * today's ET date, the state is considered empty (new day = fresh slate).
 *
 * No --force flag is provided. If the user genuinely needs to override (e.g.
 * spurious flag from a failed fill), they must manually `rm traded_today.json`.
 * This friction is intentional — Path A (systematic trader) requires it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const TRADED_TODAY_FILE = path.join(REPO_ROOT, 'traded_today.json');

function todayET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());  // YYYY-MM-DD
}

function readRaw() {
  if (!fs.existsSync(TRADED_TODAY_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(TRADED_TODAY_FILE, 'utf8')); }
  catch { return null; }
}

/** Returns current state {date, traded: [tickers], ...} or fresh state if day has rolled over. */
export function loadTradedToday() {
  const raw = readRaw();
  const today = todayET();
  if (!raw || raw.date !== today) return { date: today, traded: [] };
  return raw;
}

/** true if `ticker` has already placed an order today (ET date). */
export function hasTradedToday(ticker) {
  return loadTradedToday().traded.includes(ticker);
}

/** Record a successful order placement. Appends ticker + optional meta. */
export function recordTrade(ticker, meta = {}) {
  const d = loadTradedToday();
  if (!d.traded.includes(ticker)) d.traded.push(ticker);
  d.lastTradeAt = new Date().toISOString();
  d[`${ticker}_meta`] = { ...meta, recordedAt: new Date().toISOString() };
  fs.writeFileSync(TRADED_TODAY_FILE, JSON.stringify(d, null, 2));
}

/** Pretty error message for blocked re-entry attempts. */
export function formatBlockedMessage(ticker) {
  const d = loadTradedToday();
  const meta = d[`${ticker}_meta`];
  let extra = '';
  if (meta) {
    extra = `\n   Previous trade: ${meta.strike ?? '?'} ${meta.right ?? '?'} × ${meta.qty ?? '?'} at ${meta.recordedAt ?? '?'}`;
    if (meta.orderId) extra += ` (orderId=${meta.orderId})`;
  }
  return [
    `❌ ${ticker} already traded today (${d.date}) per one-trade-per-day rule.${extra}`,
    `   Path A systematic trader: max one trade per ticker per session.`,
    `   If you REALLY need to override (genuine emergency): rm ${path.basename(TRADED_TODAY_FILE)}`,
  ].join('\n');
}
