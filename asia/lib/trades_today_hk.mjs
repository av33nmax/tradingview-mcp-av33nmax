/**
 * asia/lib/trades_today_hk.mjs — per-instrument trade-count guard for HK
 * watchers.
 *
 * HK-equivalent of the US one_trade_per_day.mjs. Differences:
 *   - State file lives at asia/state/traded_today_hk.json
 *   - Date reset on Asia/Hong_Kong calendar day (not ET)
 *   - Cap default reads from asia/config/gates.json (daily_trade_cap.max_trades)
 *     with a fallback to 3 — matches the conservative Asia config
 *   - All ticker → instrumentKey ('MHI', 'TENCENT', etc.)
 *
 * The watcher checks getTradeCount(instrumentKey) BEFORE firing and
 * recordTrade(instrumentKey, meta) AFTER a successful placeOrder.
 *
 * To override (e.g. spurious flag from a failed fill):
 *   `rm asia/state/traded_today_hk.json`
 *
 * Friction is intentional.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASIA_ROOT = path.resolve(__dirname, '..');
export const TRADED_TODAY_HK_FILE = path.join(ASIA_ROOT, 'state', 'traded_today_hk.json');

const GATES_PATH = path.join(ASIA_ROOT, 'config', 'gates.json');
// No cap by default (user decision 2026-06-02: "I don't need max trade cap on
// watchers"). The binding gate is the manual dashboard Y/N, not a trade count.
// A finite cap applies ONLY if gates.json daily_trade_cap is enabled !== false
// AND has a positive integer max_trades. Setting enabled:false removes the cap
// everywhere (this watcher count check AND the daily_trade_cap gate).
const DEFAULT_MAX_TRADES = Infinity;

let _capCache = null;
function loadCap() {
  if (_capCache != null) return _capCache;
  try {
    const gates = JSON.parse(fs.readFileSync(GATES_PATH, 'utf8'));
    const dtc = gates?.daily_trade_cap;
    if (dtc?.enabled === false) { _capCache = Infinity; return _capCache; }
    const v = dtc?.max_trades;
    _capCache = Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_TRADES;
  } catch {
    _capCache = DEFAULT_MAX_TRADES;
  }
  return _capCache;
}

/** Returns the configured per-instrument daily cap (per session). */
export function maxTradesPerDay() {
  return loadCap();
}

function todayHK() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function readRaw() {
  if (!fs.existsSync(TRADED_TODAY_HK_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(TRADED_TODAY_HK_FILE, 'utf8')); }
  catch { return null; }
}

/** Returns the current state, resetting if the date rolled over (HK). */
export function loadTradedToday() {
  const raw = readRaw();
  const today = todayHK();
  if (!raw || raw.date !== today) {
    return { date: today, tradeCount: {}, trades: [] };
  }
  if (!raw.tradeCount) raw.tradeCount = {};
  if (!Array.isArray(raw.trades)) raw.trades = [];
  return raw;
}

export function getTradeCount(instrumentKey) {
  return loadTradedToday().tradeCount[instrumentKey] ?? 0;
}

/** True if instrumentKey has hit the per-day cap. */
export function hasTradedToday(instrumentKey) {
  return getTradeCount(instrumentKey) >= maxTradesPerDay();
}

/**
 * Record a successful order placement. Increments count + appends to trades.
 * Meta should include strike, qty, orderId, expiry, triggerType, etc.
 */
export function recordTrade(instrumentKey, meta = {}) {
  const d = loadTradedToday();
  d.tradeCount[instrumentKey] = (d.tradeCount[instrumentKey] ?? 0) + 1;
  d.trades.push({ instrument: instrumentKey, ...meta, recordedAt: new Date().toISOString() });
  d.lastTradeAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(TRADED_TODAY_HK_FILE), { recursive: true });
  fs.writeFileSync(TRADED_TODAY_HK_FILE, JSON.stringify(d, null, 2));
}

export function formatBlockedMessage(instrumentKey) {
  const d = loadTradedToday();
  const count = d.tradeCount[instrumentKey] ?? 0;
  const cap = maxTradesPerDay();
  const instrumentTrades = d.trades.filter(t => t.instrument === instrumentKey);
  let extra = '';
  if (instrumentTrades.length) {
    const lines = instrumentTrades.map((t, i) =>
      `   Trade ${i + 1}: ${t.triggerType ?? '?'}-trigger · ${t.strike ?? '?'}${t.right ?? ''} × ${t.qty ?? '?'} at ${t.recordedAt ?? '?'}` +
      (t.orderId ? ` (orderId=${t.orderId})` : '')
    );
    extra = '\n' + lines.join('\n');
  }
  return [
    `❌ ${instrumentKey} has hit the HK per-day trade cap (${count}/${cap}) for ${d.date} HK.${extra}`,
    `   To override (genuine emergency): rm ${path.basename(TRADED_TODAY_HK_FILE)}`,
  ].join('\n');
}
