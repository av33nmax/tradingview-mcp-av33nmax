/**
 * asia/lib/ibkr_hk_orders.mjs — HK-aware IBKR order helpers.
 *
 * HK-equivalent of the root ibkr_orders.mjs (US). Key differences:
 *   - Contract specs read from asia/config/contracts.json (no SMART/USD/100 baked in)
 *   - Two contract families: index futures options (FOP on HKFE) and
 *     single-stock options (OPT on SEHK). The two have different secType,
 *     exchange, multiplier, and underlying resolution.
 *   - PriceCondition for OCA brackets uses the underlying's actual exchange
 *     (HKFE for futures, SEHK for stocks) — NOT the US's hardcoded 'SMART'.
 *   - pickHKWednesdayWeeklyExpiry replaces the US Friday-weekly picker.
 *   - For index futures, the option's underlying is the front-month FUTURE
 *     (not the cash index), and we resolve its conId via reqContractDetails.
 *
 * ⚠ HK CONTRACT SYMBOLOGY IS PARTIALLY VERIFIED. Before first live use,
 *   run `node asia/scripts/test_hk_contract_resolve.mjs` and verify the
 *   IBKR-returned contract specs match the assumptions baked here:
 *     - MHI / MTW   : secType=FOP, exchange=HKFE, currency=HKD,
 *                     multiplier from contracts.json (10), futures expiry
 *                     = front-month FUT contract (monthlies, not weekly)
 *     - 700/9988/1810: secType=OPT, exchange=SEHK, currency=HKD,
 *                     multiplier from contracts.json
 *   If any of these are wrong, IBKR will reject placeOrder with code 200
 *   (contract not found) or 201 (bad order). Adjust EXCHANGE_FOR_KIND or
 *   the contract builders below.
 */

import { EventName, SecType } from '@stoqey/ib';
import { PriceCondition } from '@stoqey/ib/dist/api/order/condition/price-condition.js';
import { TriggerMethod } from '@stoqey/ib/dist/api/order/enum/trigger-method.js';
import { ConjunctionConnection } from '@stoqey/ib/dist/api/order/enum/conjunction-connection.js';
import readline from 'node:readline';

let _reqIdCounter = 60000;  // HK reqIds start at 60000 (US uses 50000)
export function nextReqId() { return _reqIdCounter++; }

// HK exchange codes by instrument kind. If reqContractDetails returns an
// "ambiguous" or "not found" error, the offender is almost always here.
//
// index_options: HK index options (HSI, HHI) listed as OPT on the cash
//   INDEX (not FOP on a future). Multiplier set per-instrument via
//   contracts.json (HK$50/point for HSI, HK$10/point for Mini-HSI).
//   Discovered 2026-05-18 — the earlier `index_futures` kind didn't work
//   for HSI weeklies because they're not futures options.
// index_futures: legacy kind — kept for future FOP products but the only
//   real HK index futures options product (MHI) only has monthly expiries,
//   so we don't currently use this kind in contracts.json.
// single_stock: HK stock options on SEHK with per-instrument tradingClass.
const EXCHANGE_FOR_KIND = {
  index_options: { underlying: 'HKFE', option: 'HKFE', secType: SecType.OPT, undSecType: SecType.IND },
  index_futures: { underlying: 'HKFE', option: 'HKFE', secType: SecType.FOP, undSecType: SecType.FUT },
  single_stock:  { underlying: 'SEHK', option: 'SEHK', secType: SecType.OPT, undSecType: SecType.STK },
};

function exchangesFor(spec) {
  const m = EXCHANGE_FOR_KIND[spec.kind];
  if (!m) throw new Error(`ibkr_hk_orders: unknown instrument kind '${spec.kind}' (expected 'index_futures' or 'single_stock')`);
  return m;
}

// ─── Historical bars (verbatim from US — generic, no HK changes needed) ─────
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

// ─── Build underlying contract for analysis (bar fetching, conditions) ──────
/**
 * Build the underlying contract spec for an instrument. For single_stock,
 * that's STK on SEHK. For index_futures, that's a FUT contract — but the
 * specific futures contract month is left empty here, letting IBKR resolve
 * to the front-month at reqContractDetails time (caller passes that to
 * resolveHKUnderlyingConId).
 */
export function buildUnderlyingContract(spec) {
  const { underlying, undSecType } = exchangesFor(spec);
  const symbol = spec.ibkr_symbol_root || spec.tradingview_search;
  if (!symbol) throw new Error(`buildUnderlyingContract: spec missing ibkr_symbol_root/tradingview_search`);
  return {
    symbol,
    secType: undSecType,
    exchange: underlying,
    currency: spec.currency || 'HKD',
  };
}

// ─── Resolve underlying conId (single STK → conId; FUT → front-month conId+expiry) ──
/**
 * For single_stock: returns { conId, exchange, contract }
 * For index_futures: returns { conId, exchange, contract, frontMonthExpiry }
 *   where frontMonthExpiry is the YYYYMM string of the picked futures contract.
 */
export async function resolveHKUnderlyingConId(ib, spec) {
  const base = buildUnderlyingContract(spec);
  return new Promise((resolve, reject) => {
    const reqId = nextReqId();
    const details = [];

    const onDetails = (id, d) => { if (id === reqId) details.push(d); };
    const onEnd = (id) => {
      if (id !== reqId) return;
      ib.off(EventName.contractDetails, onDetails);
      ib.off(EventName.contractDetailsEnd, onEnd);
      if (details.length === 0) {
        reject(new Error(`resolveHKUnderlyingConId: no contract details for ${base.symbol} (${base.secType}/${base.exchange})`));
        return;
      }
      // For STK: typically one result, use it directly.
      // For FUT: multiple results (one per expiry month). Pick the nearest
      // expiry >= today (front-month).
      if (spec.kind === 'index_futures') {
        const today = todayYYYYMMDD();
        const sorted = details
          .map(d => ({
            conId: d.contract.conId,
            expiry: d.contract.lastTradeDateOrContractMonth || '99999999',
            contract: d.contract,
          }))
          .sort((a, b) => a.expiry.localeCompare(b.expiry));
        const front = sorted.find(s => s.expiry >= today) || sorted[0];
        resolve({
          conId: front.conId,
          exchange: base.exchange,
          contract: front.contract,
          frontMonthExpiry: front.expiry,
        });
      } else {
        const d = details[0];
        resolve({
          conId: d.contract.conId,
          exchange: base.exchange,
          contract: d.contract,
        });
      }
    };

    ib.on(EventName.contractDetails, onDetails);
    ib.on(EventName.contractDetailsEnd, onEnd);
    ib.reqContractDetails(reqId, base);
    setTimeout(() => reject(new Error(`resolveHKUnderlyingConId timeout for ${base.symbol}`)), 10000);
  });
}

function todayYYYYMMDD(tz = 'Asia/Hong_Kong') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()).replaceAll('-', '');
}

// ─── Build option contract from instrument spec ─────────────────────────────
/**
 * @param {object} spec      - contracts.json primary[key]
 * @param {string} expiry    - YYYYMMDD option expiry
 * @param {number} strike    - option strike price
 * @param {string} right     - 'C' or 'P'
 * @param {object} [opts]
 * @param {string} [opts.tradingClass]    - some HK option chains require this (e.g. weekly classes vs monthly)
 *
 * Note: For futures options (FOP), IBKR sometimes requires the underlying
 * futures contract's expiry as part of qualifying the option. If you hit
 * "ambiguous contract" errors on MHI/MTW, you may need to add
 * `lastTradeDate` of the future itself — currently we rely on IBKR's
 * default front-month resolution.
 */
export function buildOptionContract(spec, expiry, strike, right, opts = {}) {
  const { option, secType } = exchangesFor(spec);
  const symbol = spec.ibkr_symbol_root || spec.tradingview_search;
  const multiplier = String(spec.multiplier);
  const contract = {
    symbol,
    secType,
    exchange: option,
    currency: spec.currency || 'HKD',
    lastTradeDateOrContractMonth: expiry,
    strike,
    right,
    multiplier,
  };
  // tradingClass: opts override > spec default (per-instrument in contracts.json).
  // HK single-stocks require this — without it, reqContractDetails returns 0
  // results because the bare {symbol,secType,exchange,strike,right} matches
  // no canonical contract (verified 2026-05-18 against IBKR).
  const tradingClass = opts.tradingClass || spec.tradingClass;
  if (tradingClass) contract.tradingClass = tradingClass;
  return contract;
}

// ─── Option chain (expirations + strikes) for an HK underlying ───────────────
//
// For futures options (FOP), the futFopExchange (2nd arg of reqSecDefOptParams)
// is REQUIRED — without it IBKR returns error 321 "Missing exchange for
// security type FUT". For regular stock options it stays empty.
//
// When spec.tradingClass is set, filter the returned param sets to only
// that class — HK stocks publish multiple series (e.g. ALB weekly vs
// monthly) and we only want one. Without the filter, expirations get
// merged across series and the strike picker picks invalid combinations.
export async function getHKOptionChainParams(ib, spec, underlyingConId) {
  const symbol = spec.ibkr_symbol_root || spec.tradingview_search;
  const { undSecType, option } = exchangesFor(spec);
  const futFopExchange = spec.kind === 'index_futures' ? option : '';
  return new Promise((resolve) => {
    const reqId = nextReqId();
    const expirations = new Set();
    const strikes = new Set();

    const onParam = (id, exchange, undConId, tradingClass, multiplier, exps, strks) => {
      if (id !== reqId) return;
      if (spec.tradingClass && spec.tradingClass !== tradingClass) return;
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
    ib.reqSecDefOptParams(reqId, symbol, futFopExchange, undSecType, underlyingConId);
    setTimeout(() => resolve({ expirations, strikes }), 10000);
  });
}

// ─── Wednesday-weekly expiry picker (HK weeklies expire Wednesdays) ─────────
/**
 * Returns today if today is Wednesday and a Wednesday expiry exists;
 * otherwise the next Wednesday's YYYYMMDD. Falls back to nearest-future
 * expiry if the computed Wednesday isn't in the chain (e.g. holiday-shifted).
 */
export function pickHKWednesdayWeeklyExpiry(expirations) {
  // Anchor calendar math to HK calendar day (matters near midnight UTC).
  const hkFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [y, mo, d] = hkFmt.format(new Date()).split('-');
  const todayYMD = `${y}${mo}${d}`;
  const todayUTC = new Date(Date.UTC(parseInt(y, 10), parseInt(mo, 10) - 1, parseInt(d, 10)));
  const dayOfWeek = todayUTC.getUTCDay();  // 0=Sun, 3=Wed
  const daysUntilWed = (3 - dayOfWeek + 7) % 7;
  const wed = new Date(todayUTC);
  wed.setUTCDate(todayUTC.getUTCDate() + daysUntilWed);
  const wy = wed.getUTCFullYear();
  const wm = String(wed.getUTCMonth() + 1).padStart(2, '0');
  const wd = String(wed.getUTCDate()).padStart(2, '0');
  const wedYMD = `${wy}${wm}${wd}`;
  if (expirations.has(wedYMD)) return wedYMD;
  const sorted = [...expirations].sort();
  return sorted.find(e => e >= todayYMD) || sorted[0];
}

// ─── Nearest strikes (prefers round-dollar strikes — same logic as US) ──────
export function nearestStrikes(allStrikes, centerPrice, n) {
  const arr = [...allStrikes].sort((a, b) => a - b);
  const rounds = arr.filter(s => Number.isInteger(s));
  const pool = rounds.length > 20 ? rounds : arr;
  pool.sort((a, b) => Math.abs(a - centerPrice) - Math.abs(b - centerPrice));
  return pool.slice(0, n).sort((a, b) => a - b);
}

// ─── ATM strike picker (no premium scan for v1 — saves ~3s per fire) ────────
/**
 * Picks the nearest strike to entryPrice from the chain. For LONG (CALLS),
 * prefers ATM-or-slightly-OTM. For SHORT (PUTS), prefers ATM-or-slightly-OTM
 * on the put side. Returns { strike, expiry, right } or null if no chain.
 *
 * For v1 we skip the US-style premium-range scan (queryOptionPremium loop)
 * because HK option chains are smaller, less liquid, and the scan adds 3-5s
 * latency per fire. Add later if you want premium-bounded sizing.
 */
export async function pickHKStrikeATM({ ib, spec, expiry, entryPrice, direction }) {
  const right = direction === 'CALLS' || direction === 'long' ? 'C' : 'P';
  const underlying = await resolveHKUnderlyingConId(ib, spec);
  const { strikes } = await getHKOptionChainParams(ib, spec, underlying.conId);
  if (strikes.size === 0) return null;
  const nearby = nearestStrikes(strikes, entryPrice, 5);
  // Prefer ATM (closest), accept the closest regardless of side. ATM bias
  // is the right v1 default for HK weeklies — they're already wider-priced
  // than US so OTM strikes have very thin premium and worse spreads.
  if (nearby.length === 0) return null;
  const closest = nearby.reduce((best, s) =>
    Math.abs(s - entryPrice) < Math.abs(best - entryPrice) ? s : best
  );
  // Query the option mid so callers can size a %-based stop (the MKT fill ≈ mid).
  // Null on thin/empty books → caller falls back. Added 2026-06-04 for the 15%
  // fixed stop (HKD premiums span ~1–7 HKD so a flat-dollar stop can't scale).
  let mid = null;
  try {
    const bars = await reqHistoricalBars(
      ib, buildOptionContract(spec, expiry, closest, right), '120 S', '10 secs', 'MIDPOINT', 1,
    );
    if (bars && bars.length) mid = bars[bars.length - 1].close;
  } catch { /* mid stays null — caller falls back to trailing */ }
  return { strike: closest, expiry, right, mid };
}

// ─── YES prompt (blocking readline) — same as US ─────────────────────────────
export async function promptYes(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

// ─── Place the option BUY order (transmit flag controls staged-vs-fire) ─────
export function placeHKStagedOrder({
  ib, spec, expiry, strike, qty, direction, orderId, staged = true, tradingClass,
}) {
  const right = direction === 'CALLS' || direction === 'long' ? 'C' : 'P';
  const contract = buildOptionContract(spec, expiry, strike, right, { tradingClass });
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

// ─── OCA bracket exits — T1 take-profit + stop, conditions on underlying ────
/**
 * Places TWO conditional SELL orders linked as OCA (ocaType=1 = cancel-with-block).
 * Conditions trigger on the underlying's price (FUT for index_futures,
 * STK for single_stock), using the underlying's actual exchange (NOT 'SMART').
 *
 * Returns { ocaGroup, t1OrderId, stopOrderId, t1Order, stopOrder }.
 */
export function placeHKOCABracketExits({
  ib, spec, expiry, strike, right, qty, direction,
  underlyingConId, underlyingExchange,
  t1Price, stopPrice,
  t1OrderId, stopOrderId,
  ocaGroupName,
  staged = false,
  tradingClass,
}) {
  if (!underlyingConId) throw new Error('placeHKOCABracketExits: underlyingConId required');
  if (!underlyingExchange) throw new Error('placeHKOCABracketExits: underlyingExchange required (HKFE for FUT, SEHK for STK)');
  if (!Number.isFinite(t1Price) || !Number.isFinite(stopPrice)) {
    throw new Error('placeHKOCABracketExits: t1Price and stopPrice must be numbers');
  }
  if (!Number.isInteger(qty) || qty < 1) {
    throw new Error('placeHKOCABracketExits: qty must be a positive integer');
  }

  const optContract = buildOptionContract(spec, expiry, strike, right, { tradingClass });
  const ocaGroup = ocaGroupName || `brk-hk-${optContract.symbol}-${strike}${right}-${Date.now()}`;

  function priceCondition(price, isMore) {
    return new PriceCondition(
      price,
      TriggerMethod.Default,
      underlyingConId,
      underlyingExchange,
      isMore,
      ConjunctionConnection.AND,
    );
  }

  const isLong = direction === 'CALLS' || direction === 'long';
  const t1IsMore = isLong;       // CALLS: T1 fires when underlying rises to T1
  const stopIsMore = !isLong;    // CALLS: stop fires when underlying falls to stop

  const commonOrder = {
    action: 'SELL',
    totalQuantity: qty,
    orderType: 'MKT',
    tif: 'DAY',
    ocaGroup,
    ocaType: 1,
    firmQuoteOnly: false,
    eTradeOnly: false,
    conditionsCancelOrder: false,
  };
  const legTransmit = !staged;

  const t1Order = {
    ...commonOrder,
    conditions: [priceCondition(t1Price, t1IsMore)],
    orderRef: `T1 @ ${t1Price}`,
    transmit: legTransmit,
  };
  const stopOrder = {
    ...commonOrder,
    conditions: [priceCondition(stopPrice, stopIsMore)],
    orderRef: `STOP @ ${stopPrice}`,
    transmit: legTransmit,
  };

  ib.placeOrder(t1OrderId, optContract, t1Order);
  ib.placeOrder(stopOrderId, optContract, stopOrder);

  return { ocaGroup, t1OrderId, stopOrderId, t1Order, stopOrder };
}

// ─── Pretty printers ─────────────────────────────────────────────────────────
export function printHKOrderSpec({
  instrumentKey, spec, direction, strike, expiry, qty, port, staged, entryPrice, exitSpec,
}) {
  const right = direction === 'CALLS' || direction === 'long' ? 'C' : 'P';
  const rightLabel = right === 'C' ? 'CALL' : 'PUT';
  const isLive = port === 7496;
  console.log(`\n════════════════════════════════════════════════════════════════`);
  console.log(`  HK ORDER SPEC — please review carefully`);
  console.log(`════════════════════════════════════════════════════════════════`);
  console.log(`  Instrument:    ${instrumentKey}  (${spec.name})`);
  console.log(`  Symbol:        ${spec.ibkr_symbol_root}  ·  ${exchangesFor(spec).option}  ·  ${spec.currency}  ·  ×${spec.multiplier}`);
  console.log(`  Right:         ${rightLabel} (${right})`);
  console.log(`  Strike:        ${strike}`);
  console.log(`  Expiry:        ${expiry}`);
  console.log(`  Action:        BUY`);
  console.log(`  Quantity:      ${qty} contracts`);
  console.log(`  Order type:    MARKET`);
  console.log(`  Time-in-force: DAY`);
  console.log(`  transmit:      ${staged ? 'false (STAGED in TWS — you click Transmit)' : 'true (FIRES IMMEDIATELY)'}`);
  console.log(`────────────────────────────────────────────────────────────────`);
  if (entryPrice != null) {
    const cmp = direction === 'CALLS' || direction === 'long' ? '>' : '<';
    console.log(`  Trigger:       fired when ${spec.ibkr_symbol_root} ${cmp} ${entryPrice.toFixed(2)}`);
  }
  if (exitSpec) {
    console.log(`  Exit plan:     stop ${exitSpec.stop?.toFixed(2) ?? 'N/A'}  ·  T1 ${exitSpec.T1?.toFixed(2) ?? 'N/A'}  ·  T2 ${exitSpec.T2?.toFixed(2) ?? 'N/A'}`);
  }
  if (isLive) {
    console.log(`  Account:       🔴 IBKR LIVE  (port ${port}) — REAL MONEY`);
  } else {
    console.log(`  Account:       📋 IBKR paper (port ${port})`);
  }
  console.log(`════════════════════════════════════════════════════════════════`);
}

export function printHKBracketSpec({
  instrumentKey, spec, direction, strike, right, qty, t1Price, stopPrice,
  entryUnderlying, t1OrderId, stopOrderId, ocaGroup,
}) {
  const rightLabel = right === 'C' ? 'CALL' : 'PUT';
  const isLong = direction === 'CALLS' || direction === 'long';
  console.log(`\n────────────────────────────────────────────────────────────────`);
  console.log(`  OCA BRACKET — armed in TWS`);
  console.log(`────────────────────────────────────────────────────────────────`);
  console.log(`  Contract:     ${instrumentKey} ${strike} ${rightLabel} · ${qty} contract(s)`);
  console.log(`  T1 exit:      SELL MKT when ${spec.ibkr_symbol_root} ${isLong ? '>=' : '<='} ${t1Price.toFixed(2)}   (orderId=${t1OrderId})`);
  console.log(`  Stop exit:    SELL MKT when ${spec.ibkr_symbol_root} ${isLong ? '<=' : '>='} ${stopPrice.toFixed(2)}   (orderId=${stopOrderId})`);
  console.log(`  OCA group:    ${ocaGroup}   (one fills → the other auto-cancels)`);
  if (entryUnderlying != null) {
    const t1Dist = Math.abs(t1Price - entryUnderlying);
    const stopDist = Math.abs(entryUnderlying - stopPrice);
    const rr = stopDist > 0 ? (t1Dist / stopDist).toFixed(2) : '∞';
    console.log(`  R:R to T1:    ${rr}  (T1 ${t1Dist >= 0 ? '+' : ''}${t1Dist.toFixed(2)} / stop −${stopDist.toFixed(2)} from trigger)`);
  }
  console.log(`────────────────────────────────────────────────────────────────`);
}

// ─── Trailing-stop SELL on HK option (premium-trailing) ─────────────────────
/**
 * Places a single TRAIL SELL order on the option premium itself. IBKR tracks
 * the option's high-water mark server-side and trails the stop by trailAmount
 * (in option currency, HKD for HK options) below peak.
 *
 * Used INSTEAD OF placeHKOCABracketExits when trailing mode is enabled for
 * the instrument. Premium rises → stop rises. Premium falls trailAmount from
 * peak → exit at market.
 *
 * Worst-case loss at fill (if premium only drops): trailAmount × multiplier × qty.
 *
 * @param {object} args
 * @param {object} args.spec        — contracts.json primary entry (drives exchange/currency/multiplier)
 * @param {string} args.expiry      — YYYYMMDD
 * @param {number} args.strike
 * @param {string} args.right       — 'C' or 'P'
 * @param {number} args.qty
 * @param {number} args.trailAmount — option-premium dollars below peak (HKD)
 * @param {number} args.orderId
 * @param {boolean} [args.staged=false]
 * @param {string} [args.tradingClass]
 */
export function placeHKTrailingStop({
  ib, spec, expiry, strike, right, qty,
  trailAmount,
  orderId,
  staged = false,
  tradingClass,
}) {
  if (!Number.isFinite(trailAmount) || trailAmount <= 0) {
    throw new Error(`placeHKTrailingStop: trailAmount must be > 0 (got ${trailAmount})`);
  }
  if (!Number.isInteger(qty) || qty < 1) {
    throw new Error('placeHKTrailingStop: qty must be a positive integer');
  }
  if (!Number.isInteger(orderId)) {
    throw new Error('placeHKTrailingStop: orderId must be a pre-allocated integer');
  }

  const contract = buildOptionContract(spec, expiry, strike, right, { tradingClass });
  const trailOrder = {
    action: 'SELL',
    totalQuantity: qty,
    orderType: 'TRAIL',
    auxPrice: trailAmount,
    // triggerMethod: 1 = DOUBLE BID/ASK (explicit). Mirrors the root
    // ibkr_orders.mjs fix (2026-06-02): the default (method 0) tracked AND
    // triggered off the LAST traded price. On a thin 0DTE option the last goes
    // stale (minutes with no prints, last frozen above the live bid), so the
    // stop's high-water mark locked at peak_last−trail and never fired even as
    // the bid collapsed — the US AAPL 310P incident, closed manually. HK
    // single-stock option books are at least as illiquid, so force both the
    // trail and the trigger off the live quote (the bid we actually exit into).
    triggerMethod: 1,
    tif: 'DAY',
    transmit: !staged,
    firmQuoteOnly: false,
    eTradeOnly: false,
    orderRef: `TRAIL @ -${trailAmount.toFixed(2)} ${spec.currency || 'HKD'} from peak`,
  };
  ib.placeOrder(orderId, contract, trailOrder);
  return { orderId, trailOrder };
}

export function printHKTrailingSpec({
  instrumentKey, spec, direction, strike, right, qty, trailAmount, orderId,
}) {
  const rightLabel = right === 'C' ? 'CALL' : 'PUT';
  const ccy = spec.currency || 'HKD';
  const maxLoss = qty * trailAmount * Number(spec.multiplier);
  console.log(`\n────────────────────────────────────────────────────────────────`);
  console.log(`  TRAILING STOP — runner mode armed in TWS`);
  console.log(`────────────────────────────────────────────────────────────────`);
  console.log(`  Contract:     ${instrumentKey} ${strike} ${rightLabel} · ${qty} contract(s)`);
  console.log(`  Trail width:  ${trailAmount.toFixed(2)} ${ccy} below peak (option premium)`);
  console.log(`  Multiplier:   ×${spec.multiplier}`);
  console.log(`  Max loss:     ${maxLoss.toFixed(2)} ${ccy} (= ${trailAmount.toFixed(2)} × ${spec.multiplier} × ${qty}) — only if premium drops without first rising`);
  console.log(`  Behavior:     premium rises → stop rises  ·  premium falls ${trailAmount.toFixed(2)} ${ccy} from peak → exit at market`);
  console.log(`  orderId:      ${orderId}`);
  console.log(`────────────────────────────────────────────────────────────────`);
}

/**
 * Places a single FIXED STP SELL on the option premium at stopPrice (HKD).
 * No high-water mark — the stop never moves. Replaces placeHKTrailingStop
 * (2026-06-04): the trail failed to ratchet on cheap/fast 0DTE premium (US
 * SPY 753P case). Caller sizes stopPrice = optionMid × (1 − HK_STOP_PCT), 15%.
 * Market exit on triggerMethod=1 (live bid) — see placeHKTrailingStop note.
 * Worst-case loss at fill: (fill − stopPrice) × multiplier × qty.
 */
export function placeHKFixedStop({
  ib, spec, expiry, strike, right, qty,
  stopPrice,
  orderId,
  staged = false,
  tradingClass,
}) {
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
    throw new Error(`placeHKFixedStop: stopPrice must be > 0 (got ${stopPrice})`);
  }
  if (!Number.isInteger(qty) || qty < 1) {
    throw new Error('placeHKFixedStop: qty must be a positive integer');
  }
  if (!Number.isInteger(orderId)) {
    throw new Error('placeHKFixedStop: orderId must be a pre-allocated integer');
  }
  const contract = buildOptionContract(spec, expiry, strike, right, { tradingClass });
  const stopOrder = {
    action: 'SELL',
    totalQuantity: qty,
    orderType: 'STP',
    auxPrice: stopPrice,
    triggerMethod: 1,                  // double bid/ask — see placeHKTrailingStop note
    tif: 'DAY',
    transmit: !staged,
    firmQuoteOnly: false,
    eTradeOnly: false,
    orderRef: `FIXED STP @ ${stopPrice.toFixed(2)} ${spec.currency || 'HKD'}`,
  };
  ib.placeOrder(orderId, contract, stopOrder);
  return { orderId, stopOrder };
}

export function printHKFixedStopSpec({
  instrumentKey, spec, direction, strike, right, qty, stopPrice, fillBasis, orderId,
}) {
  const rightLabel = right === 'C' ? 'CALL' : 'PUT';
  const ccy = spec.currency || 'HKD';
  const hasBasis = Number.isFinite(fillBasis) && fillBasis > 0;
  const dist = hasBasis ? Math.max(0, fillBasis - stopPrice) : null;
  const pct = hasBasis ? (dist / fillBasis) * 100 : null;
  const maxLoss = dist != null ? dist * qty * Number(spec.multiplier) : null;
  console.log(`\n────────────────────────────────────────────────────────────────`);
  console.log(`  FIXED STOP — armed in TWS (no trailing)`);
  console.log(`────────────────────────────────────────────────────────────────`);
  console.log(`  Contract:     ${instrumentKey} ${strike} ${rightLabel} · ${qty} contract(s)`);
  if (hasBasis) console.log(`  Est. fill:    ~${fillBasis.toFixed(2)} ${ccy} (option mid)`);
  console.log(`  Stop price:   ${stopPrice.toFixed(2)} ${ccy}${pct != null ? `  (= −${dist.toFixed(2)} / ${pct.toFixed(0)}% below)` : ''}`);
  console.log(`  Multiplier:   ×${spec.multiplier}`);
  if (maxLoss != null) console.log(`  Max loss:     ${maxLoss.toFixed(2)} ${ccy} (= ${dist.toFixed(2)} × ${spec.multiplier} × ${qty})`);
  console.log(`  Trigger:      double bid/ask · MARKET exit on trigger · stop does NOT move`);
  console.log(`  Manage:       upside is yours to manage manually — this is the hard floor`);
  console.log(`  orderId:      ${orderId}`);
  console.log(`────────────────────────────────────────────────────────────────`);
}
