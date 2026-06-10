#!/usr/bin/env node
/**
 * draw_sr_zones.mjs — CLI for multi-timeframe S/R levels (asia/lib/sr_zones.mjs).
 *
 * Draws swing S/R from 1D / 4H / 15m / 5m, merged + de-cluttered, as SZone /
 * RZone lines. A symbol's zones are drawn on EVERY tab it appears on — the
 * dedicated multi-pane ticker tab AND any overview-tab pane. The compute+draw
 * logic lives in the shared lib (also used by both daily premarket routines).
 *
 * Usage:
 *   node asia/scripts/draw_sr_zones.mjs            # default HSI
 *   node asia/scripts/draw_sr_zones.mjs 700        # one ticker (HKEX:700)
 *   node asia/scripts/draw_sr_zones.mjs all        # every dedicated ticker chart
 * Tune live: SR_MERGE_PCT=0.002 SR_MAX_PER_SIDE=6 node asia/scripts/draw_sr_zones.mjs all
 */
import { listTabs, getChartsInTab, normaliseSymbol } from "../lib/multi_tab.mjs";
import { drawSRForSymbol } from "../lib/sr_zones.mjs";

process.stdout.on("error", (e) => { if (e.code !== "EPIPE") throw e; });

const SYMBOL = process.argv[2] || process.env.SR_SYMBOL || "HSI";

/**
 * Resolve the arg → list of symbols to draw. "all" = the universe of
 * dedicated single-symbol tabs (multi-symbol overview/reference tabs don't
 * define the universe — overview panes are covered by the per-symbol mirror,
 * reference symbols like VHSI/VIX are deliberately excluded).
 */
async function resolveSymbols(arg) {
  if (String(arg).toLowerCase() !== "all") return [arg];
  const tabs = await listTabs();
  const universe = new Map(); // norm → display symbol
  for (const tab of tabs) {
    const charts = await getChartsInTab(tab.id);
    if (!charts.length) continue;
    const norms = new Set(charts.map((c) => normaliseSymbol(c.symbol)));
    if (norms.size === 1) {
      const n = [...norms][0];
      if (!universe.has(n)) universe.set(n, charts[0].symbol);
    } else {
      console.log(`[sr] multi-symbol tab ${tab.id.slice(0, 8)} (${[...norms].join("/")}) — covered per symbol`);
    }
  }
  return [...universe.values()];
}

async function main() {
  const symbols = await resolveSymbols(SYMBOL);
  if (!symbols.length) { console.error(`[sr] nothing to draw for "${SYMBOL}"`); process.exit(1); }
  console.log(`[sr] symbols: ${symbols.join(", ")}`);

  const summary = [];
  for (const sym of symbols) {
    try {
      const r = await drawSRForSymbol(sym);
      if (r._missing) { console.log(`\n[sr] ${sym}: no chart found`); continue; }
      console.log(`\n[sr] ${r.symbol} — last≈${r.lastPrice} · ${r.R}R + ${r.S}S → ${r.panes} pane(s) on ${r.tabs} tab(s)`);
      for (const z of r.zones) {
        console.log(`[sr]   ${z.side === "R" ? "RZone" : "SZone"} ${z.price} [${z.tfs.join("/")}] x${z.strength}`);
      }
      summary.push(r);
    } catch (e) {
      console.log(`[sr]   ${sym}: ERROR ${e.message}`);
    }
  }
  console.log(`\n[sr] done: ${summary.map((s) => `${s.symbol} ${s.R}R/${s.S}S (${s.tabs}t)`).join("  ·  ")}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("[sr] fatal:", e); process.exit(1); });
