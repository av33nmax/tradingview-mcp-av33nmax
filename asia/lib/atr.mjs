/**
 * asia/lib/atr.mjs
 *
 * ATR (Average True Range) using Wilder's smoothing.
 * Standard 14-period implementation.
 *
 * Pure math, no TV calls.
 */

/**
 * Compute True Range for a single bar relative to the previous bar.
 *   TR = max( high - low, |high - prevClose|, |low - prevClose| )
 */
function trueRange(curr, prev) {
  if (!prev) return curr.high - curr.low;
  return Math.max(
    curr.high - curr.low,
    Math.abs(curr.high - prev.close),
    Math.abs(curr.low - prev.close)
  );
}

/**
 * Compute ATR over a bars array.
 * Uses Wilder's smoothing:
 *   ATR_n = (ATR_{n-1} * (period - 1) + TR_n) / period
 *
 * Returns the latest ATR value, or null if insufficient bars.
 */
export function atr(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null;

  // Initial ATR = simple average of first `period` TRs
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    sum += trueRange(bars[i], bars[i - 1]);
  }
  let atrValue = sum / period;

  // Wilder smoothing for the rest
  for (let i = period + 1; i < bars.length; i++) {
    const tr = trueRange(bars[i], bars[i - 1]);
    atrValue = (atrValue * (period - 1) + tr) / period;
  }

  return atrValue;
}

/**
 * Compute ATR as a percentage of the last close (useful for cross-asset comparison).
 */
export function atrPct(bars, period = 14) {
  const a = atr(bars, period);
  if (a == null) return null;
  const lastClose = bars[bars.length - 1]?.close;
  if (!lastClose) return null;
  return (a / lastClose) * 100;
}
