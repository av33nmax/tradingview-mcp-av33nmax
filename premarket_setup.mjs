/**
 * premarket_setup.mjs — one-shot pre-market setup, single command for the day's prep.
 *
 * Runs ONLY when user asks ("run the pre-market setup"). Never in background.
 *
 * Actions (in order):
 *   STEP 1 — Run multi_timeframe_analysis.js (confluence brief with entry/exit triggers).
 *            Stdout is piped through to user AND captured; final JSON parsed so the
 *            trigger values (entry/stop/T1/T2 for both Trigger A and Trigger B) are
 *            available for annotation drawing in STEP 2.
 *
 *   STEP 2 — For each target tab (SPY + QQQ Iceman Style, identified by pane 0 symbol):
 *     a) Delete all hand-drawn Horizontal lines across all panes (also wipes the
 *        [T-A] / [T-B] annotation lines from the previous run so they don't stack)
 *     b) Delete all auto rectangles — both current "[auto] " prefix and legacy
 *        (R/S/FVG↑/FVG↓ without prefix) from older script versions
 *     c) Switch pane 1 to Daily TF, pull deep history, find swings + unfilled FVGs
 *        down to `depthBelow` points below current price, draw rectangles, restore TF
 *     d) Draw Trigger A (orange) and Trigger B (purple) horizontal lines with
 *        labels [T-A] / [T-B] for entry / stop (dashed) / T1 / T2. These are
 *        deleted by the cleanup step on the next run — no stacking.
 *
 * Drawings are layout-shared in this TV build — drawing on one pane renders on all 3.
 */

import { spawn } from 'node:child_process';
import CDP from 'chrome-remote-interface';

const CDP_HOST = 'localhost', CDP_PORT = 9222;
const AUTO_LABEL_PREFIX = '[auto] ';
const TRIGGER_A_COLOR = '#ff9500';  // orange
const TRIGGER_B_COLOR = '#c77dff';  // purple

// Tabs to process — identified by the pane 0 symbol (robust to URL changes).
// `key` matches the ticker name used in multi_timeframe_analysis.js final[] output.
const TARGETS = [
  { match: 'BATS:SPY', key: 'SPY', label: 'SPY',                depthBelow: 60 },
  { match: 'BATS:QQQ', key: 'QQQ', label: 'QQQ (Iceman Style)', depthBelow: 70 },
];

// ─── Run multi_timeframe_analysis.js, pass stdout through to user,
//     capture it, and parse the trailing JSON block. ─────────────────────────
async function runAnalysisAndCapture() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  STEP 1: Multi-timeframe confluence + entry/exit triggers');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn('node', ['multi_timeframe_analysis.js'], {
      stdio: ['inherit', 'pipe', 'inherit'],
    });
    child.stdout.on('data', chunk => {
      process.stdout.write(chunk);
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0) return reject(new Error(`analysis exited ${code}`));
      // Find JSON block after the marker and brace-match to extract the object.
      const marker = '─── FULL DATA (JSON) ───';
      const idx = output.indexOf(marker);
      if (idx < 0) return reject(new Error(`analysis JSON marker not found`));
      const after = output.slice(idx + marker.length);
      const openIdx = after.indexOf('{');
      if (openIdx < 0) return reject(new Error(`analysis JSON open-brace not found`));
      let depth = 0, end = -1, inStr = false, esc = false;
      for (let i = openIdx; i < after.length; i++) {
        const ch = after[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\' && inStr) { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end < 0) return reject(new Error(`analysis JSON not well-formed`));
      try { resolve(JSON.parse(after.slice(openIdx, end + 1))); }
      catch (e) { reject(e); }
    });
  });
}

// ─── Per-tab helpers ────────────────────────────────────────────────────────
function makeRunner(client) {
  return async function run(expr, awaitPromise = false) {
    const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
}

async function focusPane(run, paneIndex) {
  await run(`
    (function() {
      var w = window.TradingViewApi._chartWidgetCollection.getAll()[${paneIndex}];
      if (w && w._mainDiv) w._mainDiv.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 400));
}

async function cleanupPane(run) {
  return run(`
    (function() {
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      var shapes = api.getAllShapes();
      var legacy = /^(FVG[\u2191\u2193]|[RS]) /;
      var handLines = 0, autoRects = 0;
      for (var j = 0; j < shapes.length; j++) {
        try {
          var s = api.getShapeById(shapes[j].id);
          var props = s && s.getProperties ? s.getProperties() : null;
          var text = props && props.text ? String(props.text) : '';
          var nameLc = (shapes[j].name || '').toLowerCase();
          if (nameLc.indexOf('horizontal') >= 0 && text.indexOf(${JSON.stringify(AUTO_LABEL_PREFIX)}) !== 0) {
            api.removeEntity(shapes[j].id);
            handLines++;
          } else if (nameLc.indexOf('rectangle') >= 0 && (text.indexOf(${JSON.stringify(AUTO_LABEL_PREFIX)}) === 0 || legacy.test(text))) {
            api.removeEntity(shapes[j].id);
            autoRects++;
          }
        } catch(e) {}
      }
      return { handLines: handLines, autoRects: autoRects };
    })()
  `);
}

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

async function drawDeepZones(run, paneIndex, depthBelow) {
  await focusPane(run, paneIndex);

  const origRes = await run(`window.TradingViewApi._activeChartWidgetWV.value().resolution()`);
  const ANALYSIS_RES = 'D';
  const needsSwitch = String(origRes) !== ANALYSIS_RES;
  if (needsSwitch) {
    console.log(`    switching pane ${paneIndex} ${origRes} → ${ANALYSIS_RES} for deep swing analysis`);
    await run(`window.TradingViewApi._activeChartWidgetWV.value().setResolution('${ANALYSIS_RES}')`);
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
    console.log(`    pane ${paneIndex}: insufficient bars (${ohlc.length}), skipping draw`);
    if (needsSwitch) await run(`window.TradingViewApi._activeChartWidgetWV.value().setResolution('${origRes}')`).catch(() => {});
    return;
  }
  const lastPrice = ohlc[ohlc.length - 1].c;
  const lastTime = ohlc[ohlc.length - 1].t;
  const minPrice = lastPrice - depthBelow;

  const swings = findSwings(ohlc, 5, 5);
  const resistance = swings.highs.filter(p => p.price > lastPrice).slice(-8)
    .map(p => ({ top: p.price, bot: p.price * 0.9985, t: p.t }));
  // Support: dedupe nearby lows within target depth range
  const rawLows = swings.lows.filter(p => p.price < lastPrice && p.price >= minPrice);
  const seen = [];
  const dedupedLows = [];
  for (const p of rawLows.sort((a, b) => b.price - a.price)) {
    if (seen.some(s => Math.abs(s - p.price) / p.price < 0.0015)) continue;
    seen.push(p.price);
    dedupedLows.push(p);
  }
  const support = dedupedLows.slice(0, 20)
    .map(p => ({ top: p.price * 1.0015, bot: p.price, t: p.t }));

  const fvgs = [];
  for (let i = 2; i < ohlc.length; i++) {
    const a = ohlc[i - 2], b = ohlc[i - 1], cc = ohlc[i];
    if (a.h < cc.l) fvgs.push({ type: 'bull', top: cc.l, bot: a.h, t: b.t, idx: i });
    else if (a.l > cc.h) fvgs.push({ type: 'bear', top: a.l, bot: cc.h, t: b.t, idx: i });
  }
  const maxResistance = resistance.length ? Math.max(...resistance.map(r => r.top)) : lastPrice * 1.02;
  const unfilled = fvgs.filter(g => {
    if ((g.top - g.bot) / g.top < 0.0005) return false;
    if (g.top < minPrice || g.bot > maxResistance) return false;
    for (let j = g.idx + 1; j < ohlc.length; j++) {
      if (g.type === 'bull' && ohlc[j].l <= g.bot) return false;
      if (g.type === 'bear' && ohlc[j].h >= g.top) return false;
    }
    return true;
  }).slice(-20);

  console.log(`    ${data.sym} ${data.res}-TF (${ohlc.length} bars): ${resistance.length}R + ${support.length}S + ${unfilled.filter(g => g.type === 'bull').length} bullFVG + ${unfilled.filter(g => g.type === 'bear').length} bearFVG  |  range covers ${minPrice.toFixed(2)} → ${lastPrice.toFixed(2)}+`);

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
  console.log(`    drew ${drawn}/${rectangles.length} rectangles`);

  if (needsSwitch) {
    await run(`window.TradingViewApi._activeChartWidgetWV.value().setResolution('${origRes}')`).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
    console.log(`    pane ${paneIndex} resolution restored to ${origRes}`);
  }
}

// ─── Draw Trigger A (orange) and Trigger B (purple) horizontal lines ───────
// Uses values from multi_timeframe_analysis JSON (entry_notes.trigger_a / .trigger_b).
// Labels use [T-A] and [T-B] prefixes so they are cleared on the next run by
// cleanupPane's "delete non-auto horizontal lines" rule.
async function drawTriggerAnnotations(run, ticker, entryNotes, anchorTime) {
  if (!entryNotes || (!entryNotes.trigger_a && !entryNotes.trigger_b)) {
    console.log(`    no entry_notes for ${ticker} — skipping trigger annotations`);
    return;
  }

  async function drawLine(price, label, color, style) {
    if (price == null || Number.isNaN(price) || !Number.isFinite(price)) return false;
    const styleCode = style === 'dashed' ? 2 : (style === 'dotted' ? 1 : 0);
    try {
      await run(`
        (function() {
          var api = window.TradingViewApi._activeChartWidgetWV.value();
          api.createMultipointShape(
            [{ time: ${anchorTime}, price: ${price} }],
            { shape: 'horizontal_line', text: ${JSON.stringify(label)},
              overrides: {
                linecolor: '${color}', linewidth: 2, linestyle: ${styleCode},
                showLabel: true, textcolor: '${color}', fontsize: 11,
                horzLabelsAlign: 'right', vertLabelsAlign: 'top', showPrice: true,
              } }
          );
        })()
      `);
      return true;
    } catch (e) {
      return false;
    }
  }

  const lines = [];
  const a = entryNotes.trigger_a;
  if (a) {
    if (a.entry != null) lines.push({ price: a.entry, label: `[T-A] ${ticker} Entry ${a.entry}`, color: TRIGGER_A_COLOR, style: 'solid' });
    if (a.stop != null)  lines.push({ price: a.stop,  label: `[T-A] ${ticker} Stop ${a.stop}`,  color: TRIGGER_A_COLOR, style: 'dashed' });
    if (a.T1 != null)    lines.push({ price: a.T1,    label: `[T-A] ${ticker} T1 ${a.T1}`,      color: TRIGGER_A_COLOR, style: 'solid' });
    if (a.T2 != null)    lines.push({ price: a.T2,    label: `[T-A] ${ticker} T2 ${a.T2}`,      color: TRIGGER_A_COLOR, style: 'solid' });
  }
  const b = entryNotes.trigger_b;
  if (b) {
    if (b.entry_vwap != null)    lines.push({ price: b.entry_vwap,    label: `[T-B] ${ticker} Entry VWAP ${b.entry_vwap}`,    color: TRIGGER_B_COLOR, style: 'solid' });
    if (b.entry_ema21_1H != null) lines.push({ price: b.entry_ema21_1H, label: `[T-B] ${ticker} Entry EMA21 ${b.entry_ema21_1H}`, color: TRIGGER_B_COLOR, style: 'solid' });
    if (b.stop != null)          lines.push({ price: b.stop,          label: `[T-B] ${ticker} Stop ${b.stop}`,                  color: TRIGGER_B_COLOR, style: 'dashed' });
    if (b.T1 != null)            lines.push({ price: b.T1,            label: `[T-B] ${ticker} T1 ${b.T1}`,                      color: TRIGGER_B_COLOR, style: 'solid' });
    if (b.T2 != null)            lines.push({ price: b.T2,            label: `[T-B] ${ticker} T2 ${b.T2}`,                      color: TRIGGER_B_COLOR, style: 'solid' });
  }

  let drawn = 0;
  for (const ln of lines) {
    const ok = await drawLine(ln.price, ln.label, ln.color, ln.style);
    if (ok) drawn++;
    await new Promise(r => setTimeout(r, 60));
  }
  console.log(`    drew ${drawn}/${lines.length} trigger annotation line(s)  |  T-A orange, T-B purple`);
}

async function processTab(tab, config, analysisJson) {
  console.log(`\n── ${config.label} (${tab.url.split('?')[0].split('/').slice(-2)[0]}) ──`);
  const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: tab.id });
  await client.Runtime.enable();
  const run = makeRunner(client);

  const paneCount = await run(`window.TradingViewApi._chartWidgetCollection.getAll().length`);

  // Cleanup phase: hand-drawn horizontal lines (includes old [T-A]/[T-B]
  // annotations from prior runs) + auto rectangles across all panes
  let totalHand = 0, totalAuto = 0;
  for (let i = 0; i < paneCount; i++) {
    await focusPane(run, i);
    const r = await cleanupPane(run);
    totalHand += r.handLines;
    totalAuto += r.autoRects;
  }
  console.log(`    cleanup: removed ${totalHand} hand-drawn/annotation horizontal line(s), ${totalAuto} auto rectangle(s)`);

  // Draw phase: daily-TF deep zones on pane 1 (layout-shared render)
  const drawPane = Math.min(1, paneCount - 1);
  try { await drawDeepZones(run, drawPane, config.depthBelow); }
  catch (e) { console.log(`    draw failed: ${e.message}`); }

  // Trigger annotations: horizontal lines at Trigger A / B entry/stop/T1/T2
  // using values from multi_timeframe_analysis JSON. Focus pane 1 (drawings
  // are layout-shared so they render on all panes).
  const entryNotes = analysisJson?.final?.[config.key]?.entry_notes;
  if (entryNotes) {
    await focusPane(run, drawPane);
    const lastTime = await run(`
      (function() {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var bars = chart._chartWidget.model().mainSeries().bars();
        var v = bars.valueAt(bars.lastIndex());
        return v ? v[0] : Math.floor(Date.now()/1000);
      })()
    `);
    try { await drawTriggerAnnotations(run, config.key, entryNotes, lastTime); }
    catch (e) { console.log(`    trigger annotations failed: ${e.message}`); }
  } else {
    console.log(`    no analysis data for ${config.key} — skipping trigger annotations`);
  }

  await client.close();
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  // STEP 1: run the analysis first so we have the JSON with trigger values
  // available for the per-tab drawing step.
  let analysisJson = null;
  try { analysisJson = await runAnalysisAndCapture(); }
  catch (e) { console.error(`  analysis failed: ${e.message}  (continuing without trigger annotations)`); }

  // STEP 2: cleanup + deep S/R + FVG zones + trigger annotations on each tab
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  STEP 2: Cleanup + deep S/R + FVG zones + trigger lines (SPY + QQQ)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const chartTabs = targets.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
  if (!chartTabs.length) { console.error('No TradingView chart tab found'); process.exit(1); }

  // Identify each tab by the symbol on pane 0
  const matched = [];
  for (const tab of chartTabs) {
    try {
      const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: tab.id });
      await client.Runtime.enable();
      const sym = await client.Runtime.evaluate({
        expression: `
          (function() {
            var w = window.TradingViewApi._chartWidgetCollection.getAll()[0];
            try { return w.model().mainSeries().symbol(); } catch(e) { return ''; }
          })()
        `,
        returnByValue: true,
      }).then(r => r.result.value).catch(() => '');
      await client.close();
      const cfg = TARGETS.find(t => t.match === sym);
      if (cfg) matched.push({ tab, config: cfg });
      else console.log(`    (skipping tab with symbol ${sym || 'unknown'})`);
    } catch (e) {
      console.log(`    tab ${tab.url}: ${e.message}`);
    }
  }

  if (!matched.length) {
    console.error('No SPY or QQQ tab matched. Expected pane 0 symbol BATS:SPY or BATS:QQQ.');
    process.exit(1);
  }

  for (const { tab, config } of matched) {
    try { await processTab(tab, config, analysisJson); }
    catch (e) { console.log(`  ${config.label} failed: ${e.message}`); }
  }

  console.log('\n✅ Pre-market setup complete.');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
