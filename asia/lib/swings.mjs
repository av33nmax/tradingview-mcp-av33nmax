/**
 * asia/lib/swings.mjs
 *
 * Pivot-based swing high / swing low detection (Williams fractal pattern).
 *
 * A bar i is a swing high if its high is the maximum of the window
 * [i-left .. i+right], with at least one strictly-lower bar on each side
 * (no degenerate flat-top swings).
 *
 * Pure math, no TV calls.
 */

/**
 * Find swings in a bars array.
 *
 * @param bars  Array of { time, open, high, low, close, volume }
 * @param left  Bars to the left required to confirm a swing (default 5)
 * @param right Bars to the right required to confirm a swing (default 5)
 *
 * Returns { highs, lows } — each an array of { time, price, index } sorted by
 * time ascending. The most recent items are at the end.
 */
export function findSwings(bars, left = 5, right = 5) {
  if (!Array.isArray(bars) || bars.length < left + right + 1) {
    return { highs: [], lows: [] };
  }

  const highs = [];
  const lows = [];

  for (let i = left; i < bars.length - right; i++) {
    const pivotHigh = bars[i].high;
    const pivotLow = bars[i].low;

    let isHigh = true;
    let isLow = true;
    let strictHigher = 0;
    let strictLower = 0;

    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j].high > pivotHigh) isHigh = false;
      if (bars[j].high < pivotHigh) strictHigher++;
      if (bars[j].low < pivotLow) isLow = false;
      if (bars[j].low > pivotLow) strictLower++;
    }

    // Reject degenerate flat-top / flat-bottom swings
    if (isHigh && strictHigher >= 2) {
      highs.push({ time: bars[i].time, price: pivotHigh, index: i });
    }
    if (isLow && strictLower >= 2) {
      lows.push({ time: bars[i].time, price: pivotLow, index: i });
    }
  }

  return { highs, lows };
}

/**
 * Return the N most recent swings (highs and lows combined and sorted by time).
 * Useful for "what are the last 5 key levels?".
 */
export function recentSwings(bars, n = 5, left = 5, right = 5) {
  const { highs, lows } = findSwings(bars, left, right);
  const combined = [
    ...highs.map((h) => ({ ...h, type: "high" })),
    ...lows.map((l) => ({ ...l, type: "low" })),
  ].sort((a, b) => b.index - a.index);
  return combined.slice(0, n);
}
