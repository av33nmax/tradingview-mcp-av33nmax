/**
 * asia/lib/tab_swap.mjs
 *
 * Flip TradingView chart symbols between US and HK counterparts so the user
 * can reuse the same 3 chart-tab slots for both trading sessions (workaround
 * for the TradingView Plus plan's tab limit).
 *
 * Called from:
 *   - asia/scripts/premarket_asia.mjs   → swapTabs('us-to-asia') at start
 *   - premarket_setup.mjs (root, US)    → swapTabs('asia-to-us') at start
 *
 * Pairs are loaded from asia/config/tab_swap.json. Edit there to change.
 *
 * Safety: if both source and target tabs exist, the function SKIPS (does
 * not duplicate). If neither exists, it skips silently. Only when source is
 * loaded and target isn't does it swap. Re-runs are idempotent.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTabBySymbol, withTabSession, normaliseSymbol } from './multi_tab.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'tab_swap.json');

async function loadConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Iterate EVERY chart widget in a tab and switch any whose current symbol
 * normalises to `sourceNorm` over to `newSymbol`. Charts already on the
 * target are left alone. Returns counts of {switched, alreadyTarget, total}.
 *
 * This is the right primitive for the multi-chart layout TV uses (3 sub-
 * charts per tab — e.g. 15m / 5m / 1m). Switching only chart-index-0 leaves
 * the other 2 sub-charts on the old symbol — the bug the original
 * implementation hit.
 */
async function swapAllChartsInTab(tabId, sourceNorm, targetNorm, newSymbol) {
  return withTabSession(tabId, async (run) => {
    const charts = await run(`(()=>{try{
      return window.TradingViewApi._chartWidgetCollection._chartWidgetsDefs.map((d,i)=>{
        try { return {i, sym: d.chartWidget.model().mainSeries().symbol()}; }
        catch(e) { return {i, sym: null}; }
      });
    }catch(e){return [];}})()`);

    let switched = 0;
    let alreadyTarget = 0;
    for (const c of charts || []) {
      if (!c.sym) continue;
      const n = normaliseSymbol(c.sym);
      if (n === targetNorm) { alreadyTarget++; continue; }
      if (n !== sourceNorm) continue; // unrelated chart in this tab — leave alone
      const r = await run(`(()=>{try{
        const cw = window.TradingViewApi._chartWidgetCollection._chartWidgetsDefs[${c.i}].chartWidget;
        cw.activeChart ? cw.activeChart().setSymbol(${JSON.stringify(newSymbol)}) : cw.setSymbol(${JSON.stringify(newSymbol)}, {});
        return 'ok';
      }catch(e){return 'err';}})()`);
      if (r === 'ok') switched++;
    }
    return { switched, alreadyTarget, total: (charts || []).length };
  });
}

/**
 * Flip tabs from one side to the other.
 *
 * Handles three states correctly:
 *   - All sub-charts on source → swap them all to target.
 *   - Mixed (some source, some target — e.g. after a partial swap) → swap
 *     only the source-side sub-charts; leave the target-side ones alone.
 *   - All sub-charts already on target → skip silently (idempotent).
 *
 * @param direction  'us-to-asia' (run before Asia premarket) or
 *                   'asia-to-us' (run before US premarket)
 * @returns { swapped, alreadyOnTarget, neitherFound, missingConfig }
 */
export async function swapTabs(direction) {
  if (direction !== 'us-to-asia' && direction !== 'asia-to-us') {
    throw new Error(`swapTabs: invalid direction "${direction}"`);
  }
  const config = await loadConfig();
  if (!config || !Array.isArray(config.pairs)) {
    console.log(`  tab_swap config missing/invalid at ${CONFIG_PATH} — skipping flip`);
    return { swapped: 0, alreadyOnTarget: 0, neitherFound: 0, missingConfig: true };
  }

  const isUStoAsia = direction === 'us-to-asia';
  const summary = { swapped: 0, alreadyOnTarget: 0, neitherFound: 0, missingConfig: false };

  for (const pair of config.pairs) {
    const sourceTicker = isUStoAsia ? pair.us : pair.asia;
    const targetTicker = isUStoAsia ? pair.asia : pair.us;
    const targetPrefix = isUStoAsia ? config.asia_prefix : config.us_prefix;
    const sourceLabel  = isUStoAsia ? (pair.label_us || pair.us)   : (pair.label_asia || pair.asia);
    const targetLabel  = isUStoAsia ? (pair.label_asia || pair.asia) : (pair.label_us || pair.us);
    const newSymbol = `${targetPrefix}:${targetTicker}`;
    const sourceNorm = normaliseSymbol(sourceTicker);
    const targetNorm = normaliseSymbol(targetTicker);

    // Find ANY tab matching source OR target. Source takes priority — that's
    // the tab we're flipping FROM. If only target exists, the tab is already
    // fully on the target side; if neither, nothing to do.
    const sourceFound = await findTabBySymbol(sourceTicker);
    const targetFound = sourceFound ? null : await findTabBySymbol(targetTicker);
    const tab = sourceFound ?? targetFound;
    if (!tab) {
      console.log(`  [${sourceLabel} → ${targetLabel}] neither source nor target tab open — skipped`);
      summary.neitherFound++;
      continue;
    }
    const result = await swapAllChartsInTab(tab.tab.id, sourceNorm, targetNorm, newSymbol);
    if (result.switched > 0) {
      console.log(`  [${sourceLabel} → ${targetLabel}] swapped ${result.switched}/${result.total} sub-chart(s) → ${newSymbol}  (${result.alreadyTarget} already on target)`);
      summary.swapped++;
    } else if (result.alreadyTarget > 0) {
      console.log(`  [${sourceLabel} → ${targetLabel}] all ${result.alreadyTarget} sub-chart(s) already on target — skipped`);
      summary.alreadyOnTarget++;
    } else {
      console.log(`  [${sourceLabel} → ${targetLabel}] no source-matching sub-charts found — skipped`);
    }
  }

  // Brief settle for bars to load on the new symbols before downstream reads.
  if (summary.swapped > 0) {
    await new Promise((r) => setTimeout(r, 1500));
  }
  return summary;
}
