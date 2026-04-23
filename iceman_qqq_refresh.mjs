/**
 * iceman_qqq_refresh.mjs — one-shot.
 * Targets the "Iceman Style QQQ" chart tab.
 *   1. Deletes all hand-drawn Horizontal lines from each pane (keeps [auto]-tagged shapes)
 *   2. Draws fresh S/R + FVG rectangles on each pane (same logic as premarket_setup.mjs)
 */
import CDP from 'chrome-remote-interface';

const AUTO_LABEL_PREFIX = '[auto] ';
const QQQ_TAB_URL_FRAGMENT = '/chart/o6Tc3OIX';  // Iceman Style QQQ

const resp = await fetch('http://localhost:9222/json/list');
const targets = await resp.json();
const tab = targets.find(t => t.type === 'page' && t.url.includes(QQQ_TAB_URL_FRAGMENT));
if (!tab) {
  console.error(`Iceman Style QQQ tab not found (expected URL containing ${QQQ_TAB_URL_FRAGMENT})`);
  console.error('Available TV tabs:');
  for (const t of targets.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))) {
    console.error(`  ${t.url}`);
  }
  process.exit(1);
}
console.log(`Connected to tab: ${tab.url}`);

const c = await CDP({ host: 'localhost', port: 9222, target: tab.id });
await c.Runtime.enable();

async function run(expr, awaitPromise = false) {
  const r = await c.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

// Bring the tab to front so the widgets render
await c.Page?.bringToFront?.().catch(() => {});

const paneCount = await run(`window.TradingViewApi._chartWidgetCollection.getAll().length`);
console.log(`Panes: ${paneCount}`);

// ── Step 1: delete all hand-drawn horizontal lines on each pane ──
let totalDeleted = 0;
for (let i = 0; i < paneCount; i++) {
  await run(`
    (function() {
      var w = window.TradingViewApi._chartWidgetCollection.getAll()[${i}];
      if (w && w._mainDiv) w._mainDiv.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 400));

  const deleted = await run(`
    (function() {
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      var shapes = api.getAllShapes();
      var removed = 0, found = 0;
      for (var k = 0; k < shapes.length; k++) {
        var s = shapes[k];
        var name = (s.name || '').toLowerCase();
        // Match horizontal line variants
        if (name.indexOf('horizontal') < 0) continue;
        found++;
        // Skip auto-tagged shapes (shouldn't apply to horizontal lines from our script, but safe)
        try {
          var shape = api.getShapeById(s.id);
          var props = shape && shape.getProperties ? shape.getProperties() : null;
          var text = props && props.text ? String(props.text) : '';
          if (text.indexOf(${JSON.stringify(AUTO_LABEL_PREFIX)}) === 0) continue;
        } catch(e) {}
        try { api.removeEntity(s.id); removed++; } catch(e) {}
      }
      return { found: found, removed: removed };
    })()
  `);
  console.log(`  pane ${i}: horizontal lines found=${deleted.found}, removed=${deleted.removed}`);
  totalDeleted += deleted.removed;
}
console.log(`\nTotal hand-drawn horizontal lines removed: ${totalDeleted}\n`);

// ── Step 2: draw S/R + FVG on each pane (reusing the logic from premarket_setup.mjs) ──
async function drawZonesOnPane(paneIndex, analysisResolution = 'D', priceDepthBelow = 70) {
  await run(`
    (function() {
      var w = window.TradingViewApi._chartWidgetCollection.getAll()[${paneIndex}];
      if (w && w._mainDiv) w._mainDiv.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 500));

  // Remember current resolution and switch to analysis TF for deeper history
  const origRes = await run(`window.TradingViewApi._activeChartWidgetWV.value().resolution()`);
  const needsSwitch = String(origRes) !== String(analysisResolution);
  if (needsSwitch) {
    console.log(`  pane ${paneIndex}: switching from ${origRes} to ${analysisResolution} for swing analysis`);
    await run(`window.TradingViewApi._activeChartWidgetWV.value().setResolution('${analysisResolution}')`);
    // Wait for bars to load — poll up to 10s
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(r => setTimeout(r, 500));
      const barCount = await run(`
        (function() {
          var b = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
          return b.lastIndex() - b.firstIndex() + 1;
        })()
      `).catch(() => 0);
      if (barCount > 100) break;
    }
  }

  const data = await run(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var bars = chart._chartWidget.model().mainSeries().bars();
      var out = [];
      var end = bars.lastIndex();
      var start = bars.firstIndex();
      for (var i = start; i <= end; i++) {
        var v = bars.valueAt(i);
        if (v) out.push([v[0], v[1], v[2], v[3], v[4], v[5] || 0]);
      }
      return { sym: chart.symbol(), res: chart.resolution(), bars: out };
    })()
  `);
  const ohlc = data.bars.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  if (ohlc.length < 30) {
    console.log(`  pane ${paneIndex}: not enough bars (${ohlc.length}), skipping`);
    return;
  }
  const lastPrice = ohlc[ohlc.length - 1].c;
  const lastTime = ohlc[ohlc.length - 1].t;
  const dataMinLow = Math.min(...ohlc.map(b => b.l));
  const dataMaxHigh = Math.max(...ohlc.map(b => b.h));
  const firstTime = ohlc[0].t;
  const daysSpan = ((lastTime - firstTime) / 86400).toFixed(1);
  console.log(`  pane ${paneIndex} data range: ${ohlc.length} bars over ${daysSpan}d, price [${dataMinLow.toFixed(2)} .. ${dataMaxHigh.toFixed(2)}], last=${lastPrice.toFixed(2)}`);

  // Clear prior auto-drawn rectangles — current [auto] prefix AND legacy pattern
  const cleared = await run(`
    (function() {
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      var shapes = api.getAllShapes();
      var legacy = /^(FVG[\u2191\u2193]|[RS]) /;
      var removed = 0;
      for (var i = 0; i < shapes.length; i++) {
        try {
          if ((shapes[i].name || '').toLowerCase().indexOf('rectangle') < 0) continue;
          var shape = api.getShapeById(shapes[i].id);
          var props = shape.getProperties ? shape.getProperties() : null;
          var text = props && props.text ? String(props.text) : '';
          if (text.indexOf(${JSON.stringify(AUTO_LABEL_PREFIX)}) === 0 || legacy.test(text)) {
            api.removeEntity(shapes[i].id);
            removed++;
          }
        } catch(e) {}
      }
      return removed;
    })()
  `);
  if (cleared > 0) console.log(`  pane ${paneIndex}: cleared ${cleared} prior auto-zones`);

  // Swing pivots
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
  const minPrice = lastPrice - priceDepthBelow;
  // Resistance: closest 6 highs above current price
  const resistance = swings.highs.filter(p => p.price > lastPrice).slice(-6)
    .map(p => ({ top: p.price, bot: p.price * 0.9985, t: p.t, kind: 'R' }));
  // Support: dedupe nearby lows (within 0.15% = same zone), keep all within priceDepthBelow of current
  const rawLows = swings.lows.filter(p => p.price < lastPrice && p.price >= minPrice);
  const deduped = [];
  const seen = [];
  for (const p of rawLows.sort((a, b) => b.price - a.price)) {
    if (seen.some(s => Math.abs(s - p.price) / p.price < 0.0015)) continue;
    seen.push(p.price);
    deduped.push(p);
  }
  const support = deduped.slice(0, 20)
    .map(p => ({ top: p.price * 1.0015, bot: p.price, t: p.t, kind: 'S' }));

  // Unfilled FVGs
  const fvgs = [];
  for (let i = 2; i < ohlc.length; i++) {
    const a = ohlc[i - 2], b = ohlc[i - 1], cc = ohlc[i];
    if (a.h < cc.l) fvgs.push({ type: 'bull', top: cc.l, bot: a.h, t: b.t, idx: i });
    else if (a.l > cc.h) fvgs.push({ type: 'bear', top: a.l, bot: cc.h, t: b.t, idx: i });
  }
  // FVGs: keep any unfilled FVG that intersects the target range [minPrice, lastPrice + resistance zone above]
  const maxResistance = resistance.length ? Math.max(...resistance.map(r => r.top)) : lastPrice * 1.02;
  const unfilled = fvgs.filter(g => {
    if ((g.top - g.bot) / g.top < 0.0005) return false;
    // Skip FVGs entirely outside the target range
    if (g.top < minPrice || g.bot > maxResistance) return false;
    for (let j = g.idx + 1; j < ohlc.length; j++) {
      if (g.type === 'bull' && ohlc[j].l <= g.bot) return false;
      if (g.type === 'bear' && ohlc[j].h >= g.top) return false;
    }
    return true;
  }).slice(-20);

  console.log(`  pane ${paneIndex} (${data.sym} ${data.res}m): ${resistance.length} R + ${support.length} S + ${unfilled.filter(g => g.type === 'bull').length} bullFVG + ${unfilled.filter(g => g.type === 'bear').length} bearFVG`);

  const extendTo = lastTime + 7 * 24 * 3600;
  const rectangles = [
    ...resistance.map(z => ({ from: { t: z.t, p: z.bot }, to: { t: extendTo, p: z.top },
      label: `${AUTO_LABEL_PREFIX}R ${z.top.toFixed(2)}`, color: 'rgba(239, 83, 80, 0.35)', border: '#ef5350' })),
    ...support.map(z => ({ from: { t: z.t, p: z.bot }, to: { t: extendTo, p: z.top },
      label: `${AUTO_LABEL_PREFIX}S ${z.bot.toFixed(2)}`, color: 'rgba(38, 166, 154, 0.35)', border: '#26a69a' })),
    ...unfilled.filter(g => g.type === 'bull').map(g => ({ from: { t: g.t, p: g.bot }, to: { t: extendTo, p: g.top },
      label: `${AUTO_LABEL_PREFIX}FVG↑ ${g.bot.toFixed(2)}-${g.top.toFixed(2)}`, color: 'rgba(66, 165, 245, 0.25)', border: '#42a5f5' })),
    ...unfilled.filter(g => g.type === 'bear').map(g => ({ from: { t: g.t, p: g.bot }, to: { t: extendTo, p: g.top },
      label: `${AUTO_LABEL_PREFIX}FVG↓ ${g.top.toFixed(2)}-${g.bot.toFixed(2)}`, color: 'rgba(255, 167, 38, 0.25)', border: '#ffa726' })),
  ];

  let drawn = 0;
  for (const r of rectangles) {
    try {
      await run(`
        (function() {
          var api = window.TradingViewApi._activeChartWidgetWV.value();
          api.createMultipointShape(
            [{ time: ${r.from.t}, price: ${r.from.p} }, { time: ${r.to.t}, price: ${r.to.p} }],
            { shape: 'rectangle', text: ${JSON.stringify(r.label)}, overrides: {
              backgroundColor: '${r.color}', color: '${r.border}', linewidth: 1,
              fillBackground: true, showLabel: true, textColor: '${r.border}', fontSize: 10,
            }}
          );
        })()
      `);
      drawn++;
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  console.log(`  pane ${paneIndex}: drew ${drawn}/${rectangles.length} rectangles`);

  // Restore original resolution
  if (needsSwitch) {
    await run(`window.TradingViewApi._activeChartWidgetWV.value().setResolution('${origRes}')`).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
    console.log(`  pane ${paneIndex}: restored resolution to ${origRes}`);
  }
}

// Analyze on Daily TF to capture deeper swings (down to ~70 points below current), draw on pane 1
try { await drawZonesOnPane(1, 'D', 70); } catch (e) { console.log(`  pane 1 failed: ${e.message}`); }

// Restore focus to pane 0 (user's default)
await run(`
  (function() {
    var w = window.TradingViewApi._chartWidgetCollection.getAll()[0];
    if (w && w._mainDiv) w._mainDiv.click();
  })()
`).catch(() => {});

await c.close();
console.log('\n✅ Iceman Style QQQ refresh complete.');
process.exit(0);
