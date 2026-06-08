/**
 * asia/lib/fvg.mjs
 *
 * Fair Value Gap detection — the 3-bar pattern where bar[i-2] and bar[i] leave
 * an untraded zone (the "imbalance") that bar[i-1] doesn't cover.
 *
 *   Bullish FVG  (gap up):    bar[i-2].high < bar[i].low
 *                             Zone = [bar[i-2].high, bar[i].low]
 *   Bearish FVG  (gap down):  bar[i-2].low  > bar[i].high
 *                             Zone = [bar[i].high, bar[i-2].low]
 *
 * "Unfilled" = no subsequent bar's range has overlapped into the zone.
 *
 * Pure math, no TV calls.
 */

/**
 * Find all FVGs in a bars array.
 * Returns array of { type: "bullish"|"bearish", low, high, time, index }
 * sorted by index ascending. Most recent items are at the end.
 */
export function findFVGs(bars) {
  if (!Array.isArray(bars) || bars.length < 3) return [];

  const out = [];
  for (let i = 2; i < bars.length; i++) {
    const a = bars[i - 2];
    const c = bars[i];

    // Bullish FVG: prior-prior high below current low (gap up)
    if (a.high < c.low) {
      out.push({
        type: "bullish",
        low: a.high,
        high: c.low,
        time: bars[i - 1].time,
        index: i - 1,
      });
    }

    // Bearish FVG: prior-prior low above current high (gap down)
    if (a.low > c.high) {
      out.push({
        type: "bearish",
        low: c.high,
        high: a.low,
        time: bars[i - 1].time,
        index: i - 1,
      });
    }
  }
  return out;
}

/**
 * Check if a single FVG has been filled by any subsequent bar.
 * "Filled" = a later bar's range [low..high] overlaps with the FVG zone.
 */
function isFilled(fvg, bars) {
  for (let j = fvg.index + 2; j < bars.length; j++) {
    const b = bars[j];
    // Overlap exists if max(starts) < min(ends)
    const overlap = Math.min(b.high, fvg.high) - Math.max(b.low, fvg.low);
    if (overlap > 0) return true;
  }
  return false;
}

/**
 * Find unfilled FVGs only.
 */
export function findUnfilledFVGs(bars) {
  const all = findFVGs(bars);
  return all.filter((fvg) => !isFilled(fvg, bars));
}

/**
 * Return the N most recent unfilled FVGs.
 */
export function recentUnfilledFVGs(bars, n = 3) {
  const unfilled = findUnfilledFVGs(bars);
  return unfilled.slice(-n).reverse(); // most recent first
}
