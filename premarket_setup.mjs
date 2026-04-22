/**
 * premarket_setup.mjs — one-shot pre-market setup brief.
 *
 * Runs ONLY when user asks. Never run in background.
 *
 * Actions:
 *   1. Runs multi_timeframe_analysis.js inline (ES/NQ/SPY/QQQ × 15m/1H/4H confluence + ORB)
 *   2. Draws fresh S/R and unfilled FVG rectangles on SPY 1H and SPY 15m panes
 *   3. Clears any previous auto-drawn zones first so drawings don't stack day-over-day
 *   4. Restores the user's original chart symbol on exit
 *
 * Usage: node premarket_setup.mjs
 */

import { spawn } from 'node:child_process';
import CDP from 'chrome-remote-interface';

const CDP_HOST = 'localhost', CDP_PORT = 9222;
const AUTO_LABEL_PREFIX = '[auto] ';  // rectangles added by this script carry this prefix

// ─── Run multi_timeframe_analysis.js as a child process and pipe its output ────
async function runAnalysis() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  STEP 1: Multi-timeframe confluence analysis');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['multi_timeframe_analysis.js'], { stdio: 'inherit' });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`analysis exited ${code}`)));
    child.on('error', reject);
  });
}

// ─── Draw S/R + FVG zones on a specific pane ─────────────────────────────────
async function drawZonesOnPane(client, paneIndex, lookback = 200) {
  async function run(expr, awaitPromise = false) {
    const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }

  // Focus the pane
  await run(`
    (function() {
      var w = window.TradingViewApi._chartWidgetCollection.getAll()[${paneIndex}];
      if (w && w._mainDiv) w._mainDiv.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 500));

  // Pull OHLCV
  const data = await run(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var bars = chart._chartWidget.model().mainSeries().bars();
      var out = [];
      var end = bars.lastIndex();
      var start = Math.max(bars.firstIndex(), end - ${lookback} + 1);
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

  // Clear prior auto-drawn rectangles on this pane
  const cleared = await run(`
    (function() {
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      var shapes = api.getAllShapes();
      var removed = 0;
      for (var i = 0; i < shapes.length; i++) {
        try {
          if ((shapes[i].name || '').indexOf('rectangle') < 0) continue;
          var shape = api.getShapeById(shapes[i].id);
          var props = shape.getProperties ? shape.getProperties() : null;
          var text = props && props.text ? String(props.text) : '';
          if (text.indexOf(${JSON.stringify(AUTO_LABEL_PREFIX)}) === 0) {
            api.removeEntity(shapes[i].id);
            removed++;
          }
        } catch(e) {}
      }
      return removed;
    })()
  `);
  if (cleared > 0) console.log(`  pane ${paneIndex}: cleared ${cleared} prior auto-zones`);

  // Detect swing pivots
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
  const resistance = swings.highs.filter(p => p.price > lastPrice).slice(-6)
    .map(p => ({ top: p.price, bot: p.price * 0.9985, t: p.t, kind: 'R' }));
  const support = swings.lows.filter(p => p.price < lastPrice).slice(-6)
    .map(p => ({ top: p.price * 1.0015, bot: p.price, t: p.t, kind: 'S' }));

  // Detect unfilled FVGs (3-bar gap)
  const fvgs = [];
  for (let i = 2; i < ohlc.length; i++) {
    const a = ohlc[i - 2], b = ohlc[i - 1], cc = ohlc[i];
    if (a.h < cc.l) fvgs.push({ type: 'bull', top: cc.l, bot: a.h, t: b.t, idx: i });
    else if (a.l > cc.h) fvgs.push({ type: 'bear', top: a.l, bot: cc.h, t: b.t, idx: i });
  }
  const unfilled = fvgs.filter(g => {
    if ((g.top - g.bot) / g.top < 0.0005) return false;
    for (let j = g.idx + 1; j < ohlc.length; j++) {
      if (g.type === 'bull' && ohlc[j].l <= g.bot) return false;
      if (g.type === 'bear' && ohlc[j].h >= g.top) return false;
    }
    return true;
  }).slice(-8);

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
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  // Step 1: Run analysis
  await runAnalysis();

  // Step 2: Draw zones on SPY 1H and SPY 15m panes of the active tab
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  STEP 2: Drawing S/R + FVG rectangles on SPY 1H and 15m');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const tab = targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
  if (!tab) { console.error('No TradingView chart tab found'); process.exit(1); }

  const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: tab.id });
  await client.Runtime.enable();

  // Capture user's original active chart's symbol to restore later
  const origSymbol = await client.Runtime.evaluate({
    expression: `window.TradingViewApi._activeChartWidgetWV.value().symbol()`,
    returnByValue: true,
  }).then(r => r.result.value).catch(() => null);

  // Try to draw on panes 0 (1H) and 1 (15m) — works if the layout is the 3-pane SPY setup
  try { await drawZonesOnPane(client, 0, 200); } catch (e) { console.log(`  pane 0 failed: ${e.message}`); }
  try { await drawZonesOnPane(client, 1, 200); } catch (e) { console.log(`  pane 1 failed: ${e.message}`); }

  // Restore user's original active pane (if we changed focus)
  if (origSymbol) {
    await client.Runtime.evaluate({
      expression: `
        (function() {
          var all = window.TradingViewApi._chartWidgetCollection.getAll();
          for (var i = 0; i < all.length; i++) {
            try {
              if (all[i].model().mainSeries().symbol() === '${origSymbol}' && all[i]._mainDiv) {
                all[i]._mainDiv.click();
                break;
              }
            } catch(e) {}
          }
        })()
      `,
      returnByValue: true,
    }).catch(() => {});
  }

  await client.close();
  console.log('\n✅ Pre-market setup complete. Chart focus restored.');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
