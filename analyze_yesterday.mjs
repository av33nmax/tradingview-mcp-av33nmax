/**
 * analyze_yesterday.mjs — pull yesterday's 15m bars from TradingView for SPY
 * and QQQ, evaluate them against the trigger levels, and report whether any
 * candle would have fired Trigger A.
 *
 * Usage: node analyze_yesterday.mjs
 */
import CDP from 'chrome-remote-interface';

// Trigger levels from yesterday's pre-market setup (per dashboard screenshot)
const SETUPS = {
  SPY: {
    direction: 'CALLS',
    triggerA: { entry: 711.16, stop: 708.26, T1: 712.77, T2: 714.38 },
    triggerB: { vwap: 710.07, ema21: 709.51, stop: 708.82, T1: 713.35, T2: 712.77 },
    chartFragment: '/chart/PbLW86HI',
  },
  QQQ: {
    direction: 'CALLS',
    triggerA: { entry: 659.69, stop: 653.75, T1: 661.65, T2: 663.61 },
    triggerB: { vwap: 658.57, ema21: 655.42, stop: 656.90, T1: 662.12, T2: 661.65 },
    chartFragment: '/chart/o6Tc3OIX',
  },
};

const RVOL_THRESHOLD = 1.2;
const VOLUME_LOOKBACK_BARS = 20;

async function evalTicker(ticker, setup) {
  console.log(`\n━━━ ${ticker} ${setup.direction} ━━━`);
  console.log(`Trigger A: 15m close > ${setup.triggerA.entry}, with rVol ≥ ${RVOL_THRESHOLD}`);
  console.log(`Stop: ${setup.triggerA.stop}  T1: ${setup.triggerA.T1}  T2: ${setup.triggerA.T2}`);

  const targets = await fetch('http://localhost:9222/json/list').then(r => r.json());
  const tab = targets.find(t => t.type === 'page' && t.url?.includes(setup.chartFragment));
  if (!tab) { console.log(`  (chart tab not found)`); return; }

  const c = await CDP({ host: 'localhost', port: 9222, target: tab.id });
  await c.Runtime.enable();

  async function run(expr) {
    const r = await c.Runtime.evaluate({ expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }

  // Focus pane 1 (15m timeframe ideally)
  await run(`
    (function() {
      var w = window.TradingViewApi._chartWidgetCollection.getAll()[1];
      if (w && w._mainDiv) w._mainDiv.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 300));

  const data = await run(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var bars = chart._chartWidget.model().mainSeries().bars();
      var out = [];
      var end = bars.lastIndex();
      var start = Math.max(bars.firstIndex(), end - 200);
      for (var i = start; i <= end; i++) {
        var v = bars.valueAt(i);
        if (v) out.push([v[0], v[1], v[2], v[3], v[4], v[5] || 0]);
      }
      return { sym: chart.symbol(), res: chart.resolution(), bars: out };
    })()
  `);
  console.log(`Loaded chart: ${data.sym} @ ${data.res}m  ·  ${data.bars.length} bars`);

  if (data.res !== '15') {
    console.log(`  ⚠ pane 1 is not on 15m TF — analyzing on ${data.res}m anyway`);
  }

  const ohlc = data.bars.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  if (ohlc.length === 0) { console.log(`  no bars`); await c.close(); return; }

  // Identify yesterday's RTH bars (Friday 2026-04-24, 09:30-16:00 ET = 13:30-20:00 UTC)
  const yesterdayRTH = ohlc.filter(b => {
    const d = new Date(b.t * 1000);
    const iso = d.toISOString();
    const m = d.getUTCHours() * 60 + d.getUTCMinutes();
    return iso.startsWith('2026-04-24') && m >= 13 * 60 + 30 && m <= 20 * 60;
  });

  console.log(`Yesterday's RTH 15m bars: ${yesterdayRTH.length}`);
  if (yesterdayRTH.length === 0) {
    console.log(`  (chart resolution may not be 15m, or yesterday's bars aren't loaded)`);
    await c.close();
    return;
  }

  // For each bar, compute rVol vs the prior 20 bars (use the full ohlc as base)
  const lookup = new Map(ohlc.map((b, i) => [b.t, i]));
  console.log(`\n  ${'time(ET)'.padEnd(8)} ${'O'.padStart(8)} ${'H'.padStart(8)} ${'L'.padStart(8)} ${'C'.padStart(8)} ${'vol'.padStart(10)} ${'rVol'.padStart(6)}  cross  rVol≥1.2?  → fire?`);
  console.log(`  ${'─'.repeat(82)}`);
  let fired = null;
  for (const bar of yesterdayRTH) {
    const idx = lookup.get(bar.t);
    if (idx == null) continue;
    const priorStart = Math.max(0, idx - VOLUME_LOOKBACK_BARS);
    const prior = ohlc.slice(priorStart, idx);
    if (prior.length === 0) continue;
    const avgVol = prior.reduce((s, b) => s + b.v, 0) / prior.length;
    const rVol = avgVol > 0 ? bar.v / avgVol : 0;

    const crossed = setup.direction === 'CALLS'
      ? bar.c > setup.triggerA.entry
      : bar.c < setup.triggerA.entry;

    const etDate = new Date(bar.t * 1000 - 4 * 3600 * 1000);  // EDT
    const etTime = etDate.toISOString().slice(11, 16);

    const wouldFire = crossed && rVol >= RVOL_THRESHOLD;
    const flag = wouldFire ? '🔔 FIRE' : '';
    if (wouldFire && !fired) fired = { bar, etTime, rVol };

    console.log(
      `  ${etTime.padEnd(8)} ${bar.o.toFixed(2).padStart(8)} ${bar.h.toFixed(2).padStart(8)} ${bar.l.toFixed(2).padStart(8)} ${bar.c.toFixed(2).padStart(8)} ${Math.round(bar.v).toLocaleString().padStart(10)} ${rVol.toFixed(2).padStart(6)}  ${crossed ? 'YES'.padEnd(5) : 'no '.padEnd(5)}  ${rVol >= RVOL_THRESHOLD ? 'YES'.padEnd(8) : 'no '.padEnd(8)}  ${flag}`,
    );
  }

  if (fired) {
    console.log(`\n  ✅ Trigger A would have fired at ${fired.etTime} ET — close ${fired.bar.c.toFixed(2)}, rVol ${fired.rVol.toFixed(2)}`);
  } else {
    console.log(`\n  ❌ Trigger A NEVER fired — no 15m close above ${setup.triggerA.entry} with rVol ≥ ${RVOL_THRESHOLD}`);
  }

  // Also note key high/low + ORB
  const open = yesterdayRTH[0].o;
  const high = Math.max(...yesterdayRTH.map(b => b.h));
  const low = Math.min(...yesterdayRTH.map(b => b.l));
  const close = yesterdayRTH[yesterdayRTH.length - 1].c;
  console.log(`\n  Session: O ${open.toFixed(2)} · H ${high.toFixed(2)} · L ${low.toFixed(2)} · C ${close.toFixed(2)}`);

  await c.close();
}

(async () => {
  for (const [ticker, setup] of Object.entries(SETUPS)) {
    try { await evalTicker(ticker, setup); }
    catch (e) { console.log(`  error: ${e.message}`); }
  }
  process.exit(0);
})();
