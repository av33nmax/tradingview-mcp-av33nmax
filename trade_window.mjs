/**
 * trade_window.mjs — time-bounded candle-close validator + auto-notify + order
 * placement for Trigger A (ORB breakout).
 *
 * Usage:
 *   node trade_window.mjs <SPY|QQQ> [--until HH:MM] [--test]
 *
 * Example:
 *   node trade_window.mjs SPY --until 23:00
 *
 * What it does:
 *   1. Loads entry_notes from latest_entry_notes.json (requires fresh premarket_setup)
 *   2. Verifies ticker is tradeable (bias aligned, entry_notes present)
 *   3. Connects to IBKR (paper TWS via shared config)
 *   4. Loops every 15m aligned to candle closes (:00, :15, :30, :45 + 30s):
 *        - Pulls last N 15m TRADES bars
 *        - Finds most recent completed bar
 *        - Checks: close crossed Trigger A entry?
 *        - Checks: rVol = curVol / avg(20 prior bars) ≥ 1.2?
 *        - Checks: within RTH + after ORB (9:45 ET) + before time stop (14:00 ET)?
 *   5. On trigger fire:
 *        - macOS notification + sound
 *        - Picks strike with premium in $0.50-$0.90 via historical mid
 *        - Prompts "type YES"
 *        - Places MKT DAY order with transmit=false (you click Transmit in TWS)
 *        - Exits loop (one-trade-per-day enforcement)
 *   6. Auto-stops at --until time (default 23:00 SGT)
 *   7. Ctrl+C exits cleanly
 *
 * Design aligned with user prefs 2026-04-24:
 *   - Path A (systematic trader)
 *   - One trade per day enforced
 *   - 15m close + rVol ≥ 1.2 discipline (no tick-touch triggers)
 *   - Human YES gate before order placement
 *   - transmit=false (two-gate safety: YES in CLI + Transmit in TWS)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { IBApi, EventName, SecType } from '@stoqey/ib';
import { IBKR_CONFIG, CLIENT_IDS, isInfoCode } from './ibkr_config.mjs';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_NOTES_FILE = path.join(REPO_ROOT, 'latest_entry_notes.json');

// ─── Config ──────────────────────────────────────────────────────────────────
const PREMIUM_MIN = 0.50;
const PREMIUM_MAX = 0.90;
const MAX_RISK_USD = 300;
const STRIKES_TO_QUERY = 20;
const REQ_PACING_MS = 200;
const COLLECT_WINDOW_MS = 35000;
const STAGED_MODE = true;               // transmit=false — user clicks Transmit in TWS
const RVOL_THRESHOLD = 1.2;
const VOLUME_LOOKBACK_BARS = 20;
const STALE_ENTRY_NOTES_HOURS = 4;
const TIME_STOP_ET_HOUR = 14;           // 14:00 ET — no new entries after
const ORB_COMPLETE_ET_HOUR = 9;
const ORB_COMPLETE_ET_MIN = 45;
const RTH_CLOSE_ET_HOUR = 16;           // 16:00 ET market close

// ─── Arg parsing ─────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const ticker = args[0]?.toUpperCase();
  if (!['SPY', 'QQQ'].includes(ticker)) {
    console.error('Usage: node trade_window.mjs <SPY|QQQ> [--until HH:MM]');
    process.exit(1);
  }

  let untilStr = '23:00';  // default: 11:00 PM SGT
  const untilIdx = args.indexOf('--until');
  if (untilIdx >= 0 && args[untilIdx + 1]) untilStr = args[untilIdx + 1];

  const [h, m] = untilStr.split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    console.error(`Invalid --until time: ${untilStr}. Expected HH:MM.`);
    process.exit(1);
  }
  const until = new Date();
  until.setHours(h, m, 0, 0);
  if (until.getTime() <= Date.now()) {
    console.error(`--until ${untilStr} is in the past. Exiting.`);
    process.exit(1);
  }

  const testMode = args.includes('--test');

  return { ticker, until, untilStr, testMode };
}

const { ticker, until, untilStr, testMode } = parseArgs();

// ─── Load entry_notes ────────────────────────────────────────────────────────
function loadEntryNotes(ticker) {
  if (!fs.existsSync(ENTRY_NOTES_FILE)) {
    console.error(`❌ ${path.basename(ENTRY_NOTES_FILE)} not found. Run premarket_setup.mjs first.`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(ENTRY_NOTES_FILE, 'utf8'));
  const ageMs = Date.now() - new Date(raw.generatedAt).getTime();
  const ageHrs = ageMs / 3600000;
  if (ageHrs > STALE_ENTRY_NOTES_HOURS) {
    console.error(`❌ entry_notes is ${ageHrs.toFixed(1)}h old (>${STALE_ENTRY_NOTES_HOURS}h stale threshold).`);
    console.error(`   Re-run premarket_setup.mjs for fresh values.`);
    process.exit(1);
  }
  const t = raw.tickers?.[ticker];
  if (!t) {
    console.error(`❌ ${ticker} not present in entry_notes.`);
    process.exit(1);
  }
  if (!t.entry_notes) {
    console.error(`❌ ${ticker} shows ${t.bias} (aligned=${t.aligned}) — no trade signal.`);
    console.error(`   This ticker is NOT tradeable per the latest analysis. Aborting.`);
    process.exit(0);
  }
  return {
    data: t.entry_notes,
    ageHrs,
    generatedAt: raw.generatedAt,
  };
}

const { data: entryNotes, ageHrs } = loadEntryNotes(ticker);
const direction = entryNotes.direction;  // 'CALLS' or 'PUTS'
const right = direction === 'CALLS' ? 'C' : 'P';
const triggerA = entryNotes.trigger_a;
const entryPrice = triggerA.entry;

// ─── Time helpers ────────────────────────────────────────────────────────────
function nowInTZ(tz) {
  // Returns {h, m, s} in the given TZ (e.g. 'America/New_York')
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = fmt.formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
  const s = parseInt(parts.find(p => p.type === 'second').value, 10);
  return { h, m, s };
}

function nowETStr() {
  const { h, m, s } = nowInTZ('America/New_York');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ET`;
}

function nowSGTStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} SGT`;
}

function isWithinTradingWindow() {
  const { h, m } = nowInTZ('America/New_York');
  const mins = h * 60 + m;
  const orbMins = ORB_COMPLETE_ET_HOUR * 60 + ORB_COMPLETE_ET_MIN;  // 9:45 ET
  const timeStopMins = TIME_STOP_ET_HOUR * 60;                       // 14:00 ET
  return mins >= orbMins && mins < timeStopMins;
}

function nextCandleBoundary() {
  // Next :00, :15, :30, or :45 past current time + 30s buffer
  const now = new Date();
  const m = now.getMinutes();
  const nextQuarter = Math.floor(m / 15) * 15 + 15;  // always move to NEXT boundary
  const target = new Date(now);
  target.setSeconds(30);
  target.setMilliseconds(0);
  target.setMinutes(nextQuarter);  // JS handles rollover to next hour
  if (target.getTime() - now.getTime() < 30000) {
    // Too close — jump to the boundary after
    target.setTime(target.getTime() + 15 * 60 * 1000);
  }
  return target;
}

// ─── IBKR connection ─────────────────────────────────────────────────────────
const ib = new IBApi({ host: IBKR_CONFIG.host, port: IBKR_CONFIG.port, clientId: CLIENT_IDS.market_data });

let connected = false;
let nextOrderId = null;
const errorCounts = new Map();

ib.on(EventName.connected, () => { connected = true; });
ib.on(EventName.disconnected, () => { connected = false; });
ib.on(EventName.nextValidId, (id) => { nextOrderId = id; });
ib.on(EventName.error, (err, code, reqId) => {
  if (isInfoCode(code)) return;
  // Silent on known benign codes
  if (code === 162 || code === 200 || code === 300 || code === 354 || code === 2137) return;
  errorCounts.set(code, (errorCounts.get(code) || 0) + 1);
  if (errorCounts.get(code) === 1) {
    console.log(`   [first] error [code=${code}  reqId=${reqId}]  ${err?.message || err}`);
  }
});

function connectIB() {
  return new Promise((resolve, reject) => {
    const handler = () => { ib.off(EventName.connected, handler); resolve(); };
    ib.on(EventName.connected, handler);
    const errHandler = (err, code) => {
      if (!isInfoCode(code) && code < 2000) {
        ib.off(EventName.error, errHandler);
        reject(new Error(`connect failed: ${err?.message || err}`));
      }
    };
    ib.on(EventName.error, errHandler);
    ib.connect();
    setTimeout(() => reject(new Error('connection timeout after 10s')), 10000);
  });
}

// ─── Candle-close validator ──────────────────────────────────────────────────
let nextReqId = 8000;

function reqHistoricalBars(contract, duration, barSize, whatToShow = 'TRADES') {
  return new Promise((resolve) => {
    const reqId = nextReqId++;
    const bars = [];

    const onBar = (id, time, open, high, low, close, volume) => {
      if (id !== reqId) return;
      if (typeof time === 'string' && time.startsWith('finished')) return;
      const epoch = typeof time === 'string' ? parseInt(time, 10) : time;
      if (Number.isFinite(epoch) && close > 0) {
        bars.push({ time: epoch, open, high, low, close, volume: volume || 0 });
      }
    };
    const onEnd = (id) => {
      if (id !== reqId) return;
      ib.off(EventName.historicalData, onBar);
      ib.off(EventName.historicalDataEnd, onEnd);
      resolve(bars);
    };

    ib.on(EventName.historicalData, onBar);
    ib.on(EventName.historicalDataEnd, onEnd);

    // useRTH=1 — only RTH bars, keeps volume comparable across checks
    // formatDate=2 — epoch seconds as string, easier to parse
    ib.reqHistoricalData(reqId, contract, '', duration, barSize, whatToShow, 1, 2, false);

    // Fail-safe timeout
    setTimeout(() => {
      ib.off(EventName.historicalData, onBar);
      ib.off(EventName.historicalDataEnd, onEnd);
      resolve(bars);
    }, 10000);
  });
}

async function validateCandleClose() {
  const stockContract = {
    symbol: ticker, secType: SecType.STK, exchange: 'SMART', currency: 'USD',
  };

  // Pull enough bars for rVol baseline: need last closed + 20 prior = 21 completed + forming possible
  // 1 day = 26 × 15m bars, plenty of room
  const bars = await reqHistoricalBars(stockContract, '1 D', '15 mins', 'TRADES');

  if (bars.length < VOLUME_LOOKBACK_BARS + 1) {
    return { triggered: false, reason: `insufficient bars (${bars.length})`, bars: 0 };
  }

  // Sort oldest → newest
  bars.sort((a, b) => a.time - b.time);

  // Identify most recent COMPLETED bar
  const nowSec = Math.floor(Date.now() / 1000);
  const completed = bars.filter(b => b.time + 15 * 60 <= nowSec);
  if (completed.length < VOLUME_LOOKBACK_BARS + 1) {
    return { triggered: false, reason: `only ${completed.length} completed bars`, bars: completed.length };
  }
  const lastClosed = completed[completed.length - 1];
  const priorBars = completed.slice(-(VOLUME_LOOKBACK_BARS + 1), -1);  // 20 bars before the last closed

  // Time-guard: bar must be within today's RTH (reject stale data if TWS returns yesterday's data)
  const etNow = nowInTZ('America/New_York');
  const barAgeMin = (nowSec - lastClosed.time - 15 * 60) / 60;
  if (barAgeMin > 20) {
    return { triggered: false, reason: `stale bar (${barAgeMin.toFixed(0)}m old)`, bars: completed.length };
  }

  // Volume check
  const avgVol = priorBars.reduce((s, b) => s + b.volume, 0) / priorBars.length;
  const rVol = avgVol > 0 ? lastClosed.volume / avgVol : 0;

  // Price crossing check
  const crossed = direction === 'CALLS'
    ? lastClosed.close > entryPrice
    : lastClosed.close < entryPrice;

  const barTimeET = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  }).format(new Date(lastClosed.time * 1000));

  const summary = `bar[${barTimeET} ET] close=${lastClosed.close.toFixed(2)} ${direction === 'CALLS' ? '>' : '<'}${entryPrice.toFixed(2)}=${crossed ? 'YES' : 'no'} rVol=${rVol.toFixed(2)}`;

  if (!crossed) {
    return { triggered: false, reason: summary, crossed: false, rVol, lastClosed };
  }
  if (rVol < RVOL_THRESHOLD) {
    return { triggered: false, reason: `${summary} (below ${RVOL_THRESHOLD})`, crossed: true, rVol, lastClosed };
  }
  if (!isWithinTradingWindow()) {
    return { triggered: false, reason: `${summary} BUT outside trading window [9:45-14:00 ET]`, crossed: true, rVol, lastClosed };
  }

  return { triggered: true, reason: summary, crossed: true, rVol, lastClosed };
}

// ─── macOS notifications ─────────────────────────────────────────────────────
function notify(title, message, sound = 'Submarine') {
  // Escape single quotes in title/message for osascript
  const esc = (s) => String(s).replace(/'/g, "\\'").replace(/"/g, '\\"');
  try {
    execSync(`osascript -e 'display notification "${esc(message)}" with title "${esc(title)}" sound name "${sound}"'`);
  } catch {
    // non-fatal — notification is a nice-to-have
  }
}

// ─── Order placement helpers (duplicated from place_option_order.mjs) ────────
// TODO future refactor: extract to shared ibkr_orders.mjs module so this and
// place_option_order.mjs call the same code.

async function resolveStockConId(ticker) {
  return new Promise((resolve, reject) => {
    const reqId = nextReqId++;
    let conId = null;
    const onDetails = (id, details) => { if (id === reqId && !conId) conId = details.contract.conId; };
    const onEnd = (id) => {
      if (id !== reqId) return;
      ib.off(EventName.contractDetails, onDetails);
      ib.off(EventName.contractDetailsEnd, onEnd);
      conId ? resolve(conId) : reject(new Error(`could not resolve ${ticker}`));
    };
    ib.on(EventName.contractDetails, onDetails);
    ib.on(EventName.contractDetailsEnd, onEnd);
    ib.reqContractDetails(reqId, {
      symbol: ticker, secType: SecType.STK, exchange: 'SMART', currency: 'USD',
    });
    setTimeout(() => reject(new Error('resolveStockConId timeout')), 8000);
  });
}

async function getOptionChainParams(ticker, underlyingConId) {
  return new Promise((resolve) => {
    const reqId = nextReqId++;
    const expirations = new Set();
    const strikes = new Set();
    const onParam = (id, exchange, undConId, tradingClass, multiplier, exps, strks) => {
      if (id !== reqId) return;
      for (const e of exps) expirations.add(e);
      for (const s of strks) strikes.add(s);
    };
    const onEnd = (id) => {
      if (id !== reqId) return;
      ib.off(EventName.securityDefinitionOptionParameter, onParam);
      ib.off(EventName.securityDefinitionOptionParameterEnd, onEnd);
      resolve({ expirations, strikes });
    };
    ib.on(EventName.securityDefinitionOptionParameter, onParam);
    ib.on(EventName.securityDefinitionOptionParameterEnd, onEnd);
    ib.reqSecDefOptParams(reqId, ticker, '', SecType.STK, underlyingConId);
    setTimeout(() => resolve({ expirations, strikes }), 10000);
  });
}

function pick0DTEExpiry(expirations) {
  const { h, m } = nowInTZ('America/New_York');
  const etDate = new Date(Date.now() - (h < 0 ? 0 : 0));  // just use UTC→ET for date
  const etFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [y, mo, d] = etFmt.format(new Date()).split('-');
  const today = `${y}${mo}${d}`;
  if (expirations.has(today)) return today;
  const sorted = [...expirations].sort();
  return sorted.find(e => e >= today) || sorted[0];
}

function nearestStrikes(allStrikes, centerPrice, n) {
  const arr = [...allStrikes].sort((a, b) => a - b);
  const rounds = arr.filter(s => Number.isInteger(s));
  const pool = rounds.length > 20 ? rounds : arr;
  pool.sort((a, b) => Math.abs(a - centerPrice) - Math.abs(b - centerPrice));
  return pool.slice(0, n).sort((a, b) => a - b);
}

async function queryOptionPremium(ticker, expiry, strike, right) {
  const contract = {
    symbol: ticker, secType: SecType.OPT, exchange: 'SMART', currency: 'USD',
    lastTradeDateOrContractMonth: expiry, strike, right, multiplier: '100',
  };
  const bars = await reqHistoricalBars(contract, '3600 S', '5 mins', 'MIDPOINT');
  if (!bars.length) return null;
  const last = bars[bars.length - 1];
  return last.close > 0 ? last.close : null;
}

async function pickStrike(ticker, expiry) {
  const { strikes } = await getOptionChainParams(ticker, await resolveStockConId(ticker));
  const nearby = nearestStrikes(strikes, entryPrice, STRIKES_TO_QUERY * 2);
  const candidates = direction === 'CALLS'
    ? nearby.filter(s => s >= entryPrice - 2).slice(0, STRIKES_TO_QUERY)
    : nearby.filter(s => s <= entryPrice + 2).slice(-STRIKES_TO_QUERY);

  console.log(`   Querying ${candidates.length} strikes (${candidates[0]}–${candidates[candidates.length - 1]})...`);

  const premiums = new Map();
  for (const strike of candidates) {
    const mid = await queryOptionPremium(ticker, expiry, strike, right);
    if (mid != null) premiums.set(strike, mid);
    await new Promise(r => setTimeout(r, REQ_PACING_MS));
  }

  const inRange = [...premiums.entries()]
    .filter(([, mid]) => mid >= PREMIUM_MIN && mid <= PREMIUM_MAX)
    .map(([strike, mid]) => ({ strike, mid }));

  if (inRange.length === 0) return null;
  inRange.sort((a, b) => Math.abs(a.strike - entryPrice) - Math.abs(b.strike - entryPrice));
  return inRange[0];
}

async function askYes(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

async function placeStagedOrder(ticker, expiry, strike, premiumEst) {
  const qty = Math.floor(MAX_RISK_USD / (premiumEst * 100));
  if (qty < 1) {
    console.log(`   ⚠ premium $${premiumEst} too high for $${MAX_RISK_USD} risk cap`);
    return false;
  }

  const exitSpec = triggerA;
  const rightLabel = direction === 'CALLS' ? 'CALL' : 'PUT';

  console.log(`\n════════════════════════════════════════════════════════════════`);
  console.log(`  ORDER SPEC — please review carefully`);
  console.log(`════════════════════════════════════════════════════════════════`);
  console.log(`  Symbol:        ${ticker}`);
  console.log(`  Right:         ${rightLabel} (${right})`);
  console.log(`  Strike:        ${strike}`);
  console.log(`  Expiry:        ${expiry}  (0DTE)`);
  console.log(`  Action:        BUY`);
  console.log(`  Quantity:      ${qty} contracts`);
  console.log(`  Order type:    MARKET`);
  console.log(`  Time-in-force: DAY`);
  console.log(`  Est premium:   $${premiumEst.toFixed(2)} (hist-mid)`);
  console.log(`  Est risk:      $${(qty * premiumEst * 100).toFixed(2)} / $${MAX_RISK_USD} cap`);
  console.log(`  transmit:      ${STAGED_MODE ? 'false (STAGED in TWS — you click Transmit to send)' : 'true (FIRES IMMEDIATELY)'}`);
  console.log(`────────────────────────────────────────────────────────────────`);
  console.log(`  Trigger A:     fires when ${ticker} ${direction === 'CALLS' ? '>' : '<'} ${entryPrice.toFixed(2)}`);
  console.log(`  Exit plan:     stop ${exitSpec.stop?.toFixed(2)}  ·  T1 ${exitSpec.T1?.toFixed(2)}  ·  T2 ${exitSpec.T2?.toFixed(2)}`);
  console.log(`  Account:       IBKR paper  (port ${IBKR_CONFIG.port})`);
  console.log(`════════════════════════════════════════════════════════════════`);

  const answer = await askYes(`\nType "YES" to ${STAGED_MODE ? 'STAGE in TWS' : 'FIRE NOW'}, anything else to abort: `);
  if (answer !== 'YES') {
    console.log(`   aborted — no order placed`);
    return false;
  }

  // Make sure we have an order ID
  if (nextOrderId == null) {
    ib.reqIds(-1);
    await new Promise(r => setTimeout(r, 1500));
  }
  if (nextOrderId == null) {
    console.log(`   ❌ no order ID from TWS`);
    return false;
  }

  const orderId = nextOrderId++;
  const contract = {
    symbol: ticker, secType: SecType.OPT, exchange: 'SMART', currency: 'USD',
    lastTradeDateOrContractMonth: expiry, strike, right, multiplier: '100',
  };
  const order = {
    action: 'BUY',
    totalQuantity: qty,
    orderType: 'MKT',
    tif: 'DAY',
    transmit: !STAGED_MODE,
    firmQuoteOnly: false,
    eTradeOnly: false,
  };

  console.log(`\n   placing order id=${orderId}...`);
  ib.placeOrder(orderId, contract, order);

  if (STAGED_MODE) {
    console.log(`\n✅ Order STAGED in TWS (orderId=${orderId}).`);
    console.log(`   Go to TWS Orders tab → click Transmit on the "Pending Transmission" row.`);
  } else {
    console.log(`\n🚀 Order SUBMITTED (orderId=${orderId}).`);
  }

  ib.on(EventName.orderStatus, (id, status, filled, remaining, avgFillPrice) => {
    if (id === orderId) {
      console.log(`   orderStatus  status=${status}  filled=${filled}  remaining=${remaining}  avgFill=${avgFillPrice ?? '-'}`);
    }
  });

  // Listen briefly for fills, then return
  await new Promise(r => setTimeout(r, 10000));
  return true;
}

// ─── Loop: fire validation at every 15m boundary until --until ───────────────
async function runLoop() {
  let checkNum = 0;
  let stopAfterThisCheck = false;

  // Do an immediate check first — useful if user starts mid-candle and a recent bar already crossed
  console.log(`[${nowETStr()}] Initial check...`);
  try {
    const r = await validateCandleClose();
    console.log(`   ${r.triggered ? '🔔 TRIGGERED' : 'not yet'}: ${r.reason}`);
    if (r.triggered && !testMode) {
      stopAfterThisCheck = await handleTriggered();
      if (stopAfterThisCheck) return;
    } else if (r.triggered && testMode) {
      console.log(`   (test mode — skipping order placement)`);
    }
  } catch (e) {
    console.log(`   initial validation error: ${e.message}`);
  }

  while (true) {
    if (Date.now() >= until.getTime()) {
      console.log(`\n⏰ ${untilStr} SGT reached. No trigger fired — closing cleanly.`);
      break;
    }

    const nextBoundary = nextCandleBoundary();
    if (nextBoundary.getTime() > until.getTime()) {
      const remainMs = until.getTime() - Date.now();
      console.log(`\n⏰ Next boundary (${nextBoundary.toLocaleTimeString()} SGT) is past --until ${untilStr}. Sleeping ${Math.round(remainMs/60000)}m more then exiting.`);
      await new Promise(r => setTimeout(r, remainMs));
      break;
    }

    const waitMs = nextBoundary.getTime() - Date.now();
    const nbTimeStr = nextBoundary.toLocaleTimeString('en-US', { hour12: false });
    console.log(`\nSleeping ${Math.round(waitMs/1000)}s until ${nbTimeStr} SGT...`);
    await new Promise(r => setTimeout(r, waitMs));

    checkNum++;
    console.log(`\n[${nowETStr()}] Check #${checkNum}...`);
    try {
      const r = await validateCandleClose();
      console.log(`   ${r.triggered ? '🔔 TRIGGERED' : 'not yet'}: ${r.reason}`);
      if (r.triggered && !testMode) {
        stopAfterThisCheck = await handleTriggered();
        if (stopAfterThisCheck) break;
      } else if (r.triggered && testMode) {
        console.log(`   (test mode — skipping order placement)`);
      }
    } catch (e) {
      console.log(`   validation error: ${e.message}`);
    }
  }
}

async function handleTriggered() {
  notify(`🎯 ${ticker} Trigger A`, `${direction} setup fired — switch to terminal to confirm`);

  const conId = await resolveStockConId(ticker);
  const { expirations } = await getOptionChainParams(ticker, conId);
  const expiry = pick0DTEExpiry(expirations);
  if (!expiry) {
    console.log(`   ⚠ no 0DTE expiry found — aborting`);
    return false;
  }

  const pick = await pickStrike(ticker, expiry);
  if (!pick) {
    console.log(`   ⚠ no strike in $${PREMIUM_MIN}-$${PREMIUM_MAX} premium range — aborting`);
    return false;
  }
  console.log(`   selected: ${pick.strike} ${right} @ est $${pick.mid.toFixed(2)}`);

  const placed = await placeStagedOrder(ticker, expiry, pick.strike, pick.mid);
  return placed;  // true = stop loop (one-trade-per-day)
}

// ─── Ctrl+C handler ──────────────────────────────────────────────────────────
let shuttingDown = false;
process.on('SIGINT', () => {
  if (shuttingDown) process.exit(0);
  shuttingDown = true;
  console.log('\n\n⏹  Ctrl+C — shutting down cleanly...');
  ib.disconnect();
  setTimeout(() => process.exit(0), 500);
});

// ─── Banner + main ───────────────────────────────────────────────────────────
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  trade_window.mjs — ${ticker} Trigger A watcher`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  Loaded entry_notes (${ageHrs.toFixed(1)}h old): ${ticker} ${direction}`);
console.log(`  Trigger A: 15m close ${direction === 'CALLS' ? '>' : '<'} ${entryPrice.toFixed(2)} with rVol ≥ ${RVOL_THRESHOLD}`);
console.log(`  Window:    now (${nowETStr()}) → ${untilStr} SGT`);
console.log(`  Mode:      ${testMode ? 'TEST (no order placement)' : 'LIVE (will prompt for YES on trigger)'}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

(async () => {
  console.log('Connecting to TWS...');
  try { await connectIB(); } catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
  console.log(`✅ connected (clientId=${CLIENT_IDS.market_data})`);

  await runLoop();

  ib.disconnect();
  setTimeout(() => process.exit(0), 500);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
