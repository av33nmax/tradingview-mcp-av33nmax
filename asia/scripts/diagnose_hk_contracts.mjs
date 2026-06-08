#!/usr/bin/env node
/**
 * asia/scripts/diagnose_hk_contracts.mjs
 *
 * DEEP DIAGNOSTIC — investigates the 4 instruments that test_hk_contract_resolve
 * failed on (MHI, MTW, ALIBABA, XIAOMI). Goes beyond pass/fail to capture
 * exactly what IBKR returns, so we can patch contract specs from data.
 *
 * For futures-option underlyings (MHI/MTW): tries multiple underlying spec
 * variants (FUT/IND, different symbols/exchanges) until one returns details.
 *
 * For single-stock options (ALIBABA/XIAOMI): captures ALL (tradingClass,
 * exchange, multiplier, expirations) tuples from reqSecDefOptParams, then
 * probes a sample option contract for each tradingClass.
 *
 * Read-only. No orders placed.
 */

import { IBApi, EventName, SecType } from '@stoqey/ib';
import {
  IBKR_HK_CONFIG, modeLabel, isInfoCode, isNoisyHKCode, HK_CLIENT_IDS,
} from '../lib/ibkr_hk_config.mjs';

process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });

let _reqIdCounter = 70000;
function nextReqId() { return _reqIdCounter++; }

const ib = new IBApi({
  host: IBKR_HK_CONFIG.host,
  port: IBKR_HK_CONFIG.port,
  clientId: 71,  // dedicated diagnostic ID
});

const errCounts = new Map();
ib.on(EventName.error, (err, code, reqId) => {
  if (isInfoCode(code)) return;
  if (isNoisyHKCode(code)) return;
  errCounts.set(code, (errCounts.get(code) || 0) + 1);
  if (errCounts.get(code) <= 3) {
    console.log(`   [IBKR err code=${code} reqId=${reqId}]: ${err?.message || err}`);
  }
});

function connectIB() {
  return new Promise((resolve, reject) => {
    ib.on(EventName.connected, () => resolve());
    ib.connect();
    setTimeout(() => reject(new Error('IBKR connect timeout (10s)')), 10000);
  });
}

async function reqContractDetailsAll(contract, label, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const reqId = nextReqId();
    const out = [];
    const onD = (id, d) => { if (id === reqId) out.push(d); };
    const onE = (id) => {
      if (id !== reqId) return;
      ib.off(EventName.contractDetails, onD);
      ib.off(EventName.contractDetailsEnd, onE);
      resolve(out);
    };
    ib.on(EventName.contractDetails, onD);
    ib.on(EventName.contractDetailsEnd, onE);
    ib.reqContractDetails(reqId, contract);
    setTimeout(() => resolve(out), timeoutMs);
  });
}

/**
 * Full chain dump — captures all (exchange, tradingClass, multiplier,
 * expirations[], strikes[]) tuples. Standard getHKOptionChainParams throws
 * away tradingClass; this preserves it for diagnostic.
 */
async function reqOptionChainFull(symbol, undSecType, undConId) {
  return new Promise((resolve) => {
    const reqId = nextReqId();
    const sets = [];  // [{exchange, undConId, tradingClass, multiplier, exps, strks}]
    const onParam = (id, exchange, ucid, tradingClass, multiplier, exps, strks) => {
      if (id !== reqId) return;
      sets.push({
        exchange, undConId: ucid, tradingClass, multiplier,
        exps: [...exps].sort(), strks: [...strks].sort((a, b) => a - b),
      });
    };
    const onEnd = (id) => {
      if (id !== reqId) return;
      ib.off(EventName.securityDefinitionOptionParameter, onParam);
      ib.off(EventName.securityDefinitionOptionParameterEnd, onEnd);
      resolve(sets);
    };
    ib.on(EventName.securityDefinitionOptionParameter, onParam);
    ib.on(EventName.securityDefinitionOptionParameterEnd, onEnd);
    ib.reqSecDefOptParams(reqId, symbol, '', undSecType, undConId);
    setTimeout(() => resolve(sets), 8000);
  });
}

function todayYYYYMMDD() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()).replaceAll('-', '');
}

// ─── Probe targets ─────────────────────────────────────────────────────────
async function probeFutures(label, variants) {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║ ${label.padEnd(60)} ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);
  let resolvedFut = null;

  for (const v of variants) {
    console.log(`\n[A] reqContractDetails: ${JSON.stringify(v)}`);
    const details = await reqContractDetailsAll(v, label, 4000);
    if (details.length === 0) {
      console.log(`     ✗ ZERO results`);
      continue;
    }
    console.log(`     ✓ ${details.length} contract(s):`);
    for (const d of details.slice(0, 8)) {
      const c = d.contract;
      console.log(`         conId=${c.conId}  symbol=${c.symbol}  secType=${c.secType}  exch=${c.exchange}/${c.primaryExch || '-'}  ccy=${c.currency}  expiry=${c.lastTradeDateOrContractMonth || '-'}  mult=${c.multiplier || '-'}  tradingClass=${c.tradingClass || '-'}  localSymbol=${c.localSymbol || '-'}`);
    }
    if (details.length > 8) console.log(`         ... +${details.length - 8} more`);
    if (!resolvedFut) {
      // Pick front-month (nearest expiry >= today)
      const today = todayYYYYMMDD();
      const sorted = details
        .map(d => ({ c: d.contract, exp: d.contract.lastTradeDateOrContractMonth || '99999999' }))
        .sort((a, b) => a.exp.localeCompare(b.exp));
      const front = sorted.find(s => s.exp >= today) || sorted[0];
      resolvedFut = front.c;
      console.log(`     → using front-month: conId=${front.c.conId} expiry=${front.exp}`);
    }
  }

  if (!resolvedFut) {
    console.log(`\n   ⚠ No underlying contract found for ${label}. Skipping chain query.`);
    return;
  }

  // Try multiple chain query variants
  const chainVariants = [
    { symbol: resolvedFut.symbol, undSecType: resolvedFut.secType, undConId: resolvedFut.conId, note: 'using resolved FUT conId' },
    { symbol: resolvedFut.symbol, undSecType: 'IND', undConId: 0, note: 'as IND with undConId=0' },
    { symbol: resolvedFut.symbol, undSecType: 'FUT', undConId: 0, note: 'as FUT with undConId=0' },
  ];
  for (const cv of chainVariants) {
    console.log(`\n[B] reqSecDefOptParams: symbol=${cv.symbol} undSecType=${cv.undSecType} undConId=${cv.undConId}  (${cv.note})`);
    const sets = await reqOptionChainFull(cv.symbol, cv.undSecType, cv.undConId);
    if (sets.length === 0) {
      console.log(`     ✗ ZERO param sets`);
      continue;
    }
    console.log(`     ✓ ${sets.length} param set(s):`);
    for (const s of sets) {
      console.log(`         exch=${s.exchange}  tradingClass=${s.tradingClass}  mult=${s.multiplier}  ${s.exps.length} expirations  ${s.strks.length} strikes`);
      if (s.exps.length > 0) {
        console.log(`           expirations sample: ${s.exps.slice(0, 6).join(', ')}${s.exps.length > 6 ? ' ...' : ''}`);
      }
    }
    break; // first success is enough
  }
}

async function probeStock(label, symbol) {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║ ${label.padEnd(60)} ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);

  // 1. Resolve STK
  console.log(`\n[A] reqContractDetails STK symbol=${symbol}`);
  const stkDetails = await reqContractDetailsAll({
    symbol, secType: 'STK', exchange: 'SEHK', currency: 'HKD',
  }, label, 4000);
  if (stkDetails.length === 0) {
    console.log(`     ✗ no STK details — symbol or exchange wrong`);
    return;
  }
  const stk = stkDetails[0].contract;
  console.log(`     ✓ conId=${stk.conId} primaryExch=${stk.primaryExch} localSymbol=${stk.localSymbol}`);

  // 2. Full chain dump
  console.log(`\n[B] reqSecDefOptParams symbol=${symbol} undSecType=STK undConId=${stk.conId}`);
  const sets = await reqOptionChainFull(symbol, 'STK', stk.conId);
  if (sets.length === 0) {
    console.log(`     ✗ ZERO chain param sets — no options available?`);
    return;
  }
  console.log(`     ✓ ${sets.length} param set(s):`);
  for (const s of sets) {
    console.log(`         exch=${s.exchange}  tradingClass=${s.tradingClass}  mult=${s.multiplier}  ${s.exps.length} expirations  ${s.strks.length} strikes`);
    if (s.exps.length > 0) {
      console.log(`           sample exps: ${s.exps.slice(0, 6).join(', ')}${s.exps.length > 6 ? ' ...' : ''}`);
    }
  }

  // 3. Probe option with explicit tradingClass — pick first set with expirations
  const liveSets = sets.filter(s => s.exps.length > 0 && s.strks.length > 0);
  for (const s of liveSets) {
    const targetExpiry = s.exps.find(e => e >= todayYYYYMMDD()) || s.exps[0];
    const closeStrike = s.strks[Math.floor(s.strks.length / 2)]; // middle as ATM-ish
    console.log(`\n[C] Probe OPT: symbol=${symbol} expiry=${targetExpiry} strike=${closeStrike} right=C exchange=${s.exchange} mult=${s.multiplier} tradingClass=${s.tradingClass}`);
    const optProbe = await reqContractDetailsAll({
      symbol, secType: 'OPT', exchange: s.exchange, currency: 'HKD',
      lastTradeDateOrContractMonth: targetExpiry, strike: closeStrike, right: 'C',
      multiplier: String(s.multiplier), tradingClass: s.tradingClass,
    }, label, 4000);
    if (optProbe.length === 0) {
      console.log(`     ✗ ZERO results — this tradingClass doesn't work at this strike/expiry`);
    } else {
      console.log(`     ✓ ${optProbe.length} option(s) resolved:`);
      for (const od of optProbe.slice(0, 3)) {
        const c = od.contract;
        console.log(`         conId=${c.conId}  exch=${c.exchange}  mult=${c.multiplier}  tradingClass=${c.tradingClass}  localSymbol=${c.localSymbol}`);
      }
    }
  }
}

async function main() {
  console.log(`\n┌──────────────────────────────────────────────────────────────────┐`);
  console.log(`│ HK CONTRACT DIAGNOSTIC — ${modeLabel().padEnd(31, ' ')}                │`);
  console.log(`│ ${IBKR_HK_CONFIG.host}:${IBKR_HK_CONFIG.port}                                            │`);
  console.log(`└──────────────────────────────────────────────────────────────────┘`);

  try { await connectIB(); console.log('✓ IBKR connected'); }
  catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }

  await probeFutures('MHI — Mini-HSI futures options', [
    { symbol: 'MHI', secType: 'FUT', exchange: 'HKFE', currency: 'HKD' },
    { symbol: 'MHI', secType: 'FUT', exchange: 'HKFE' },  // no currency
    { symbol: 'HSI', secType: 'IND', exchange: 'HKFE', currency: 'HKD' },
  ]);

  await probeFutures('MTW — Mini-HSTECH futures options', [
    { symbol: 'MTW', secType: 'FUT', exchange: 'HKFE', currency: 'HKD' },
    { symbol: 'MTW', secType: 'FUT', exchange: 'HKFE' },
    { symbol: 'MCH', secType: 'FUT', exchange: 'HKFE', currency: 'HKD' },  // possible alt symbol
    { symbol: 'HSTECH', secType: 'IND', exchange: 'HKFE', currency: 'HKD' },
    { symbol: 'HTI', secType: 'FUT', exchange: 'HKFE', currency: 'HKD' },  // HSI tech index futures alt
  ]);

  await probeStock('ALIBABA — 9988.HK', '9988');
  await probeStock('XIAOMI — 1810.HK', '1810');

  console.log('\n──────────────────────────────────────────────────────────────────');
  console.log('Done. Use the dumped tradingClass + exchange + multiplier values to');
  console.log('patch asia/lib/ibkr_hk_orders.mjs (per-instrument tradingClass map)');
  console.log('and asia/config/contracts.json (correct symbols/multipliers).');
  console.log('──────────────────────────────────────────────────────────────────\n');

  ib.disconnect();
  process.exit(0);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
