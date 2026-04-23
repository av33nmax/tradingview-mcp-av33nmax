/**
 * test_ibkr_connect.mjs — read-only sanity check against paper TWS.
 * Connects, asks for account summary, prints results, disconnects.
 * NO orders placed.
 */
import { IBApi, EventName } from '@stoqey/ib';

const HOST = '192.168.18.35';
const PORT = 7497;            // 7497 = paper, 7496 = live
const CLIENT_ID = 42;         // arbitrary unique number for this connection

const ib = new IBApi({ host: HOST, port: PORT, clientId: CLIENT_ID });

const REQ_ACCOUNT = 9001;
const summary = {};

let timeout = setTimeout(() => {
  console.log('⏱  timeout — disconnecting');
  ib.disconnect();
  process.exit(1);
}, 15000);

ib.on(EventName.connected, () => {
  console.log(`✅ connected to TWS at ${HOST}:${PORT}  (clientId=${CLIENT_ID})`);
  console.log('   requesting account summary...');
  ib.reqAccountSummary(REQ_ACCOUNT, 'All', 'NetLiquidation,AvailableFunds,BuyingPower,TotalCashValue,GrossPositionValue');
});

ib.on(EventName.error, (err, code, reqId) => {
  // IBKR "errors" include informational messages (code 2104/2106/2158 = connectivity info). Not fatal.
  const msg = err?.message || String(err);
  if (code && code >= 2100 && code <= 2200) {
    console.log(`   ℹ info  [${code}]  ${msg}`);
  } else {
    console.log(`   ⚠ error [code=${code}  reqId=${reqId}]  ${msg}`);
  }
});

ib.on(EventName.accountSummary, (reqId, account, tag, value, currency) => {
  if (!summary[account]) summary[account] = {};
  summary[account][tag] = `${value} ${currency}`;
});

ib.on(EventName.accountSummaryEnd, () => {
  console.log('\n── Account summary ──');
  for (const [account, tags] of Object.entries(summary)) {
    console.log(`Account ${account}:`);
    for (const [tag, v] of Object.entries(tags)) console.log(`  ${tag.padEnd(22)} ${v}`);
  }
  ib.reqCurrentTime();
});

ib.on(EventName.currentTime, (t) => {
  console.log(`\nServer time: ${new Date(t * 1000).toISOString()}`);
  console.log('\n✅ test complete — disconnecting');
  clearTimeout(timeout);
  ib.disconnect();
  setTimeout(() => process.exit(0), 300);
});

ib.on(EventName.disconnected, () => {
  console.log('   connection closed');
});

ib.connect();
