#!/usr/bin/env node
/**
 * premarket_asia.mjs — unified Asia pre-market routine.
 *
 * Mirrors the US root `premarket_setup.mjs` pattern: ONE entry point that
 * orchestrates every pre-market step in sequence with a single upfront
 * tag-scan cleanup pass per tab (wipes [asia-pm *] AND [ORB *] together).
 *
 * STEPS:
 *   0. Tab-swap (US → HK) — flip the reusable AAPL/AMZN/NVDA tabs to their
 *      HK counterparts (Alibaba/Xiaomi/Tencent) per asia/config/tab_swap.json.
 *      Workaround for the TradingView Plus tab limit. Idempotent.
 *   1. Tag-scan cleanup — wipe ALL [asia-pm *] and [ORB *] shapes on the
 *      4 HK tabs (HSI, Tencent 700, Alibaba 9988, Xiaomi 1810). Robust to
 *      TradingView restarts and missing state files.
 *   2. Ensure realtime symbols — flip any HKEX_DLY: sub-chart back to
 *      HKEX: so subsequent bar reads aren't 15-min stale. Self-healing
 *      against saved layouts that retained the _DLY identifier.
 *   3. refresh_calendar.mjs       → policy events (China/HK news)
 *   4. premarket_hsi.mjs          → multi-TF bias + key levels + FVG draw
 *   5. check_a50_correlation.mjs  → HSI/A50 first-bar agreement (≥10:00 SGT)
 *   6. post_open_orb.mjs          → ORB compute + draw          (≥10:00 SGT)
 *   7. verify_drawings.mjs        → sanity-check that shapes are on chart
 *
 * Steps 5 & 6 are deliberately SKIPPED pre-10:00 SGT — the 30-min opening
 * range isn't complete yet, so there's no ORB to compute / correlation to
 * run. Re-running this script after 10:00 will fill them in (and the upfront
 * cleanup ensures no stacking). The STEP 1 cleanup wipes the PRIOR session's
 * ORB lines either way — stale levels are worse than no levels.
 *
 * Usage:
 *   npm run premarket                       # from asia/
 *   node asia/scripts/premarket_asia.mjs    # from repo root
 *   Asia dashboard → "Pre-market Asia" button
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findTabBySymbol, findChartsAcrossTabs, withTabSession } from '../lib/multi_tab.mjs';
import { withDrawSession } from '../lib/draw.mjs';
import { swapTabs } from '../lib/tab_swap.mjs';

process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });
process.stderr.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = __dirname;

const HK_SYMBOLS = ['HSI', '700', '9988', '1810'];

const SGT_OFFSET_HOURS = 8;
// 30-min ORB (since 2026-06-08): completes at 10:00 SGT (was 09:45 / 15-min).
const ORB_COMPLETE_HOUR_SGT = 10;
const ORB_COMPLETE_MIN_SGT = 0;

function isAfterORBComplete() {
  const now = new Date();
  const sgt = new Date(now.getTime() + SGT_OFFSET_HOURS * 3600 * 1000);
  const minOfDay = sgt.getUTCHours() * 60 + sgt.getUTCMinutes();
  return minOfDay >= ORB_COMPLETE_HOUR_SGT * 60 + ORB_COMPLETE_MIN_SGT;
}

/**
 * Pre-emptive stale-shape cleanup across EVERY tab and pane showing an HK
 * symbol (dedicated ticker tabs, overview tabs, the swap tab). Removes:
 *   - legacy tagged shapes:  [asia-pm *], [ORB *]
 *   - clean-label ORB lines: "ORB H · …", "ORB L · …", "T1 ▲/▼", "T2 ▲/▼"
 *
 * The clean ORB labels matter most: post_open_orb only redraws them at/after
 * 10:00 SGT, so a pre-10:00 premarket must WIPE the prior session's set
 * rather than let it masquerade as today's (2026-06-12: Wednesday's stale
 * T1▲ 24,626 sat one point from Friday's real opening high all morning).
 * PMH/PML/PDH/PDL and SZone/RZone are deliberately NOT wiped here — their
 * owning scripts clean-and-redraw them in later steps.
 *
 * Returns total shapes removed across all tabs/panes (for the run summary).
 */
async function cleanupAllHKTabs() {
  let totalRemoved = 0;
  for (const sym of HK_SYMBOLS) {
    const targets = await findChartsAcrossTabs(sym);
    if (!targets.length) {
      console.log(`  [${sym}] no tab open — skipped`);
      continue;
    }
    let removed = 0;
    let panes = 0;
    for (const target of targets) {
      for (const ci of target.chartIndices) {
        panes++;
        await withDrawSession(target.tab.id, async (draw) => {
          removed += await draw.removeByLabelMatch('^\\[(ORB |asia-pm )');
          removed += await draw.removeByLabelMatch('^(ORB [HL]|T1 [▲▼]|T2 [▲▼])');
        }, { chartIndex: ci });
      }
    }
    console.log(`  [${targets[0].actualSymbol}] removed ${removed} stale shape(s) across ${panes} pane(s) on ${targets.length} tab(s)`);
    totalRemoved += removed;
  }
  return totalRemoved;
}

/**
 * Walk every chart widget in every HK tab and flip any whose symbol prefix is
 * `HKEX_DLY:` to `HKEX:` so we read realtime bars instead of 15-min-delayed
 * ones. TradingView often keeps `HKEX_DLY:` baked into saved chart layouts
 * even after the user re-activates realtime data — this self-heals it on
 * every premarket run. Idempotent: no-op when symbols are already HKEX:.
 *
 * Returns { switched, stillDelayed, alreadyRealtime } for the run summary.
 * If `stillDelayed > 0` after this, the TradingView entitlement cache is
 * likely stale (full Cmd+Q + reopen needed).
 */
async function ensureRealtimeSymbols() {
  const summary = { switched: 0, stillDelayed: 0, alreadyRealtime: 0 };
  for (const sym of HK_SYMBOLS) {
    const found = await findTabBySymbol(sym);
    if (!found) continue;
    await withTabSession(found.tab.id, async (run) => {
      const charts = await run(`(()=>{try{
        return window.TradingViewApi._chartWidgetCollection._chartWidgetsDefs.map((d,i)=>{
          try { return {i, sym: d.chartWidget.model().mainSeries().symbol()}; } catch(e) { return {i, sym: null}; }
        });
      }catch(e){return [];}})()`);
      let switchedHere = 0;
      for (const c of charts || []) {
        if (!c.sym) continue;
        if (/^HKEX:/.test(c.sym)) { summary.alreadyRealtime++; continue; }
        if (!/^HKEX_DLY:/.test(c.sym)) continue;
        const newSym = c.sym.replace(/^HKEX_DLY:/, 'HKEX:');
        const r = await run(`(()=>{try{
          const cw = window.TradingViewApi._chartWidgetCollection._chartWidgetsDefs[${c.i}].chartWidget;
          cw.activeChart ? cw.activeChart().setSymbol(${JSON.stringify(newSym)}) : cw.setSymbol(${JSON.stringify(newSym)}, {});
          return 'ok';
        }catch(e){return 'err';}})()`);
        if (r === 'ok') { summary.switched++; switchedHere++; }
      }
      if (switchedHere === 0) return;
      // Brief wait, then verify any sub-chart still on HKEX_DLY (entitlement issue)
      await new Promise((res) => setTimeout(res, 1500));
      const after = await run(`(()=>{try{
        return window.TradingViewApi._chartWidgetCollection._chartWidgetsDefs.map((d)=>{
          try { return d.chartWidget.model().mainSeries().symbol(); } catch(e) { return null; }
        });
      }catch(e){return [];}})()`);
      for (const s of after || []) {
        if (s && /^HKEX_DLY:/.test(s)) summary.stillDelayed++;
      }
      console.log(`  [${found.actualSymbol}] switched ${switchedHere} sub-chart(s) HKEX_DLY → HKEX`);
    });
  }
  return summary;
}

/**
 * Spawn one of the existing step scripts as a child process, streaming its
 * stdout/stderr through to ours. Returns true on exit code 0.
 *
 * We deliberately spawn-as-child instead of importing each script's logic
 * because (a) the step scripts already self-cleanup with the tag-scan
 * primitive we added — they're idempotent and safe to chain; (b) keeps the
 * existing CLI entry points working untouched; (c) any future change to a
 * step script's internals carries zero risk of breaking the unified run.
 */
function runStep(scriptName, label) {
  return new Promise((resolve) => {
    const scriptPath = path.join(SCRIPTS_DIR, scriptName);
    console.log('\n──────────────────────────────────────');
    console.log(`  ${label}`);
    console.log(`  → node ${scriptName}`);
    console.log('──────────────────────────────────────');
    const child = spawn('node', [scriptPath], { stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code !== 0) console.error(`  ⚠ ${label} exited with code ${code} — continuing`);
      else console.log(`  ✓ ${label} done`);
      resolve(code === 0);
    });
    child.on('error', (err) => {
      console.error(`  ✗ ${label} spawn error: ${err.message}`);
      resolve(false);
    });
  });
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  PREMARKET ASIA — unified pre-market routine');
  console.log('═══════════════════════════════════════════════');
  const startedAt = new Date();
  console.log(`  Started: ${startedAt.toISOString()}`);

  const orbReady = isAfterORBComplete();
  console.log(`  ORB ready (≥10:00 SGT): ${orbReady ? 'YES' : 'NO — ORB + A50 will be skipped (stale ORB lines still wiped in STEP 1)'}`);

  // STEP 0 — tab swap (US → HK). Flips reusable AAPL/AMZN/NVDA tabs to their
  // HK counterparts per asia/config/tab_swap.json. Plus-plan tab-limit workaround.
  console.log('\n──────────────────────────────────────');
  console.log('  STEP 0 — Tab swap (US → HK tickers)');
  console.log('──────────────────────────────────────');
  const swap = await swapTabs('us-to-asia');
  console.log(`  swapped ${swap.swapped}  |  already on target ${swap.alreadyOnTarget}  |  neither tab open ${swap.neitherFound}`);

  // STEP 1 — pre-emptive cleanup on all 4 HK tabs.
  console.log('\n──────────────────────────────────────');
  console.log('  STEP 1 — Clean stale [asia-pm *] and [ORB *] shapes');
  console.log('──────────────────────────────────────');
  const cleaned = await cleanupAllHKTabs();
  console.log(`  total stale shapes removed: ${cleaned}`);

  // STEP 2 — ensure HK charts are on the realtime HKEX: feed (not HKEX_DLY:).
  // Saved chart layouts often retain `_DLY` even after realtime is re-activated.
  console.log('\n──────────────────────────────────────');
  console.log('  STEP 2 — Ensure HK charts on realtime feed (HKEX:, not HKEX_DLY:)');
  console.log('──────────────────────────────────────');
  const fx = await ensureRealtimeSymbols();
  console.log(`  switched ${fx.switched} sub-chart(s) HKEX_DLY → HKEX  |  ${fx.alreadyRealtime} already realtime`);
  if (fx.stillDelayed > 0) {
    console.log(`  ⚠ ${fx.stillDelayed} sub-chart(s) STILL on HKEX_DLY after switch — entitlement cache likely stale (Cmd+Q TradingView and reopen)`);
  }

  // STEP 3 — refresh policy calendar (China/HK news events)
  await runStep('refresh_calendar.mjs', 'STEP 3 — Refresh policy calendar');

  // STEP 4 — multi-TF bias + key levels + FVG draws
  await runStep('premarket_hsi.mjs', 'STEP 4 — Multi-TF bias, key levels, FVG');

  if (orbReady) {
    // STEP 5 — A50/HSI correlation check
    await runStep('check_a50_correlation.mjs', 'STEP 5 — A50/HSI correlation');
    // STEP 6 — ORB compute + draw
    await runStep('post_open_orb.mjs', 'STEP 6 — ORB compute + draw');
  } else {
    console.log('\n──────────────────────────────────────');
    console.log('  STEP 5/6 — SKIPPED (pre-10:00 SGT — 30-min opening range not complete)');
    console.log('  Re-run this routine (or click "ORB triggers") after 10:00 SGT to populate A50 + ORB.');
    console.log('──────────────────────────────────────');
  }

  // STEP 7 — verify drawings (cross-check live shapes vs state)
  await runStep('verify_drawings.mjs', 'STEP 7 — Verify drawings');

  const elapsedMs = Date.now() - startedAt.getTime();
  console.log('\n═══════════════════════════════════════════════');
  console.log(`  PREMARKET ASIA — done in ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log('═══════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('[premarket-asia] Fatal:', err);
  process.exit(1);
});
