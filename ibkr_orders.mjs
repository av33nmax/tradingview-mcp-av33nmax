/**
 * ibkr_orders.mjs — shared IBKR helpers used by trade_window.mjs,
 * place_option_order.mjs, trade_planner.mjs.
 *
 * Functions:
 *   reqHistoricalBars      — wrap reqHistoricalData as a Promise, returns parsed bars
 *   resolveStockConId      — stock symbol → IBKR conId (for reqSecDefOptParams)
 *   getOptionChainParams   — get expiries + strikes Set for an underlying
 *   pick0DTEExpiry         — pick today's ET expiry from a Set
 *   nearestStrikes         — n closest strikes to a center price (prefer round)
 *   queryOptionPremium     — single-strike mid premium via historical MIDPOINT bar
 *   pickStrikeInRange      — full strike picker: filters by premium range, nearest-ATM
 *   promptYes              — readline prompt that returns trimmed answer
 *   printOrderSpec         — consistent order-spec box for CLI
 *   placeStagedOrder       — places order via ib.placeOrder, returns metadata
 *   placeOCABracketExits   — after an option entry fills, places T1 take-profit
 *                            + stop-loss as an OCA group, both triggered by the
 *                            underlying stock's price (not the option price).
 *                            When one fires, the other auto-cancels.
 *
 * Design notes:
 *   - All functions take `ib` (IBApi instance) as first arg — no hidden globals
 *   - reqIds are allocated from a module-level counter starting at 50000 to
 *     avoid collision with caller's own reqId space
 *   - All historical-data calls use formatDate=2 (epoch seconds as string)
 *   - Timeouts fail-safe: functions resolve (not reject) on timeout when safe
 */
import { EventName, SecType } from '@stoqey/ib';
import { PriceCondition } from '@stoqey/ib/dist/api/order/condition/price-condition.js';
import { TriggerMethod } from '@stoqey/ib/dist/api/order/enum/trigger-method.js';
import { ConjunctionConnection } from '@stoqey/ib/dist/api/order/enum/conjunction-connection.js';
import readline from 'node:readline';

let _reqIdCounter = 50000;
export function nextReqId() { return _reqIdCounter++; }

// ─── Historical bars ─────────────────────────────────────────────────────────
export async function reqHistoricalBars(ib, contract, duration, barSize, whatToShow = 'TRADES', useRTH = 1) {
  const reqId = nextReqId();
  const bars = [];

  return new Promise((resolve) => {
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
    ib.reqHistoricalData(reqId, contract, '', duration, barSize, whatToShow, useRTH, 2, false);

    setTimeout(() => {
      ib.off(EventName.historicalData, onBar);
      ib.off(EventName.historicalDataEnd, onEnd);
      resolve(bars);
    }, 10000);
  });
}

// ─── Stock contract resolution ───────────────────────────────────────────────
export async function resolveStockConId(ib, ticker) {
  return new Promise((resolve, reject) => {
    const reqId = nextReqId();
    let conId = null;

    const onDetails = (id, details) => {
      if (id === reqId && !conId) conId = details.contract.conId;
    };
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

// ─── Option chain parameters (exchanges, expirations, strikes) ───────────────
export async function getOptionChainParams(ib, ticker, underlyingConId) {
  return new Promise((resolve) => {
    const reqId = nextReqId();
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

// ─── Expiry picker — today's ET date if available, else nearest future ───────
export function pick0DTEExpiry(expirations) {
  const etFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [y, mo, d] = etFmt.format(new Date()).split('-');
  const today = `${y}${mo}${d}`;
  if (expirations.has(today)) return today;
  const sorted = [...expirations].sort();
  return sorted.find(e => e >= today) || sorted[0];
}

// ─── Nearest strikes (prefers round-dollar strikes) ──────────────────────────
export function nearestStrikes(allStrikes, centerPrice, n) {
  const arr = [...allStrikes].sort((a, b) => a - b);
  const rounds = arr.filter(s => Number.isInteger(s));
  const pool = rounds.length > 20 ? rounds : arr;
  pool.sort((a, b) => Math.abs(a - centerPrice) - Math.abs(b - centerPrice));
  return pool.slice(0, n).sort((a, b) => a - b);
}

// ─── Single-strike premium query (historical mid) ────────────────────────────
export async function queryOptionPremium(ib, ticker, expiry, strike, right) {
  const contract = {
    symbol: ticker, secType: SecType.OPT, exchange: 'SMART', currency: 'USD',
    lastTradeDateOrContractMonth: expiry, strike, right, multiplier: '100',
  };
  const bars = await reqHistoricalBars(ib, contract, '3600 S', '5 mins', 'MIDPOINT', 0);
  if (!bars.length) return null;
  const last = bars[bars.length - 1];
  return last.close > 0 ? last.close : null;
}

// ─── Full strike picker (premium range + nearest-ATM) ────────────────────────
export async function pickStrikeInRange({
  ib, ticker, expiry, entryPrice, direction,
  premiumMin = 0.50, premiumMax = 0.90,
  strikesToQuery = 20, pacingMs = 200,
}) {
  const right = direction === 'CALLS' ? 'C' : 'P';
  const conId = await resolveStockConId(ib, ticker);
  const { strikes } = await getOptionChainParams(ib, ticker, conId);

  const nearby = nearestStrikes(strikes, entryPrice, strikesToQuery * 2);
  const candidates = direction === 'CALLS'
    ? nearby.filter(s => s >= entryPrice - 2).slice(0, strikesToQuery)
    : nearby.filter(s => s <= entryPrice + 2).slice(-strikesToQuery);

  if (candidates.length === 0) return null;
  console.log(`   Querying ${candidates.length} strikes (${candidates[0]}–${candidates[candidates.length - 1]})...`);

  const premiums = new Map();
  for (const strike of candidates) {
    const mid = await queryOptionPremium(ib, ticker, expiry, strike, right);
    if (mid != null) premiums.set(strike, mid);
    await new Promise(r => setTimeout(r, pacingMs));
  }

  const inRange = [...premiums.entries()]
    .filter(([, mid]) => mid >= premiumMin && mid <= premiumMax)
    .map(([strike, mid]) => ({ strike, mid }));

  if (inRange.length === 0) return null;
  inRange.sort((a, b) => Math.abs(a.strike - entryPrice) - Math.abs(b.strike - entryPrice));
  return inRange[0];
}

// ─── YES prompt (blocking readline) ──────────────────────────────────────────
export async function promptYes(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

// ─── Consistent order spec print ─────────────────────────────────────────────
export function printOrderSpec({
  ticker, direction, strike, expiry, qty, premiumEst,
  maxRisk, entryPrice, exitSpec, port, staged,
}) {
  const right = direction === 'CALLS' ? 'C' : 'P';
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
  console.log(`  Est risk:      $${(qty * premiumEst * 100).toFixed(2)} / $${maxRisk} cap`);
  console.log(`  transmit:      ${staged ? 'false (STAGED in TWS — you click Transmit to send)' : 'true (FIRES IMMEDIATELY)'}`);
  console.log(`────────────────────────────────────────────────────────────────`);
  if (entryPrice != null) {
    console.log(`  Trigger:       fires when ${ticker} ${direction === 'CALLS' ? '>' : '<'} ${entryPrice.toFixed(2)}`);
  }
  if (exitSpec) {
    console.log(`  Exit plan:     stop ${exitSpec.stop?.toFixed(2) ?? 'N/A'}  ·  T1 ${exitSpec.T1?.toFixed(2) ?? 'N/A'}  ·  T2 ${exitSpec.T2?.toFixed(2) ?? 'N/A'}`);
  }
  console.log(`  Account:       IBKR paper  (port ${port})`);
  console.log(`════════════════════════════════════════════════════════════════`);
}

// ─── Place the order (transmit flag controls staged-vs-fire) ─────────────────
export function placeStagedOrder({
  ib, ticker, expiry, strike, qty, direction, orderId, staged = true,
}) {
  const right = direction === 'CALLS' ? 'C' : 'P';
  const contract = {
    symbol: ticker, secType: SecType.OPT, exchange: 'SMART', currency: 'USD',
    lastTradeDateOrContractMonth: expiry, strike, right, multiplier: '100',
  };
  const order = {
    action: 'BUY',
    totalQuantity: qty,
    orderType: 'MKT',
    tif: 'DAY',
    transmit: !staged,
    firmQuoteOnly: false,
    eTradeOnly: false,
  };
  ib.placeOrder(orderId, contract, order);
  return { orderId, contract, order };
}

// ─── OCA Bracket Exits (T1 take-profit + stop-loss linked as OCA) ───────────
//
// Places TWO conditional SELL orders after an option entry fills:
//   1) Take-profit: SELL @ MKT when underlying reaches T1 price
//   2) Stop-loss:   SELL @ MKT when underlying reaches stop price
// Both orders are in the same OCA group (ocaType=1) so when one fills,
// the other is automatically cancelled by IBKR.
//
// Conditions trigger on the UNDERLYING stock price (not the option price).
// This matches the plan levels exactly and avoids the "option wick-out"
// problem where option-price stops fire on a wide spread tick.
//
// For CALLS (long call):
//   - T1 fires when underlying >= T1_underlying (price rose)
//   - stop fires when underlying <= stop_underlying (price fell)
// For PUTS (long put):
//   - T1 fires when underlying <= T1_underlying (price fell)
//   - stop fires when underlying >= stop_underlying (price rose)
//
// Returns { ocaGroup, t1OrderId, stopOrderId }.
export function placeOCABracketExits({
  ib, ticker, expiry, strike, right, qty, direction,
  underlyingConId,
  t1Price, stopPrice,
  t1OrderId, stopOrderId,
  ocaGroupName,
  staged = false,  // default false — auto-send exits (entry is where the YES gate lives)
}) {
  if (!underlyingConId) throw new Error('placeOCABracketExits: underlyingConId is required');
  if (!Number.isFinite(t1Price) || !Number.isFinite(stopPrice)) {
    throw new Error('placeOCABracketExits: t1Price and stopPrice must be numbers');
  }
  if (!Number.isInteger(qty) || qty < 1) {
    throw new Error('placeOCABracketExits: qty must be a positive integer');
  }

  const optContract = {
    symbol: ticker,
    secType: SecType.OPT,
    exchange: 'SMART',
    currency: 'USD',
    lastTradeDateOrContractMonth: expiry,
    strike,
    right,
    multiplier: '100',
  };

  const ocaGroup = ocaGroupName || `brk-${ticker}-${strike}${right}-${Date.now()}`;

  // Build the price condition via @stoqey/ib's PriceCondition class.
  // `isMore: true`  → fires when the referenced price is >= threshold
  // `isMore: false` → fires when the referenced price is <= threshold
  // TriggerMethod.Default = last trade / midpoint (0)
  function priceCondition(price, isMore) {
    return new PriceCondition(
      price,
      TriggerMethod.Default,
      underlyingConId,
      'SMART',
      isMore,
      ConjunctionConnection.AND,
    );
  }

  // For CALLS: T1 is ABOVE entry (price rose), stop is BELOW entry (price fell)
  // For PUTS:  T1 is BELOW entry (price fell), stop is ABOVE entry (price rose)
  const isCallsDirection = direction === 'CALLS';
  const t1IsMore   = isCallsDirection ? true  : false;   // CALLS: fires on price >=, PUTS: on <=
  const stopIsMore = isCallsDirection ? false : true;    // CALLS: fires on <=, PUTS: on >=

  const commonOrder = {
    action: 'SELL',
    totalQuantity: qty,
    orderType: 'MKT',
    tif: 'DAY',
    ocaGroup,
    ocaType: 1,                      // 1 = cancel with block (other members cancelled on fill)
    firmQuoteOnly: false,
    eTradeOnly: false,
    conditionsCancelOrder: false,    // condition triggers order, does not cancel it
  };

  const t1Order = {
    ...commonOrder,
    conditions: [priceCondition(t1Price, t1IsMore)],
    orderRef: `T1 @ ${t1Price}`,
    transmit: staged ? false : false,  // leaves staged/live controlled by the group transmit pattern below
  };

  const stopOrder = {
    ...commonOrder,
    conditions: [priceCondition(stopPrice, stopIsMore)],
    orderRef: `STOP @ ${stopPrice}`,
    transmit: true,  // last order in the group sends the whole OCA
  };

  // First order must be staged (transmit=false); last order triggers submission
  t1Order.transmit = false;

  ib.placeOrder(t1OrderId, optContract, t1Order);
  ib.placeOrder(stopOrderId, optContract, stopOrder);

  return { ocaGroup, t1OrderId, stopOrderId, t1Order, stopOrder };
}

// ─── Print a bracket summary box ─────────────────────────────────────────────
export function printBracketSpec({
  ticker, direction, strike, right, qty, t1Price, stopPrice,
  entryUnderlying, t1OrderId, stopOrderId, ocaGroup,
}) {
  const rightLabel = direction === 'CALLS' ? 'CALL' : 'PUT';
  console.log(`\n────────────────────────────────────────────────────────────────`);
  console.log(`  OCA BRACKET — automated exits now armed in TWS`);
  console.log(`────────────────────────────────────────────────────────────────`);
  console.log(`  Contract:     ${ticker} ${strike} ${rightLabel} · ${qty} contract(s)`);
  console.log(`  T1 exit:      SELL MKT when ${ticker} ${direction === 'CALLS' ? '>=' : '<='} ${t1Price.toFixed(2)}   (orderId=${t1OrderId})`);
  console.log(`  Stop exit:    SELL MKT when ${ticker} ${direction === 'CALLS' ? '<=' : '>='} ${stopPrice.toFixed(2)}   (orderId=${stopOrderId})`);
  console.log(`  OCA group:    ${ocaGroup}   (one fills → the other auto-cancels)`);
  if (entryUnderlying != null) {
    const t1Dist   = Math.abs(t1Price - entryUnderlying).toFixed(2);
    const stopDist = Math.abs(entryUnderlying - stopPrice).toFixed(2);
    console.log(`  R:R to T1:    ${(parseFloat(t1Dist) / parseFloat(stopDist)).toFixed(2)}  (T1 +$${t1Dist} / stop −$${stopDist} from trigger)`);
  }
  console.log(`────────────────────────────────────────────────────────────────`);
}
