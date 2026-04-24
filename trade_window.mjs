/**
 * trade_window.mjs — time-bounded candle-close validator + auto-notify + order
 * placement for Trigger A (ORB breakout).
 *
 * Usage:
 *   node trade_window.mjs <SPY|QQQ> [--until HH:MM] [--test]
 *
 * What it does:
 *   1. Loads entry_notes from latest_entry_notes.json (requires fresh premarket_setup)
 *   2. Verifies: ticker tradeable, entry_notes not stale, one-trade-per-day OK
 *   3. Connects to IBKR paper TWS
 *   4. Loops every 15m aligned to candle closes (:00, :15, :30, :45 + 30s):
 *        - Pulls last N 15m TRADES bars
 *        - Finds most recent completed bar
 *        - Validates: close crossed trigger? rVol ≥ 1.2? in RTH window?
 *   5. On trigger fire:
 *        - macOS notification with Submarine sound
 *        - Picks 0DTE strike with premium in $0.50-$0.90, nearest-ATM
 *        - Prompts "type YES"
 *        - Places MKT DAY order with transmit=false (two-gate safety)
 *        - Records trade to traded_today.json, exits loop
 *   6. Auto-stops at --until time (default 23:00 SGT)
 *   7. Ctrl+C exits cleanly
 *
 * Path A systematic trader commitment:
 *   - 15m close + rVol ≥ 1.2 discipline (no tick-touch)
 *   - Human YES gate + TWS Transmit click (two human gates)
 *   - One-trade-per-day hard-enforced via persistent flag file
 *   - Stale entry_notes refused (>4h = must re-run premarket_setup)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { IBApi, EventName } from '@stoqey/ib';
import { IBKR_CONFIG, CLIENT_IDS, isInfoCode } from './ibkr_config.mjs';
import {
  reqHistoricalBars,
  resolveStockConId,
  getOptionChainParams,
  pick0DTEExpiry,
  pickStrikeInRange,
  promptYes,
  printOrderSpec,
  placeStagedOrder,
  placeOCABracketExits,
  printBracketSpec,
} from './ibkr_orders.mjs';
import {
  hasTradedToday,
  recordTrade,
  formatBlockedMessage,
} from './one_trade_per_day.mjs';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_NOTES_FILE = path.join(REPO_ROOT, 'latest_entry_notes.json');

// ─── Config ──────────────────────────────────────────────────────────────────
const PREMIUM_MIN = 0.50;
const PREMIUM_MAX = 0.90;
const MAX_RISK_USD = 300;
const STRIKES_TO_QUERY = 20;
const STAGED_MODE = true;                  // transmit=false — user clicks Transmit in TWS
const BRACKET_ENABLED = true;              // auto-place T1 + stop as OCA after fill
const RVOL_THRESHOLD = 1.2;
const VOLUME_LOOKBACK_BARS = 20;
const STALE_ENTRY_NOTES_HOURS = 4;
const TIME_STOP_ET_HOUR = 14;              // 14:00 ET — no new entries after
const ORB_COMPLETE_ET_HOUR = 9;
const ORB_COMPLETE_ET_MIN = 45;

// ─── Arg parsing ─────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const ticker = args[0]?.toUpperCase();
  if (!['SPY', 'QQQ'].includes(ticker)) {
    console.error('Usage: node trade_window.mjs <SPY|QQQ> [--until HH:MM] [--test]');
    process.exit(1);
  }

  let untilStr = '23:00';
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
  const ageHrs = (Date.now() - new Date(raw.generatedAt).getTime()) / 3600000;
  if (ageHrs > STALE_ENTRY_NOTES_HOURS) {
    console.error(`❌ entry_notes is ${ageHrs.toFixed(1)}h old (>${STALE_ENTRY_NOTES_HOURS}h stale threshold).`);
    console.error(`   Re-run premarket_setup.mjs for fresh values.`);
    process.exit(1);
  }
  const t = raw.tickers?.[ticker];
  if (!t) { console.error(`❌ ${ticker} not in entry_notes.`); process.exit(1); }
  if (!t.entry_notes) {
    console.error(`❌ ${ticker} shows ${t.bias} (aligned=${t.aligned}) — no trade signal. Aborting.`);
    process.exit(0);
  }
  return { data: t.entry_notes, ageHrs };
}

const { data: entryNotes, ageHrs } = loadEntryNotes(ticker);
const direction = entryNotes.direction;
const triggerA = entryNotes.trigger_a;
const entryPrice = triggerA.entry;

// ─── One-trade-per-day check at startup ──────────────────────────────────────
if (hasTradedToday(ticker)) {
  console.error(formatBlockedMessage(ticker));
  process.exit(1);
}

// ─── Time helpers ────────────────────────────────────────────────────────────
function nowInTZ(tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = fmt.formatToParts(new Date());
  return {
    h: parseInt(parts.find(p => p.type === 'hour').value, 10),
    m: parseInt(parts.find(p => p.type === 'minute').value, 10),
    s: parseInt(parts.find(p => p.type === 'second').value, 10),
  };
}

function nowETStr() {
  const { h, m, s } = nowInTZ('America/New_York');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ET`;
}

function isWithinTradingWindow() {
  const { h, m } = nowInTZ('America/New_York');
  const mins = h * 60 + m;
  const orbMins = ORB_COMPLETE_ET_HOUR * 60 + ORB_COMPLETE_ET_MIN;
  const timeStopMins = TIME_STOP_ET_HOUR * 60;
  return mins >= orbMins && mins < timeStopMins;
}

function nextCandleBoundary() {
  const now = new Date();
  const m = now.getMinutes();
  const nextQuarter = Math.floor(m / 15) * 15 + 15;
  const target = new Date(now);
  target.setSeconds(30);
  target.setMilliseconds(0);
  target.setMinutes(nextQuarter);
  if (target.getTime() - now.getTime() < 30000) {
    target.setTime(target.getTime() + 15 * 60 * 1000);
  }
  return target;
}

// ─── IBKR connection ─────────────────────────────────────────────────────────
const ib = new IBApi({ host: IBKR_CONFIG.host, port: IBKR_CONFIG.port, clientId: CLIENT_IDS.market_data });

let nextOrderId = null;
const errorCounts = new Map();

ib.on(EventName.nextValidId, (id) => { nextOrderId = id; });
ib.on(EventName.error, (err, code, reqId) => {
  if (isInfoCode(code)) return;
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
    ib.connect();
    setTimeout(() => reject(new Error('connection timeout after 10s')), 10000);
  });
}

// ─── Notifications ───────────────────────────────────────────────────────────
function notify(title, message, sound = 'Submarine') {
  const esc = (s) => String(s).replace(/'/g, "\\'").replace(/"/g, '\\"');
  try {
    execSync(`osascript -e 'display notification "${esc(message)}" with title "${esc(title)}" sound name "${sound}"'`);
  } catch {}
}

// ─── Candle-close validator ──────────────────────────────────────────────────
async function validateCandleClose() {
  const stockContract = {
    symbol: ticker, secType: 'STK', exchange: 'SMART', currency: 'USD',
  };
  const bars = await reqHistoricalBars(ib, stockContract, '1 D', '15 mins', 'TRADES', 1);

  if (bars.length < VOLUME_LOOKBACK_BARS + 1) {
    return { triggered: false, reason: `insufficient bars (${bars.length})` };
  }
  bars.sort((a, b) => a.time - b.time);

  const nowSec = Math.floor(Date.now() / 1000);
  const completed = bars.filter(b => b.time + 15 * 60 <= nowSec);
  if (completed.length < VOLUME_LOOKBACK_BARS + 1) {
    return { triggered: false, reason: `only ${completed.length} completed bars` };
  }
  const lastClosed = completed[completed.length - 1];
  const priorBars = completed.slice(-(VOLUME_LOOKBACK_BARS + 1), -1);

  const barAgeMin = (nowSec - lastClosed.time - 15 * 60) / 60;
  if (barAgeMin > 20) {
    return { triggered: false, reason: `stale bar (${barAgeMin.toFixed(0)}m old) — market may be closed` };
  }

  const avgVol = priorBars.reduce((s, b) => s + b.volume, 0) / priorBars.length;
  const rVol = avgVol > 0 ? lastClosed.volume / avgVol : 0;

  const crossed = direction === 'CALLS'
    ? lastClosed.close > entryPrice
    : lastClosed.close < entryPrice;

  const barTimeET = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  }).format(new Date(lastClosed.time * 1000));

  const cmp = direction === 'CALLS' ? '>' : '<';
  const summary = `bar[${barTimeET} ET] close=${lastClosed.close.toFixed(2)} ${cmp}${entryPrice.toFixed(2)}=${crossed ? 'YES' : 'no'} rVol=${rVol.toFixed(2)}`;

  if (!crossed) return { triggered: false, reason: summary };
  if (rVol < RVOL_THRESHOLD) return { triggered: false, reason: `${summary} (below ${RVOL_THRESHOLD})` };
  if (!isWithinTradingWindow()) return { triggered: false, reason: `${summary} BUT outside trading window [9:45-14:00 ET]` };

  return { triggered: true, reason: summary, rVol, lastClosed };
}

// ─── Order placement flow on trigger fire ────────────────────────────────────
async function handleTriggered() {
  notify(`🎯 ${ticker} Trigger A`, `${direction} setup fired — switch to terminal to confirm`);

  const conId = await resolveStockConId(ib, ticker);
  const { expirations } = await getOptionChainParams(ib, ticker, conId);
  const expiry = pick0DTEExpiry(expirations);
  if (!expiry) { console.log(`   ⚠ no 0DTE expiry found — aborting`); return false; }

  const pick = await pickStrikeInRange({
    ib, ticker, expiry, entryPrice, direction,
    premiumMin: PREMIUM_MIN, premiumMax: PREMIUM_MAX,
    strikesToQuery: STRIKES_TO_QUERY,
  });
  if (!pick) {
    console.log(`   ⚠ no strike in $${PREMIUM_MIN}-$${PREMIUM_MAX} premium range — aborting`);
    return false;
  }
  console.log(`   selected: ${pick.strike} ${direction === 'CALLS' ? 'CALL' : 'PUT'} @ est $${pick.mid.toFixed(2)}`);

  const qty = Math.floor(MAX_RISK_USD / (pick.mid * 100));
  if (qty < 1) {
    console.log(`   ⚠ premium $${pick.mid} too high for $${MAX_RISK_USD} risk cap`);
    return false;
  }

  printOrderSpec({
    ticker, direction, strike: pick.strike, expiry, qty, premiumEst: pick.mid,
    maxRisk: MAX_RISK_USD, entryPrice, exitSpec: triggerA,
    port: IBKR_CONFIG.port, staged: STAGED_MODE,
  });

  const answer = await promptYes(`\nType "YES" to ${STAGED_MODE ? 'STAGE in TWS' : 'FIRE NOW'}, anything else to abort: `);
  if (answer !== 'YES') { console.log(`   aborted — no order placed`); return false; }

  if (nextOrderId == null) {
    ib.reqIds(-1);
    await new Promise(r => setTimeout(r, 1500));
  }
  if (nextOrderId == null) { console.log(`   ❌ no order ID from TWS`); return false; }

  const orderId = nextOrderId++;
  const { contract } = placeStagedOrder({
    ib, ticker, expiry, strike: pick.strike, qty, direction, orderId, staged: STAGED_MODE,
  });

  console.log(`\n${STAGED_MODE ? '✅ Order STAGED in TWS' : '🚀 Order SUBMITTED'} (orderId=${orderId}).`);
  if (STAGED_MODE) {
    console.log(`   Go to TWS Orders tab → click Transmit on the "Pending Transmission" row.`);
  }

  // Auto-arm OCA bracket exits once the entry fills
  let bracketArmed = false;
  const underlyingConId = await resolveStockConId(ib, ticker);
  const t1Price = triggerA.T1;
  const stopPrice = triggerA.stop;

  ib.on(EventName.orderStatus, (id, status, filled, remaining, avgFillPrice) => {
    if (id !== orderId) return;
    console.log(`   orderStatus  status=${status}  filled=${filled}  remaining=${remaining}  avgFill=${avgFillPrice ?? '-'}`);

    if (
      BRACKET_ENABLED &&
      !bracketArmed &&
      status === 'Filled' &&
      Number(filled) > 0 &&
      Number(remaining) === 0 &&
      Number.isFinite(t1Price) &&
      Number.isFinite(stopPrice)
    ) {
      bracketArmed = true;
      const actualQty = Number(filled);
      if (actualQty < qty) {
        console.log(`   ℹ partial fill detected: sizing bracket to actual ${actualQty} (planned ${qty})`);
      }
      try {
        const t1OrderId = nextOrderId++;
        const stopOrderId = nextOrderId++;
        const right = direction === 'CALLS' ? 'C' : 'P';
        const br = placeOCABracketExits({
          ib, ticker, expiry, strike: pick.strike, right, qty: actualQty, direction,
          underlyingConId,
          t1Price, stopPrice,
          t1OrderId, stopOrderId,
        });
        printBracketSpec({
          ticker, direction, strike: pick.strike, right, qty: actualQty,
          t1Price, stopPrice, entryUnderlying: entryPrice,
          t1OrderId: br.t1OrderId, stopOrderId: br.stopOrderId, ocaGroup: br.ocaGroup,
        });
      } catch (e) {
        console.log(`   ⚠ bracket placement failed: ${e.message}`);
        console.log(`   You will need to set your exits manually in TWS.`);
      }
    }
  });

  // Record the trade for one-trade-per-day enforcement on future invocations
  recordTrade(ticker, {
    orderId, strike: pick.strike, right: direction === 'CALLS' ? 'C' : 'P',
    qty, premiumEst: pick.mid, direction, expiry, entryTrigger: entryPrice,
    bracket: BRACKET_ENABLED ? { t1: t1Price, stop: stopPrice } : null,
  });

  // Wait a bit longer — if the user Transmits soon, we'll catch the fill
  // and place the bracket within this window. If they take longer, the
  // event loop continues but the script exits this function.
  await new Promise(r => setTimeout(r, 15000));
  return true;
}

// ─── Main loop ───────────────────────────────────────────────────────────────
async function runLoop() {
  let checkNum = 0;

  console.log(`[${nowETStr()}] Initial check...`);
  try {
    const r = await validateCandleClose();
    console.log(`   ${r.triggered ? '🔔 TRIGGERED' : 'not yet'}: ${r.reason}`);
    if (r.triggered && !testMode) {
      if (await handleTriggered()) return;
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
      console.log(`\n⏰ Next boundary is past --until ${untilStr}. Sleeping ${Math.round(remainMs/60000)}m more then exiting.`);
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
        if (await handleTriggered()) break;
      } else if (r.triggered && testMode) {
        console.log(`   (test mode — skipping order placement)`);
      }
    } catch (e) {
      console.log(`   validation error: ${e.message}`);
    }
  }
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
