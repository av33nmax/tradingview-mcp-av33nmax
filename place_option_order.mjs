/**
 * place_option_order.mjs — stage a 0DTE option order in TWS for one trigger.
 *
 * Usage:
 *   node place_option_order.mjs SPY A      # Trigger A on SPY
 *   node place_option_order.mjs QQQ B      # Trigger B on QQQ
 *
 * What it does:
 *   1. Runs the same strike/qty logic as trade_planner.mjs for the given trigger
 *   2. Prints the order spec in detail
 *   3. Prompts the user to type exactly "YES" (case-sensitive, full word) to proceed
 *   4. Places the order with transmit=false — order appears in TWS as
 *      "Pending Transmission" but does NOT send to market until the user
 *      clicks Transmit in TWS. Two-step confirmation for safety.
 *   5. Listens for orderStatus events — prints fill details when they come in
 *
 * Order defaults (user prefs 2026-04-23):
 *   orderType = MKT (market, fills at ask)
 *   tif       = DAY
 *   transmit  = false (staged, user clicks Transmit in TWS)
 *
 * When you're ready to remove the second gate, change STAGED_MODE below.
 */
import readline from 'node:readline';
import { IBApi, EventName, SecType } from '@stoqey/ib';
import { IBKR_CONFIG, CLIENT_IDS, isInfoCode } from './ibkr_config.mjs';

// ─── Config ──────────────────────────────────────────────────────────────────
const STAGED_MODE = true;  // true = transmit:false (TWS staging), false = fire immediately
const PREMIUM_MIN = 0.50;
const PREMIUM_MAX = 0.90;
const MAX_RISK_USD = 300;
const STRIKES_TO_QUERY = 20;
const REQ_PACING_MS = 200;
const COLLECT_WINDOW_MS = 35000;

// ─── Mock entry_notes (yesterday's values — replaced by premarket pipeline later) ──
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
if (!MOCK[ticker] || !['A', 'B'].includes(triggerArg)) {
  console.error('Usage: node place_option_order.mjs <SPY|QQQ> <A|B>');
  process.exit(1);
}
const input = MOCK[ticker];
const triggerKey = triggerArg === 'A' ? 'trigger_a' : 'trigger_b';
const triggerSpec = input[triggerKey];
const entryPrice = triggerKey === 'trigger_a' ? triggerSpec.entry : triggerSpec.entry_ema21_1H;
const dir = input.direction;
const right = dir === 'CALLS' ? 'C' : 'P';

// ─── Connect ─────────────────────────────────────────────────────────────────
const ib = new IBApi({ host: IBKR_CONFIG.host, port: IBKR_CONFIG.port, clientId: CLIENT_IDS.place_order });

let nextReqId = 7000;
let nextOrderId = null;
let underlyingConId = null;
let expiry0DTE = null;
const expirations = new Set();
const strikes = new Set();
const strikeQuotes = new Map();

const REQ_CONTRACT = 6001;
const REQ_OPT_PARAMS = 6002;

const overallTimeout = setTimeout(() => {
  console.log('\n⏱ overall timeout — disconnecting');
  ib.disconnect();
  process.exit(1);
}, 180000);

ib.on(EventName.connected, () => {
  console.log(`✅ connected (clientId=${CLIENT_IDS.place_order})`);
  ib.reqIds(-1);  // ask for the next valid order ID
  ib.reqContractDetails(REQ_CONTRACT, {
    symbol: ticker, secType: SecType.STK, exchange: 'SMART', currency: 'USD',
  });
});

ib.on(EventName.nextValidId, (id) => { nextOrderId = id; });

ib.on(EventName.contractDetails, (reqId, details) => {
  if (reqId === REQ_CONTRACT && !underlyingConId) underlyingConId = details.contract.conId;
});

ib.on(EventName.contractDetailsEnd, (reqId) => {
  if (reqId !== REQ_CONTRACT) return;
  ib.reqSecDefOptParams(REQ_OPT_PARAMS, ticker, '', SecType.STK, underlyingConId);
});

ib.on(EventName.securityDefinitionOptionParameter, (reqId, exchange, undConId, tradingClass, multiplier, exps, strks) => {
  if (reqId !== REQ_OPT_PARAMS) return;
  for (const e of exps) expirations.add(e);
  for (const s of strks) strikes.add(s);
});

function pick0DTE() {
  const et = new Date(Date.now() - 4 * 3600 * 1000);
  const y = et.getUTCFullYear(), m = String(et.getUTCMonth() + 1).padStart(2, '0'), d = String(et.getUTCDate()).padStart(2, '0');
  const today = `${y}${m}${d}`;
  const sorted = [...expirations].sort();
  return sorted.includes(today) ? today : sorted.find(e => e >= today) || sorted[0];
}

function nearestStrikes(centerPrice, n) {
  const arr = [...strikes].sort((a, b) => a - b);
  const rounds = arr.filter(s => Number.isInteger(s));
  const pool = rounds.length > 20 ? rounds : arr;
  pool.sort((a, b) => Math.abs(a - centerPrice) - Math.abs(b - centerPrice));
  return pool.slice(0, n).sort((a, b) => a - b);
}

ib.on(EventName.securityDefinitionOptionParameterEnd, (reqId) => {
  if (reqId !== REQ_OPT_PARAMS) return;
  expiry0DTE = pick0DTE();
  if (!expiry0DTE) { console.log('⚠ no expirations found'); ib.disconnect(); return; }

  // For CALLS: strikes at/above entry; for PUTS: at/below
  const near = nearestStrikes(entryPrice, STRIKES_TO_QUERY * 2);
  const selected = dir === 'CALLS'
    ? near.filter(s => s >= entryPrice - 2).slice(0, STRIKES_TO_QUERY)
    : near.filter(s => s <= entryPrice + 2).slice(-STRIKES_TO_QUERY);

  console.log(`\n── ${ticker} ${dir} Trigger ${triggerArg}  ·  0DTE ${expiry0DTE}  ·  entry ${entryPrice.toFixed(2)} ──`);
  console.log(`Querying ${selected.length} strikes: ${selected[0]}–${selected[selected.length-1]}`);

  for (const strike of selected) {
    strikeQuotes.set(strike, { strike, mid: null, source: null });
  }
  const list = [...strikeQuotes.keys()];
  let i = 0;
  const dispatch = () => {
    if (i >= list.length) return;
    const strike = list[i++];
    const id = nextReqId++;
    reqMap.set(id, strike);
    const contract = {
      symbol: ticker, secType: SecType.OPT, exchange: 'SMART', currency: 'USD',
      lastTradeDateOrContractMonth: expiry0DTE, strike, right, multiplier: '100',
    };
    try {
      ib.reqHistoricalData(id, contract, '', '3600 S', '5 mins', 'MIDPOINT', 0, 1, false);
    } catch {}
    setTimeout(dispatch, REQ_PACING_MS);
  };
  dispatch();
  setTimeout(pickAndConfirm, list.length * REQ_PACING_MS + COLLECT_WINDOW_MS);
});

const reqMap = new Map();  // reqId → strike

ib.on(EventName.historicalData, (reqId, time, open, high, low, close) => {
  const strike = reqMap.get(reqId);
  if (strike == null) return;
  if (typeof time === 'string' && time.startsWith('finished')) return;
  if (close != null && close > 0) {
    const q = strikeQuotes.get(strike);
    if (q) { q.mid = close; q.source = 'hist-mid'; }
  }
});

async function askYes(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

async function pickAndConfirm() {
  const candidates = [...strikeQuotes.values()]
    .filter(c => c.mid != null)
    .map(c => ({ strike: c.strike, est: c.mid, source: c.source }));
  const inRange = candidates.filter(c => c.est >= PREMIUM_MIN && c.est <= PREMIUM_MAX);

  if (inRange.length === 0) {
    console.log(`\n⚠ no strike has premium in $${PREMIUM_MIN}–$${PREMIUM_MAX} range`);
    console.log(`   available: ${candidates.map(c => `${c.strike}=$${c.est.toFixed(2)}`).join(', ')}`);
    clearTimeout(overallTimeout);
    ib.disconnect();
    setTimeout(() => process.exit(1), 300);
    return;
  }

  inRange.sort((a, b) => Math.abs(a.strike - entryPrice) - Math.abs(b.strike - entryPrice));
  const pick = inRange[0];
  const qty = Math.floor(MAX_RISK_USD / (pick.est * 100));
  if (qty < 1) {
    console.log(`\n⚠ premium too high for risk cap — best is $${pick.est} needing $${pick.est * 100} for 1 contract vs $${MAX_RISK_USD} cap`);
    clearTimeout(overallTimeout);
    ib.disconnect();
    setTimeout(() => process.exit(1), 300);
    return;
  }

  const action = dir === 'CALLS' ? 'BUY' : 'BUY';  // always buying options, calls or puts
  const exitSpec = input[triggerKey];
  const rightLabel = dir === 'CALLS' ? 'CALL' : 'PUT';

  console.log(`\n════════════════════════════════════════════════════════════════`);
  console.log(`  ORDER SPEC — please review carefully`);
  console.log(`════════════════════════════════════════════════════════════════`);
  console.log(`  Symbol:        ${ticker}`);
  console.log(`  Right:         ${rightLabel} (${right})`);
  console.log(`  Strike:        ${pick.strike}`);
  console.log(`  Expiry:        ${expiry0DTE}  (0DTE)`);
  console.log(`  Action:        ${action}`);
  console.log(`  Quantity:      ${qty} contracts`);
  console.log(`  Order type:    MARKET`);
  console.log(`  Time-in-force: DAY`);
  console.log(`  Est premium:   $${pick.est.toFixed(2)} (${pick.source})`);
  console.log(`  Est risk:      $${(qty * pick.est * 100).toFixed(2)} / $${MAX_RISK_USD} cap`);
  console.log(`  transmit:      ${STAGED_MODE ? 'false (STAGED in TWS — you click Transmit to send)' : 'true (FIRES IMMEDIATELY)'}`);
  console.log(`────────────────────────────────────────────────────────────────`);
  console.log(`  Trigger ${triggerArg}:     fires when ${ticker} ${dir === 'CALLS' ? '>' : '<'} ${entryPrice.toFixed(2)}`);
  console.log(`  Exit plan:     stop ${exitSpec.stop?.toFixed(2) ?? 'N/A'}  ·  T1 ${exitSpec.T1?.toFixed(2) ?? 'N/A'}  ·  T2 ${exitSpec.T2?.toFixed(2) ?? 'N/A'}`);
  console.log(`  Account:       IBKR paper  (port ${IBKR_CONFIG.port})`);
  console.log(`════════════════════════════════════════════════════════════════`);

  // User can take as long as they want to decide — clear the overall timeout.
  clearTimeout(overallTimeout);

  const answer = await askYes('\nType "YES" (uppercase) to ' + (STAGED_MODE ? 'STAGE in TWS' : 'FIRE NOW') + ', anything else to abort: ');
  if (answer !== 'YES') {
    console.log(`   aborted — no order placed`);
    clearTimeout(overallTimeout);
    ib.disconnect();
    setTimeout(() => process.exit(0), 300);
    return;
  }

  if (nextOrderId == null) {
    console.log(`   ⚠ no valid order ID received yet — waiting 2s...`);
    await new Promise(r => setTimeout(r, 2000));
  }
  if (nextOrderId == null) {
    console.log(`   ❌ still no order ID from TWS — aborting`);
    ib.disconnect();
    setTimeout(() => process.exit(1), 300);
    return;
  }

  const orderId = nextOrderId++;
  const contract = {
    symbol: ticker, secType: SecType.OPT, exchange: 'SMART', currency: 'USD',
    lastTradeDateOrContractMonth: expiry0DTE, strike: pick.strike, right, multiplier: '100',
  };
  const order = {
    action,
    totalQuantity: qty,
    orderType: 'MKT',
    tif: 'DAY',
    transmit: !STAGED_MODE,
    // IBKR compliance flags — prevent order rejection for retail accounts
    firmQuoteOnly: false,
    eTradeOnly: false,
  };

  console.log(`\n   placing order id=${orderId}...`);
  ib.placeOrder(orderId, contract, order);

  if (STAGED_MODE) {
    console.log(`\n✅ Order STAGED in TWS (orderId=${orderId}).`);
    console.log(`   In TWS → check the "Orders" tab → you'll see this order with status "Pending Transmission".`);
    console.log(`   Click the "Transmit" button on that row to actually send it to the market.`);
    console.log(`   Or right-click → Cancel to remove without sending.`);
    console.log(`\n   Listening for fills for 60s (if you transmit in TWS)...`);
  } else {
    console.log(`\n🚀 Order SUBMITTED to market (orderId=${orderId}). Listening for fills...`);
  }

  // Hold open to catch fill events
  setTimeout(() => {
    console.log(`\n   (exiting — order remains in TWS)`);
    clearTimeout(overallTimeout);
    ib.disconnect();
    setTimeout(() => process.exit(0), 300);
  }, 60000);
}

ib.on(EventName.orderStatus, (orderId, status, filled, remaining, avgFillPrice, permId, parentId, lastFillPrice, clientId, whyHeld, mktCapPrice) => {
  console.log(`   orderStatus  id=${orderId}  status=${status}  filled=${filled}  remaining=${remaining}  avgFill=${avgFillPrice ?? '-'}  lastFill=${lastFillPrice ?? '-'}${whyHeld ? `  whyHeld=${whyHeld}` : ''}`);
});

ib.on(EventName.execDetails, (reqId, contract, execution) => {
  console.log(`   💰 EXEC  ${execution.side} ${execution.shares} @ $${execution.price}  time=${execution.time}  exchange=${execution.exchange}`);
});

ib.on(EventName.error, (err, code, reqId) => {
  if (isInfoCode(code)) return;
  if (code === 162 || code === 200 || code === 300 || code === 354) return;
  console.log(`   error [code=${code}  reqId=${reqId}]  ${err?.message || err}`);
});

ib.connect();
