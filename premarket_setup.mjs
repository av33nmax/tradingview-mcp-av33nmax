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

// EPIPE tolerance — when the dashboard server spawns this script and its
// stdout/stderr pipe gets closed mid-run (component remount, SSE reconnect,
// drawer close), every subsequent console.* call would throw and crash the
// premarket pipeline. Silently swallow EPIPE so the script keeps doing its
// work even if no one is listening. Surface other socket errors normally.
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CDP from 'chrome-remote-interface';
import { pickTarget, buildTargetCandidates, computeEntryConfluence } from './src/target_selector.js';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_NOTES_FILE = path.join(REPO_ROOT, 'latest_entry_notes.json');
const ENTRY_NOTES_PREV  = path.join(REPO_ROOT, 'latest_entry_notes.prev.json');
const ENTRY_NOTES_TMP   = path.join(REPO_ROOT, 'latest_entry_notes.json.tmp');

// ─── entry_notes corruption defenses (P0 2026-04-30) ─────────────────────────
// Wide per-ticker price bounds. Trigger levels (entry, stop, T1, T2 for both
// A and B) must land inside their ticker's range. This catches cross-ticker
// contamination — anchor case 2026-04-30: a re-run produced IWM trigger_b
// with values 659.71/661.36/645.52 (QQQ-range) on a $272 underlying, the
// dashboard showed nonsense levels mid-trade. Wide bounds = update only on
// multi-year bull runs / splits, not on routine moves.
const TICKER_PRICE_BOUNDS = {
  SPY: [400, 1000],
  QQQ: [400, 1000],
  IWM: [150, 400],
  // Stock tickers (added 2026-05-06). Wide bands tolerate normal single-stock
  // volatility but still catch obvious cross-ticker contamination (e.g. an
  // SPY-range $700 leaking into NVDA's price slot).
  AAPL: [120, 400],
  NVDA: [50, 400],
  AMZN: [120, 400],
};

function validateTickerLevels(ticker, payload) {
  const bounds = TICKER_PRICE_BOUNDS[ticker];
  if (!bounds) return { ok: true };
  const [lo, hi] = bounds;
  const inRange = (v) => v == null || (Number.isFinite(v) && v >= lo && v <= hi);

  const a = payload.entry_notes?.trigger_a;
  const b = payload.entry_notes?.trigger_b;
  const checks = [
    a && ['trigger_a.entry', a.entry],
    a && ['trigger_a.stop',  a.stop],
    a && ['trigger_a.T1',    a.T1],
    a && ['trigger_a.T2',    a.T2],
    b && ['trigger_b.entry_vwap',    b.entry_vwap],
    b && ['trigger_b.entry_ema21_1H', b.entry_ema21_1H],
    b && ['trigger_b.stop',          b.stop],
    b && ['trigger_b.T1',            b.T1],
    b && ['trigger_b.T2',            b.T2],
  ].filter(Boolean);

  for (const [field, value] of checks) {
    if (!inRange(value)) {
      return { ok: false, field, value, bounds };
    }
  }

  // Aurora zone bounds check — same per-ticker price range catches
  // cross-ticker contamination (e.g. QQQ-range zones leaking into IWM's
  // aurora_zones). Lenient on empty arrays.
  if (Array.isArray(payload.aurora_zones)) {
    for (let i = 0; i < payload.aurora_zones.length; i++) {
      const z = payload.aurora_zones[i];
      if (!inRange(z?.high)) return { ok: false, field: `aurora_zones[${i}].high`, value: z?.high, bounds };
      if (!inRange(z?.low))  return { ok: false, field: `aurora_zones[${i}].low`,  value: z?.low,  bounds };
    }
  }
  // Session-level bounds check — catches the same cross-ticker contamination
  // pattern for PDH/PDL/PMH/PML (e.g. a QQQ-range PDH leaking into IWM).
  // Lenient on null fields and missing block.
  if (payload.session_levels && typeof payload.session_levels === 'object') {
    for (const k of ['pdh', 'pdl', 'pmh', 'pml']) {
      const v = payload.session_levels[k];
      if (v != null && !inRange(v)) {
        return { ok: false, field: `session_levels.${k}`, value: v, bounds };
      }
    }
  }
  // Cross-field consistency: if bias is BEAR or BULL with aligned=true,
  // trigger_a should have non-null entry. All-null trigger_a on a directional
  // aligned bias is the exact 2026-04-30 IWM failure mode.
  if (payload.aligned === true &&
      (payload.bias === 'BEAR' || payload.bias === 'BULL') &&
      a && a.entry == null && a.stop == null && a.T1 == null && a.T2 == null) {
    return {
      ok: false,
      field: 'trigger_a',
      value: 'all-null',
      reason: `bias=${payload.bias} aligned=true but trigger_a is entirely null — contradictory state`,
    };
  }
  return { ok: true };
}

function validateEntryNotesPayload(out) {
  const failures = [];
  for (const [ticker, payload] of Object.entries(out.tickers ?? {})) {
    const v = validateTickerLevels(ticker, payload);
    if (!v.ok) failures.push({ ticker, ...v });
  }
  return failures;
}

function writeEntryNotesAtomic(out) {
  // Atomic write: tmp → validate → snapshot current → rename. On corruption,
  // recovery is a one-liner: `mv latest_entry_notes.prev.json latest_entry_notes.json`
  const failures = validateEntryNotesPayload(out);
  if (failures.length > 0) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const badFile = path.join(REPO_ROOT, `latest_entry_notes.bad-${ts}.json`);
    fs.writeFileSync(badFile, JSON.stringify(out, null, 2));
    console.error(`\n  ❌ entry_notes validation FAILED — ${failures.length} issue(s):`);
    for (const f of failures) {
      const detail = f.reason ?? `${f.value} not in [${f.bounds?.[0]}-${f.bounds?.[1]}]`;
      console.error(`     ${f.ticker} ${f.field}: ${detail}`);
    }
    console.error(`  → wrote payload for inspection: ${path.basename(badFile)}`);
    console.error(`  → existing ${path.basename(ENTRY_NOTES_FILE)} preserved (NOT overwritten)`);
    return { ok: false, failures, badFile };
  }
  fs.writeFileSync(ENTRY_NOTES_TMP, JSON.stringify(out, null, 2));
  if (fs.existsSync(ENTRY_NOTES_FILE)) {
    fs.copyFileSync(ENTRY_NOTES_FILE, ENTRY_NOTES_PREV);
  }
  fs.renameSync(ENTRY_NOTES_TMP, ENTRY_NOTES_FILE);
  return { ok: true };
}

const CDP_HOST = 'localhost', CDP_PORT = 9222;
const AUTO_LABEL_PREFIX = '[auto] ';
const TRIGGER_A_COLOR = '#ff9500';  // orange
const TRIGGER_B_COLOR = '#c77dff';  // purple
const SESSION_PD_COLOR = '#3b82f6'; // PDH/PDL — solid blue
const SESSION_PM_COLOR = '#38bdf8'; // PMH/PML — dashed lighter blue
const WARNING_COLOR    = '#ef4444'; // entry near opposing level — soft red dashed

// Tabs to process — identified by the pane 0 symbol (robust to URL changes).
// `key` matches the ticker name used in multi_timeframe_analysis.js final[] output.
const TARGETS = [
  { match: 'BATS:SPY', key: 'SPY', label: 'SPY',                depthBelow: 60 },
  { match: 'BATS:QQQ', key: 'QQQ', label: 'QQQ (Iceman Style)', depthBelow: 70 },
  // IWM (Russell 2000 ETF) at ~$276 — depthBelow scaled proportionally
  // (~9% of price, matches SPY/QQQ ratio). User's IWM tab uses BATS prefix
  // (verified 2026-04-28 via tv symbol query against the active tab).
  { match: 'BATS:IWM', key: 'IWM', label: 'IWM (Russell 2000)', depthBelow: 25 },
  // Stock tickers added 2026-05-06. Tabs labeled AAPLIcemanStyle /
  // NVDAIcemanStyle / AMZNIcemanStyle in TV layout; pane-0 symbols are the
  // standard NASDAQ listings. depthBelow scaled to ~9% of underlying price.
  // If the user has these on a different exchange (BATS, NYSE), update the
  // `match` strings here to match what their pane-0 query returns.
  // User's tabs use BATS prefix (verified 2026-05-06 via pane-0 symbol query —
  // the script was skipping these as "BATS:AAPL/NVDA/AMZN" before the prefix fix).
  { match: 'BATS:AAPL', key: 'AAPL', label: 'AAPL (Iceman Style)', depthBelow: 22 },
  { match: 'BATS:NVDA', key: 'NVDA', label: 'NVDA (Iceman Style)', depthBelow: 12 },
  { match: 'BATS:AMZN', key: 'AMZN', label: 'AMZN (Iceman Style)', depthBelow: 20 },
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

// Run a createMultipointShape (or any shape-creating expression) and verify
// that a new shape actually appeared in the active chart widget. The bare
// try/await pattern used previously returned `true` on any non-throwing eval —
// silently masking failures where TV rejected the shape (e.g. wrong active
// pane context after a resolution swap-and-restore). With this helper, the
// "drew N/M" log reflects shapes actually on the chart.
//
// Operates against `_activeChartWidgetWV.value()` so callers must focus the
// intended pane *before* invoking. Returns true iff a fresh id appeared.
async function createShapeVerified(run, shapeExpr) {
  const idsExpr = `
    (function() {
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      var s = api && api.getAllShapes ? api.getAllShapes() : [];
      return s.map(function(x){ return x.id; });
    })()
  `;
  const before = await run(idsExpr).catch(() => []);
  try { await run(shapeExpr); } catch { return false; }
  await new Promise(r => setTimeout(r, 120));
  const after = await run(idsExpr).catch(() => []);
  const beforeSet = new Set(before || []);
  return (after || []).some(id => !beforeSet.has(id));
}

async function cleanupPane(run) {
  return run(`
    (function() {
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      var shapes = api.getAllShapes();
      var legacy = /^(FVG[\u2191\u2193]|[RS]) /;
      var handLines = 0, autoRects = 0, biasLabels = 0;
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
          } else if ((nameLc.indexOf('text') >= 0 || nameLc === 'callout' || nameLc === 'note')
                     && text.indexOf('[BIAS]') === 0) {
            // Bias-label text shapes from prior premarket runs \u2014 wipe so the
            // new one isn't stacked on top of stale labels.
            api.removeEntity(shapes[j].id);
            biasLabels++;
          }
        } catch(e) {}
      }
      return { handLines: handLines, autoRects: autoRects, biasLabels: biasLabels };
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

  // Caps tightened 2026-05-07 to reduce TV renderer load. Earlier
  // values (8 R + 20 S + 20 FVG = 48 max rectangles per tab) drove
  // TradingView Electron renderer crashes ("write EPIPE / App has
  // crashed") on heavy days, especially IWM where ~24 zones consistently
  // landed. Beyond ~12 zones the rectangles overlap visually anyway, so
  // trimming caps reduces stress without losing usable signal.
  const swings = findSwings(ohlc, 5, 5);
  const resistance = swings.highs.filter(p => p.price > lastPrice).slice(-4)
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
  const support = dedupedLows.slice(0, 6)
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
  }).slice(-4);

  console.log(`    ${data.sym} ${data.res}-TF (${ohlc.length} bars): ${resistance.length}R + ${support.length}S + ${unfilled.filter(g => g.type === 'bull').length} bullFVG + ${unfilled.filter(g => g.type === 'bear').length} bearFVG  |  range covers ${minPrice.toFixed(2)} → ${lastPrice.toFixed(2)}+`);

  const extendTo = lastTime + 7 * 24 * 3600;
  // R/S (swing) + FVG zones — DISABLED 2026-06-08 to match the clean template
  //   (user doesn't trade them; the filled rectangles were the main clutter).
  //   Flip DRAW_SWINGS / DRAW_FVG to re-enable.
  const DRAW_SWINGS = false;
  const DRAW_FVG = false;
  const rectangles = [
    ...(DRAW_SWINGS ? resistance.map(z => ({ from: { t: z.t, p: z.bot }, to: { t: extendTo, p: z.top },
      label: `${AUTO_LABEL_PREFIX}R ${z.top.toFixed(2)}`, color: 'rgba(239, 83, 80, 0.35)', border: '#ef5350' })) : []),
    ...(DRAW_SWINGS ? support.map(z => ({ from: { t: z.t, p: z.bot }, to: { t: extendTo, p: z.top },
      label: `${AUTO_LABEL_PREFIX}S ${z.bot.toFixed(2)}`, color: 'rgba(38, 166, 154, 0.35)', border: '#26a69a' })) : []),
    ...(DRAW_FVG ? unfilled.filter(g => g.type === 'bull').map(g => ({ from: { t: g.t, p: g.bot }, to: { t: extendTo, p: g.top },
      label: `${AUTO_LABEL_PREFIX}FVG↑ ${g.bot.toFixed(2)}-${g.top.toFixed(2)}`, color: 'rgba(66, 165, 245, 0.25)', border: '#42a5f5' })) : []),
    ...(DRAW_FVG ? unfilled.filter(g => g.type === 'bear').map(g => ({ from: { t: g.t, p: g.bot }, to: { t: extendTo, p: g.top },
      label: `${AUTO_LABEL_PREFIX}FVG↓ ${g.top.toFixed(2)}-${g.bot.toFixed(2)}`, color: 'rgba(255, 167, 38, 0.25)', border: '#ffa726' })) : []),
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
    // 200ms (was 50ms) — gives TV's renderer time to commit each shape
    // before the next createMultipointShape call. Tight 50ms loops on heavy
    // tabs (IWM with 24 zones) caused the renderer to fall behind, eventually
    // tripping an internal "write EPIPE" + Electron crash. Adds ~3s per tab
    // in the worst case; well worth it for stability.
    await new Promise(r => setTimeout(r, 200));
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

  async function drawLine(price, label, color, style, width = 2) {
    if (price == null || Number.isNaN(price) || !Number.isFinite(price)) return false;
    const styleCode = style === 'dashed' ? 2 : (style === 'dotted' ? 1 : 0);
    return createShapeVerified(run, `
      (function() {
        var api = window.TradingViewApi._activeChartWidgetWV.value();
        api.createMultipointShape(
          [{ time: ${anchorTime}, price: ${price} }],
          { shape: 'horizontal_line', text: ${JSON.stringify(label)},
            overrides: {
              linecolor: '${color}', linewidth: ${width}, linestyle: ${styleCode},
              showLabel: true, textcolor: '${color}', fontsize: 11,
              horzLabelsAlign: 'right', vertLabelsAlign: 'top', showPrice: true,
            } }
        );
      })()
    `);
  }

  // Per-line styling helpers — Layer 1 visualization.
  // ENTRY line: width 3 + glow if confluence.score ≥ 3,
  //             dashed + warning color if any opposing-direction warning,
  //             default solid otherwise.
  // TARGET line: width 3 if cluster count ≥ 2 (multiple sources confirm),
  //              default width 2 otherwise.
  // SOURCE in label so the operator knows WHY this is T1: "T1 PDH 676.50".
  // Compact labels (2026-05-12): TV's right-axis already shows the price and
  // the chart context already shows the ticker — so the label only needs the
  // role (Entry/T1/T2) + source (PML/PDH/VWAP) + decoration (⚠/★). Cluster
  // members list dropped from the label; the ★ alone communicates "cluster"
  // and the full member list is one tooltip click away in TV.
  const entryStyle = (conf) => {
    if (!conf) return { color: null /* keep base */, style: 'solid', width: 2, prefix: '' };
    if (conf.warning?.count >= 1) {
      return { color: WARNING_COLOR, style: 'dashed', width: 2,
               prefix: `⚠${conf.warning.sources.join('/')} ` };
    }
    if (conf.score >= 3) {
      return { color: null, style: 'solid', width: 3,
               prefix: `★${conf.score} ` };
    }
    return { color: null, style: 'solid', width: 2, prefix: '' };
  };
  const targetStyle = (cluster) => {
    if (cluster?.count >= 2) {
      return { width: 3, suffix: ' ★' };
    }
    return { width: 2, suffix: '' };
  };

  const lines = [];
  const a = entryNotes.trigger_a;
  if (a) {
    if (a.entry != null) {
      const s = entryStyle(a.confluence);
      lines.push({
        price: a.entry,
        label: `[T-A] ${s.prefix}Entry`,
        color: s.color ?? TRIGGER_A_COLOR, style: s.style, width: s.width,
      });
    }
    // Stop deliberately NOT drawn: real stop is an option-premium STP at
    // (fillPrice − OPTION_STOP_OFFSET_USD), which has no fixed mapping to an
    // underlying price level. Showing the structural stop here would be
    // misleading. (User decision 2026-05-04.)
    if (a.T1 != null) {
      const t = targetStyle(a.T1_cluster);
      const src = a.T1_source ? ` ${a.T1_source}` : '';
      lines.push({ price: a.T1, label: `[T-A] T1${src}${t.suffix}`,
                   color: TRIGGER_A_COLOR, style: 'solid', width: t.width });
    }
    if (a.T2 != null) {
      const t = targetStyle(a.T2_cluster);
      const src = a.T2_source ? ` ${a.T2_source}` : '';
      lines.push({ price: a.T2, label: `[T-A] T2${src}${t.suffix}`,
                   color: TRIGGER_A_COLOR, style: 'solid', width: t.width });
    }
  }

  const b = entryNotes.trigger_b;
  if (b) {
    // T-B has per-candidate metadata when available (post-Layer-2). Each
    // candidate's entry line + that candidate's T1/T2 are styled per its OWN
    // confluence. Falls back to the top-level T1/T2/source if per_candidate
    // is missing (older entry_notes).
    const vwapMeta  = b.per_candidate?.vwap  ?? null;
    const emaMeta   = b.per_candidate?.ema21_1H ?? null;

    if (b.entry_vwap != null) {
      const s = entryStyle(vwapMeta?.confluence);
      lines.push({
        price: b.entry_vwap,
        label: `[T-B·V] ${s.prefix}Entry`,
        color: s.color ?? TRIGGER_B_COLOR, style: s.style, width: s.width,
      });
      if (vwapMeta?.T1 != null) {
        const t = targetStyle(vwapMeta.T1_cluster);
        const src = vwapMeta.T1_source ? ` ${vwapMeta.T1_source}` : '';
        lines.push({ price: vwapMeta.T1,
                     label: `[T-B·V] T1${src}${t.suffix}`,
                     color: TRIGGER_B_COLOR, style: 'solid', width: t.width });
      }
      if (vwapMeta?.T2 != null) {
        const t = targetStyle(vwapMeta.T2_cluster);
        const src = vwapMeta.T2_source ? ` ${vwapMeta.T2_source}` : '';
        lines.push({ price: vwapMeta.T2,
                     label: `[T-B·V] T2${src}${t.suffix}`,
                     color: TRIGGER_B_COLOR, style: 'solid', width: t.width });
      }
    }
    if (b.entry_ema21_1H != null) {
      const s = entryStyle(emaMeta?.confluence);
      lines.push({
        price: b.entry_ema21_1H,
        label: `[T-B·E] ${s.prefix}Entry`,
        color: s.color ?? TRIGGER_B_COLOR, style: s.style, width: s.width,
      });
      if (emaMeta?.T1 != null) {
        const t = targetStyle(emaMeta.T1_cluster);
        const src = emaMeta.T1_source ? ` ${emaMeta.T1_source}` : '';
        lines.push({ price: emaMeta.T1,
                     label: `[T-B·E] T1${src}${t.suffix}`,
                     color: TRIGGER_B_COLOR, style: 'solid', width: t.width });
      }
      if (emaMeta?.T2 != null) {
        const t = targetStyle(emaMeta.T2_cluster);
        const src = emaMeta.T2_source ? ` ${emaMeta.T2_source}` : '';
        lines.push({ price: emaMeta.T2,
                     label: `[T-B·E] T2${src}${t.suffix}`,
                     color: TRIGGER_B_COLOR, style: 'solid', width: t.width });
      }
    }
    // Stop deliberately NOT drawn (same rationale as T-A above): real stop is
    // an option-premium STP, no fixed underlying mapping.
    // Fallback for older entry_notes without per_candidate metadata —
    // still draw T1 and T2 even when per_candidate is missing.
    if (!vwapMeta && !emaMeta) {
      if (b.T1 != null)   lines.push({ price: b.T1,   label: `[T-B] T1`,
                                        color: TRIGGER_B_COLOR, style: 'solid', width: 2 });
      if (b.T2 != null)   lines.push({ price: b.T2,   label: `[T-B] T2`,
                                        color: TRIGGER_B_COLOR, style: 'solid', width: 2 });
    }
  }

  // Merge lines that fall at the same (or very close) price into ONE line
  // with a combined tag prefix. TV stacks horizontal-line labels vertically
  // when prices coincide — pre-merging prevents that pile-up.
  //
  // Tolerance is 0.05% of the reference price (~$0.15 at AAPL @ $290,
  // ~$0.37 at SPY @ $735). Group's color/style favors warning (red dashed)
  // over solid; T-A orange wins over T-B purple when both are present;
  // line width is the max in the group; the longest "rest" string survives
  // so cluster ★ and source tags don't get lost.
  const mergedLines = (() => {
    if (lines.length < 2) return lines;
    const sorted = [...lines].sort((a, b) => a.price - b.price);
    const TOL_PCT = 0.0005;
    const groups = [[sorted[0]]];
    for (let i = 1; i < sorted.length; i++) {
      const ref = groups[groups.length - 1][0].price;
      if (Math.abs(sorted[i].price - ref) / ref <= TOL_PCT) {
        groups[groups.length - 1].push(sorted[i]);
      } else {
        groups.push([sorted[i]]);
      }
    }
    return groups.map(g => {
      if (g.length === 1) return g[0];
      const parsed = g.map(ln => {
        const m = /^\[([^\]]+)\]\s*(.*)$/.exec(ln.label);
        return m ? { tag: m[1], rest: m[2] } : { tag: '', rest: ln.label };
      });
      const tags = [...new Set(parsed.map(p => p.tag).filter(Boolean))];
      const longestRest = parsed.reduce((best, p) => p.rest.length > best.length ? p.rest : best, '');
      const anyWarning = g.find(ln => ln.color === WARNING_COLOR);
      const anyTA = g.find(ln => ln.color === TRIGGER_A_COLOR);
      const color = anyWarning?.color ?? anyTA?.color ?? g[0].color;
      const style = anyWarning ? 'dashed' : 'solid';
      const width = Math.max(...g.map(ln => ln.width || 2));
      const price = g.reduce((s, ln) => s + ln.price, 0) / g.length;
      return { price, label: `[${tags.join('+')}] ${longestRest}`, color, style, width };
    });
  })();

  let drawn = 0;
  for (const ln of mergedLines) {
    const ok = await drawLine(ln.price, ln.label, ln.color, ln.style, ln.width ?? 2);
    if (ok) drawn++;
    await new Promise(r => setTimeout(r, 60));
  }
  const mergeNote = mergedLines.length < lines.length ? ` (merged from ${lines.length})` : '';
  console.log(`    drew ${drawn}/${mergedLines.length} trigger annotation line(s)${mergeNote}  |  T-A orange, T-B·V/T-B·E purple, ★=cluster, ⚠=opposing-level warning`);
  // Return the drawn prices so drawSessionLevels can skip any session level
  // that already coincides with a trigger line (avoids [SESS]/[T-*] overlap).
  return mergedLines.map((l) => l.price);
}

// ─── Draw session levels: PDH/PDL (solid blue) + PMH/PML (dashed lighter) ──
// Mirrors drawTriggerAnnotations. Labels use the [SESS] prefix so they are
// cleared on the next run by cleanupPane's "delete non-auto horizontal lines"
// rule (same mechanism that cleans up [T-A]/[T-B] lines).
async function drawSessionLevels(run, ticker, sessionLevels, anchorTime, triggerPrices = []) {
  if (!sessionLevels) {
    console.log(`    no session_levels for ${ticker} — skipping session-level annotations`);
    return;
  }
  // A session level a trigger line already sits on (within 0.05%) would overlap
  // it — the trigger label already names the level (e.g. "T1 PML"), so skip the
  // redundant [SESS] line.
  const onTrigger = (p) =>
    triggerPrices.some(
      (tp) =>
        Number.isFinite(tp) && Number.isFinite(p) && p !== 0 &&
        Math.abs(tp - p) / p <= 0.0005
    );

  async function drawLine(price, label, color, style) {
    if (price == null || Number.isNaN(price) || !Number.isFinite(price)) return false;
    const styleCode = style === 'dashed' ? 2 : (style === 'dotted' ? 1 : 0);
    return createShapeVerified(run, `
      (function() {
        var api = window.TradingViewApi._activeChartWidgetWV.value();
        api.createMultipointShape(
          [{ time: ${anchorTime}, price: ${price} }],
          { shape: 'horizontal_line', text: ${JSON.stringify(label)},
            overrides: {
              linecolor: '${color}', linewidth: 1, linestyle: ${styleCode},
              showLabel: true, textcolor: '${color}', fontsize: 10,
              horzLabelsAlign: 'right', vertLabelsAlign: 'top', showPrice: true,
            } }
        );
      })()
    `);
  }

  const { pdh, pdl, pmh, pml } = sessionLevels;
  const allLines = [
    { price: pdh, label: `[SESS] ${ticker} PDH ${pdh}`, color: SESSION_PD_COLOR, style: 'solid' },
    { price: pdl, label: `[SESS] ${ticker} PDL ${pdl}`, color: SESSION_PD_COLOR, style: 'solid' },
    { price: pmh, label: `[SESS] ${ticker} PMH ${pmh}`, color: SESSION_PM_COLOR, style: 'dashed' },
    { price: pml, label: `[SESS] ${ticker} PML ${pml}`, color: SESSION_PM_COLOR, style: 'dashed' },
  ];
  const lines = allLines.filter((ln) => !onTrigger(ln.price));
  const skipped = allLines.length - lines.length;

  let drawn = 0;
  for (const ln of lines) {
    const ok = await drawLine(ln.price, ln.label, ln.color, ln.style);
    if (ok) drawn++;
    await new Promise(r => setTimeout(r, 60));
  }
  console.log(`    drew ${drawn}/${lines.length} session-level line(s)${skipped ? ` (${skipped} skipped — already on a trigger line)` : ''}  |  PDH/PDL solid blue, PMH/PML dashed`);
}

// ─── Draw bias label at top-right: mirrors dashboard's BULL/BEAR chip ──────
// User-facing visual cue so the operator can glance at the chart and see
// the same bias the dashboard shows for that ticker, without switching to
// the dashboard tab. Anchors to ~25 bars in the future on the time axis
// (so it sits in the empty right-hand area) and to the chart's current
// visible top on the price axis (falls back to last_high × 1.005 then
// last_close × 1.02 if priceRange not readable).
//
// Label format: "[BIAS] {ticker}: BULL 91%" / "BEAR 100%" / "NO_TRADE".
// "[BIAS]" prefix lets cleanupPane wipe stale labels on each new run.
async function drawBiasLabel(run, ticker, tickerData) {
  if (!tickerData) return;
  const bias = tickerData.bias || 'NO_TRADE';
  const pct  = tickerData.bias_pct;
  const pctStr = (typeof pct === 'number') ? ` ${pct}%` : '';
  const label = `[BIAS] ${ticker}: ${bias}${pctStr}`;
  const color = bias === 'BULL' ? '#26a69a'
              : bias === 'BEAR' ? '#ef5350'
              : '#888888';

  // Placement strategy — anchor to the chart's CURRENT MARKET LEVEL.
  // User feedback 2026-05-19: a label floating above the bar area gets lost
  // in empty space; sticking it at the current close keeps it visually
  // attached to where attention already is, and it moves with price action
  // automatically. (v5 attempt to anchor to top-of-visible-area via
  // max-shape-price was rejected in favor of this simpler placement.)
  //
  //   PRICE: lastClose. Simple, intuitive, always inside the visible range.
  //
  //   TIME: rightmost-visible bar index minus 8 bars (small breathing room
  //   from the right edge), converted via indexToUserTime() so it adapts to
  //   user zoom + chart timeframe automatically.
  const placement = await run(`
    (function() {
      try {
        var api = window.TradingViewApi._activeChartWidgetWV.value();
        var chart = api._chartWidget;
        var bars = chart.model().mainSeries().bars();
        var lastIdx = bars.lastIndex();
        var lastBar = bars.valueAt(lastIdx);
        if (!lastBar) return null;
        var lastClose = lastBar[4];
        var prev = bars.valueAt(lastIdx - 1);
        var barSec = (prev && lastBar[0] > prev[0]) ? (lastBar[0] - prev[0]) : 900;
        if (barSec > 86400 || barSec < 30) {
          try {
            var r = String(api.resolution());
            barSec = (r === '1') ? 60 : (r === '5') ? 300 : (r === '15') ? 900
                  : (r === '30') ? 1800 : (r === '60') ? 3600
                  : (r === '240') ? 14400 : (r === 'D') ? 86400 : 900;
          } catch(e) { barSec = 900; }
        }
        // ── TIME: visibleBarsStrictRange._lastBar - 8 bars margin
        var labelTime = lastBar[0] + 30 * barSec; // safe fallback
        try {
          var ts = chart.model().timeScale();
          var vbr = ts.visibleBarsStrictRange();
          if (vbr && typeof vbr._lastBar === 'number') {
            var rightIdx = vbr._lastBar - 8;
            if (ts.indexToUserTime) {
              var t = ts.indexToUserTime(rightIdx);
              if (t) {
                var d = new Date(t);
                if (!isNaN(d.getTime())) labelTime = Math.floor(d.getTime() / 1000);
              }
            }
            if (labelTime === lastBar[0] + 30 * barSec) {
              var baseIdx = ts.baseIndex && ts.baseIndex();
              if (typeof baseIdx === 'number') {
                labelTime = lastBar[0] + (rightIdx - baseIdx) * barSec;
              }
            }
          }
        } catch(e) {}
        // ── PRICE: current market level (lastClose) per user preference
        return { time: labelTime, price: lastClose, _debug: { lastClose: lastClose, barSec: barSec } };
      } catch(e) { return null; }
    })()
  `);
  if (!placement || placement.price == null) {
    console.log(`    bias label skipped — could not compute placement`);
    return;
  }

  const ok = await createShapeVerified(run, `
    (function() {
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      api.createShape(
        { time: ${placement.time}, price: ${placement.price} },
        { shape: 'text', text: ${JSON.stringify(label)},
          overrides: {
            color: '${color}', fontsize: 18, bold: true,
            backgroundColor: 'rgba(0, 0, 0, 0.45)',
            fillBackground: true,
            wordWrap: false,
          } }
      );
    })()
  `);
  if (ok) {
    console.log(`    drew bias label: ${label}`);
  } else {
    console.log(`    bias label draw failed (TV API may have rejected 'text' shape)`);
  }
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

  // Draw phase: daily-TF deep zones on pane 1 (layout-shared render).
  //
  // Skip the deep-zone analysis when pane 1 holds a *different* symbol than
  // pane 0 — e.g. SPY layout has NQ1! futures on pane 1. The script would
  // run findSwings/FVG analysis against NQ1!'s OHLC and try to draw zones at
  // NQ1! prices (~28,500) which are completely off-screen for SPY's price
  // axis (~730). Useless work that also stresses TV's renderer for nothing.
  // The trigger lines and session levels (drawn on pane 0 below) are the
  // important annotations anyway.
  const drawPane = Math.min(1, paneCount - 1);
  let pane1Sym = null, pane0Sym = null;
  if (paneCount > 1) {
    try {
      pane0Sym = await run(`
        (function(){ try { return window.TradingViewApi._chartWidgetCollection.getAll()[0]._chartWidget.model().mainSeries().symbol(); } catch(e) { return null; } })()
      `);
      pane1Sym = await run(`
        (function(){ try { return window.TradingViewApi._chartWidgetCollection.getAll()[1]._chartWidget.model().mainSeries().symbol(); } catch(e) { return null; } })()
      `);
    } catch { /* ignore */ }
  }
  if (pane1Sym && pane0Sym && pane1Sym !== pane0Sym) {
    console.log(`    skipping deep-zone analysis: pane 1 holds ${pane1Sym} ≠ pane 0 ${pane0Sym} (analysis would draw at wrong price scale)`);
  } else {
    try { await drawDeepZones(run, drawPane, config.depthBelow); }
    catch (e) { console.log(`    draw failed: ${e.message}`); }
  }

  // Trigger annotations + session-level annotations both anchor to the
  // latest bar's timestamp, so compute once and reuse.
  //
  // IMPORTANT: focus pane 0 (the ticker pane), NOT drawPane (=1, the deep-zone
  // analysis pane). Shapes created via createMultipointShape are bound to the
  // active chart widget — for tabs where pane 1 holds a *different* symbol
  // than pane 0 (e.g. SPY layout has NQ1! futures on pane 1), drawing while
  // pane 1 is active anchors the lines to that other symbol's price scale,
  // making them invisible at the ticker's price levels. Also read lastTime
  // from pane 0 so the anchor matches the pane the lines render on.
  const entryNotes = analysisJson?.final?.[config.key]?.entry_notes;
  const sessionLevels = analysisJson?.final?.[config.key]?.session_levels;
  if (entryNotes || sessionLevels) {
    await focusPane(run, 0);
    const lastTime = await run(`
      (function() {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var bars = chart._chartWidget.model().mainSeries().bars();
        var v = bars.valueAt(bars.lastIndex());
        return v ? v[0] : Math.floor(Date.now()/1000);
      })()
    `);

    // Trigger annotations: horizontal lines at Trigger A / B entry/stop/T1/T2.
    // Drawings are layout-shared so they render on all panes.
    let triggerPrices = [];
    if (entryNotes) {
      try { triggerPrices = (await drawTriggerAnnotations(run, config.key, entryNotes, lastTime)) || []; }
      catch (e) { console.log(`    trigger annotations failed: ${e.message}`); }
    }

    // Session-boundary levels: PDH/PDL (solid blue) + PMH/PML (dashed lighter).
    // Independent of bias — useful even when no entry is set up. Skip any level
    // a trigger line already sits on (e.g. T1 sourced from PML) to avoid overlap.
    if (sessionLevels) {
      try { await drawSessionLevels(run, config.key, sessionLevels, lastTime, triggerPrices); }
      catch (e) { console.log(`    session-level annotations failed: ${e.message}`); }
    }

    // Bias label at top-right — mirrors the dashboard's BULL/BEAR chip so the
    // operator can glance at the chart and know the bias without context-
    // switching. Independent of trigger setup; renders even on NO_TRADE bias.
    try {
      await drawBiasLabel(run, config.key, analysisJson?.final?.[config.key]);
    } catch (e) { console.log(`    bias label failed: ${e.message}`); }
  } else {
    console.log(`    no analysis data for ${config.key} — skipping annotations`);
  }

  // Aurora supply/demand zones — fetch via CDP for the watcher's confluence
  // gate (suppresses fires within 0.5×ATR of an opposing zone). Best-effort:
  // if Aurora isn't on the chart or fetch fails, return empty array; the
  // watcher gate falls through gracefully.
  //
  // Step 0: if the indicator is present but hidden (visibility toggled off),
  // turn it back on. A hidden Pine script does not emit box.new() primitives,
  // so the zone fetch would return 0 even though the indicator is loaded.
  // After toggling we wait briefly for the chart to re-render the boxes.
  let auroraZones = [];
  try {
    const visStatus = await ensureAuroraVisible(run);
    if (visStatus.toggled > 0) {
      console.log(`    Aurora indicator was hidden — toggled ${visStatus.toggled} study/studies back on`);
      // Re-render delay: Pine primitive emission after setVisible(true) is
      // async; 800 ms is enough for the 4-DTE-style heavy zone scripts.
      await new Promise(r => setTimeout(r, 800));
    } else if (!visStatus.found) {
      console.log(`    Aurora indicator NOT on this chart — load "Supply and Demand Zones" to enable confluence`);
    }
    auroraZones = await fetchAuroraZones(run);
    console.log(`    Aurora zones: ${auroraZones.length} drawn box(es) captured`);
  } catch (e) {
    console.log(`    Aurora zone fetch failed: ${e.message}`);
  }

  await client.close();
  return { ticker: config.key, auroraZones };
}

/**
 * Ensure the Aurora-style supply/demand indicator is visible on the chart.
 * If the user (or a prior session) had toggled the indicator's eye icon off
 * in the legend, Pine stops emitting box.new() primitives entirely — so
 * fetchAuroraZones() returns 0 even though the script is loaded. Calling
 * study.setVisible(true) re-runs the script and re-populates the boxes.
 *
 * Returns { found: bool, toggled: int }:
 *   found   = at least one Aurora/Supply-and-Demand study exists on the chart
 *   toggled = how many of those studies were hidden and have just been shown
 *
 * Matches the same name predicate as fetchAuroraZones (case-insensitive
 * "aurora" OR "supply and demand").
 */
async function ensureAuroraVisible(run) {
  const expr = `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var sources = chart.model().model().dataSources();
      var found = 0, toggled = 0;
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          var lc = name.toLowerCase();
          if (lc.indexOf('aurora') === -1 && lc.indexOf('supply and demand') === -1) continue;
          found++;
          var isVis = true;
          try { isVis = s.isVisible(); } catch(e) {}
          if (!isVis) {
            try { s.setVisible(true); toggled++; } catch(e) {}
          }
        } catch(e) {}
      }
      return { found: found > 0, toggled: toggled };
    })()
  `;
  const r = await run(expr);
  return (r && typeof r === 'object') ? r : { found: false, toggled: 0 };
}

/**
 * Read all currently-drawn Pine `box.new()` primitives from the Aurora-style
 * supply/demand indicator. The Pine script's metaInfo.description in
 * TradingView is "Supply and Demand Zones" (NOT "Aurora") — the literal
 * "Aurora" filter never matched, so this used to return 0 boxes every run.
 * Matches "Aurora" OR "Supply and Demand" (case-insensitive). Mirrors
 * src/core/data.js getPineBoxes. Returns sorted [{high, low}] zones with
 * duplicates removed. Empty array if the indicator isn't on the chart.
 */
async function fetchAuroraZones(run) {
  const expr = `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var sources = chart.model().model().dataSources();
      var zones = [];
      var seen = {};
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          var lc = name.toLowerCase();
          if (lc.indexOf('aurora') === -1 && lc.indexOf('supply and demand') === -1) continue;
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          var outer = pc.dwgboxes;
          if (!outer) continue;
          var inner = outer.get('boxes');
          if (!inner) continue;
          var coll = inner.get(false);
          if (!coll || !coll._primitivesDataById || coll._primitivesDataById.size === 0) continue;
          coll._primitivesDataById.forEach(function(v) {
            if (v.y1 == null || v.y2 == null) return;
            var hi = Math.round(Math.max(v.y1, v.y2) * 100) / 100;
            var lo = Math.round(Math.min(v.y1, v.y2) * 100) / 100;
            var key = hi + ':' + lo;
            if (!seen[key]) { zones.push({ high: hi, low: lo }); seen[key] = true; }
          });
        } catch(e) {}
      }
      zones.sort(function(a, b) { return b.high - a.high; });
      return zones;
    })()
  `;
  const result = await run(expr);
  return Array.isArray(result) ? result : [];
}

// ─── Layer-2 Aurora re-pass ────────────────────────────────────────────────
// After STEP 2 has fetched Aurora zones, re-run the target selector for the
// ticker with the full candidate set (now including Aurora opposing-zone
// edges). Mutates `tickerEntry` in place. Lenient on missing data.
//
// MIN_R_FLOOR_ATR: minimum distance from entry (in ATR multiples) that any
// candidate must satisfy to be considered as T1/T2. Without this, Aurora
// supply/demand zones sitting right next to entry collapse T1 to ~1 tick
// while the stop stays wide (ORB-derived), producing degenerate R/R like
// 4.86 risk / 0.06 reward = 0.012R (SPY on 2026-05-19). Setting to 0.5 means
// any target must be at least 0.5×ATR(15m) from entry, otherwise it falls
// through to the next eligible candidate (or NO_TRADE if exhausted).
const MIN_R_FLOOR_ATR = 0.5;

function rePickTargetsWithAurora(tickerEntry, auroraZones) {
  const en = tickerEntry?.entry_notes;
  if (!en) return;  // NO_TRADE — nothing to re-pick
  const sl = tickerEntry.session_levels ?? null;
  const atr = en.atr_15m;
  const isCalls = en.direction === 'CALLS';

  function rebuild(orbExtension, orbExtName, recentSwing) {
    return buildTargetCandidates({
      orbExtension, orbExtName, sessionLevels: sl,
      auroraZones, recentSwing, isCalls,
    });
  }

  // ── Trigger A re-pick ────
  const a = en.trigger_a;
  if (a?.entry != null) {
    const orbExt1 = a.T1_raw ?? a.T1;
    const orbExt2 = a.T2_raw ?? a.T2;
    const orbExt1Name = isCalls ? 'ORB+range' : 'ORB-range';
    const orbExt2Name = isCalls ? 'ORB+2x'    : 'ORB-2x';
    const swingA = isCalls
      ? Math.max(a.T1_raw ?? -Infinity, a.T2_raw ?? -Infinity)
      : Math.min(a.T1_raw ?? Infinity, a.T2_raw ?? Infinity);

    const t1 = pickTarget({
      candidates: rebuild(orbExt1, orbExt1Name, /* swing */ null),
      entry: a.entry, isCalls, atr,
      minDistanceAtr: MIN_R_FLOOR_ATR,
    });
    const t2 = pickTarget({
      candidates: rebuild(orbExt2, orbExt2Name, /* swing */ null),
      entry: a.entry, isCalls,
      beyondPrice: t1?.value ?? a.entry, atr,
      minDistanceAtr: MIN_R_FLOOR_ATR,
    });
    if (t1) {
      a.T1 = Math.round(t1.value * 100) / 100;
      a.T1_source = t1.source;
      a.T1_cluster = t1.cluster;
    } else {
      // No eligible T1 past min-R floor — mark trigger A as un-tradeable
      // so the watcher doesn't fire on degenerate targets. NULL stays NULL
      // through to entry_notes; the watcher path skips trigger_a without T1.
      a.T1 = null;
      a.T1_source = 'NO_TRADE_min_R_floor';
      a.T1_cluster = null;
    }
    if (t2) {
      a.T2 = Math.round(t2.value * 100) / 100;
      a.T2_source = t2.source;
      a.T2_cluster = t2.cluster;
    } else {
      a.T2 = null;
      a.T2_source = 'NO_TRADE_min_R_floor';
      a.T2_cluster = null;
    }
    // Re-compute entry confluence with Aurora included
    a.confluence = computeEntryConfluence({
      entry: a.entry, isCalls, sessionLevels: sl,
      vwap: en.trigger_b?.entry_vwap, ema21_1H: en.trigger_b?.entry_ema21_1H,
      auroraZones, atr,
    });
  }

  // ── Trigger B re-pick (per candidate) ────
  const b = en.trigger_b;
  if (b?.per_candidate) {
    for (const which of ['vwap', 'ema21_1H']) {
      const candidate = b.per_candidate[which];
      if (!candidate) continue;
      const candidateEntry = which === 'vwap' ? b.entry_vwap : b.entry_ema21_1H;
      if (candidateEntry == null) continue;
      const orbExt1 = isCalls ? a?.T1_raw : a?.T1_raw;
      const orbExt2 = isCalls ? a?.T2_raw : a?.T2_raw;
      const orbExt1Name = isCalls ? 'ORB+range' : 'ORB-range';
      const orbExt2Name = isCalls ? 'ORB+2x'    : 'ORB-2x';

      const t1 = pickTarget({
        candidates: rebuild(orbExt1, orbExt1Name, /* swing */ null),
        entry: candidateEntry, isCalls, atr,
        minDistanceAtr: MIN_R_FLOOR_ATR,
      });
      const t2 = pickTarget({
        candidates: rebuild(orbExt2, orbExt2Name, /* swing */ null),
        entry: candidateEntry, isCalls,
        beyondPrice: t1?.value ?? candidateEntry, atr,
        minDistanceAtr: MIN_R_FLOOR_ATR,
      });
      if (t1) {
        candidate.T1 = Math.round(t1.value * 100) / 100;
        candidate.T1_source = t1.source;
        candidate.T1_cluster = t1.cluster;
      } else {
        candidate.T1 = null;
        candidate.T1_source = 'NO_TRADE_min_R_floor';
        candidate.T1_cluster = null;
      }
      if (t2) {
        candidate.T2 = Math.round(t2.value * 100) / 100;
        candidate.T2_source = t2.source;
        candidate.T2_cluster = t2.cluster;
      } else {
        candidate.T2 = null;
        candidate.T2_source = 'NO_TRADE_min_R_floor';
        candidate.T2_cluster = null;
      }
      candidate.confluence = computeEntryConfluence({
        entry: candidateEntry, isCalls, sessionLevels: sl,
        vwap: which === 'vwap' ? null : b.entry_vwap,
        ema21_1H: which === 'ema21_1H' ? null : b.entry_ema21_1H,
        auroraZones, atr,
      });
    }
    // Mirror VWAP-candidate's T1/T2 to the top-level for backward compat
    const vwapMeta = b.per_candidate.vwap;
    if (vwapMeta) {
      if (vwapMeta.T1 != null) { b.T1 = vwapMeta.T1; b.T1_source = vwapMeta.T1_source; b.T1_cluster = vwapMeta.T1_cluster; }
      if (vwapMeta.T2 != null) { b.T2 = vwapMeta.T2; b.T2_source = vwapMeta.T2_source; b.T2_cluster = vwapMeta.T2_cluster; }
    }
  }

  // ─── Roll-up: if min-R floor wiped out every trigger's T1, mark the
  // whole entry_notes as NO_TRADE so the watcher path (which reads T1 as
  // a finite number) doesn't try to fire on a null target. The dashboard
  // status printer then shows "skip (min-R floor)" instead of "tradeable".
  const aValid = en.trigger_a?.entry != null && en.trigger_a?.T1 != null;
  const bVwapValid = en.trigger_b?.per_candidate?.vwap?.T1 != null;
  const bEmaValid  = en.trigger_b?.per_candidate?.ema21_1H?.T1 != null;
  if (!aValid && !bVwapValid && !bEmaValid) {
    tickerEntry.entry_notes = null;
    tickerEntry.no_trade_reason =
      `min-R floor (${MIN_R_FLOOR_ATR}×ATR) rejected every target candidate — ` +
      `Aurora zones too close to entry and no structural target further out. ` +
      `Stop is wide vs. nearest target = degenerate R/R, would have produced ` +
      `<0.5R trade. Skip rather than fire.`;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  // STEP 0: tab swap (HK → US). Mirrors asia/scripts/premarket_asia.mjs in
  // reverse — flips Tencent/Alibaba/Xiaomi tabs back to NVDA/AAPL/AMZN per
  // asia/config/tab_swap.json. Tab-limit workaround for TradingView Plus.
  // Wrapped in try/catch + dynamic import so a missing lib never blocks the
  // US routine; idempotent and safe to re-run.
  console.log('  STEP 0: Tab swap (HK → US tickers)');
  try {
    const { swapTabs } = await import('./asia/lib/tab_swap.mjs');
    const r = await swapTabs('asia-to-us');
    console.log(`    swapped ${r.swapped}  |  already on target ${r.alreadyOnTarget}  |  neither tab open ${r.neitherFound}`);
  } catch (e) {
    console.log(`    skipped — ${e instanceof Error ? e.message : String(e)}`);
  }

  // STEP 1: run the analysis first so we have the JSON with trigger values
  // available for the per-tab drawing step.
  let analysisJson = null;
  try { analysisJson = await runAnalysisAndCapture(); }
  catch (e) { console.error(`  analysis failed: ${e.message}  (continuing without trigger annotations)`); }

  // STEP 1.5: persist entry_notes so place_option_order.mjs can consume them.
  // We write even when analysisJson is partial / NO_TRADE so consumers can see
  // exactly what the latest run produced (and skip staging orders accordingly).
  if (analysisJson?.final) {
    const out = {
      generatedAt: new Date().toISOString(),
      tickers: {},
    };
    for (const [ticker, data] of Object.entries(analysisJson.final)) {
      out.tickers[ticker] = {
        bias: data.bias ?? null,
        aligned: data.aligned ?? null,
        entry_notes: data.entry_notes ?? null,  // null when NO_TRADE
        session_levels: data.session_levels ?? null, // PDH/PDL/PMH/PML — present even on NO_TRADE
      };
    }
    try {
      const result = writeEntryNotesAtomic(out);
      if (!result.ok) {
        // Validation failed — defenses already preserved the prior good file
        // and wrote the bad payload for inspection. Abort with non-zero so
        // any caller (including the dashboard ActionsPanel) sees the failure.
        process.exitCode = 2;
        return;
      }
      console.log(`\n  wrote ${path.basename(ENTRY_NOTES_FILE)} — ${Object.keys(out.tickers).length} ticker(s)`);
      for (const [t, d] of Object.entries(out.tickers)) {
        const status = d.entry_notes ? `✓ tradeable (${d.entry_notes.direction})` : `skip (${d.bias})`;
        console.log(`    ${t}: ${status}`);
      }
    } catch (e) {
      console.log(`  ⚠ could not write ${ENTRY_NOTES_FILE}: ${e.message}`);
    }
  }

  // STEP 2: cleanup + deep S/R + FVG zones + trigger annotations on each tab
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  STEP 2: Cleanup + deep S/R + FVG zones + trigger lines (SPY + QQQ)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const chartTabs = targets.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
  if (!chartTabs.length) {
    console.error('❌ No TradingView chart tab found.');
    console.error('   Most common cause: TradingView was just launched and tabs are still loading.');
    console.error('   Try: re-run "Launch TradingView (CDP)" from the dashboard (waits for tab restore),');
    console.error('        OR open your SPY and QQQ charts in TV manually, then retry this command.');
    process.exit(1);
  }

  // Identify each tab by its pane symbols. A tab is processed as a DEDICATED
  // ticker tab only when no OTHER pane holds a different TARGETS symbol.
  // Multi-target tabs (the all-US overview, the US⇄HK swap tab) are routed to
  // the STEP 2.5 mirror pass instead — treating the overview as "a SPY tab"
  // (pre-2026-06-10 behavior) wiped all six panes and redrew only SPY.
  const matched = [];
  const mirrorTabs = [];
  for (const tab of chartTabs) {
    try {
      const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: tab.id });
      await client.Runtime.enable();
      const syms = await client.Runtime.evaluate({
        expression: `
          (function() {
            try {
              var defs = window.TradingViewApi._chartWidgetCollection._chartWidgetsDefs;
              var out = [];
              for (var i = 0; i < defs.length; i++) {
                try { out.push(defs[i].chartWidget.model().mainSeries().symbol()); } catch(e) { out.push(null); }
              }
              return out;
            } catch(e) { return []; }
          })()
        `,
        returnByValue: true,
      }).then(r => r.result.value).catch(() => []);
      await client.close();

      const sym0 = (syms && syms[0]) || '';
      const cfg0 = TARGETS.find(t => t.match === sym0);
      const targetPanes = (syms || [])
        .map((s, idx) => ({ idx, config: TARGETS.find(t => t.match === s) }))
        .filter(p => p.config);
      const distinctTargets = new Set(targetPanes.map(p => p.config.key));

      if (cfg0 && distinctTargets.size <= 1) {
        matched.push({ tab, config: cfg0 });
      } else if (targetPanes.length > 0) {
        mirrorTabs.push({ tab, panes: targetPanes });
        console.log(`    (multi-symbol tab ${tab.id.slice(0, 8)}: ${[...distinctTargets].join('/')} — routed to mirror pass)`);
      } else {
        console.log(`    (skipping tab with symbol ${sym0 || 'unknown'})`);
      }
    } catch (e) {
      console.log(`    tab ${tab.url}: ${e.message}`);
    }
  }

  if (!matched.length) {
    console.error('No SPY or QQQ tab matched. Expected pane 0 symbol BATS:SPY or BATS:QQQ.');
    process.exit(1);
  }

  // 800ms pause between tabs gives TV's main process / renderers a moment
  // to settle (close the prior tab's CDP client, finish rendering committed
  // shapes, run GC) before the next tab's barrage of createMultipointShape
  // calls. Without this, back-to-back tab processing on a heavy day was
  // a contributor to the renderer EPIPE crash. Adds ~4s to total runtime
  // across 6 tabs.
  const auroraByTicker = {};
  let firstTab = true;
  // Multi-TF S/R zones (SZone/RZone) — best-effort, shares asia/lib/sr_zones.mjs
  // with the Asia premarket + standalone CLI. Set DRAW_SR=0 to disable.
  const DRAW_SR_ZONES = process.env.DRAW_SR !== '0';
  for (const { tab, config } of matched) {
    if (!firstTab) await new Promise(r => setTimeout(r, 800));
    firstTab = false;
    try {
      const result = await processTab(tab, config, analysisJson);
      if (result?.ticker) auroraByTicker[result.ticker] = result.auroraZones ?? [];
    } catch (e) { console.log(`  ${config.label} failed: ${e.message}`); }
    // S/R zones — isolated; dynamic import so US premarket never hard-depends on
    // the asia lib, and a failure here can't break the routine.
    if (DRAW_SR_ZONES) {
      try {
        const { drawSRForSymbol } = await import('./asia/lib/sr_zones.mjs');
        const sr = await drawSRForSymbol(config.match);
        console.log(`    S/R: ${sr._missing ? 'no tab' : `${sr.R}R/${sr.S}S @ ${sr.lastPrice}`}`);
      } catch (e) { console.log(`    S/R draw failed: ${e.message}`); }
    }
  }

  // STEP 2.5: mirror trigger/session/bias lines onto overview & swap tabs.
  // Every pane on a multi-symbol tab whose symbol matches a TARGETS config
  // gets the SAME lines its dedicated tab got, drawn by the same functions.
  // Cleanup here is SCOPED to the labels this pass redraws ([SESS]/[T-A]/
  // [T-B]/[BIAS]) — S/R zones and hand-drawn lines on these dashboard tabs
  // survive, unlike the dedicated-tab cleanupPane sweep.
  if (mirrorTabs.length > 0) {
    console.log('\n  STEP 2.5: mirroring lines to overview/swap tabs');
    for (const { tab, panes } of mirrorTabs) {
      let client = null;
      try {
        client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: tab.id });
        await client.Runtime.enable();
        const run = makeRunner(client);
        for (const { idx, config } of panes) {
          const final = analysisJson?.final?.[config.key];
          const entryNotes = final?.entry_notes;
          const sessionLevels = final?.session_levels;
          if (!entryNotes && !sessionLevels) continue;
          try {
            await focusPane(run, idx);
            await run(`
              (function() {
                var api = window.TradingViewApi._activeChartWidgetWV.value();
                var shapes = api.getAllShapes();
                var re = /^\\[(SESS|T-A|T-B|BIAS)/;
                for (var j = 0; j < shapes.length; j++) {
                  try {
                    var s = api.getShapeById(shapes[j].id);
                    var props = s && s.getProperties ? s.getProperties() : null;
                    var text = props && props.text ? String(props.text) : '';
                    if (re.test(text.trim())) api.removeEntity(shapes[j].id);
                  } catch(e) {}
                }
              })()
            `);
            const lastTime = await run(`
              (function() {
                var chart = window.TradingViewApi._activeChartWidgetWV.value();
                var bars = chart._chartWidget.model().mainSeries().bars();
                var v = bars.valueAt(bars.lastIndex());
                return v ? v[0] : Math.floor(Date.now()/1000);
              })()
            `);
            let triggerPrices = [];
            if (entryNotes) {
              try { triggerPrices = (await drawTriggerAnnotations(run, config.key, entryNotes, lastTime)) || []; }
              catch (e) { console.log(`    mirror ${config.key} triggers failed: ${e.message}`); }
            }
            if (sessionLevels) {
              try { await drawSessionLevels(run, config.key, sessionLevels, lastTime, triggerPrices); }
              catch (e) { console.log(`    mirror ${config.key} session levels failed: ${e.message}`); }
            }
            try { await drawBiasLabel(run, config.key, final); } catch (e) { /* cosmetic */ }
            console.log(`    mirrored ${config.key} → tab ${tab.id.slice(0, 8)} pane ${idx}`);
          } catch (e) {
            console.log(`    mirror ${config.key} pane ${idx} failed: ${e.message}`);
          }
        }
      } catch (e) {
        console.log(`    mirror tab ${tab.id.slice(0, 8)} failed: ${e.message}`);
      } finally {
        try { if (client) await client.close(); } catch {}
      }
    }
  }

  // STEP 3: re-write entry_notes with Aurora zones merged in. Reads the
  // file just written in STEP 1.5, augments each ticker with its
  // aurora_zones array, and atomic-rewrites through the same validation
  // pipeline. Lenient: if a ticker had no Aurora data fetched, its
  // aurora_zones is just an empty array — the watcher gate falls through
  // when zones are empty.
  if (Object.keys(auroraByTicker).length > 0 && fs.existsSync(ENTRY_NOTES_FILE)) {
    try {
      const current = JSON.parse(fs.readFileSync(ENTRY_NOTES_FILE, 'utf8'));
      let updated = 0;
      for (const [t, zones] of Object.entries(auroraByTicker)) {
        if (current.tickers?.[t]) {
          current.tickers[t].aurora_zones = zones;
          // ─── Layer-2 re-pass: re-pick T1/T2 with Aurora added ────────────
          // multi_timeframe_analysis.js ran the selector without Aurora.
          // Now we have Aurora zones → re-run with the full candidate set
          // so a wall represented by an Aurora zone can win over the
          // ORB-extension fallback (or even over PDH/PMH if it's nearer).
          rePickTargetsWithAurora(current.tickers[t], zones);
          updated++;
        }
      }
      if (updated > 0) {
        const result = writeEntryNotesAtomic(current);
        if (result.ok) {
          console.log(`\n  augmented ${path.basename(ENTRY_NOTES_FILE)} with Aurora zones + re-picked T1/T2 for ${updated} ticker(s)`);
          // Show post-floor status per ticker so the user sees which setups
          // got demoted to NO_TRADE by the min-R floor (e.g. SPY/IWM/AAPL
          // on 2026-05-19 where Aurora demand sat 1 tick from entry).
          for (const [t, td] of Object.entries(current.tickers)) {
            if (!td) continue;
            if (td.entry_notes) {
              const en = td.entry_notes;
              const a = en.trigger_a ?? {};
              const r = (a.entry != null && a.stop != null && a.T1 != null)
                ? Math.abs(a.T1 - a.entry) / Math.abs(a.stop - a.entry)
                : null;
              const rStr = r != null ? ` (T-A R=${r.toFixed(2)})` : '';
              console.log(`    ${t}: ✓ tradeable (${en.direction})${rStr}`);
            } else {
              const reason = td.no_trade_reason || '';
              const short = reason.startsWith('min-R floor') ? 'NO_TRADE: min-R floor' : `skip (${td.bias || 'NO_TRADE'})`;
              console.log(`    ${t}: ${short}`);
            }
          }
        } else {
          console.log(`\n  ⚠ Aurora-zone augmentation failed validation — original entry_notes preserved`);
        }
      }
    } catch (e) {
      console.log(`\n  ⚠ could not augment with Aurora zones: ${e.message}`);
    }
  }

  console.log('\n✅ Pre-market setup complete.');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
