/**
 * one_trade_per_day.mjs — persistent multi-trade-per-day quota guard.
 *
 * Filename retained for git history and existing imports, but semantics
 * have evolved: now tracks a TRADE COUNT per ticker per day and enforces
 * a configurable cap (MAX_TRADES_PER_DAY).
 *
 * Stores state in ./traded_today.json (gitignored), keyed by ET trading
 * date (US markets define the trading day). Any script that places orders
 * must check hasTradedToday(ticker) BEFORE placing, and call
 * recordTrade(ticker, meta) AFTER a successful placement.
 *
 * History:
 *   - Original (2026-04): one trade per ticker per day. Boolean state.
 *   - Phase 2 (2026-04-28): N trades per ticker per day to support
 *     Trigger A and Trigger B firing on the same day independently.
 *     Started at MAX_TRADES_PER_DAY=2; user agreed to graduate to 3
 *     after a week of confidence. Per-trade risk in the watcher path is
 *     now bounded by the OPTION_STOP_OFFSET_USD STP (~$10/contract);
 *     legacy MAX_RISK_USD ceiling still exists in trade_planner.mjs and
 *     place_option_order.mjs, where it drives dynamic qty derivation.
 *
 * Date reset: automatic. When the file's `date` field no longer matches
 * today's ET date, state is considered empty (new day = fresh slate).
 *
 * No --force flag. To override (e.g. spurious flag from a failed fill):
 * `rm traded_today.json`. Friction is intentional.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const TRADED_TODAY_FILE = path.join(REPO_ROOT, 'traded_today.json');

/**
 * Maximum trades per ticker per day. History:
 *   2026-04-28: 2 — Phase 2 (Trigger A and B can fire same day independently)
 *   2026-05-02: 1 — Monday qty=1 + $60-stop + gated-sniper test, conservative
 *   2026-05-04 morning: 2 — bumped on logic that $0.10 stop bounds downside
 *   2026-05-04 evening: 1 — REVERTED. Same-day data showed cap=2's "second
 *                  look" produced 0/3 win rate (-$33 from three correlated
 *                  fires at 11:06 ET, all stopped out).
 *   2026-05-05: 99 — effectively removed. User reasoning: manual confirmation
 *                  on the dashboard portal is now the binding gate (every
 *                  fire requires explicit YES to transmit), so a code-side
 *                  daily cap is redundant. Cross-ticker correlation gate
 *                  remains active to suppress correlated-noise bursts. This
 *                  is a deliberate override of the previous "stays at 1
 *                  until ≥5 sessions of correlation-gate data" criterion;
 *                  the user is treating the manual-Y/N prompt as the
 *                  failsafe instead of a hard cap.
 *
 * The gated sniper and 15m baseline both count toward this cap. Trigger A
 * and Trigger B fires on the same ticker each consume one slot.
 *
 * No cap by default (user decision 2026-06-02: "I don't need max trade cap on
 * watchers"). The binding gate is the manual dashboard Y/N (ENABLE TRADING),
 * not a trade count. The check infrastructure (hasTradedToday / blockedReason)
 * is unchanged — only the threshold is removed. Re-enable a hard cap by setting
 * WATCHER_MAX_TRADES_PER_DAY=N in the environment.
 */
export const MAX_TRADES_PER_DAY = process.env.WATCHER_MAX_TRADES_PER_DAY
  ? Number(process.env.WATCHER_MAX_TRADES_PER_DAY)
  : Infinity;

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

/**
 * Returns the current state. Migrates legacy single-trade format
 * ({date, traded: [tickers], ...}) into the new count-based format
 * ({date, tradeCount: {ticker: int}, trades: [...], ...}) on read.
 */
export function loadTradedToday() {
  const raw = readRaw();
  const today = todayET();
  if (!raw || raw.date !== today) {
    return { date: today, tradeCount: {}, trades: [] };
  }
  // Migrate legacy format if encountered (e.g. file written by older code)
  if (Array.isArray(raw.traded) && !raw.tradeCount) {
    const migrated = { ...raw, tradeCount: {}, trades: [] };
    for (const t of raw.traded) {
      migrated.tradeCount[t] = 1;
      const meta = raw[`${t}_meta`];
      if (meta) migrated.trades.push({ ticker: t, ...meta });
    }
    return migrated;
  }
  if (!raw.tradeCount) raw.tradeCount = {};
  if (!Array.isArray(raw.trades)) raw.trades = [];
  return raw;
}

/** Returns the trade count for `ticker` today (0 if none). */
export function getTradeCount(ticker) {
  return loadTradedToday().tradeCount[ticker] ?? 0;
}

/**
 * True if `ticker` has hit the per-day cap (MAX_TRADES_PER_DAY).
 * Function name preserved for backward compatibility with existing callers.
 */
export function hasTradedToday(ticker) {
  return getTradeCount(ticker) >= MAX_TRADES_PER_DAY;
}

/**
 * Record a successful order placement. Increments the per-ticker count
 * and appends to the trades array. Meta should include any context the
 * caller wants preserved (strike, qty, orderId, triggerType, etc.).
 */
export function recordTrade(ticker, meta = {}) {
  const d = loadTradedToday();
  d.tradeCount[ticker] = (d.tradeCount[ticker] ?? 0) + 1;
  d.trades.push({ ticker, ...meta, recordedAt: new Date().toISOString() });
  d.lastTradeAt = new Date().toISOString();
  fs.writeFileSync(TRADED_TODAY_FILE, JSON.stringify(d, null, 2));
}

/** Pretty error message for blocked re-entry attempts. */
export function formatBlockedMessage(ticker) {
  const d = loadTradedToday();
  const count = d.tradeCount[ticker] ?? 0;
  const tickerTrades = d.trades.filter(t => t.ticker === ticker);
  let extra = '';
  if (tickerTrades.length) {
    const lines = tickerTrades.map((t, i) =>
      `   Trade ${i + 1}: ${t.triggerType ?? '?'}-trigger · ${t.strike ?? '?'}${t.right ?? ''} × ${t.qty ?? '?'} at ${t.recordedAt ?? '?'}` +
      (t.orderId ? ` (orderId=${t.orderId})` : '')
    );
    extra = '\n' + lines.join('\n');
  }
  return [
    `❌ ${ticker} has hit the per-day trade cap (${count}/${MAX_TRADES_PER_DAY}) for ${d.date} ET.${extra}`,
    `   Multi-trade-per-day mode: max ${MAX_TRADES_PER_DAY} trades per ticker per session.`,
    `   If you REALLY need to override (genuine emergency): rm ${path.basename(TRADED_TODAY_FILE)}`,
  ].join('\n');
}
