/**
 * asia/lib/sr_zones.mjs
 *
 * Multi-timeframe swing support/resistance — single source of truth, shared by
 * the standalone CLI (asia/scripts/draw_sr_zones.mjs) and both daily premarket
 * routines (asia premarket_hsi.mjs + US premarket_setup.mjs).
 *
 * Pipeline: read 1D / 4H / 15m / 5m bars → swing pivots per TF → MERGE
 * super-nearby levels into one (de-clutter) → classify support (below price) /
 * resistance (above) → draw one horizontal line per level, "SZone" / "RZone",
 * right-aligned, on every pane (clean-first, sync-agnostic).
 */
import { findAllChartsBySymbol, readBarsAtResolutionFromTab } from "./multi_tab.mjs";
import { withDrawSession } from "./draw.mjs";
import { findSwings } from "./swings.mjs";

// Per-timeframe: resolution, swing strictness (left/right bars), how many
// recent swings of each type to take, and a significance weight (higher TF =
// stronger; drives the merged price and line thickness).
export const SR_TF_CONFIG = [
  { res: "D",   label: "1D",  count: 90,  lr: 3, take: 8, weight: 4 },
  { res: "240", label: "4H",  count: 120, lr: 3, take: 6, weight: 3 },
  { res: "15",  label: "15m", count: 250, lr: 3, take: 6, weight: 2 },
  { res: "5",   label: "5m",  count: 250, lr: 3, take: 6, weight: 1 },
];

export const SR_DEFAULTS = {
  mergePct: Number(process.env.SR_MERGE_PCT ?? 0.0015), // merge within 0.15% of price
  maxPerSide: Number(process.env.SR_MAX_PER_SIDE ?? 6), // cap lines per side
  resColor: "#EF5350", // red   — resistance
  supColor: "#26A69A", // green — support
  labelRe: "^(SZone|RZone)", // cleanup pattern — only touches our own lines
};

/**
 * Pure: merge candidate swing prices → final zones.
 * candidates = [{ price, tf, weight }]. Returns { rZones, sZones } each
 * sorted high→low, where a zone is { price, side:'R'|'S', tfs[], strength }.
 */
export function mergeSRZones(candidates, lastPrice, opts = {}) {
  const { mergePct, maxPerSide } = { ...SR_DEFAULTS, ...opts };
  if (!Array.isArray(candidates) || !candidates.length || lastPrice == null) {
    return { rZones: [], sZones: [] };
  }
  const threshold = lastPrice * mergePct;
  const sorted = [...candidates].sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const c of sorted) {
    const cur = clusters[clusters.length - 1];
    if (cur && c.price - cur.maxPrice <= threshold) {
      cur.members.push(c);
      cur.maxPrice = Math.max(cur.maxPrice, c.price);
    } else {
      clusters.push({ members: [c], maxPrice: c.price });
    }
  }
  const zones = clusters.map((cl) => {
    const wsum = cl.members.reduce((s, m) => s + m.weight, 0);
    const price = cl.members.reduce((s, m) => s + m.price * m.weight, 0) / wsum;
    const tfs = [...new Set(cl.members.map((m) => m.tf))];
    return { price: Math.round(price * 100) / 100, side: price >= lastPrice ? "R" : "S", tfs, strength: tfs.length };
  });
  const pick = (side) =>
    zones
      .filter((z) => z.side === side)
      .sort((a, b) => b.strength - a.strength || Math.abs(a.price - lastPrice) - Math.abs(b.price - lastPrice))
      .slice(0, maxPerSide)
      .sort((a, b) => b.price - a.price);
  return { rZones: pick("R"), sZones: pick("S") };
}

/**
 * Read every TF for an already-resolved target, compute merged S/R, and draw.
 * target = { tabId, actualSymbol, chartIndices }. Returns a summary object.
 */
export async function drawSRForTarget({ tabId, actualSymbol, chartIndices }, opts = {}) {
  const cfg = { ...SR_DEFAULTS, ...opts };
  const panes = chartIndices;
  const readIdx = panes[0];

  const candidates = [];
  let lastPrice = null;
  for (const tf of SR_TF_CONFIG) {
    const { bars } = await readBarsAtResolutionFromTab(tabId, tf.res, tf.count, { chartIndex: readIdx });
    if (!Array.isArray(bars) || bars.length === 0) continue;
    lastPrice = bars[bars.length - 1].close;
    const { highs, lows } = findSwings(bars, tf.lr, tf.lr);
    for (const h of highs.slice(-tf.take)) candidates.push({ price: h.price, tf: tf.label, weight: tf.weight });
    for (const l of lows.slice(-tf.take)) candidates.push({ price: l.price, tf: tf.label, weight: tf.weight });
  }

  const { rZones, sZones } = mergeSRZones(candidates, lastPrice, cfg);
  const finalZones = [...rZones, ...sZones];

  for (const ci of panes) {
    await withDrawSession(tabId, async (draw) => {
      await draw.removeByLabelMatch(cfg.labelRe);
      for (const z of finalZones) {
        const color = z.side === "R" ? cfg.resColor : cfg.supColor;
        const text = z.side === "R" ? "RZone" : "SZone";
        await draw.hline(z.price, text, color, { linestyle: 0, linewidth: z.strength >= 2 ? 2 : 1 });
      }
    }, { chartIndex: ci });
  }

  return { symbol: actualSymbol, lastPrice, R: rZones.length, S: sZones.length, zones: finalZones };
}

/**
 * Resolve a symbol (e.g. "700", "BATS:SPY") to its tab, then draw S/R.
 * Returns { _missing: true, R:0, S:0 } if no matching tab is loaded.
 */
export async function drawSRForSymbol(symbol, opts = {}) {
  const f = await findAllChartsBySymbol(symbol);
  if (!f) return { symbol, _missing: true, R: 0, S: 0 };
  return drawSRForTarget({ tabId: f.tab.id, actualSymbol: f.actualSymbol, chartIndices: f.chartIndices }, opts);
}
