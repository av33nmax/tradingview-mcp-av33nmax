/**
 * asia/lib/multi_tf.mjs
 *
 * Orchestrate multi-timeframe analysis for a single index tab.
 *
 * For each TF in [D, H4, H1, M15]:
 *   - Switch tab to that TF
 *   - Pull bars
 *   - Restore tab's original TF
 *   - Compute trend (close vs SMA20 with 1% tolerance band)
 *
 * Then:
 *   - From D bars: extract recent swings (= "key levels")
 *   - From H1 bars: extract unfilled FVGs (= "imbalance zones")
 *   - Compute trend alignment across all 4 TFs
 */

import { readBarsAtResolutionFromTab } from "./multi_tab.mjs";
import { recentSwings } from "./swings.mjs";
import { recentUnfilledFVGs } from "./fvg.mjs";
import { computeOvernightRange, computePriorLevels } from "./levels.mjs";

const TIMEFRAMES = [
  { code: "D", label: "Daily", barCount: 100 },
  { code: "240", label: "H4", barCount: 120 },
  { code: "60", label: "H1", barCount: 150 },
  { code: "15", label: "M15", barCount: 150 },
];

/**
 * Compute SMA-based trend for a single bars array.
 * Returns "bullish" | "bearish" | "neutral" | "unknown".
 */
function detectTrend(bars, smaPeriod = 20, toleranceBand = 0.01) {
  if (!Array.isArray(bars) || bars.length < smaPeriod) return "unknown";
  const recent = bars.slice(-smaPeriod);
  const sma = recent.reduce((s, b) => s + b.close, 0) / smaPeriod;
  const last = bars[bars.length - 1].close;
  if (last > sma * (1 + toleranceBand)) return "bullish";
  if (last < sma * (1 - toleranceBand)) return "bearish";
  return "neutral";
}

/**
 * Aggregate trend votes across timeframes.
 * Returns "bullish_all" | "bearish_all" | "bullish_majority" | "bearish_majority" | "mixed".
 */
function alignTrends(trendsByTF) {
  const votes = Object.values(trendsByTF).filter((t) => t !== "unknown");
  if (votes.length === 0) return "unknown";
  const bull = votes.filter((t) => t === "bullish").length;
  const bear = votes.filter((t) => t === "bearish").length;
  const neut = votes.length - bull - bear;
  if (bull === votes.length) return "bullish_all";
  if (bear === votes.length) return "bearish_all";
  if (bull > bear && bull >= votes.length / 2) return "bullish_majority";
  if (bear > bull && bear >= votes.length / 2) return "bearish_majority";
  return "mixed";
}

/**
 * Run full multi-TF analysis on a single index tab.
 *
 * @param tabId          CDP target id (from findTabBySymbol)
 * @param actualSymbol   The actual symbol string (for logging)
 *
 * Returns:
 * {
 *   symbol,
 *   timeframes: { D: { trend, bar_count }, "240": {...}, "60": {...}, "15": {...} },
 *   trend_alignment,
 *   key_levels:   [ { time, price, type, tf } ],     // top swings from D
 *   fvg_zones:    [ { type, low, high, time, tf } ], // unfilled FVGs from H1
 * }
 */
export async function analyzeMultiTF(tabId, actualSymbol, opts = {}) {
  const result = {
    symbol: actualSymbol,
    chart_index: opts.chartIndex ?? 0,
    timeframes: {},
    trend_alignment: null,
    key_levels: [],
    fvg_zones: [],
    overnight: null,
    prior_high: null,
    prior_low: null,
  };

  const trends = {};
  let dailyBars = null;
  let h1Bars = null;
  let m15Bars = null;

  // Run TF reads sequentially to avoid racing on the same tab's resolution.
  for (const tf of TIMEFRAMES) {
    const { bars, original_tf, switched } = await readBarsAtResolutionFromTab(
      tabId,
      tf.code,
      tf.barCount,
      { chartIndex: opts.chartIndex }
    );
    const trend = detectTrend(bars);
    trends[tf.code] = trend;
    result.timeframes[tf.code] = {
      label: tf.label,
      trend,
      bar_count: bars.length,
      switched_from: switched ? original_tf : null,
    };
    if (tf.code === "D") dailyBars = bars;
    if (tf.code === "60") h1Bars = bars;
    if (tf.code === "15") m15Bars = bars;
  }

  result.trend_alignment = alignTrends(trends);

  // Key levels from Daily — top 5 most recent swings
  if (dailyBars) {
    result.key_levels = recentSwings(dailyBars, 5, 5, 5).map((s) => ({
      ...s,
      tf: "D",
    }));
  }

  // FVG zones from H1 — top 3 unfilled FVGs
  if (h1Bars) {
    result.fvg_zones = recentUnfilledFVGs(h1Bars, 3).map((f) => ({
      ...f,
      tf: "60",
    }));
  }

  // Overnight range from M15 — the HK-futures night session (17:15–03:00 HKT).
  // Returns null for cash equities (no night session); caller draws nothing.
  if (m15Bars) {
    result.overnight = computeOvernightRange(m15Bars);
  }
  // Prior-day H/L (PDH/PDL) — the pre-open reference for instruments with no
  // night session (cash stocks). HSI uses overnight above; stocks fall back here.
  if (dailyBars) {
    const pl = computePriorLevels(dailyBars);
    result.prior_high = pl.prev_high;
    result.prior_low = pl.prev_low;
  }

  return result;
}
