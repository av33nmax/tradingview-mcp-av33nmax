/**
 * trade_planner.mjs — given a trigger plan (entry/stop/T1/T2 + direction),
 * query live option quotes on today's 0DTE, pick the strike whose premium
 * falls in the user's target range, size qty per max-risk rule, and print
 * a ready-to-execute order spec for both Trigger A and Trigger B.
 *
 * Usage:
 *   node trade_planner.mjs SPY
 *   node trade_planner.mjs QQQ
 *
 * Selection rules (hardcoded per user prefs 2026-04-23):
 *   - Premium target   : $0.50 – $0.90
 *   - Expiry           : 0DTE (today)
 *   - Sizing           : qty = floor(MAX_RISK_USD / (premium × 100))
 *                         where MAX_RISK_USD = 300
 *   - Both Trigger A and Trigger B get a prepared order spec
 *
 * For now, entry_notes is mocked inline (yesterday's values). A follow-up
 * commit will let premarket_setup.mjs pipe real entry_notes JSON in.
 *
 * Read-only — prints to stdout, no orders placed.
 */
import { IBApi, EventName, SecType } from '@stoqey/ib';
import { IBKR_CONFIG, CLIENT_IDS, isInfoCode } from './ibkr_config.mjs';

// ─── Selection rules ─────────────────────────────────────────────────────────
const PREMIUM_MIN = 0.50;
const PREMIUM_MAX = 0.90;
const MAX_RISK_USD = 300;
const STRIKES_TO_QUERY = 20;    // breadth from entry going OTM
const REQ_PACING_MS = 200;      // spacing between reqHistoricalData calls to avoid IBKR pacing limits
const COLLECT_WINDOW_MS = 35000; // total time to wait for all bars

// ─── Mock entry_notes (yesterday's values — will be replaced by live feed) ──
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

// ─── Arg parsing ─────────────────────────────────────────────────────────────
const ticker = (process.argv[2] || 'SPY').toUpperCase();
const input = MOCK[ticker];
if (!input) {
  console.error(`Unknown ticker: ${ticker}. Supported: ${Object.keys(MOCK).join(', ')}`);
  process.exit(1);
}

// ─── Connect ─────────────────────────────────────────────────────────────────
const ib = new IBApi({ host: IBKR_CONFIG.host, port: IBKR_CONFIG.port, clientId: CLIENT_IDS.trade_planner });

let underlyingConId = null;
const chainByExchange = new Map();
const strikes = new Set();
const expirations = new Set();

// Historical-data quotes: reqId → { strike, right, mid, source, done }
const quotes = new Map();
let nextReqId = 5000;
const REQ_CONTRACT = 4001;
const REQ_OPT_PARAMS = 4002;

const timeout = setTimeout(() => {
  console.log('\n⏱ overall timeout — disconnecting');
  ib.disconnect();
  process.exit(1);
}, 120000);

// ─── Phase 1: resolve stock → get conId ──────────────────────────────────────
ib.on(EventName.connected, () => {
  console.log(`✅ connected (clientId=${CLIENT_IDS.trade_planner})`);
  // We use reqHistoricalData (not reqMktData) to estimate option premiums.
  // Historical uses a separate data path that doesn't conflict with TV's live
  // session holding the account's market data slot. For strike selection in
  // pre-market planning, a recent historical mid is fine — premiums don't
  // move that fast for ATM/near-ATM contracts over a few minutes.
  ib.reqContractDetails(REQ_CONTRACT, {
    symbol: ticker, secType: SecType.STK, exchange: 'SMART', currency: 'USD',
  });
});

ib.on(EventName.contractDetails, (reqId, details) => {
  if (reqId === REQ_CONTRACT && !underlyingConId) {
    underlyingConId = details.contract.conId;
  }
});
ib.on(EventName.contractDetailsEnd, (reqId) => {
  if (reqId !== REQ_CONTRACT) return;
  ib.reqSecDefOptParams(REQ_OPT_PARAMS, ticker, '', SecType.STK, underlyingConId);
});

// ─── Phase 2: collect chain params ───────────────────────────────────────────
ib.on(EventName.securityDefinitionOptionParameter,
  (reqId, exchange, undConId, tradingClass, multiplier, exps, strks) => {
    if (reqId !== REQ_OPT_PARAMS) return;
    if (!chainByExchange.has(exchange)) {
      chainByExchange.set(exchange, { multiplier, tradingClass, exps: new Set(exps), strks: new Set(strks) });
    }
    for (const e of exps) expirations.add(e);
    for (const s of strks) strikes.add(s);
  });

ib.on(EventName.securityDefinitionOptionParameterEnd, (reqId) => {
  if (reqId !== REQ_OPT_PARAMS) return;
  beginQuotePhase();
});

// ─── Phase 3: pick strikes to quote, request market data ────────────────────
function todayYyyymmdd(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function pick0DTE() {
  // Use US Eastern "today" for 0DTE selection (ET date may differ from UTC).
  // April = EDT → UTC−4.
  const et = new Date(Date.now() - 4 * 3600 * 1000);
  const today = todayYyyymmdd(et);
  if (expirations.has(today)) return today;
  // Fallback: nearest future expiration
  const sorted = [...expirations].sort();
  return sorted.find(e => e >= today) || sorted[0];
}

function nearestStrikes(centerPrice, n) {
  const arr = [...strikes].sort((a, b) => a - b);
  // Prefer round-number strikes (whole dollars) if available
  const roundOnly = arr.filter(s => Number.isInteger(s));
  const pool = roundOnly.length > 20 ? roundOnly : arr;
  pool.sort((a, b) => Math.abs(a - centerPrice) - Math.abs(b - centerPrice));
  return pool.slice(0, n).sort((a, b) => a - b);
}

const triggerPlans = [];  // filled in beginQuotePhase, populated by quote results

let expiry0DTE = null;

function beginQuotePhase() {
  expiry0DTE = pick0DTE();
  if (!expiry0DTE) {
    console.log(`   ⚠ no expirations returned — aborting`);
    ib.disconnect();
    return;
  }
  const dir = input.direction;
  const right = dir === 'CALLS' ? 'C' : 'P';

  // For CALLS: strikes at and above the trigger entry (OTM + near-ATM)
  // For PUTS:  strikes at and below
  const selectStrikes = (entryPx) => {
    const allNear = nearestStrikes(entryPx, STRIKES_TO_QUERY * 2);
    return dir === 'CALLS'
      ? allNear.filter(s => s >= entryPx - 2).slice(0, STRIKES_TO_QUERY)
      : allNear.filter(s => s <= entryPx + 2).slice(-STRIKES_TO_QUERY);
  };

  const plans = [
    { key: 'Trigger A', entry: input.trigger_a.entry, exitSpec: input.trigger_a },
    // Use EMA21 as primary Trigger B entry (usually the first pullback touch)
    { key: 'Trigger B (EMA21)', entry: input.trigger_b.entry_ema21_1H, exitSpec: input.trigger_b },
  ];

  console.log(`\n── ${ticker} ${dir}  ·  0DTE expiry ${expiry0DTE.slice(0,4)}-${expiry0DTE.slice(4,6)}-${expiry0DTE.slice(6,8)} ──`);

  // Union of all strikes needed — dedup before firing requests (IBKR throttles
  // duplicate contract queries within a short window, so asking for the same
  // 660 CALL twice means the second request gets dropped).
  const unionStrikes = new Set();
  for (const plan of plans) {
    const picked = selectStrikes(plan.entry);
    console.log(`${plan.key}: entry=${plan.entry.toFixed(2)}, candidate strikes  ${picked[0]}–${picked[picked.length-1]} (${picked.length})`);
    plan.strikes = picked;
    plan.quotes = {};
    triggerPlans.push(plan);
    for (const s of picked) unionStrikes.add(s);
  }
  const dedupedStrikes = [...unionStrikes].sort((a, b) => a - b);
  console.log(`\nUnique strikes to query: ${dedupedStrikes.length}  (${dedupedStrikes[0]}–${dedupedStrikes[dedupedStrikes.length-1]})`);
  console.log(`Pacing ${dedupedStrikes.length} historical requests at ${REQ_PACING_MS}ms spacing (~${Math.round(dedupedStrikes.length * REQ_PACING_MS / 1000)}s to dispatch)...`);

  // Map strike → quote object — shared across triggers.
  const strikeQuotes = new Map();
  for (const strike of dedupedStrikes) {
    strikeQuotes.set(strike, { strike, right, mid: null, source: null, done: false });
  }
  // quotes is the reqId-indexed map used by event handlers.
  // Each reqId points at the SAME strikeQuotes entry so updates apply globally.
  let i = 0;
  const dispatch = () => {
    if (i >= dedupedStrikes.length) return;
    const strike = dedupedStrikes[i++];
    const id = nextReqId++;
    const contract = {
      symbol: ticker, secType: SecType.OPT, exchange: 'SMART', currency: 'USD',
      lastTradeDateOrContractMonth: expiry0DTE, strike, right, multiplier: '100',
    };
    quotes.set(id, strikeQuotes.get(strike));
    try {
      ib.reqHistoricalData(id, contract, '', '3600 S', '5 mins', 'MIDPOINT', 0, 1, false);
    } catch (e) {
      console.log(`   reqHistoricalData failed for strike ${strike}: ${e.message}`);
    }
    setTimeout(dispatch, REQ_PACING_MS);
  };
  dispatch();

  // Expose the strike-keyed map to finalize so it can look up quotes per plan
  _strikeQuotes = strikeQuotes;

  setTimeout(finalize, dedupedStrikes.length * REQ_PACING_MS + COLLECT_WINDOW_MS);
}

let _strikeQuotes = null;  // set during beginQuotePhase

// ─── Phase 4: collect historical midpoint bars ──────────────────────────────
// Each historicalData event is one bar: (reqId, time, open, high, low, close, volume, count, WAP)
ib.on(EventName.historicalData, (reqId, time, open, high, low, close) => {
  const q = quotes.get(reqId);
  if (!q) return;
  // Skip sentinel "finished-xxx" time markers (some IBKR builds emit an end marker via this event)
  if (typeof time === 'string' && time.startsWith('finished')) { q.done = true; return; }
  // Keep the most recent valid close as our premium estimate (bars arrive oldest-first)
  if (close != null && close > 0) {
    q.mid = close;
    q.source = 'hist-mid';
  }
});

ib.on(EventName.historicalDataEnd, (reqId) => {
  const q = quotes.get(reqId);
  if (q) q.done = true;
});

// ─── Phase 5: pick strike + size, print plan ────────────────────────────────
function formatPrice(p) { return p == null ? '—' : p.toFixed(2); }

function finalize() {
  if (errorCounts.size) {
    console.log(`\n── error summary ──`);
    for (const [code, n] of errorCounts) console.log(`   code ${code} × ${n}`);
  }
  console.log(`\n━━━ ${ticker} Trade Plan ━━━`);

  for (const plan of triggerPlans) {
    const candidates = plan.strikes.map(strike => {
      const q = _strikeQuotes?.get(strike);
      if (!q) return null;
      return { strike, est: q.mid, source: q.source };
    }).filter(Boolean);

    console.log(`\n── ${plan.key}  (entry trigger ${plan.entry.toFixed(2)}) ──`);
    if (!candidates.some(c => c.est != null)) {
      console.log(`  ⚠ no premium data available`);
      console.log(`  Candidates queried: ${candidates.map(c => c.strike).join(', ')}`);
      continue;
    }

    // Debug: show all strikes with their midpoints
    console.log(`  strikes and premium estimates:`);
    for (const c of candidates) {
      const flag = c.est != null && c.est >= PREMIUM_MIN && c.est <= PREMIUM_MAX ? ' ★' : '';
      console.log(`    ${String(c.strike).padStart(7)}  mid=${formatPrice(c.est)} (${c.source || 'no data'})${flag}`);
    }

    // Filter by premium range, pick closest-to-ATM.
    const inRange = candidates.filter(c => c.est != null && c.est >= PREMIUM_MIN && c.est <= PREMIUM_MAX);
    if (inRange.length === 0) {
      console.log(`\n  ⚠ no strike has premium in $${PREMIUM_MIN}–$${PREMIUM_MAX} range`);
      const sorted = candidates.filter(c => c.est != null).sort((a, b) => {
        const distA = a.est < PREMIUM_MIN ? PREMIUM_MIN - a.est : a.est - PREMIUM_MAX;
        const distB = b.est < PREMIUM_MIN ? PREMIUM_MIN - b.est : b.est - PREMIUM_MAX;
        return distA - distB;
      });
      if (sorted.length) console.log(`  Nearest to range: strike ${sorted[0].strike} @ $${sorted[0].est.toFixed(2)}`);
      continue;
    }
    inRange.sort((a, b) => Math.abs(a.strike - plan.entry) - Math.abs(b.strike - plan.entry));
    const pick = inRange[0];
    const qty = Math.floor(MAX_RISK_USD / (pick.est * 100));

    const rightLabel = input.direction === 'CALLS' ? 'CALL' : 'PUT';
    const rightCode  = input.direction === 'CALLS' ? 'C' : 'P';
    const prettyExpiry = `${expiry0DTE.slice(0,4)}-${expiry0DTE.slice(4,6)}-${expiry0DTE.slice(6,8)}`;

    console.log(`\n  ✅ Selected: ${ticker} ${prettyExpiry} ${pick.strike} ${rightLabel}`);
    console.log(`     Premium est:     $${pick.est.toFixed(2)}  (${pick.source})`);
    console.log(`     Max qty:         ${qty} contracts  (risk ≈ $${(qty * pick.est * 100).toFixed(2)} / $${MAX_RISK_USD} cap)`);
    console.log(`     Fires when:      underlying ${input.direction === 'CALLS' ? '>' : '<'} ${plan.entry.toFixed(2)}`);
    console.log(`     Underlying stop: ${plan.exitSpec.stop?.toFixed(2) ?? 'N/A'}`);
    console.log(`     Underlying T1:   ${plan.exitSpec.T1?.toFixed(2) ?? 'N/A'}`);
    console.log(`     Underlying T2:   ${plan.exitSpec.T2?.toFixed(2) ?? 'N/A'}`);
    console.log(`     Order spec:     symbol=${ticker}  right=${rightCode}  strike=${pick.strike}  expiry=${expiry0DTE}  qty=${qty}  limit≈$${pick.est.toFixed(2)}`);
  }

  clearTimeout(timeout);
  ib.disconnect();
  setTimeout(() => process.exit(0), 500);
}

const errorCounts = new Map();
ib.on(EventName.error, (err, code, reqId) => {
  if (isInfoCode(code)) return;
  errorCounts.set(code, (errorCounts.get(code) || 0) + 1);
  // Print first of each code with full message
  if (errorCounts.get(code) === 1) {
    console.log(`   [first] error [code=${code}  reqId=${reqId}]  ${err?.message || err}`);
  }
});

// Summarize errors just before finalize
const _origFinalize = (() => {});  // placeholder; real finalize defined below

ib.connect();
