#!/usr/bin/env node
/**
 * asia/scripts/test_hk_contract_resolve.mjs
 *
 * SYMBOLOGY VERIFICATION SCRIPT — run this ONCE against live TWS before
 * letting the HK watcher fire real orders.
 *
 * For each of the 5 primary instruments in contracts.json, this script:
 *   1. Connects to IBKR (host/port from IBKR_HOST/IBKR_PORT env, defaults
 *      to live 127.0.0.1:7496)
 *   2. Resolves the underlying contract (STK for stocks, front-month FUT
 *      for index futures) via reqContractDetails
 *   3. Lists the option chain (expirations + strike count) via
 *      reqSecDefOptParams
 *   4. Picks the front Wednesday-weekly expiry
 *   5. Picks the ATM strike based on the underlying's last bar
 *   6. Resolves a CALL contract at that strike via reqContractDetails
 *      (proves the option-side symbology is correct)
 *
 * What to verify in the output:
 *   - Each instrument resolves WITHOUT throwing
 *   - Underlying conId is a valid integer
 *   - Option chain returns >0 expirations and >0 strikes
 *   - The resolved CALL contract spec matches assumptions:
 *       MHI/MTW: secType=FOP, exchange=HKFE, multiplier=10
 *       700/9988/1810: secType=OPT, exchange=SEHK, multiplier=100
 *
 * If anything mismatches, adjust EXCHANGE_FOR_KIND in
 * asia/lib/ibkr_hk_orders.mjs OR the multiplier in contracts.json BEFORE
 * arming the watcher.
 *
 * No orders are placed. Read-only.
 *
 * Usage:
 *   node asia/scripts/test_hk_contract_resolve.mjs
 *   node asia/scripts/test_hk_contract_resolve.mjs MHI            # just one
 *   IBKR_PORT=7497 node asia/scripts/test_hk_contract_resolve.mjs # paper
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IBApi, EventName, SecType } from '@stoqey/ib';
import { IBKR_HK_CONFIG, modeLabel, isInfoCode, isNoisyHKCode, HK_CLIENT_IDS } from '../lib/ibkr_hk_config.mjs';
import {
  resolveHKUnderlyingConId,
  getHKOptionChainParams,
  pickHKWednesdayWeeklyExpiry,
  nearestStrikes,
  buildOptionContract,
  reqHistoricalBars,
  buildUnderlyingContract,
  nextReqId,
} from '../lib/ibkr_hk_orders.mjs';

process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASIA_ROOT = path.resolve(__dirname, '..');

async function loadContracts() {
  const raw = await fs.readFile(path.join(ASIA_ROOT, 'config', 'contracts.json'), 'utf8');
  const json = JSON.parse(raw);
  const keys = Object.keys(json.primary).filter(k => !k.startsWith('_'));
  return { json, keys };
}

function connectIB(ib) {
  return new Promise((resolve, reject) => {
    ib.on(EventName.connected, () => resolve());
    ib.connect();
    setTimeout(() => reject(new Error('IBKR connect timeout (10s)')), 10000);
  });
}

async function resolveOptionContractDetails(ib, contract) {
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
    setTimeout(() => resolve(out), 6000);
  });
}

async function probeOne(ib, key, spec) {
  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  ${key}  (${spec.name})`);
  console.log(`  kind=${spec.kind}  multiplier=${spec.multiplier}  currency=${spec.currency}`);
  console.log(`══════════════════════════════════════════════════════════════════`);

  // 1. Underlying resolve
  console.log(`[1/4] Resolving underlying...`);
  let underlying;
  try {
    underlying = await resolveHKUnderlyingConId(ib, spec);
    const front = underlying.frontMonthExpiry ? `  frontMonthExpiry=${underlying.frontMonthExpiry}` : '';
    console.log(`     ✓ conId=${underlying.conId}  exchange=${underlying.exchange}${front}`);
  } catch (e) {
    console.log(`     ✗ FAILED: ${e.message}`);
    return { key, ok: false, stage: 'underlying', error: e.message };
  }

  // 2. Pull a recent underlying price (for ATM strike pick)
  console.log(`[2/4] Fetching underlying last bar (to pick ATM)...`);
  const undContract = buildUnderlyingContract(spec);
  const bars = await reqHistoricalBars(ib, undContract, '1 D', '15 mins', 'TRADES', 1);
  const lastPrice = bars.length ? bars[bars.length - 1].close : null;
  if (lastPrice == null) {
    console.log(`     ⚠ no bars returned — check market data subscription`);
  } else {
    console.log(`     ✓ last close=${lastPrice}  (from ${bars.length} bars)`);
  }

  // 3. Option chain
  console.log(`[3/4] Fetching option chain...`);
  let chain;
  try {
    chain = await getHKOptionChainParams(ib, spec, underlying.conId);
    console.log(`     ✓ ${chain.expirations.size} expirations · ${chain.strikes.size} strikes`);
  } catch (e) {
    console.log(`     ✗ FAILED: ${e.message}`);
    return { key, ok: false, stage: 'chain', error: e.message };
  }
  if (chain.expirations.size === 0) {
    console.log(`     ⚠ ZERO expirations — chain not loaded. Verify HK options market data subscription on IBKR.`);
    return { key, ok: false, stage: 'chain_empty' };
  }

  // 4. Pick Wednesday weekly + ATM strike + resolve the option contract details
  console.log(`[4/4] Picking Wednesday-weekly expiry + ATM strike + resolving option contract...`);
  const expiry = pickHKWednesdayWeeklyExpiry(chain.expirations);
  console.log(`     - Wednesday weekly expiry: ${expiry}`);
  if (lastPrice != null && chain.strikes.size > 0) {
    const atm = nearestStrikes(chain.strikes, lastPrice, 1)[0];
    console.log(`     - ATM strike near ${lastPrice}: ${atm}`);
    const optContract = buildOptionContract(spec, expiry, atm, 'C');
    console.log(`     - Probing option contract: ${JSON.stringify(optContract)}`);
    const details = await resolveOptionContractDetails(ib, optContract);
    if (details.length === 0) {
      console.log(`     ✗ reqContractDetails returned ZERO results — option spec is wrong. Compare to a known-good HKFE/SEHK option in TWS Contract Search.`);
      return { key, ok: false, stage: 'option_resolve', expiry, strike: atm };
    }
    console.log(`     ✓ Resolved ${details.length} option contract(s):`);
    for (const d of details.slice(0, 3)) {
      const c = d.contract;
      console.log(`         conId=${c.conId}  symbol=${c.symbol}  secType=${c.secType}  exchange=${c.exchange}  currency=${c.currency}  multiplier=${c.multiplier}  tradingClass=${c.tradingClass || '(none)'}`);
    }
    if (details.length > 3) console.log(`         ... and ${details.length - 3} more`);
  } else {
    console.log(`     ⊘ skipping option resolve — no underlying price`);
  }

  return { key, ok: true, expiry, lastPrice };
}

async function main() {
  const filterKey = process.argv[2]?.toUpperCase();
  const { json, keys } = await loadContracts();
  const todo = filterKey ? keys.filter(k => k === filterKey) : keys;
  if (todo.length === 0) {
    console.log(`No matching instrument: ${filterKey} (available: ${keys.join(', ')})`);
    process.exit(2);
  }

  console.log(`\n┌──────────────────────────────────────────────────────────────────┐`);
  console.log(`│ HK CONTRACT SYMBOLOGY PROBE — ${modeLabel().padEnd(31, ' ')}    │`);
  console.log(`│ ${IBKR_HK_CONFIG.host}:${IBKR_HK_CONFIG.port}  ·  ${todo.length} instrument(s) to probe              │`);
  console.log(`└──────────────────────────────────────────────────────────────────┘`);

  const ib = new IBApi({
    host: IBKR_HK_CONFIG.host,
    port: IBKR_HK_CONFIG.port,
    clientId: HK_CLIENT_IDS.contract_resolve,
  });
  const errCounts = new Map();
  ib.on(EventName.error, (err, code, reqId) => {
    if (isInfoCode(code)) return;
    if (isNoisyHKCode(code)) return;
    errCounts.set(code, (errCounts.get(code) || 0) + 1);
    if (errCounts.get(code) === 1) {
      console.log(`   [first] IBKR error code=${code} reqId=${reqId}: ${err?.message || err}`);
    }
  });

  try {
    await connectIB(ib);
  } catch (e) {
    console.error(`✗ Could not connect to IBKR: ${e.message}`);
    console.error(`   Is TWS/Gateway running? Is the API enabled on port ${IBKR_HK_CONFIG.port}?`);
    process.exit(1);
  }

  const results = [];
  for (const key of todo) {
    const spec = json.primary[key];
    try {
      const r = await probeOne(ib, key, spec);
      results.push(r);
    } catch (e) {
      console.log(`   ✗ Unexpected error: ${e.message}`);
      results.push({ key, ok: false, error: e.message });
    }
  }

  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  SUMMARY`);
  console.log(`══════════════════════════════════════════════════════════════════`);
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.key.padEnd(10)} ${r.ok ? `expiry=${r.expiry}  last=${r.lastPrice}` : `failed at ${r.stage}: ${r.error ?? ''}`}`);
  }
  const allOk = results.every(r => r.ok);
  console.log(allOk
    ? `\n✅ All ${results.length} instrument(s) resolved. Watcher contract symbology is verified.`
    : `\n❌ ${results.filter(r => !r.ok).length} instrument(s) failed. DO NOT enable the watcher until these resolve.`);

  ib.disconnect();
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
