import CDP from 'chrome-remote-interface';
const resp = await fetch('http://localhost:9222/json/list');
const all = await resp.json();
const tab = all.find(t => /tradingview\.com\/chart/.test(t.url));
const c = await CDP({ host: 'localhost', port: 9222, target: tab.id });
await c.Runtime.enable();
async function run(expr, awaitPromise = false) {
  const r = await c.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

// Step 1: Focus pane 0 (SPY 1H)
await run(`
  (function() {
    var w = window.TradingViewApi._chartWidgetCollection.getAll()[0];
    if (w && w._mainDiv) w._mainDiv.click();
  })()
`);
await new Promise(r => setTimeout(r, 500));

// Step 2: Pull OHLCV data
const bars = await run(`
  (function() {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var bars = chart._chartWidget.model().mainSeries().bars();
    var out = [];
    var end = bars.lastIndex();
    var start = Math.max(bars.firstIndex(), end - 200 + 1);
    for (var i = start; i <= end; i++) {
      var v = bars.valueAt(i);
      if (v) out.push([v[0], v[1], v[2], v[3], v[4], v[5] || 0]);
    }
    return { sym: chart.symbol(), res: chart.resolution(), bars: out };
  })()
`);
console.log(`${bars.sym} @ ${bars.res}m — ${bars.bars.length} bars`);
const ohlc = bars.bars.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
const lastPrice = ohlc[ohlc.length - 1].c;
const lastTime = ohlc[ohlc.length - 1].t;

// Step 3: Find swing pivots (fractals)
function findSwings(bars, left = 5, right = 5) {
  const highs = [], lows = [];
  for (let i = left; i < bars.length - right; i++) {
    const h = bars[i].h, l = bars[i].l;
    let isH = true, isL = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j].h >= h) isH = false;
      if (bars[j].l <= l) isL = false;
    }
    if (isH) highs.push({ t: bars[i].t, price: h, i });
    if (isL) lows.push({ t: bars[i].t, price: l, i });
  }
  return { highs, lows };
}
const swings = findSwings(ohlc, 5, 5);
// Take the 5 most recent that are meaningful (at least 0.3% away from current price)
const resistanceZones = swings.highs
  .filter(p => p.price > lastPrice)
  .slice(-6)
  .map(p => ({ top: p.price, bot: p.price * 0.9985, t: p.t, type: 'R' }));  // ~0.15% zone
const supportZones = swings.lows
  .filter(p => p.price < lastPrice)
  .slice(-6)
  .map(p => ({ top: p.price * 1.0015, bot: p.price, t: p.t, type: 'S' }));

// Step 4: Find FVGs (3-bar gap pattern, unfilled)
function findFVGs(bars) {
  const gaps = [];
  for (let i = 2; i < bars.length; i++) {
    const a = bars[i - 2], b = bars[i - 1], cc = bars[i];
    if (a.h < cc.l) {
      gaps.push({ type: 'bull', top: cc.l, bot: a.h, t: b.t, i });
    } else if (a.l > cc.h) {
      gaps.push({ type: 'bear', top: a.l, bot: cc.h, t: b.t, i });
    }
  }
  // Filter unfilled
  const unfilled = [];
  for (const g of gaps) {
    let filled = false;
    for (let j = g.i + 1; j < bars.length; j++) {
      if (g.type === 'bull' && bars[j].l <= g.bot) { filled = true; break; }
      if (g.type === 'bear' && bars[j].h >= g.top) { filled = true; break; }
    }
    // Only keep if meaningful size (≥ 0.05%)
    if (!filled && (g.top - g.bot) / g.top > 0.0005) unfilled.push(g);
  }
  return unfilled.slice(-8);  // last 8 unfilled
}
const fvgs = findFVGs(ohlc);

console.log(`S/R zones: ${resistanceZones.length} R + ${supportZones.length} S`);
console.log(`Unfilled FVGs: ${fvgs.filter(f => f.type === 'bull').length} bull + ${fvgs.filter(f => f.type === 'bear').length} bear`);

// Step 5: Draw rectangles on the chart
// Use createMultipointShape with shape='rectangle'
// Extend from zone's origin time to future (1 week = 7*24*3600s = 604800s)
const extendTo = lastTime + 7 * 24 * 3600;

const toDraw = [
  // Resistance zones - red
  ...resistanceZones.map(z => ({
    from: { t: z.t, p: z.bot }, to: { t: extendTo, p: z.top },
    label: `R ${z.top.toFixed(2)}`,
    color: 'rgba(239, 83, 80, 0.35)',  // red
    border: '#ef5350',
  })),
  // Support zones - green
  ...supportZones.map(z => ({
    from: { t: z.t, p: z.bot }, to: { t: extendTo, p: z.top },
    label: `S ${z.bot.toFixed(2)}`,
    color: 'rgba(38, 166, 154, 0.35)',  // green
    border: '#26a69a',
  })),
  // Bull FVG - light blue/cyan
  ...fvgs.filter(f => f.type === 'bull').map(g => ({
    from: { t: g.t, p: g.bot }, to: { t: extendTo, p: g.top },
    label: `FVG↑ ${g.bot.toFixed(2)}-${g.top.toFixed(2)}`,
    color: 'rgba(66, 165, 245, 0.25)',
    border: '#42a5f5',
  })),
  // Bear FVG - orange
  ...fvgs.filter(f => f.type === 'bear').map(g => ({
    from: { t: g.t, p: g.bot }, to: { t: extendTo, p: g.top },
    label: `FVG↓ ${g.top.toFixed(2)}-${g.bot.toFixed(2)}`,
    color: 'rgba(255, 167, 38, 0.25)',
    border: '#ffa726',
  })),
];

console.log(`\nDrawing ${toDraw.length} rectangles...`);

let drawn = 0, failed = 0;
for (const r of toDraw) {
  try {
    await run(`
      (function() {
        var api = window.TradingViewApi._activeChartWidgetWV.value();
        api.createMultipointShape(
          [{ time: ${r.from.t}, price: ${r.from.p} }, { time: ${r.to.t}, price: ${r.to.p} }],
          {
            shape: 'rectangle',
            text: ${JSON.stringify(r.label)},
            overrides: {
              backgroundColor: '${r.color}',
              color: '${r.border}',
              linewidth: 1,
              fillBackground: true,
              showLabel: true,
              textColor: '${r.border}',
              fontSize: 10,
            }
          }
        );
      })()
    `);
    drawn++;
  } catch (e) {
    failed++;
    console.log(`  failed: ${r.label} - ${e.message.slice(0, 80)}`);
  }
  await new Promise(r => setTimeout(r, 60));
}

console.log(`\nDone: ${drawn} drawn, ${failed} failed`);
await c.close();
process.exit(0);
