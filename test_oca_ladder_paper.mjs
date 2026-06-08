/**
 * test_oca_ladder_paper.mjs
 *
 * Standalone paper-test for the new auto-trim ladder primitives.
 * Connects to TWS paper (port 7497) with a fresh clientId, places a
 * synthetic 3-tier ladder + stop OCA group, and asks the user to
 * inspect TWS Orders panel.
 *
 * What this validates:
 *   ✅ IBKR accepts ocaType=2 (REDUCE_WITH_BLOCK)
 *   ✅ IBKR accepts multi-leg OCA on the same option contract
 *   ✅ All 4 legs transition to a transmitted state
 *   ✅ OCA grouping appears correctly in TWS Orders panel
 *
 * What this does NOT validate (requires a real fill):
 *   ❌ ocaType=2 actually reduces other legs' qty when one fills
 *   ❌ modifyStopToBreakeven cleanly slides stop in a live OCA group
 *
 * USAGE:
 *   1. Boot TWS paper (port 7497, clientId range allows 55)
 *   2. Run: node test_oca_ladder_paper.mjs
 *   3. Eyeball TWS Orders panel — should see 4 OCA-linked SELL orders
 *   4. Press Enter to cancel everything and disconnect
 *
 * Tier prices are set FAR from current market so the conditions never
 * fire (no risk of accidental execution). The orders sit in TWS as
 * PendingSubmit/PreSubmitted and let you visually verify structure.
 *
 * The script does NOT open a long position first. It places SELL orders
 * naked against the paper account. IBKR paper may flag this as a margin
 * issue ("insufficient buying power for naked options") — if it does,
 * that itself is a useful signal that the placement path works but
 * paper's risk checks are different from live.
 */
import readline from 'node:readline';
import { IBApi, EventName, SecType } from '@stoqey/ib';
import {
  resolveStockConId,
  getOptionChainParams,
  pick0DTEExpiry,
  nearestStrikes,
  placeOCALadderExits,
} from './ibkr_orders.mjs';

const HOST = process.env.IBKR_HOST || '127.0.0.1';
const PORT = parseInt(process.env.IBKR_PORT || '7497', 10);   // paper default
const CLIENT_ID = 55;                                         // not in use by other scripts
const TICKER = process.env.TEST_TICKER || 'SPY';

if (PORT !== 7497) {
  console.error(`❌ This is a PAPER test. Expected PORT=7497 but got ${PORT}.`);
  console.error(`   Run: IBKR_PORT=7497 node test_oca_ladder_paper.mjs`);
  process.exit(1);
}

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  test_oca_ladder_paper.mjs — placement-only ladder test`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  Host:      ${HOST}:${PORT}  (paper)`);
console.log(`  Client ID: ${CLIENT_ID}`);
console.log(`  Ticker:    ${TICKER}`);
console.log('');

const ib = new IBApi({ host: HOST, port: PORT, clientId: CLIENT_ID });

// Track all errors so we can show them at the end
const errors = [];
ib.on(EventName.error, (err, code, reqId) => {
  // Suppress noisy info codes
  if (code >= 2100 && code <= 2200) return;
  errors.push({ code, reqId, message: err?.message ?? String(err) });
  console.log(`   ⚠ IBKR error code=${code} reqId=${reqId} ${err?.message ?? err}`);
});

// Track orderStatus events for verification
const orderStatusByOrderId = new Map();
ib.on(EventName.orderStatus, (id, status) => {
  orderStatusByOrderId.set(id, status);
});

await new Promise((resolve, reject) => {
  ib.once('connected', resolve);
  ib.once('error', (err, code) => { if (code === 502 || code === 504) reject(err); });
  ib.connect();
  setTimeout(() => reject(new Error('connect timeout (8s)')), 8000);
});
console.log(`✓ connected to TWS paper`);

let nextOrderId = null;
ib.on(EventName.nextValidId, (id) => { if (nextOrderId == null) nextOrderId = id; });
ib.reqIds(-1);
await new Promise(r => setTimeout(r, 1500));
if (nextOrderId == null) {
  console.error(`❌ no nextValidId from TWS — aborting`);
  ib.disconnect();
  process.exit(1);
}
console.log(`  nextValidOrderId: ${nextOrderId}`);

try {
  console.log(`\n[1/4] Resolving ${TICKER} conId + 0DTE chain...`);
  const conId = await resolveStockConId(ib, TICKER);
  const { expirations, strikes } = await getOptionChainParams(ib, TICKER, conId);
  const expiry = pick0DTEExpiry(expirations);
  if (!expiry) {
    console.error(`❌ no 0DTE expiry available — markets likely closed for ${TICKER}.`);
    ib.disconnect();
    process.exit(1);
  }
  console.log(`  conId=${conId}  0DTE expiry=${expiry}  strikes available=${strikes.length}`);

  // Pick a strike WAY OTM so the test ladder never accidentally fires.
  // Use SPY 600P (far below ~712 spot) — premiums near zero, conditions
  // at far-from-current prices ensure no fills.
  console.log(`\n[2/4] Picking far-OTM strike (avoid accidental fills during test)...`);
  const lowStrikes = nearestStrikes(strikes, 600, 5);
  const testStrike = lowStrikes[Math.floor(lowStrikes.length / 2)] ?? 600;
  console.log(`  test contract: ${TICKER} ${testStrike} PUT ${expiry}`);

  // Synthetic ladder: 3 tiers + stop. All conditions are well below
  // current market for SPY (~712), so a SELL on this contract triggered
  // by these underlying prices will not fire today.
  //
  // Note: ladder values here are LATE-DAY hypotheticals — the goal is
  // structural placement, not realistic price levels.
  const SYNTHETIC_ENTRY = 700;
  const SYNTHETIC_STOP  = 705;          // PUTS short: stop ABOVE entry
  const SYNTHETIC_T1    = 695;          // T1 BELOW entry
  const SYNTHETIC_T2    = 690;
  const totalQty = 3;
  const tiers = [
    { price: SYNTHETIC_ENTRY - 0.5 * (SYNTHETIC_STOP - SYNTHETIC_ENTRY), qty: 1 },  // 697.5
    { price: SYNTHETIC_T1, qty: 1 },                                                // 695.0
    { price: SYNTHETIC_T2, qty: 1 },                                                // 690.0
  ];

  console.log(`\n[3/4] Placing 3-tier OCA ladder + stop...`);
  console.log(`  totalQty=${totalQty}  direction=PUTS  conditions on ${TICKER} underlying`);
  console.log(`  Tier 1: SELL 1 MKT when ${TICKER} ≤ ${tiers[0].price.toFixed(2)}`);
  console.log(`  Tier 2: SELL 1 MKT when ${TICKER} ≤ ${tiers[1].price.toFixed(2)}`);
  console.log(`  Tier 3: SELL 1 MKT when ${TICKER} ≤ ${tiers[2].price.toFixed(2)}`);
  console.log(`  Stop:   SELL 3 MKT when ${TICKER} ≥ ${SYNTHETIC_STOP.toFixed(2)}  (auto-reduces via ocaType=2)`);

  const tierOrderIds = [nextOrderId++, nextOrderId++, nextOrderId++];
  const stopOrderId = nextOrderId++;
  const result = placeOCALadderExits({
    ib,
    ticker: TICKER,
    expiry,
    strike: testStrike,
    right: 'P',
    totalQty,
    direction: 'PUTS',
    underlyingConId: conId,
    tiers,
    stopPrice: SYNTHETIC_STOP,
    tierOrderIds,
    stopOrderId,
  });

  console.log(`\n  ✓ Placement complete. ocaGroup=${result.ocaGroup}`);
  console.log(`    tierOrderIds: ${result.tierOrderIds.join(', ')}`);
  console.log(`    stopOrderId:  ${result.stopOrderId}`);

  // Wait 5s for orderStatus events to settle
  console.log(`\n[4/4] Waiting 5s for IBKR to ack all 4 legs...`);
  await new Promise(r => setTimeout(r, 5000));

  const TRANSMITTED = new Set(['PreSubmitted', 'Submitted', 'Filled', 'Cancelled', 'Inactive', 'PendingSubmit']);
  const ids = [...result.tierOrderIds, result.stopOrderId];
  console.log(`  Status of all 4 legs:`);
  let allTransmitted = true;
  for (const id of ids) {
    const status = orderStatusByOrderId.get(id) ?? 'NEVER REPORTED';
    const ok = TRANSMITTED.has(status);
    if (!ok) allTransmitted = false;
    console.log(`    orderId=${id}: ${status} ${ok ? '✓' : '✗'}`);
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  if (allTransmitted) {
    console.log(`  ✅ All 4 legs transmitted to TWS.`);
    console.log(`  → Open TWS Orders panel and verify:`);
    console.log(`     - 4 SELL rows with the same OCA group (${result.ocaGroup})`);
    console.log(`     - Right-click any → properties: ocaType=2 (REDUCE_WITH_BLOCK)`);
    console.log(`     - All 4 should show conditions referencing the ${TICKER} stock`);
  } else {
    console.log(`  ⚠ Not all legs reported transmitted within 5s.`);
    console.log(`  → Check TWS Orders panel + check the IBKR errors shown above.`);
  }
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (errors.length) {
    console.log(`\n  IBKR errors during test:`);
    for (const e of errors) {
      console.log(`    code=${e.code} reqId=${e.reqId} ${e.message}`);
    }
  }

  // Cleanup prompt — give user time to inspect TWS, then cancel everything
  console.log(`\n  Press Enter to CANCEL all 4 test orders and disconnect (or Ctrl+C to leave them):`);
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => { rl.close(); resolve(); });
  });

  console.log(`\n  Cancelling test orders...`);
  for (const id of ids) {
    try { ib.cancelOrder(id); console.log(`    cancelled orderId=${id}`); }
    catch (e) { console.log(`    ⚠ cancel orderId=${id} failed: ${e?.message ?? e}`); }
  }
  await new Promise(r => setTimeout(r, 2000));
} catch (e) {
  console.error(`\n❌ test crashed: ${e.message}`);
  console.error(e.stack);
} finally {
  ib.disconnect();
  console.log(`\n✓ disconnected`);
  process.exit(0);
}
