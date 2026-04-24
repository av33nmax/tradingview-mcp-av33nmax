/**
 * place_option_order.mjs — stage a 0DTE option order in TWS for one trigger.
 * Manual, on-demand order staging. For automated candle-close validation +
 * order placement, see trade_window.mjs.
 *
 * Usage:
 *   node place_option_order.mjs SPY A      # Trigger A on SPY
 *   node place_option_order.mjs QQQ B      # Trigger B on QQQ
 *
 * Two-gate safety:
 *   1. CLI prompt requires literal "YES" (uppercase, full word)
 *   2. transmit=false → order appears in TWS as "Pending Transmission",
 *      user clicks Transmit manually to send to market
 *
 * Respects one-trade-per-day guard (traded_today.json). Refuses to stage
 * a second order for the same ticker on the same ET trading day.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IBApi, EventName } from '@stoqey/ib';
import { IBKR_CONFIG, CLIENT_IDS, isInfoCode } from './ibkr_config.mjs';
import {
  resolveStockConId,
  getOptionChainParams,
  pick0DTEExpiry,
  pickStrikeInRange,
  promptYes,
  printOrderSpec,
  placeStagedOrder,
} from './ibkr_orders.mjs';
import {
  hasTradedToday,
  recordTrade,
  formatBlockedMessage,
} from './one_trade_per_day.mjs';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_NOTES_FILE = path.join(REPO_ROOT, 'latest_entry_notes.json');

// ─── Config ──────────────────────────────────────────────────────────────────
const STAGED_MODE = true;
const PREMIUM_MIN = 0.50;
const PREMIUM_MAX = 0.90;
const MAX_RISK_USD = 300;
const STRIKES_TO_QUERY = 20;

// ─── Mock entry_notes (stale fallback — only used if premarket_setup hasn't written the JSON) ──
const MOCK = {
  SPY: {
    direction: 'CALLS',
    trigger_a: { entry: 710.40, stop: 707.07, T1: 712.04, T2: 713.68 },
    trigger_b: { entry_vwap: 706.42, entry_ema21_1H: 707.63, stop: 705.86, T1: 708.75, T2: 712.04 },
  },
  QQQ: {
    direction: 'CALLS',
    trigger_a: { entry: 649.09, stop: 646.79, T1: 652.28, T2: 655.47 },
    trigger_b: { entry_vwap: 646.32, entry_ema21_1H: 647.44, stop: 645.67, T1: 649.71, T2: 652.28 },
  },
};

// ─── Args ────────────────────────────────────────────────────────────────────
const ticker = (process.argv[2] || '').toUpperCase();
const triggerArg = (process.argv[3] || '').toUpperCase();
if (!['SPY', 'QQQ'].includes(ticker) || !['A', 'B'].includes(triggerArg)) {
  console.error('Usage: node place_option_order.mjs <SPY|QQQ> <A|B>');
  process.exit(1);
}

// ─── One-trade-per-day check ─────────────────────────────────────────────────
if (hasTradedToday(ticker)) {
  console.error(formatBlockedMessage(ticker));
  process.exit(1);
}

// ─── Load entry_notes (fresh preferred, mock fallback) ───────────────────────
function loadInput(ticker) {
  if (fs.existsSync(ENTRY_NOTES_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(ENTRY_NOTES_FILE, 'utf8'));
      const t = data.tickers?.[ticker];
      if (t?.entry_notes) {
        const ageMin = Math.round((Date.now() - new Date(data.generatedAt).getTime()) / 60000);
        console.log(`📄 loaded ${ticker} entry_notes from ${path.basename(ENTRY_NOTES_FILE)} (generated ${ageMin}m ago)`);
        if (ageMin > 60) console.log(`   ⚠ ${ageMin}m old — consider refreshing with premarket_setup.mjs`);
        return t.entry_notes;
      }
      if (t && !t.entry_notes) {
        console.log(`📄 ${ticker} in ${path.basename(ENTRY_NOTES_FILE)} shows ${t.bias} (aligned=${t.aligned}) — no entry_notes.`);
        console.log(`   Pre-market analysis said NO TRADE for ${ticker}. Aborting.`);
        process.exit(0);
      }
    } catch (e) {
      console.log(`   ⚠ could not read ${ENTRY_NOTES_FILE}: ${e.message}`);
    }
  }
  console.log(`⚠ no ${path.basename(ENTRY_NOTES_FILE)} found — falling back to stale mock values.`);
  return MOCK[ticker];
}

const input = loadInput(ticker);
const triggerKey = triggerArg === 'A' ? 'trigger_a' : 'trigger_b';
const triggerSpec = input[triggerKey];
const entryPrice = triggerKey === 'trigger_a' ? triggerSpec.entry : triggerSpec.entry_ema21_1H;
const direction = input.direction;

// ─── Connect ─────────────────────────────────────────────────────────────────
const ib = new IBApi({ host: IBKR_CONFIG.host, port: IBKR_CONFIG.port, clientId: CLIENT_IDS.place_order });

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

const overallTimeout = setTimeout(() => {
  console.log('\n⏱ overall timeout — disconnecting');
  ib.disconnect();
  process.exit(1);
}, 180000);

// ─── Main flow ───────────────────────────────────────────────────────────────
async function main() {
  await new Promise((resolve, reject) => {
    const handler = () => { ib.off(EventName.connected, handler); resolve(); };
    ib.on(EventName.connected, handler);
    ib.connect();
    setTimeout(() => reject(new Error('connection timeout')), 10000);
  });

  console.log(`✅ connected (clientId=${CLIENT_IDS.place_order})`);
  ib.reqIds(-1);

  const conId = await resolveStockConId(ib, ticker);
  const { expirations } = await getOptionChainParams(ib, ticker, conId);
  const expiry = pick0DTEExpiry(expirations);
  if (!expiry) { console.log(`   ⚠ no 0DTE expiry`); ib.disconnect(); process.exit(1); }

  console.log(`\n── ${ticker} ${direction} Trigger ${triggerArg}  ·  0DTE ${expiry}  ·  entry ${entryPrice.toFixed(2)} ──`);

  const pick = await pickStrikeInRange({
    ib, ticker, expiry, entryPrice, direction,
    premiumMin: PREMIUM_MIN, premiumMax: PREMIUM_MAX,
    strikesToQuery: STRIKES_TO_QUERY,
  });
  if (!pick) {
    console.log(`\n⚠ no strike in $${PREMIUM_MIN}-$${PREMIUM_MAX} premium range — aborting`);
    clearTimeout(overallTimeout);
    ib.disconnect();
    setTimeout(() => process.exit(1), 300);
    return;
  }

  const qty = Math.floor(MAX_RISK_USD / (pick.mid * 100));
  if (qty < 1) {
    console.log(`\n⚠ premium $${pick.mid} too high for $${MAX_RISK_USD} risk cap`);
    clearTimeout(overallTimeout);
    ib.disconnect();
    setTimeout(() => process.exit(1), 300);
    return;
  }

  const exitSpec = input[triggerKey];
  printOrderSpec({
    ticker, direction, strike: pick.strike, expiry, qty, premiumEst: pick.mid,
    maxRisk: MAX_RISK_USD, entryPrice, exitSpec,
    port: IBKR_CONFIG.port, staged: STAGED_MODE,
  });

  clearTimeout(overallTimeout);  // user has unlimited time to decide

  const answer = await promptYes(`\nType "YES" to ${STAGED_MODE ? 'STAGE in TWS' : 'FIRE NOW'}, anything else to abort: `);
  if (answer !== 'YES') {
    console.log(`   aborted — no order placed`);
    ib.disconnect();
    setTimeout(() => process.exit(0), 300);
    return;
  }

  if (nextOrderId == null) {
    ib.reqIds(-1);
    await new Promise(r => setTimeout(r, 1500));
  }
  if (nextOrderId == null) {
    console.log(`   ❌ no order ID from TWS`);
    ib.disconnect();
    setTimeout(() => process.exit(1), 300);
    return;
  }

  const orderId = nextOrderId++;
  placeStagedOrder({
    ib, ticker, expiry, strike: pick.strike, qty, direction, orderId, staged: STAGED_MODE,
  });

  console.log(`\n${STAGED_MODE ? '✅ Order STAGED in TWS' : '🚀 Order SUBMITTED'} (orderId=${orderId}).`);
  if (STAGED_MODE) {
    console.log(`   Go to TWS Orders tab → click Transmit on the "Pending Transmission" row.`);
    console.log(`   Or right-click → Cancel to remove without sending.`);
    console.log(`\n   Listening for fills for 60s (if you transmit in TWS)...`);
  }

  ib.on(EventName.orderStatus, (id, status, filled, remaining, avgFillPrice, permId, parentId, lastFillPrice, clientId, whyHeld) => {
    console.log(`   orderStatus  id=${id}  status=${status}  filled=${filled}  remaining=${remaining}  avgFill=${avgFillPrice ?? '-'}  lastFill=${lastFillPrice ?? '-'}${whyHeld ? `  whyHeld=${whyHeld}` : ''}`);
  });
  ib.on(EventName.execDetails, (reqId, contract, execution) => {
    console.log(`   💰 EXEC  ${execution.side} ${execution.shares} @ $${execution.price}  time=${execution.time}  exchange=${execution.exchange}`);
  });

  // Record the trade so one-trade-per-day guard blocks further attempts
  recordTrade(ticker, {
    orderId, strike: pick.strike, right: direction === 'CALLS' ? 'C' : 'P',
    qty, premiumEst: pick.mid, direction, expiry, trigger: triggerArg, entryTrigger: entryPrice,
  });

  setTimeout(() => {
    console.log(`\n   (exiting — order remains in TWS)`);
    ib.disconnect();
    setTimeout(() => process.exit(0), 300);
  }, 60000);
}

main().catch(e => { console.error('FATAL:', e.message); ib.disconnect(); process.exit(1); });
