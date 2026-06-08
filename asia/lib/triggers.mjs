/**
 * asia/lib/triggers.mjs
 *
 * ORB-based trigger generation for HSI / HSTECH.
 *
 * Inspired by the US side's "Trigger A" (Opening Range Breakout).
 *
 * Conceptually:
 *   - Bullish trigger fires if price breaks above ORB high
 *     - entry  = ORB high
 *     - stop   = ORB low
 *     - T1     = ORB high + 1× range  (1R)
 *     - T2     = ORB high + 2× range  (2R)
 *   - Bearish trigger fires if price breaks below ORB low
 *     - entry  = ORB low
 *     - stop   = ORB high
 *     - T1     = ORB low - 1× range
 *     - T2     = ORB low - 2× range
 *
 * ATR is computed for context (volatility sanity check) but isn't required
 * for the basic trigger structure.
 *
 * Pure math, no TV calls.
 */

import { atr } from "./atr.mjs";

/**
 * Build the symmetric long+short ORB trigger structure.
 *
 * @param orb     Output from computeORB() — must have { high, low, range }
 * @param m15Bars M15 bars for ATR calculation (optional context)
 *
 * Returns:
 *   {
 *     orb: { high, low, range },
 *     long:  { entry, stop, T1, T2, R },
 *     short: { entry, stop, T1, T2, R },
 *     atr_15: number | null,           // ATR-14 on M15 (context)
 *     atr_15_pct: number | null,
 *     range_vs_atr: number | null,     // ratio: bigger ORB than usual = stronger signal
 *   }
 */
export function buildORBTrigger(orb, m15Bars = []) {
  if (!orb || orb._waiting || orb._no_bar_yet || orb.high == null) {
    return { _no_orb: true, ...(orb || {}) };
  }

  const { high, low, range } = orb;
  const R = range; // one "R" = ORB range

  const long = {
    entry: round(high),
    stop: round(low),
    T1: round(high + R),
    T2: round(high + 2 * R),
    R: round(R),
    risk_per_unit: round(R), // entry - stop = R
  };

  const short = {
    entry: round(low),
    stop: round(high),
    T1: round(low - R),
    T2: round(low - 2 * R),
    R: round(R),
    risk_per_unit: round(R),
  };

  const atrValue = m15Bars.length > 14 ? atr(m15Bars, 14) : null;
  const atrPct =
    atrValue != null && high && low
      ? Number(((atrValue / ((high + low) / 2)) * 100).toFixed(3))
      : null;
  const rangeVsAtr = atrValue ? Number((R / atrValue).toFixed(2)) : null;

  return {
    orb: { high: round(high), low: round(low), range: round(R) },
    long,
    short,
    atr_15: atrValue != null ? round(atrValue) : null,
    atr_15_pct: atrPct,
    range_vs_atr: rangeVsAtr,
  };
}

function round(n) {
  if (n == null) return null;
  return Math.round(n * 100) / 100;
}
