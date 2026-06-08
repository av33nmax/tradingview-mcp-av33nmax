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
 *   placeOCALadderExits    — multi-tier scale-out alternative to placeOCABracketExits.
 *                            Places N tier limits + 1 full-qty stop in an
 *                            ocaType=2 (REDUCE_WITH_BLOCK) group so each tier
 *                            fill auto-reduces the remaining legs' qty.
 *                            Caller computes tier prices + qty allocation;
 *                            this is just the placement primitive.
 *   modifyStopToBreakeven  — slide an existing stop's auxPrice (and optionally
 *                            qty) without losing OCA membership. Used after
 *                            tier 1 fills to move the stop to BE for the rest.
 *                            Tries IBKR in-place modify first; falls back to
 *                            cancel-and-replace on rare modify rejections.
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

// ─── Friday-weekly expiry picker (for stock options where 0DTE isn't daily) ──
// Returns today if today is Friday and a Friday expiry exists; otherwise the
// next Friday's YYYYMMDD. Falls back to nearest-future expiry like
// pick0DTEExpiry if the computed Friday isn't in the chain (shouldn't happen
// for liquid weeklies but be lenient).
export function pickFridayWeeklyExpiry(expirations) {
  const etFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [y, mo, d] = etFmt.format(new Date()).split('-');
  const todayYMD = `${y}${mo}${d}`;
  // UTC-anchored date for weekday math (avoids local-TZ surprises).
  const todayUTC = new Date(Date.UTC(parseInt(y, 10), parseInt(mo, 10) - 1, parseInt(d, 10)));
  const dayOfWeek = todayUTC.getUTCDay(); // 0=Sun, 5=Fri
  const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
  const friday = new Date(todayUTC);
  friday.setUTCDate(todayUTC.getUTCDate() + daysUntilFriday);
  const fy = friday.getUTCFullYear();
  const fm = String(friday.getUTCMonth() + 1).padStart(2, '0');
  const fd = String(friday.getUTCDate()).padStart(2, '0');
  const fridayYMD = `${fy}${fm}${fd}`;
  if (expirations.has(fridayYMD)) return fridayYMD;
  const sorted = [...expirations].sort();
  return sorted.find(e => e >= todayYMD) || sorted[0];
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
  // maxRisk is optional — trade_window.mjs (watcher) omits it because the
  // option-premium STP bounds realized loss; trade_planner.mjs and
  // place_option_order.mjs still pass it as a dynamic-qty derivation cap.
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
  const estRisk = (qty * premiumEst * 100).toFixed(2);
  console.log(`  Est risk:      $${estRisk}${maxRisk != null ? ` / $${maxRisk} cap` : '  (loss bounded by option STP)'}`);
  console.log(`  transmit:      ${staged ? 'false (STAGED in TWS — you click Transmit to send)' : 'true (FIRES IMMEDIATELY)'}`);
  console.log(`────────────────────────────────────────────────────────────────`);
  if (entryPrice != null) {
    console.log(`  Trigger:       fires when ${ticker} ${direction === 'CALLS' ? '>' : '<'} ${entryPrice.toFixed(2)}`);
  }
  if (exitSpec) {
    console.log(`  Exit plan:     stop ${exitSpec.stop?.toFixed(2) ?? 'N/A'}  ·  T1 ${exitSpec.T1?.toFixed(2) ?? 'N/A'}  ·  T2 ${exitSpec.T2?.toFixed(2) ?? 'N/A'}`);
  }
  const isLivePort = port === 7496;
  if (isLivePort) {
    console.log(`  Account:       🔴 IBKR LIVE  (port ${port}) — REAL MONEY`);
  } else {
    console.log(`  Account:       📋 IBKR paper  (port ${port})`);
  }
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
/**
 * Place the OCA exit bracket after entry fill.
 *
 * @param {Object} args
 * @param {number} args.t1Price - T1 trigger. Underlying price (default) or
 *   option price when useOptionPriceStop=true (less common; T1 typically
 *   stays underlying-anchored to the structural target).
 * @param {number} args.stopPrice - Stop trigger. Underlying price by
 *   default; option price (STP auxPrice) when useOptionPriceStop=true.
 * @param {boolean} [args.useOptionPriceStop=false] - When true, the STOP
 *   leg becomes a true STP order on the OPTION contract (orderType:'STP',
 *   auxPrice=stopPrice). Used by the qty=1 + $60-stop config 2026-05-02:
 *   stopPrice is computed as max(0.01, fillPremium - 0.60) so realized
 *   loss is capped at $60 regardless of underlying behavior. T1 leg stays
 *   on the underlying-trigger conditional MKT (structural target).
 */
export function placeOCABracketExits({
  ib, ticker, expiry, strike, right, qty, direction,
  underlyingConId,
  t1Price, stopPrice,
  t1OrderId, stopOrderId,
  ocaGroupName,
  staged = false,  // default false — auto-send exits (entry is where the YES gate lives)
  useOptionPriceStop = false,
}) {
  if (!underlyingConId) throw new Error('placeOCABracketExits: underlyingConId is required');
  if (!Number.isFinite(t1Price) || !Number.isFinite(stopPrice)) {
    throw new Error('placeOCABracketExits: t1Price and stopPrice must be numbers');
  }
  if (!Number.isInteger(qty) || qty < 1) {
    throw new Error('placeOCABracketExits: qty must be a positive integer');
  }
  if (useOptionPriceStop && stopPrice <= 0) {
    throw new Error(`placeOCABracketExits: option-price stop must be > 0 (got ${stopPrice})`);
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

  // OCA groups: each member transmits independently. (This differs from
  // bracket parent/child orders, where transmit on the last child sends the
  // whole group. Earlier code used the bracket pattern here, which left the
  // T1 leg staged in TWS — see 2026-04-28 QQQ 653P incident.)
  const legTransmit = !staged;

  const t1Order = {
    ...commonOrder,
    conditions: [priceCondition(t1Price, t1IsMore)],
    orderRef: `T1 @ ${t1Price}`,
    transmit: legTransmit,
  };

  // Stop leg: two flavors.
  //   underlying-trigger MKT (default): "fires when SPY hits 707.07"
  //   option-price STP (useOptionPriceStop=true): "fires when option mid
  //                       drops to 0.30" — bounded $$$ loss
  const stopOrder = useOptionPriceStop ? {
    ...commonOrder,
    orderType: 'STP',
    auxPrice: stopPrice,                            // option price stop trigger
    orderRef: `STOP @ option ${stopPrice.toFixed(2)} ($${MAX_LOSS_HINT_FOR_REF}/trade cap)`,
    transmit: legTransmit,
  } : {
    ...commonOrder,
    conditions: [priceCondition(stopPrice, stopIsMore)],
    orderRef: `STOP @ ${stopPrice}`,
    transmit: legTransmit,
  };

  ib.placeOrder(t1OrderId, optContract, t1Order);
  ib.placeOrder(stopOrderId, optContract, stopOrder);

  return { ocaGroup, t1OrderId, stopOrderId, t1Order, stopOrder, useOptionPriceStop };
}

// Cosmetic constant for the orderRef label only — the actual cap is
// computed and enforced by the caller (trade_window.mjs).
const MAX_LOSS_HINT_FOR_REF = 60;

// ─── Multi-tier OCA ladder exits (auto-trim) ─────────────────────────────────
// Multi-tier replacement for placeOCABracketExits. Used when total qty ≥ 2
// to scale out across multiple price levels.
//
// Structure: N tier-limit SELLs (one per scale-out price) + 1 full-qty
// stop SELL, all in the same OCA group with ocaType=2 (REDUCE_WITH_BLOCK).
//
// Why ocaType=2 (not 1 like the binary bracket):
//   ocaType=1 = CANCEL_WITH_BLOCK — when ANY leg fills, ALL others cancel.
//                Wrong for the ladder: filling tier 1 would also cancel
//                tiers 2/3 and the stop, leaving the remaining position
//                unprotected.
//   ocaType=2 = REDUCE_WITH_BLOCK — when one leg fills for N contracts,
//                the OTHER legs' qty are reduced by N (but they stay
//                live). Exactly the auto-trim semantic we need: tier 1
//                fires for 1 contract → stop's qty drops from 3 to 2,
//                tiers 2/3 stay at their original qty (which already
//                summed to 2). Cascade continues correctly when tier 2
//                fires.
//
// Caller responsibilities:
//   - Compute tier prices (entry+0.5×ATR for tier 1, T1 for tier 2, etc.)
//   - Allocate qty across tiers — sum of tiers MUST equal totalQty
//   - Pre-allocate orderIds for each tier + the stop (caller's nextOrderId
//     counter)
//
// Returns { ocaGroup, tierOrderIds: number[], stopOrderId,
//           tierOrders: object[], stopOrder }
export function placeOCALadderExits({
  ib, ticker, expiry, strike, right, totalQty, direction,
  underlyingConId,
  tiers,                                 // [{ price: number, qty: number }, ...]
  stopPrice,
  tierOrderIds,                          // number[] same length as tiers
  stopOrderId,
  ocaGroupName,
  staged = false,
  useOptionPriceStop = false,            // when true, stopPrice is the OPTION
                                         // premium (STP auxPrice). Mirrors the
                                         // same flag on placeOCABracketExits.
}) {
  if (!underlyingConId) throw new Error('placeOCALadderExits: underlyingConId is required');
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new Error('placeOCALadderExits: tiers must be a non-empty array of {price, qty}');
  }
  if (!Array.isArray(tierOrderIds) || tierOrderIds.length !== tiers.length) {
    throw new Error('placeOCALadderExits: tierOrderIds length must match tiers length');
  }
  if (!Number.isFinite(stopPrice)) {
    throw new Error('placeOCALadderExits: stopPrice must be a number');
  }
  if (useOptionPriceStop && stopPrice <= 0) {
    throw new Error(`placeOCALadderExits: option-price stop must be > 0 (got ${stopPrice})`);
  }
  if (!Number.isInteger(totalQty) || totalQty < 2) {
    throw new Error('placeOCALadderExits: totalQty must be an integer ≥ 2 (use placeOCABracketExits for qty=1)');
  }
  // Validate tier qtys sum to totalQty and each is positive
  let sum = 0;
  for (const t of tiers) {
    if (!Number.isFinite(t?.price)) throw new Error(`placeOCALadderExits: tier.price must be a number (got ${t?.price})`);
    if (!Number.isInteger(t?.qty) || t.qty < 1) {
      throw new Error(`placeOCALadderExits: tier.qty must be a positive integer (got ${t?.qty})`);
    }
    sum += t.qty;
  }
  if (sum !== totalQty) {
    throw new Error(`placeOCALadderExits: tier qtys sum to ${sum} but totalQty is ${totalQty} (must match)`);
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

  const ocaGroup = ocaGroupName || `lad-${ticker}-${strike}${right}-${Date.now()}`;

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

  // For CALLS (long call): tier-take-profits ABOVE entry (price rose),
  //                        stop BELOW entry (price fell)
  // For PUTS  (long put):  tier-take-profits BELOW entry (price fell),
  //                        stop ABOVE entry (price rose)
  const isCallsDirection = direction === 'CALLS';
  const tierIsMore = isCallsDirection ? true  : false;
  const stopIsMore = isCallsDirection ? false : true;

  const commonOrderSkeleton = {
    action: 'SELL',
    orderType: 'MKT',
    tif: 'DAY',
    ocaGroup,
    ocaType: 2,                          // REDUCE_WITH_BLOCK — fills reduce other legs' qty
    firmQuoteOnly: false,
    eTradeOnly: false,
    conditionsCancelOrder: false,        // condition triggers order, doesn't cancel it
  };

  const legTransmit = !staged;

  // Tier limits — each its own qty allocation
  const tierOrders = tiers.map((t, i) => ({
    ...commonOrderSkeleton,
    totalQuantity: t.qty,
    conditions: [priceCondition(t.price, tierIsMore)],
    orderRef: `T${i + 1} @ ${t.price}`,
    transmit: legTransmit,
  }));

  // Stop — full position qty initially. ocaType=2 will reduce this
  // automatically as tier fills happen.
  // Two flavors (matching placeOCABracketExits):
  //   underlying-condition (default): "fires when underlying touches stopPrice"
  //   option-price STP   (useOptionPriceStop=true): "fires when option mid
  //                       drops to stopPrice" — fixed offset below fill premium
  const stopOrder = useOptionPriceStop ? {
    ...commonOrderSkeleton,
    orderType: 'STP',
    auxPrice: stopPrice,                          // option-price stop trigger
    totalQuantity: totalQty,
    orderRef: `STOP @ option ${stopPrice.toFixed(2)}`,
    transmit: legTransmit,
  } : {
    ...commonOrderSkeleton,
    totalQuantity: totalQty,
    conditions: [priceCondition(stopPrice, stopIsMore)],
    orderRef: `STOP @ ${stopPrice}`,
    transmit: legTransmit,
  };

  // Place all legs. Each transmits independently (matches the binary
  // bracket pattern — see placeOCABracketExits comments for why this
  // differs from parent/child bracket transmit semantics).
  for (let i = 0; i < tiers.length; i++) {
    ib.placeOrder(tierOrderIds[i], optContract, tierOrders[i]);
  }
  ib.placeOrder(stopOrderId, optContract, stopOrder);

  return { ocaGroup, tierOrderIds, stopOrderId, tierOrders, stopOrder };
}

// ─── Modify a stop's price (and optionally qty) without losing OCA membership ─
// Used by the auto-trim ladder when tier 1 fills: the stop price slides
// from `entry ± 1×ATR` to `entry` itself (break-even), so the rest of
// the position has zero downside.
//
// Approach 1 (preferred): IBKR in-place modify. Call ib.placeOrder with
// the same orderId — IBKR treats this as an update, not a new order.
// The order keeps its ocaGroup membership and just refreshes the stop
// price (and qty if changed).
//
// Approach 2 (fallback): cancel-and-replace. Used only if approach 1
// rejects (rare: happens when the order is in a transitional state).
// Note that this leaves a sub-second window with no stop in place — if
// the underlying gaps in that microsecond, the position is unprotected.
// Caller can pass `forceCancelReplace: true` to skip the in-place attempt
// for testing.
//
// Returns {
//   newOrderId: number,                  // same as input on success, new on fallback
//   modifiedInPlace: boolean,            // true on approach 1, false on fallback
//   newOrder: object,                    // the order object that was placed
// }
export function modifyStopToBreakeven({
  ib,
  stopOrderId,                           // existing stop's orderId
  contract,                              // option contract spec (symbol/expiry/strike/right/...)
  newStopPrice,                          // BE price (entry, in underlying terms)
  newQty,                                // remaining qty after tier fill
  underlyingConId,                       // for the price condition
  direction,                             // 'CALLS' or 'PUTS' — for stop-side direction
  ocaGroup,                              // existing OCA group name to preserve membership
  freshOrderIdIfNeeded,                  // pre-allocated orderId for fallback path
  forceCancelReplace = false,            // testing flag — skip in-place attempt
}) {
  if (!Number.isInteger(stopOrderId)) throw new Error('modifyStopToBreakeven: stopOrderId required');
  if (!contract) throw new Error('modifyStopToBreakeven: contract required');
  if (!Number.isFinite(newStopPrice)) throw new Error('modifyStopToBreakeven: newStopPrice must be a number');
  if (!Number.isInteger(newQty) || newQty < 1) throw new Error('modifyStopToBreakeven: newQty must be a positive integer');
  if (!underlyingConId) throw new Error('modifyStopToBreakeven: underlyingConId required');

  const isCallsDirection = direction === 'CALLS';
  const stopIsMore = isCallsDirection ? false : true;

  const newOrder = {
    action: 'SELL',
    totalQuantity: newQty,
    orderType: 'MKT',
    tif: 'DAY',
    ocaGroup,
    ocaType: 2,                          // preserve REDUCE_WITH_BLOCK semantics
    firmQuoteOnly: false,
    eTradeOnly: false,
    conditionsCancelOrder: false,
    conditions: [
      new PriceCondition(
        newStopPrice,
        TriggerMethod.Default,
        underlyingConId,
        'SMART',
        stopIsMore,
        ConjunctionConnection.AND,
      ),
    ],
    orderRef: `STOP-BE @ ${newStopPrice}`,
    transmit: true,
  };

  // Approach 1: in-place modify. IBKR treats placeOrder with an existing
  // orderId as an update; the order keeps its OCA membership and just
  // refreshes price/qty.
  if (!forceCancelReplace) {
    try {
      ib.placeOrder(stopOrderId, contract, newOrder);
      return { newOrderId: stopOrderId, modifiedInPlace: true, newOrder };
    } catch (e) {
      // Fall through to cancel-and-replace. This path is rare; caller
      // should log the failure for diagnosis.
      console.log(`   ⚠ modifyStopToBreakeven: in-place modify failed (${e?.message ?? e}); falling back to cancel-and-replace`);
    }
  }

  // Approach 2: cancel-and-replace fallback. The new stop joins the same
  // OCA group as the cancelled one — IBKR treats it as a member of the
  // existing group by ocaGroup name match.
  if (!Number.isInteger(freshOrderIdIfNeeded)) {
    throw new Error('modifyStopToBreakeven: freshOrderIdIfNeeded required for cancel-replace fallback');
  }
  try { ib.cancelOrder(stopOrderId); } catch (e) {
    console.log(`   ⚠ modifyStopToBreakeven: cancel of ${stopOrderId} failed (${e?.message ?? e}); proceeding to place anyway`);
  }
  ib.placeOrder(freshOrderIdIfNeeded, contract, newOrder);
  return { newOrderId: freshOrderIdIfNeeded, modifiedInPlace: false, newOrder };
}

// ─── Trailing-stop SELL on option contract ───────────────────────────────────
// Single TRAIL order on the option. IBKR's server tracks the high-water mark
// of the option premium and keeps the stop exactly trailAmount dollars below
// peak. Premium rises → stop rises. Premium falls → stop holds at last peak
// minus trailAmount.
//
// Used INSTEAD OF placeOCABracketExits / placeOCALadderExits when the user
// enables trailing mode for a ticker (--trailing-runner CLI flag or
// WATCHER_TRAILING_RUNNER=1 env var, plumbed through per-ticker from the
// dashboard). User decision 2026-05-13: replace T1/T2 capped exits with a
// trail to let runners run; TV chart still draws T1/T2 lines as mental map.
//
// At fill: initial stop sits at (fillPrice - trailAmount). If premium goes
// up, stop moves up to maintain the trail distance. If premium goes down
// without first going up, the stop fires at the initial level. Worst case
// loss = trailAmount × 100 × qty.
//
// Returns { orderId, trailOrder } so the caller can verify-transmit and log.
export function placeTrailingStop({
  ib, ticker, expiry, strike, right, qty,
  trailAmount,
  orderId,
  staged = false,                            // default false — auto-send
}) {
  if (!Number.isFinite(trailAmount) || trailAmount <= 0) {
    throw new Error(`placeTrailingStop: trailAmount must be > 0 (got ${trailAmount})`);
  }
  if (!Number.isInteger(qty) || qty < 1) {
    throw new Error('placeTrailingStop: qty must be a positive integer');
  }
  if (!Number.isInteger(orderId)) {
    throw new Error('placeTrailingStop: orderId must be a pre-allocated integer');
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

  // TRAIL order: auxPrice = trail distance in DOLLARS (option premium).
  // IBKR maintains the trailing high-water mark server-side.
  //
  // triggerMethod: 1 = DOUBLE BID/ASK (explicit). Without this the order used
  // method 0 (default), which on 2026-06-01 (AAPL 310P 0DTE) tracked and
  // triggered off the LAST traded price: on a thin 0DTE option the last went
  // stale (minutes with 0 volume, last frozen ~$0.20-0.40 above the live bid),
  // so the stop's high-water mark locked at peak_last−trail ($2.75 = $3.45−0.70)
  // and never fired even though the BID fell to $2.55 — the position had to be
  // closed manually. Forcing double bid/ask keys both the trail and the trigger
  // off the live quote (the bid we actually exit into), immune to stale prints
  // and to whatever the TWS global stop-trigger preset is set to.
  const trailOrder = {
    action: 'SELL',
    totalQuantity: qty,
    orderType: 'TRAIL',
    auxPrice: trailAmount,
    triggerMethod: 1,                          // double bid/ask — see note above
    tif: 'DAY',
    transmit: !staged,
    firmQuoteOnly: false,
    eTradeOnly: false,
    orderRef: `TRAIL @ -$${trailAmount.toFixed(2)} from peak`,
  };

  ib.placeOrder(orderId, optContract, trailOrder);
  return { orderId, trailOrder };
}

// ─── Single FIXED stop on the option ─────────────────────────────────────────
// One STP SELL on the option at a fixed premium level (stopPrice). Unlike
// placeTrailingStop there is NO high-water mark — the stop never moves. Chosen
// 2026-06-03 after the trailing stop failed to ratchet on cheap/fast 0DTE
// premium (SPY 753P spiked 0.48→1.22→0.47 and the trail stayed pinned at entry).
// A fixed stop has nothing to ratchet, so that failure mode is gone. Caller
// computes stopPrice (typically fillPrice × (1 − STOP_PCT), tick-rounded).
//
// triggerMethod 1 = DOUBLE BID/ASK — keep the lesson from the 06-01 AAPL 310P
// miss (the old default, method 0, tracked a stale LAST and never fired on the
// reversal). Method 1 keys the trigger off the live bid we actually sell into.
// Exit is a MARKET order on trigger (not stop-limit — a stop-limit is what
// couldn't fill on the 06-03 Tencent bracket).
export function placeFixedStop({
  ib, ticker, expiry, strike, right, qty,
  stopPrice,
  orderId,
  staged = false,                            // default false — auto-send
}) {
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
    throw new Error(`placeFixedStop: stopPrice must be > 0 (got ${stopPrice})`);
  }
  if (!Number.isInteger(qty) || qty < 1) {
    throw new Error('placeFixedStop: qty must be a positive integer');
  }
  if (!Number.isInteger(orderId)) {
    throw new Error('placeFixedStop: orderId must be a pre-allocated integer');
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

  const stopOrder = {
    action: 'SELL',
    totalQuantity: qty,
    orderType: 'STP',
    auxPrice: stopPrice,                       // trigger price (option premium)
    triggerMethod: 1,                          // double bid/ask — see note above
    tif: 'DAY',
    transmit: !staged,
    firmQuoteOnly: false,
    eTradeOnly: false,
    orderRef: `FIXED STP @ $${stopPrice.toFixed(2)}`,
  };

  ib.placeOrder(orderId, optContract, stopOrder);
  return { orderId, stopOrder };
}

// ─── Print a trailing-stop summary box ───────────────────────────────────────
export function printTrailingSpec({
  ticker, direction, strike, right, qty,
  trailAmount, fillPrice, orderId,
}) {
  const rightLabel = direction === 'CALLS' ? 'CALL' : 'PUT';
  const initialStop = Math.max(0.01, fillPrice - trailAmount);
  const maxLoss = qty * trailAmount * 100;
  console.log(`\n────────────────────────────────────────────────────────────────`);
  console.log(`  TRAILING STOP — runner mode armed in TWS`);
  console.log(`────────────────────────────────────────────────────────────────`);
  console.log(`  Contract:     ${ticker} ${strike} ${rightLabel} · ${qty} contract(s)`);
  console.log(`  Fill premium: $${fillPrice.toFixed(2)}`);
  console.log(`  Trail width:  $${trailAmount.toFixed(2)} below peak (option premium)`);
  console.log(`  Initial stop: $${initialStop.toFixed(2)}  (= $${fillPrice.toFixed(2)} − $${trailAmount.toFixed(2)})`);
  console.log(`  Max loss:     $${maxLoss.toFixed(2)} (= $${trailAmount.toFixed(2)} × 100 × ${qty})  — only if premium drops without first rising`);
  console.log(`  Behavior:     premium rises → stop rises  ·  premium falls $${trailAmount.toFixed(2)} from peak → exit at market`);
  console.log(`  orderId:      ${orderId}`);
  console.log(`────────────────────────────────────────────────────────────────`);
}

// ─── Print a fixed-stop summary box ──────────────────────────────────────────
export function printFixedStopSpec({
  ticker, direction, strike, right, qty,
  stopPrice, fillPrice, orderId,
}) {
  const rightLabel = direction === 'CALLS' ? 'CALL' : 'PUT';
  const dist = Math.max(0, fillPrice - stopPrice);
  const pct = fillPrice > 0 ? (dist / fillPrice) * 100 : 0;
  const maxLoss = dist * qty * 100;
  console.log(`\n────────────────────────────────────────────────────────────────`);
  console.log(`  FIXED STOP — armed in TWS (no trailing)`);
  console.log(`────────────────────────────────────────────────────────────────`);
  console.log(`  Contract:     ${ticker} ${strike} ${rightLabel} · ${qty} contract(s)`);
  console.log(`  Fill premium: $${fillPrice.toFixed(2)}`);
  console.log(`  Stop price:   $${stopPrice.toFixed(2)}  (= −$${dist.toFixed(2)} / ${pct.toFixed(0)}% below fill)`);
  console.log(`  Max loss:     $${maxLoss.toFixed(2)} (= $${dist.toFixed(2)} × 100 × ${qty})`);
  console.log(`  Trigger:      double bid/ask · MARKET exit on trigger · stop does NOT move`);
  console.log(`  Manage:       upside is yours to manage manually — this is the hard floor`);
  console.log(`  orderId:      ${orderId}`);
  console.log(`────────────────────────────────────────────────────────────────`);
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
