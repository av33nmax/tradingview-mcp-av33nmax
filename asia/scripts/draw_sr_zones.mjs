#!/usr/bin/env node
/**
 * draw_sr_zones.mjs — CLI for multi-timeframe S/R levels (asia/lib/sr_zones.mjs).
 *
 * Draws swing S/R from 1D / 4H / 15m / 5m, merged + de-cluttered, as SZone /
 * RZone lines. The compute+draw logic lives in the shared lib (also used by
 * both daily premarket routines); this file is just discovery + logging.
 *
 * Usage:
 *   node asia/scripts/draw_sr_zones.mjs            # default HSI
 *   node asia/scripts/draw_sr_zones.mjs 700        # one ticker (HKEX:700)
 *   node asia/scripts/draw_sr_zones.mjs all        # every loaded single-symbol chart
 * Tune live: SR_MERGE_PCT=0.002 SR_MAX_PER_SIDE=6 node asia/scripts/draw_sr_zones.mjs all
 */
import { listTabs, getChartsInTab, normaliseSymbol, findAllChartsBySymbol } from "../lib/multi_tab.mjs";
import { drawSRForTarget } from "../lib/sr_zones.mjs";

process.stdout.on("error", (e) => { if (e.code !== "EPIPE") throw e; });

const SYMBOL = process.argv[2] || process.env.SR_SYMBOL || "HSI";

/** Resolve the symbol arg → [{ tabId, actualSymbol, chartIndices }]. */
async function resolveTargets(arg) {
  if (String(arg).toLowerCase() === "all") {
    const tabs = await listTabs();
    const out = [];
    for (const tab of tabs) {
      const charts = await getChartsInTab(tab.id);
      if (!charts.length) continue;
      const norms = new Set(charts.map((c) => normaliseSymbol(c.symbol)));
      // single-symbol layout = a real ticker chart; skip multi-symbol reference tabs
      if (norms.size === 1) {
        out.push({ tabId: tab.id, actualSymbol: charts[0].symbol, chartIndices: charts.map((c) => c.chartIndex) });
      } else {
        console.log(`[sr] skip ${tab.id.slice(0, 8)} (multi-symbol: ${[...norms].join("/")})`);
      }
    }
    return out;
  }
  const f = await findAllChartsBySymbol(arg);
  return f ? [{ tabId: f.tab.id, actualSymbol: f.actualSymbol, chartIndices: f.chartIndices }] : [];
}

async function main() {
  const targets = await resolveTargets(SYMBOL);
  if (!targets.length) { console.error(`[sr] no chart found for "${SYMBOL}"`); process.exit(1); }
  console.log(`[sr] target(s): ${targets.map((t) => t.actualSymbol).join(", ")}`);

  const summary = [];
  for (const t of targets) {
    try {
      const r = await drawSRForTarget(t);
      console.log(`\n[sr] ${r.symbol} — last≈${r.lastPrice} · ${r.R}R + ${r.S}S`);
      for (const z of r.zones) {
        console.log(`[sr]   ${z.side === "R" ? "RZone" : "SZone"} ${z.price} [${z.tfs.join("/")}] x${z.strength}`);
      }
      summary.push(r);
    } catch (e) {
      console.log(`[sr]   ${t.actualSymbol}: ERROR ${e.message}`);
    }
  }
  console.log(`\n[sr] done: ${summary.map((s) => `${s.symbol} ${s.R}R/${s.S}S`).join("  ·  ")}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("[sr] fatal:", e); process.exit(1); });
