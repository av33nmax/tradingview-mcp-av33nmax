#!/usr/bin/env node
/**
 * asia/scripts/trade_window_hk.mjs — HK options watcher (Trigger A / ORB).
 *
 * Per-instrument process. Mirrors the US trade_window.mjs pattern but
 * simplified for v1 — Trigger A (ORB breakout) only, no Trigger B yet.
 *
 * Lifecycle:
 *   1. Parse instrument key from argv (MHI / MTW / TENCENT / ALIBABA / XIAOMI)
 *   2. Load contracts.json + orb_triggers.json. Refuse if triggers stale or missing.
 *   3. Connect to IBKR with per-instrument clientId (60-64)
 *   4. Resolve underlying (STK or front-month FUT) — cached for the session
 *   5. Pre-flight gate check (informational — does not block startup)
 *   6. Main loop:
 *        - Sleep until next 15m boundary + 5s SGT
 *        - Fetch 15m bars from IBKR for the underlying
 *        - Check long.entry crossover (CALLS) and short.entry crossover (PUTS)
 *        - If crossed: evaluate full gate cascade with signal context
 *        - If gates pass: place HK option BUY + OCA bracket exits
 *        - Always emit __CHECK__ marker + append JSONL
 *   7. Exit on --until SGT hit or SIGINT
 *
 * Gates that hard-block fires (in evaluation order):
 *   a50_correlation, china_policy_blackout, session_window,
 *   daily_trade_cap, manual_dashboard_yn, correlation_chase_filter
 *
 * Y/N is the binding gate. Watcher will not place orders until
 * asia/state/manual_yn.json has yn='Y' set today (SGT).
 *
 * Logging:
 *   asia/journal/watcher-checks-raw/<HK_DATE>-<INSTRUMENT>.jsonl  (every check)
 *   asia/journal/executions-raw/<HK_DATE>-<INSTRUMENT>.jsonl      (every fill)
 *
 * Usage (from asia/ root):
 *   node scripts/trade_window_hk.mjs MHI
 *   node scripts/trade_window_hk.mjs TENCENT --until 16:00
 *   IBKR_PORT=7497 node scripts/trade_window_hk.mjs MHI    # paper override
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IBApi, EventName } from '@stoqey/ib';

import {
  IBKR_HK_CONFIG, isLive, modeLabel,
  hkWatcherClientId, isInfoCode, isNoisyHKCode,
} from '../lib/ibkr_hk_config.mjs';
import {
  reqHistoricalBars,
  resolveHKUnderlyingConId,
  getHKOptionChainParams,
  pickHKWednesdayWeeklyExpiry,
  pickHKStrikeATM,
  placeHKStagedOrder,
  placeHKOCABracketExits,
  placeHKTrailingStop,
  placeHKFixedStop,
  printHKOrderSpec,
  printHKBracketSpec,
  printHKTrailingSpec,
  printHKFixedStopSpec,
} from '../lib/ibkr_hk_orders.mjs';
import { getTrailing } from '../lib/trailing_config.mjs';
import { evaluateAllGates, formatVerdict } from '../lib/gates_eval.mjs';
import { getTradeCount, recordTrade, maxTradesPerDay } from '../lib/trades_today_hk.mjs';
import { discordHSI, DISCORD_HSI_ENABLED } from '../lib/discord_hsi.mjs';
import {
  anchoredSessionVWAP,
  getEMA21_1H_AsOf,
  validateTriggerBBar,
} from '../lib/vwap_ema.mjs';
import { atr } from '../lib/atr.mjs';
import { todaysHKOpenTimestamp } from '../lib/orb.mjs';

process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });
process.stderr.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASIA_ROOT = path.resolve(__dirname, '..');

// ─── CLI ────────────────────────────────────────────────────────────────────
const VALID_INSTRUMENTS = ['HSI', 'TENCENT', 'ALIBABA', 'XIAOMI'];

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(`Usage: node trade_window_hk.mjs <INSTRUMENT> [--until HH:MM]`);
    console.error(`  INSTRUMENT: one of ${VALID_INSTRUMENTS.join(', ')}`);
    process.exit(2);
  }
  const instrumentKey = String(args[0]).toUpperCase();
  if (!VALID_INSTRUMENTS.includes(instrumentKey)) {
    console.error(`Unknown instrument: ${instrumentKey}. Valid: ${VALID_INSTRUMENTS.join(', ')}`);
    process.exit(2);
  }
  let untilStr = '16:00';
  const ui = args.indexOf('--until');
  if (ui >= 0 && args[ui + 1]) untilStr = args[ui + 1];
  const m = untilStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    console.error(`--until must be HH:MM (SGT), got ${untilStr}`);
    process.exit(2);
  }
  return { instrumentKey, untilHour: Number(m[1]), untilMinute: Number(m[2]), untilStr };
}

const { instrumentKey, untilHour, untilMinute, untilStr } = parseArgs();

// ─── Exit alerting ───────────────────────────────────────────────────────────
// Mirrors the US watcher (2026-06-02). Every exit was silent — discordHSI only
// fired on arm/trade events, so a watcher that crashed, was killed, or hit
// --until vanished with no ping. notifyExit() alerts on ANY exit, with a 3s
// backstop so a hung webhook can't wedge shutdown. Global handlers catch crashes
// + kill signals; the explicit exit sites below route through it too.
let _exitAlertSent = false;
function notifyExit(reason, code = 0) {
  if (_exitAlertSent) { process.exit(code); return; }
  _exitAlertSent = true;
  const emoji = code === 0 ? '🟡' : '🔴';
  const force = setTimeout(() => process.exit(code), 3000);
  Promise.resolve(discordHSI(`${emoji} **${instrumentKey} watcher exited** (code ${code}) — ${reason}`))
    .catch(() => {})
    .finally(() => { clearTimeout(force); process.exit(code); });
}
process.on('uncaughtException', (e) => notifyExit(`crashed — ${e?.stack?.split('\n')[0] ?? e?.message ?? e}`, 1));
process.on('unhandledRejection', (e) => notifyExit(`unhandled rejection — ${e?.message ?? e}`, 1));
process.on('SIGTERM', () => notifyExit('stopped (SIGTERM — dashboard/kill)', 0));

// ─── Paths ──────────────────────────────────────────────────────────────────
const CONTRACTS_PATH = path.join(ASIA_ROOT, 'config', 'contracts.json');
const ORB_TRIGGERS_PATH = path.join(ASIA_ROOT, 'state', 'orb_triggers.json');
const PREMARKET_STATE_PATH = path.join(ASIA_ROOT, 'state', 'premarket_state.json');
const CHECKS_DIR = path.join(ASIA_ROOT, 'journal', 'watcher-checks-raw');

// ─── Trigger B threshold (rVol minimum for VWAP/EMA21 reclaim) ──────────────
// US convention is 1.2-1.5 per ticker. HK starts conservative at 1.2;
// per-instrument calibration is a future refinement.
const TRIGGER_B_RVOL_THRESHOLD = 1.2;
const EXECS_DIR = path.join(ASIA_ROOT, 'journal', 'executions-raw');

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function dateHK() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function nowSGTStr() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
}
function checksJsonlPath() { return path.join(CHECKS_DIR, `${dateHK()}-${instrumentKey}.jsonl`); }
function execsJsonlPath(dateHKstr) { return path.join(EXECS_DIR, `${dateHKstr}-${instrumentKey}.jsonl`); }

function emitCheckMarker(payload) {
  const record = { ...payload, instrument: instrumentKey, emittedAt: new Date().toISOString() };
  console.log(`__CHECK__ ${JSON.stringify(record)}`);
  try {
    ensureDir(CHECKS_DIR);
    fs.appendFileSync(checksJsonlPath(), JSON.stringify(record) + '\n');
  } catch (e) {
    console.log(`   ⚠ check-marker JSONL append failed: ${e.message}`);
  }
}

// ─── 15m boundary helper ────────────────────────────────────────────────────
function nextCandleBoundary() {
  const now = new Date();
  const m = now.getMinutes();
  const next = Math.floor(m / 15) * 15 + 15;
  const target = new Date(now);
  target.setSeconds(5);
  target.setMilliseconds(0);
  target.setMinutes(next);
  if (target.getTime() - now.getTime() < 5000) target.setTime(target.getTime() + 15 * 60 * 1000);
  return target;
}

function untilDate() {
  // Build today's SGT untilHour:untilMinute as a Date in local UTC ms.
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const y = parts.find(p => p.type === 'year').value;
  const mo = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  // SGT = UTC+8, so YYYY-MM-DD HH:MM SGT = YYYY-MM-DD (HH-8):MM UTC
  const u = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), untilHour - 8, untilMinute, 0));
  // If the computed time is already in the past (script started after --until),
  // bump it by 24h so the loop has at least one cycle.
  if (u.getTime() <= now.getTime()) u.setUTCDate(u.getUTCDate() + 1);
  return u;
}

// ─── Load primary spec + ORB triggers ───────────────────────────────────────
async function loadContext() {
  const contracts = JSON.parse(await fsp.readFile(CONTRACTS_PATH, 'utf8'));
  const spec = contracts.primary[instrumentKey];
  if (!spec) throw new Error(`No spec for ${instrumentKey} in contracts.json`);

  const today = dateHK();
  // ORB triggers (Trigger A) are OPTIONAL as of 2026-06-03. If orb_triggers.json
  // is missing / stale / has no usable trigger, Trigger A goes dormant and the
  // watcher runs on Trigger B (VWAP/EMA21 reclaim) only — which needs no ORB and
  // computes its own entry/stop/T1/T2 live. Mirrors the US null-ORB handling.
  // (Run post_open_orb.mjs ≥10:00 SGT to also enable Trigger A.)
  let myTrigger = null;
  try {
    const triggers = JSON.parse(await fsp.readFile(ORB_TRIGGERS_PATH, 'utf8'));
    if (triggers.today_sgt_date !== today) {
      console.log(`   ⓘ orb_triggers.json is from ${triggers.today_sgt_date} (today ${today}) — Trigger A OFF, running Trigger B only`);
    } else {
      const t = triggers.instruments?.[instrumentKey];
      if (t && t.ok) myTrigger = t;
      else console.log(`   ⓘ no usable ORB trigger for ${instrumentKey} — Trigger A OFF, running Trigger B only`);
    }
  } catch {
    console.log(`   ⓘ no orb_triggers.json yet — Trigger A OFF, running Trigger B only (run post_open_orb.mjs ≥10:00 SGT to enable Trigger A)`);
  }

  // Load premarket bias (for Trigger B direction lock).
  // Missing/stale state means Trigger B is disabled for the session — A still
  // works fine. Watcher continues without erroring on missing premarket state.
  let bias = null;
  let alignment = null;
  try {
    const pm = JSON.parse(await fsp.readFile(PREMARKET_STATE_PATH, 'utf8'));
    if (pm.today_sgt_date === today) {
      const inst = pm.instruments?.[instrumentKey];
      bias = inst?.bias ?? null;
      alignment = inst?.alignment ?? null;
    }
  } catch {
    // premarket_state.json missing — Trigger B will skip with reason
  }

  if (!myTrigger && bias !== 'BULL' && bias !== 'BEAR') {
    throw new Error(`Nothing to watch for ${instrumentKey}: no ORB trigger AND bias=${bias ?? 'unknown'} (Trigger B needs BULL/BEAR). Run post_open_orb.mjs (≥10:00 SGT) or re-run premarket for a directional bias.`);
  }
  return { spec, trigger: myTrigger, bias, alignment };
}

// ─── IBKR setup ─────────────────────────────────────────────────────────────
const watcherClientId = hkWatcherClientId(instrumentKey);
const ib = new IBApi({
  host: IBKR_HK_CONFIG.host,
  port: IBKR_HK_CONFIG.port,
  clientId: watcherClientId,
});

let nextOrderId = null;
ib.on(EventName.nextValidId, (id) => { nextOrderId = id; });

const errorCounts = new Map();
ib.on(EventName.error, (err, code, reqId) => {
  if (isInfoCode(code)) return;
  if (isNoisyHKCode(code)) return;
  errorCounts.set(code, (errorCounts.get(code) || 0) + 1);
  if (errorCounts.get(code) === 1) {
    console.log(`   [first] IBKR error code=${code} reqId=${reqId}: ${err?.message || err}`);
  }
});

ib.on(EventName.execDetails, (reqId, contract, execution) => {
  if (!execution || !execution.execId) return;
  const record = {
    execId: String(execution.execId),
    orderId: Number(execution.orderId ?? 0),
    permId: execution.permId,
    instrument: instrumentKey,
    symbol: contract.symbol ?? '?',
    secType: contract.secType ?? '?',
    expiry: contract.lastTradeDateOrContractMonth,
    strike: contract.strike,
    right: contract.right,
    side: String(execution.side ?? '?'),
    qty: Number(execution.shares ?? 0),
    price: Number(execution.price ?? 0),
    time: String(execution.time ?? ''),
    account: String(execution.acctNumber ?? ''),
    exchange: typeof execution.exchange === 'string' ? execution.exchange : undefined,
    capturedAt: new Date().toISOString(),
  };
  try {
    ensureDir(EXECS_DIR);
    const m = record.time.match(/^(\d{4})(\d{2})(\d{2})/);
    const d = m ? `${m[1]}-${m[2]}-${m[3]}` : dateHK();
    fs.appendFileSync(execsJsonlPath(d), JSON.stringify(record) + '\n');
    console.log(`   📒 exec recorded: ${record.side} ${record.qty} ${record.symbol} ${record.strike}${record.right} @ ${record.price}`);
  } catch (e) {
    console.log(`   ⚠ execution JSONL append failed: ${e.message}`);
  }
});

function connectIB() {
  return new Promise((resolve, reject) => {
    const handler = () => { ib.off(EventName.connected, handler); resolve(); };
    ib.on(EventName.connected, handler);
    ib.connect();
    setTimeout(() => reject(new Error('IBKR connect timeout (10s)')), 10000);
  });
}

// ─── Bar fetch + Trigger A validation ───────────────────────────────────────
async function fetchUnderlyingBars(underlyingContract) {
  // 15m TRADES bars for the last 2 days, REGULAR TRADING HOURS.
  // HK RTH: 09:30-12:00 and 13:00-16:00 SGT.
  const bars = await reqHistoricalBars(ib, underlyingContract, '2 D', '15 mins', 'TRADES', 1);
  return bars;
}

/**
 * Trigger A: did the last closed 15m bar's close cross above long.entry
 * (CALLS direction) or below short.entry (PUTS direction)?
 *
 * The ORB defines a symmetric long+short setup. The watcher checks both
 * each cycle. If long fires AND short fires on the same bar (impossible
 * given long.entry > short.entry by ORB construction), long wins.
 *
 * Returns { triggered: bool, direction?: 'CALLS'|'PUTS', signal?, reason }.
 */
function validateTriggerA(bars, trigger, currentPrice) {
  if (!trigger) {
    return { triggered: false, reason: 'Trigger A inactive — no ORB triggers (running Trigger B only)' };
  }
  if (!bars || bars.length < 2) {
    return { triggered: false, reason: `insufficient bars (${bars?.length ?? 0})` };
  }
  const lastClosed = bars[bars.length - 1];
  const longEntry = trigger.long.entry;
  const shortEntry = trigger.short.entry;
  const crossedLong = lastClosed.close > longEntry;
  const crossedShort = lastClosed.close < shortEntry;
  const barTime = new Date(lastClosed.time * 1000).toISOString();
  const summary = `bar[${barTime}] close=${lastClosed.close.toFixed(2)} long_entry=${longEntry.toFixed(2)} short_entry=${shortEntry.toFixed(2)}`;

  if (!crossedLong && !crossedShort) {
    return { triggered: false, reason: `${summary} — no crossover`, lastClosed };
  }

  // Both can't fire on the same bar mathematically (long_entry > short_entry).
  // But guard against it anyway — prefer long if somehow both true (extreme bar).
  const direction = crossedLong ? 'CALLS' : 'PUTS';
  const side = crossedLong ? trigger.long : trigger.short;
  return {
    triggered: true,
    direction,
    reason: `${summary} → ${direction} (close ${crossedLong ? '>' : '<'} ${(crossedLong ? longEntry : shortEntry).toFixed(2)})`,
    signal: {
      triggerType: 'A',
      direction,
      entry: side.entry,
      stop: side.stop,
      T1: side.T1,
      T2: side.T2,
      R: side.R,
      barTime,
      barClose: lastClosed.close,
      currentPrice,
    },
    lastClosed,
  };
}

/**
 * Trigger B: VWAP / EMA21 reclaim, bias-locked to premarket direction.
 *
 * Each cycle:
 *   1. Compute session-VWAP (cumulative from 09:30 SGT), H1 EMA21, ATR(14)
 *   2. For the last CLOSED 15m bar, check VWAP first then EMA21
 *      - LONG (bias='BULL'): open ≤ level AND close > level AND bullish body
 *      - SHORT (bias='BEAR'): open ≥ level AND close < level AND bearish body
 *      - Plus rVol ≥ TRIGGER_B_RVOL_THRESHOLD
 *      - Plus STRUCTURE GATE: level on the right side of 1H EMA21 (±0.25×ATR)
 *   3. First level to fire wins (VWAP precedence)
 *
 * Aligned to the US watcher 2026-06-06: entry=level, R=ATR(14), stop=level∓R,
 * T1=level±R, T2=level±2R. stop/T1/T2 are reference / mental-map only — the real
 * exit is the fixed 15% option-premium stop (placeHKFixedStop), not these.
 *
 * Returns { triggered, reason, signal?, levels: {vwap, ema21_1h, atr} }.
 */
function validateTriggerB(bars, hkOpenTs, bias, currentPrice) {
  // Always compute levels first (returned regardless of fire) so the
  // dashboard / __CHECK__ marker can show them on every cycle.
  const vwap = anchoredSessionVWAP(bars, hkOpenTs);
  const ema21_1h = getEMA21_1H_AsOf(bars, Math.floor(Date.now() / 1000));
  const atrVal = atr(bars, 14);
  const levels = {
    vwap: vwap != null ? Number(vwap.toFixed(2)) : null,
    ema21_1h: ema21_1h != null ? Number(ema21_1h.toFixed(2)) : null,
    atr: atrVal != null ? Number(atrVal.toFixed(2)) : null,
  };

  if (!bars || bars.length < 2) {
    return { triggered: false, reason: `insufficient bars (${bars?.length ?? 0})`, levels };
  }
  if (bias !== 'BULL' && bias !== 'BEAR') {
    return {
      triggered: false,
      reason: `B disabled: premarket bias is ${bias ?? 'unknown'} (need BULL or BEAR)`,
      levels,
    };
  }
  // ATR(14) anchors R (= stop/T1/T2 distance) and the structure-gate band.
  // Mirror US: no ATR yet → don't fire (needs ≥15 closed 15m bars).
  if (atrVal == null) {
    return { triggered: false, reason: `ATR not yet computable (need ≥15 bars, have ${bars.length})`, levels };
  }

  const lastClosed = bars[bars.length - 1];
  const priorBars = bars.slice(0, -1);
  const avgVol = priorBars.length
    ? priorBars.reduce((s, b) => s + (b.volume || 0), 0) / priorBars.length
    : 0;
  const rVol = avgVol > 0 ? (lastClosed.volume || 0) / avgVol : 0;
  const direction = bias === 'BULL' ? 'CALLS' : 'PUTS';

  // Check VWAP first, then EMA21
  const isLong = bias === 'BULL';
  const STRUCTURE_CHECK_K = 0.25;
  const checks = [
    { name: 'VWAP', level: vwap },
    { name: 'EMA21_1H', level: ema21_1h },
  ];
  for (const c of checks) {
    const r = validateTriggerBBar({
      bar: lastClosed, bias, level: c.level, rVol,
      rVolThreshold: TRIGGER_B_RVOL_THRESHOLD,
    });
    if (!r.fires) continue;

    // ─── Structure gate (ported from US 2026-06-06) ──────────────────────────
    // The reclaimed level must sit on the right side of the 1H EMA21 (±0.25×ATR)
    // — the entry can't be against the 1H trend. Lenient when EMA21 isn't yet
    // computable; degenerate-true when the level IS the EMA21. Mirrors the US fix
    // after the 2026-04-29 SPY −$20 (a B fire against the 1H trend).
    const structureOk = ema21_1h == null
      ? true
      : isLong
        ? c.level >= ema21_1h - STRUCTURE_CHECK_K * atrVal
        : c.level <= ema21_1h + STRUCTURE_CHECK_K * atrVal;
    if (!structureOk) {
      const threshold = isLong ? ema21_1h - STRUCTURE_CHECK_K * atrVal : ema21_1h + STRUCTURE_CHECK_K * atrVal;
      return {
        triggered: false,
        reason: `${c.name} reclaim BUT structure failed: ${c.name}=${c.level.toFixed(2)} ${isLong ? '<' : '>'} 1H_EMA21 ${ema21_1h.toFixed(2)} ${isLong ? '−' : '+'} 0.25×ATR (=${threshold.toFixed(2)})`,
        levels,
      };
    }

    // Entry = the reclaimed level (ported from US 2026-06-06; was bar.close).
    // R = ATR(14). stop/T1/T2 are reference / mental-map only — the real exit is
    // the fixed 15% option-premium stop (placeHKFixedStop), not these levels.
    const entry = c.level;
    const stop = isLong ? entry - atrVal : entry + atrVal;
    const T1 = isLong ? entry + atrVal : entry - atrVal;
    const T2 = isLong ? entry + 2 * atrVal : entry - 2 * atrVal;
    const R = atrVal;
    const barTime = new Date(lastClosed.time * 1000).toISOString();
    return {
      triggered: true,
      reason: `${c.name} ${r.reason} · rVol ${rVol.toFixed(2)} · entry@level ${entry.toFixed(2)} (R=ATR ${atrVal.toFixed(2)})`,
      levels,
      signal: {
        triggerType: 'B',
        subTrigger: c.name,
        direction,
        entry: Number(entry.toFixed(2)),
        stop: Number(stop.toFixed(2)),
        T1: Number(T1.toFixed(2)),
        T2: Number(T2.toFixed(2)),
        R: Number(R.toFixed(2)),
        barTime,
        barClose: lastClosed.close,
        rVol: Number(rVol.toFixed(2)),
        level: Number(c.level.toFixed(2)),
        levelName: c.name,
        currentPrice,
      },
    };
  }

  // Neither fired — first-failure reason wins for the log
  const vwapCheck = validateTriggerBBar({ bar: lastClosed, bias, level: vwap, rVol, rVolThreshold: TRIGGER_B_RVOL_THRESHOLD });
  return {
    triggered: false,
    reason: `VWAP=${levels.vwap ?? '—'} EMA21=${levels.ema21_1h ?? '—'} · ${vwapCheck.reason}`,
    levels,
  };
}

// ─── Order placement on triggered + gates-pass ──────────────────────────────
async function handleTriggered({ spec, signal, underlying }) {
  console.log(`\n🔔 ${instrumentKey} ${signal.direction} TRIGGERED — entry=${signal.entry} stop=${signal.stop} T1=${signal.T1} T2=${signal.T2}`);

  if (nextOrderId == null) {
    console.log(`   ⚠ nextOrderId not received from IBKR yet — aborting fire`);
    return false;
  }

  // 1. Pick expiry (Wednesday weekly)
  const chain = await getHKOptionChainParams(ib, spec, underlying.conId);
  if (chain.expirations.size === 0) {
    console.log(`   ⚠ option chain empty — aborting fire (verify HK market data sub)`);
    return false;
  }
  const expiry = pickHKWednesdayWeeklyExpiry(chain.expirations);

  // 2. Pick ATM strike from chain
  const pick = await pickHKStrikeATM({ ib, spec, expiry, entryPrice: signal.entry, direction: signal.direction });
  if (!pick) {
    console.log(`   ⚠ no strike picker result — aborting fire`);
    return false;
  }

  // 3. Order spec print
  const qty = 1;  // v1: hardcoded qty=1 for HK (premiums are 3x SPY notional)
  printHKOrderSpec({
    instrumentKey, spec,
    direction: signal.direction, strike: pick.strike, expiry,
    qty, port: IBKR_HK_CONFIG.port, staged: false,
    entryPrice: signal.entry,
    exitSpec: { stop: signal.stop, T1: signal.T1, T2: signal.T2 },
  });

  // 4. Place BUY MKT order (entry)
  const entryOrderId = nextOrderId++;

  try {
    placeHKStagedOrder({
      ib, spec, expiry, strike: pick.strike, qty,
      direction: signal.direction, orderId: entryOrderId, staged: false,
    });
  } catch (e) {
    console.log(`   ✗ placeHKStagedOrder failed: ${e.message}`);
    return false;
  }

  // 5. Exit plan — FIXED STOP (user decision 2026-06-04). The trailing stop is
  //    retired (it failed to ratchet on cheap/fast 0DTE premium — see the US
  //    SPY 753P case). HK premiums span ~1 HKD (Alibaba) to ~7 HKD (Tencent), so
  //    the stop is a PERCENTAGE: stopPrice = optionMid × (1 − HK_STOP_PCT), where
  //    optionMid was queried at strike-pick time (≈ the MKT fill). Market exit on
  //    a live-bid (triggerMethod=1) STP that does NOT move. If no mid is available
  //    (thin book), fall back to the trailing stop so there's always protection.
  //    The OCA bracket + trailing helpers remain in ibkr_hk_orders.mjs (reversible).
  const trailing = getTrailing(instrumentKey, spec);
  const HK_STOP_PCT = (() => {
    const v = Number(process.env.WATCHER_HK_STOP_PCT ?? 0.15);
    return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.15;
  })();
  let exitMeta = {};
  let exitPlaced = false;
  const fillBasis = Number(pick.mid);
  if (Number.isFinite(fillBasis) && fillBasis > 0) {
    const stopOrderId = nextOrderId++;
    const stopPrice = Math.max(0.01, Math.round(fillBasis * (1 - HK_STOP_PCT) * 100) / 100);
    try {
      placeHKFixedStop({
        ib, spec,
        expiry, strike: pick.strike, right: pick.right, qty,
        stopPrice,
        orderId: stopOrderId,
        staged: false,
      });
      printHKFixedStopSpec({
        instrumentKey, spec,
        direction: signal.direction, strike: pick.strike, right: pick.right, qty,
        stopPrice, fillBasis,
        orderId: stopOrderId,
      });
      exitMeta = { exitMode: 'fixed_stop', stopOrderId, stopPrice, stopPct: HK_STOP_PCT, fillBasis };
      exitPlaced = true;
    } catch (e) {
      console.log(`   ✗ placeHKFixedStop failed: ${e.message} — falling back to trailing`);
    }
  }
  if (!exitPlaced) {
    const trailOrderId = nextOrderId++;
    try {
      placeHKTrailingStop({
        ib, spec,
        expiry, strike: pick.strike, right: pick.right, qty,
        trailAmount: trailing.trailAmount,
        orderId: trailOrderId,
        staged: false,
      });
    } catch (e) {
      console.log(`   ✗ placeHKTrailingStop (fallback) failed: ${e.message}`);
      return false;
    }
    printHKTrailingSpec({
      instrumentKey, spec,
      direction: signal.direction, strike: pick.strike, right: pick.right, qty,
      trailAmount: trailing.trailAmount,
      orderId: trailOrderId,
    });
    console.log(`   ⚠ no option mid to size the ${(HK_STOP_PCT * 100).toFixed(0)}% stop — used trailing fallback (-${trailing.trailAmount} ${spec.currency || 'HKD'})`);
    exitMeta = { exitMode: 'trailing_fallback', trailOrderId, trailAmount: trailing.trailAmount };
  }

  // 6. Record + notify
  recordTrade(instrumentKey, {
    triggerType: signal.triggerType,
    direction: signal.direction,
    strike: pick.strike,
    right: pick.right,
    expiry,
    qty,
    orderId: entryOrderId,
    ...exitMeta,
  });

  const exitLine = exitMeta.exitMode === 'fixed_stop'
    ? `fixed stop ${exitMeta.stopPrice} ${spec.currency || 'HKD'} (${(exitMeta.stopPct * 100).toFixed(0)}% below ~${fillBasis.toFixed(2)})`
    : `TRAIL -${trailing.trailAmount.toFixed(2)} ${spec.currency || 'HKD'} (fallback)`;
  await discordHSI(
    `🔔 ${instrumentKey} ${signal.direction} fired — ${pick.strike}${pick.right} exp ${expiry} × ${qty}\n` +
    `entry ${signal.entry} · ${exitLine}\n` +
    `Account: ${modeLabel()} (port ${IBKR_HK_CONFIG.port})  ·  orderId=${entryOrderId}`
  );

  return true;
}

// ─── Shared: gate cascade + fire path (used by both A and B) ────────────────
async function handleSignalThroughGates({ spec, signal, currentPrice, underlying, reason }) {
  const verdict = await evaluateAllGates({
    instrumentKey,
    signal: { entry: signal.entry, direction: signal.direction, currentPrice },
  });
  console.log(formatVerdict(verdict));

  if (!verdict.passed) {
    const blockedBy = verdict.blocking.join(',');
    emitCheckMarker({
      triggerType: signal.triggerType,
      triggered: true, blockedBy, reason,
      gates: verdict.gates, signal,
    });
    await discordHSI(
      `🚧 ${instrumentKey} ${signal.direction} (${signal.triggerType}) would have fired — BLOCKED by [${blockedBy}]\n` +
      `entry ${signal.entry} · current ${currentPrice?.toFixed(2) ?? '?'}\n` +
      Object.entries(verdict.gates)
        .filter(([, g]) => g.blocking)
        .map(([n, g]) => `   · ${n}: ${g.reason}`)
        .join('\n')
    );
    return false;
  }

  emitCheckMarker({
    triggerType: signal.triggerType,
    triggered: true, reason,
    signal, gates: verdict.gates,
  });
  return await handleTriggered({ spec, signal, underlying });
}

// ─── One check cycle ────────────────────────────────────────────────────────
async function runOneCheck({ spec, trigger, underlying, bias }) {
  // Trade-cap fast path — don't even fetch bars if we're capped.
  const tradeCount = getTradeCount(instrumentKey);
  if (tradeCount >= maxTradesPerDay()) {
    console.log(`   ⏸  ${instrumentKey} at trade cap (${tradeCount}/${maxTradesPerDay()}) — skipping check`);
    return false;
  }

  // Fetch underlying bars
  const bars = await fetchUnderlyingBars(underlying.contract);
  const currentPrice = bars.length ? bars[bars.length - 1].close : null;
  console.log(`   bars=${bars.length}  last_close=${currentPrice ?? 'n/a'}`);

  // ─── Trigger A (ORB breakout) ────────────────────────────────────────────
  const a = validateTriggerA(bars, trigger, currentPrice);
  console.log(`   A: ${a.triggered ? '🔔 TRIGGERED' : 'not yet'} — ${a.reason}`);

  if (a.triggered) {
    return await handleSignalThroughGates({
      spec, signal: a.signal, currentPrice, underlying, reason: a.reason,
    });
  }

  // A didn't fire → log A's check marker, then try B
  emitCheckMarker({
    triggerType: 'A',
    triggered: false, reason: a.reason,
    barClose: a.lastClosed?.close,
    barTime: a.lastClosed ? new Date(a.lastClosed.time * 1000).toISOString() : null,
    longEntry: trigger?.long?.entry ?? null,
    shortEntry: trigger?.short?.entry ?? null,
  });

  // ─── Trigger B (VWAP / EMA21 reclaim, bias-locked) ───────────────────────
  const hkOpenTs = todaysHKOpenTimestamp();
  const b = validateTriggerB(bars, hkOpenTs, bias, currentPrice);
  console.log(`   B: ${b.triggered ? '🔔 TRIGGERED' : 'not yet'} — ${b.reason}`);

  if (b.triggered) {
    return await handleSignalThroughGates({
      spec, signal: b.signal, currentPrice, underlying, reason: b.reason,
    });
  }

  emitCheckMarker({
    triggerType: 'B',
    triggered: false, reason: b.reason,
    bias,
    levels: b.levels,
  });
  return false;
}

// ─── Main loop ──────────────────────────────────────────────────────────────
async function runLoop(ctx) {
  let checkNum = 0;
  const until = untilDate();
  console.log(`\n[${nowSGTStr()} SGT] Initial check...`);
  try {
    await runOneCheck(ctx);
  } catch (e) {
    console.log(`   initial check error: ${e.message}`);
  }

  while (true) {
    if (Date.now() >= until.getTime()) {
      console.log(`\n⏰ ${untilStr} SGT reached. Exiting.`);
      break;
    }
    if (getTradeCount(instrumentKey) >= maxTradesPerDay()) {
      console.log(`\n✅ ${instrumentKey} at trade cap. Staying alive for in-flight bracket fills until ${untilStr} SGT.`);
      console.log('__EXIT_REASON__ trade_cap');
      // Sleep in 60s chunks for clean --until exit
      while (Date.now() < until.getTime()) {
        await new Promise(r => setTimeout(r, Math.min(60_000, until.getTime() - Date.now())));
      }
      break;
    }
    const nextBoundary = nextCandleBoundary();
    if (nextBoundary.getTime() > until.getTime()) {
      const remainMs = until.getTime() - Date.now();
      console.log(`\n⏰ Next boundary past --until. Sleeping ${Math.round(remainMs / 60000)}m then exiting.`);
      await new Promise(r => setTimeout(r, remainMs));
      break;
    }
    const waitMs = nextBoundary.getTime() - Date.now();
    console.log(`\nSleeping ${Math.round(waitMs / 1000)}s until ${nextBoundary.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Hong_Kong' })} SGT...`);
    await new Promise(r => setTimeout(r, waitMs));

    checkNum++;
    console.log(`\n[${nowSGTStr()} SGT] Check #${checkNum}...`);
    try { await runOneCheck(ctx); }
    catch (e) { console.log(`   check error: ${e.message}`); }
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n┌──────────────────────────────────────────────────────────────────┐`);
  console.log(`│ HK Watcher — ${instrumentKey.padEnd(10)}  ${modeLabel().padEnd(6)} clientId=${watcherClientId}  until ${untilStr} SGT │`);
  console.log(`│ IBKR ${IBKR_HK_CONFIG.host}:${IBKR_HK_CONFIG.port}   Discord=${DISCORD_HSI_ENABLED ? 'ON ' : 'OFF'}                              │`);
  console.log(`└──────────────────────────────────────────────────────────────────┘`);

  let ctx;
  try {
    ctx = await loadContext();
  } catch (e) {
    console.error(`\n✗ Setup failed: ${e.message}`);
    process.exit(1);
  }
  console.log(`   spec: ${ctx.spec.name} (kind=${ctx.spec.kind}, ×${ctx.spec.multiplier})`);
  if (ctx.trigger) {
    console.log(`   trigger: long entry=${ctx.trigger.long.entry}/stop=${ctx.trigger.long.stop}/T1=${ctx.trigger.long.T1}`);
    console.log(`            short entry=${ctx.trigger.short.entry}/stop=${ctx.trigger.short.stop}/T1=${ctx.trigger.short.T1}`);
  } else {
    console.log(`   trigger: Trigger A OFF (no ORB) — Trigger B only (VWAP/EMA21 reclaim; entry/stop/T1/T2 computed live)`);
  }
  console.log(
    `   bias: ${ctx.bias ?? 'UNKNOWN'}${ctx.alignment ? ` (alignment=${ctx.alignment})` : ''}${ctx.bias === 'BULL' || ctx.bias === 'BEAR' ? ' — Trigger B enabled' : ' — Trigger B DISABLED (need BULL/BEAR for direction-lock)'}`
  );

  try {
    await connectIB();
    console.log(`   ✓ IBKR connected`);
  } catch (e) {
    console.error(`\n✗ IBKR connection failed: ${e.message}`);
    console.error(`   Is TWS/Gateway running with API on port ${IBKR_HK_CONFIG.port}?`);
    process.exit(1);
  }

  let underlying;
  try {
    underlying = await resolveHKUnderlyingConId(ib, ctx.spec);
    console.log(`   ✓ underlying resolved: conId=${underlying.conId} exchange=${underlying.exchange}${underlying.frontMonthExpiry ? ` (front-month FUT ${underlying.frontMonthExpiry})` : ''}`);
  } catch (e) {
    console.error(`\n✗ Underlying resolve failed: ${e.message}`);
    console.error(`   Run: node asia/scripts/test_hk_contract_resolve.mjs ${instrumentKey}`);
    process.exit(1);
  }

  // Pre-flight gate check (informational only)
  const preflight = await evaluateAllGates({ instrumentKey, signal: null });
  console.log(`\nPre-flight gate snapshot:`);
  console.log(formatVerdict(preflight));
  if (!preflight.passed) {
    console.log(`   ⓘ Pre-flight has blocking gates. Watcher will still run but fires will be blocked until gates clear.`);
  }

  await discordHSI(
    `🟢 ${instrumentKey} watcher armed (${modeLabel()}). ${ctx.trigger
      ? `ORB long ${ctx.trigger.long.entry} · short ${ctx.trigger.short.entry}`
      : `Trigger B only (no ORB) — bias ${ctx.bias ?? '?'}`}. Until ${untilStr} SGT.`
  );

  await runLoop({ spec: ctx.spec, trigger: ctx.trigger, underlying, bias: ctx.bias });
  ib.disconnect();
  notifyExit('session ended (--until reached)', 0);
}

// ─── SIGINT handler ─────────────────────────────────────────────────────────
let shuttingDown = false;
process.on('SIGINT', () => {
  if (shuttingDown) process.exit(0);
  shuttingDown = true;
  console.log(`\n\n⏹  Ctrl+C — shutting down cleanly...`);
  try { ib.disconnect(); } catch {}
  notifyExit('stopped (Ctrl+C / SIGINT)', 0);
});

main().catch((e) => {
  console.error('Fatal:', e);
  notifyExit(`FATAL — ${e?.message ?? e}`, 1);
});
