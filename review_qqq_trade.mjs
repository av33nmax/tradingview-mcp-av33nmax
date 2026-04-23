import CDP from 'chrome-remote-interface';
import fs from 'node:fs';

const resp = await fetch('http://localhost:9222/json/list');
const targets = await resp.json();
const tab = targets.find(t => t.type === 'page' && t.url.includes('/chart/o6Tc3OIX'));
if (!tab) { console.error('QQQ tab not found'); process.exit(1); }

const c = await CDP({ host: 'localhost', port: 9222, target: tab.id });
await c.Runtime.enable();
await c.Page?.enable?.();
await c.Page?.bringToFront?.().catch(() => {});

async function run(expr) {
  const r = await c.Runtime.evaluate({ expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

// Focus pane 1 (15m) to pull intraday action
await run(`
  (function() {
    var w = window.TradingViewApi._chartWidgetCollection.getAll()[1];
    if (w && w._mainDiv) w._mainDiv.click();
  })()
`);
await new Promise(r => setTimeout(r, 800));

// Current state
const state = await run(`
  (function() {
    var c = window.TradingViewApi._activeChartWidgetWV.value();
    var bars = c._chartWidget.model().mainSeries().bars();
    var last = bars.valueAt(bars.lastIndex());
    return { sym: c.symbol(), res: c.resolution(), lastPrice: last ? last[4] : null, lastTime: last ? last[0] : null, barCount: bars.lastIndex() - bars.firstIndex() + 1 };
  })()
`);
console.log(`Chart: ${state.sym} @ ${state.res}m  |  bars: ${state.barCount}  |  last=${state.lastPrice}  (t=${new Date(state.lastTime * 1000).toISOString()})`);

// Pull today's 5m bars (switch pane temporarily to 5m for granularity)
await run(`window.TradingViewApi._activeChartWidgetWV.value().setResolution('5')`);
await new Promise(r => setTimeout(r, 2500));

const intraday = await run(`
  (function() {
    var c = window.TradingViewApi._activeChartWidgetWV.value();
    var bars = c._chartWidget.model().mainSeries().bars();
    var out = [];
    var end = bars.lastIndex();
    var start = Math.max(bars.firstIndex(), end - 200);  // last ~16h of 5m bars
    for (var i = start; i <= end; i++) {
      var v = bars.valueAt(i);
      if (v) out.push([v[0], v[1], v[2], v[3], v[4], v[5] || 0]);
    }
    return { bars: out };
  })()
`);

// Filter to today's RTH (9:30-16:00 ET = 13:30-20:00 UTC)
const today = new Date();
const todayISO = today.toISOString().slice(0, 10);
const todayRTH = intraday.bars.filter(([t]) => {
  const d = new Date(t * 1000);
  const iso = d.toISOString();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return iso.startsWith(todayISO) && mins >= 13 * 60 + 30 && mins <= 20 * 60;
});

console.log(`\nToday's RTH 5m bars: ${todayRTH.length}`);
if (todayRTH.length > 0) {
  const open = todayRTH[0][1];
  const high = Math.max(...todayRTH.map(b => b[2]));
  const low = Math.min(...todayRTH.map(b => b[3]));
  const last = todayRTH[todayRTH.length - 1][4];
  const vol = todayRTH.reduce((s, b) => s + b[5], 0);
  console.log(`  Open: ${open}  High: ${high}  Low: ${low}  Last: ${last}  Vol: ${vol.toLocaleString()}`);

  // First 15 min = 9:30 - 9:45 ET (3 × 5m bars)
  const orb = todayRTH.slice(0, 3);
  if (orb.length === 3) {
    const orbHigh = Math.max(...orb.map(b => b[2]));
    const orbLow = Math.min(...orb.map(b => b[3]));
    console.log(`  ORB (9:30-9:45): ${orbLow.toFixed(2)} - ${orbHigh.toFixed(2)}`);
    // Check if ORB high was broken
    const postORB = todayRTH.slice(3);
    const brokeHigh = postORB.some(b => b[2] > orbHigh);
    const brokeLow = postORB.some(b => b[3] < orbLow);
    const firstHighBreak = postORB.find(b => b[4] > orbHigh);  // close > orbHigh
    const firstLowBreak = postORB.find(b => b[4] < orbLow);
    console.log(`  ORB: brokeHigh=${brokeHigh} brokeLow=${brokeLow}`);
    if (firstHighBreak) {
      const d = new Date(firstHighBreak[0] * 1000);
      const et = new Date(firstHighBreak[0] * 1000 - 4 * 3600 * 1000);
      console.log(`  First 5m close > ORB high: ${firstHighBreak[4]} at ${et.toISOString().slice(11,16)} ET`);
    }
    if (firstLowBreak) {
      const et = new Date(firstLowBreak[0] * 1000 - 4 * 3600 * 1000);
      console.log(`  First 5m close < ORB low: ${firstLowBreak[4]} at ${et.toISOString().slice(11,16)} ET`);
    }
  }

  // Print bar-by-bar for today
  console.log(`\nBar-by-bar (5m, ET):`);
  for (const b of todayRTH) {
    const et = new Date(b[0] * 1000 - 4 * 3600 * 1000);
    const t = et.toISOString().slice(11, 16);
    console.log(`  ${t}  O=${b[1].toFixed(2)} H=${b[2].toFixed(2)} L=${b[3].toFixed(2)} C=${b[4].toFixed(2)}  V=${b[5].toLocaleString()}`);
  }
}

// Restore resolution
await run(`window.TradingViewApi._activeChartWidgetWV.value().setResolution('15')`).catch(() => {});

// Screenshot
const ss = await c.Page.captureScreenshot({ format: 'png' });
const file = `/Users/aveenbabu/tradingview-mcp-jackson/screenshots/qqq_trade_review_${Date.now()}.png`;
fs.writeFileSync(file, Buffer.from(ss.data, 'base64'));
console.log(`\nScreenshot saved: ${file}`);

await c.close();
process.exit(0);
