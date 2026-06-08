/**
 * option_chain.mjs — fetch option chain structure from IBKR paper TWS.
 *
 * Usage:  node option_chain.mjs [TICKER] [NEAR_EXPIRIES]
 *         node option_chain.mjs SPY
 *         node option_chain.mjs QQQ 10
 *
 * What it does:
 *   1. Resolve underlying stock contract (SPY / QQQ) → get conId
 *   2. Call reqSecDefOptParams to fetch chain parameters (strikes, expiries,
 *      exchanges, multipliers) — no quotes, no market data subscription needed
 *   3. Print nearest N expirations (flagging 0DTE) and strike range
 *   4. Disconnect
 *
 * Read-only. No orders. Safe to run anytime TWS is up.
 */
import { IBApi, EventName, SecType } from '@stoqey/ib';
import { IBKR_CONFIG, CLIENT_IDS, isInfoCode } from './ibkr_config.mjs';

const { host: HOST, port: PORT } = IBKR_CONFIG;
const CLIENT_ID = CLIENT_IDS.option_chain;

const ticker = (process.argv[2] || 'SPY').toUpperCase();
const expiriesLimit = parseInt(process.argv[3] || '8', 10);

const ib = new IBApi({ host: HOST, port: PORT, clientId: CLIENT_ID });

let underlyingConId = null;
const chain = {
  perExchange: new Map(),  // exchange → { multiplier, expirations: Set, strikes: Set, tradingClass }
  allExpirations: new Set(),
  allStrikes: new Set(),
};

const REQ_CONTRACT = 3001;
const REQ_OPT_PARAMS = 3002;

const timeout = setTimeout(() => {
  console.log('⏱ timeout — disconnecting');
  ib.disconnect();
  process.exit(1);
}, 30000);

ib.on(EventName.connected, () => {
  console.log(`✅ connected to TWS at ${HOST}:${PORT}  (clientId=${CLIENT_ID})`);
  console.log(`   resolving ${ticker} stock contract...`);
  ib.reqContractDetails(REQ_CONTRACT, {
    symbol: ticker,
    secType: SecType.STK,
    exchange: 'SMART',
    currency: 'USD',
  });
});

ib.on(EventName.contractDetails, (reqId, details) => {
  if (reqId !== REQ_CONTRACT) return;
  if (underlyingConId === null) {
    underlyingConId = details.contract.conId;
    const longName = details.longName || '';
    console.log(`   ${ticker} (${longName})  conId=${underlyingConId}  primaryExchange=${details.contract.primaryExchange || details.contract.exchange}`);
  }
});

ib.on(EventName.contractDetailsEnd, (reqId) => {
  if (reqId !== REQ_CONTRACT) return;
  if (!underlyingConId) {
    console.log(`   ❌ could not resolve ${ticker} — check ticker`);
    clearTimeout(timeout);
    ib.disconnect();
    setTimeout(() => process.exit(1), 200);
    return;
  }
  console.log(`   requesting option chain parameters...`);
  ib.reqSecDefOptParams(REQ_OPT_PARAMS, ticker, '', SecType.STK, underlyingConId);
});

ib.on(EventName.securityDefinitionOptionParameter,
  (reqId, exchange, undConId, tradingClass, multiplier, expirations, strikes) => {
    if (reqId !== REQ_OPT_PARAMS) return;
    if (!chain.perExchange.has(exchange)) {
      chain.perExchange.set(exchange, { multiplier, tradingClass, expirations: new Set(), strikes: new Set() });
    }
    const entry = chain.perExchange.get(exchange);
    for (const e of expirations) { entry.expirations.add(e); chain.allExpirations.add(e); }
    for (const s of strikes)     { entry.strikes.add(s);     chain.allStrikes.add(s); }
  });

ib.on(EventName.securityDefinitionOptionParameterEnd, (reqId) => {
  if (reqId !== REQ_OPT_PARAMS) return;
  printChain();
  clearTimeout(timeout);
  ib.disconnect();
  setTimeout(() => process.exit(0), 300);
});

function daysBetween(yyyymmdd, todayDate) {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  const target = Date.UTC(y, m, d);
  const today = Date.UTC(todayDate.getUTCFullYear(), todayDate.getUTCMonth(), todayDate.getUTCDate());
  return Math.round((target - today) / (24 * 3600 * 1000));
}

function printChain() {
  const now = new Date();
  console.log(`\n━━━ ${ticker} option chain (paper) ━━━`);
  console.log(`Exchanges carrying chain: ${[...chain.perExchange.keys()].join(', ')}`);

  // SMART is the aggregated routing exchange — most representative view
  const smart = chain.perExchange.get('SMART');
  if (!smart) {
    console.log(`\n(No SMART exchange found — showing global union)`);
  } else {
    console.log(`SMART multiplier:      ${smart.multiplier} (shares per contract)`);
    console.log(`SMART trading class:   ${smart.tradingClass}`);
  }

  const allExpiries = [...chain.allExpirations].sort();
  const allStrikes = [...chain.allStrikes].sort((a, b) => a - b);

  console.log(`\nTotal expirations: ${allExpiries.length}`);
  console.log(`Total strikes:     ${allStrikes.length}`);
  console.log(`Strike range:      ${allStrikes[0]} – ${allStrikes[allStrikes.length - 1]}`);

  console.log(`\nNearest ${expiriesLimit} expirations:`);
  const nearest = allExpiries.slice(0, expiriesLimit);
  for (const e of nearest) {
    const d = daysBetween(e, now);
    const pretty = `${e.slice(0, 4)}-${e.slice(4, 6)}-${e.slice(6, 8)}`;
    const tag = d === 0 ? '  ← 0DTE' : d < 0 ? '  (past)' : `  +${d}d`;
    console.log(`  ${pretty}  (${e})${tag}`);
  }

  // Show strikes bracketing a sample ATM price — user can see granularity (usually $1 for SPY/QQQ)
  const sample = allStrikes.length > 30 ? allStrikes.slice(Math.floor(allStrikes.length / 2) - 15, Math.floor(allStrikes.length / 2) + 15) : allStrikes;
  console.log(`\nStrike granularity (mid-range sample):`);
  console.log(`  ${sample.map(s => s.toFixed(2)).join(', ')}`);

  // Strike step (most common gap between adjacent strikes in the mid)
  if (sample.length > 2) {
    const gaps = {};
    for (let i = 1; i < sample.length; i++) {
      const g = +(sample[i] - sample[i - 1]).toFixed(2);
      gaps[g] = (gaps[g] || 0) + 1;
    }
    const mostCommon = Object.entries(gaps).sort((a, b) => b[1] - a[1])[0];
    console.log(`  Most common strike gap in sample: $${mostCommon[0]}`);
  }
}

ib.on(EventName.error, (err, code, reqId) => {
  if (isInfoCode(code)) return;
  console.log(`   error [code=${code}  reqId=${reqId}]  ${err?.message || err}`);
});

ib.connect();
