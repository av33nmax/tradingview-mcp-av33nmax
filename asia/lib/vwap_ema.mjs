/**
 * asia/lib/vwap_ema.mjs — pure math for Trigger B levels.
 *
 * - anchoredSessionVWAP : cumulative session-VWAP from the 09:30 SGT anchor
 * - resampleM15to1H    : aggregate M15 bars into H1 bars (HK clock-aligned)
 * - emaSeries          : standard EMA with Wilder-style SMA seed
 * - getEMA21_1H_AsOf   : EMA21 of H1 bars as-of a timestamp
 * - validateTriggerBBar: pure logic — given a closed bar + level + rVol, does B fire?
 *
 * No IBKR / TV calls. Bars are { time (unix s), open, high, low, close, volume }.
 */

/**
 * Cumulative session-anchored VWAP. Returns the VWAP value at the LAST bar's
 * close, using typical price ((H+L+C)/3) weighted by volume from anchorTs
 * forward. Bars before anchorTs are ignored. HK lunch break creates a gap in
 * the bars array — the cumulative sum simply continues across it.
 *
 * Returns null if no qualifying bars or all-zero volume.
 */
export function anchoredSessionVWAP(bars, anchorTs) {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  let pvSum = 0;
  let vSum = 0;
  for (const b of bars) {
    if (b.time < anchorTs) continue;
    const v = b.volume || 0;
    if (v <= 0) continue;
    const tp = (b.high + b.low + b.close) / 3;
    pvSum += tp * v;
    vSum += v;
  }
  if (vSum <= 0) return null;
  return pvSum / vSum;
}

/**
 * Resample M15 bars to H1 bars, aligned to HK clock hours (HH:00).
 * A H1 bar at hour H contains all M15 bars whose time falls in [H:00, H+1:00).
 * Only emits H1 bars that are FULLY complete given the latest input bar.
 *
 * Implementation: bucket by floor(time / 3600).
 */
export function resampleM15to1H(m15Bars) {
  if (!Array.isArray(m15Bars) || m15Bars.length === 0) return [];
  const buckets = new Map();
  for (const b of m15Bars) {
    const hourTs = Math.floor(b.time / 3600) * 3600;
    let bk = buckets.get(hourTs);
    if (!bk) {
      bk = { time: hourTs, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0, count: 1 };
      buckets.set(hourTs, bk);
    } else {
      bk.high = Math.max(bk.high, b.high);
      bk.low = Math.min(bk.low, b.low);
      bk.close = b.close;
      bk.volume += b.volume || 0;
      bk.count += 1;
    }
  }
  // Sort by hour ascending. Drop the in-progress final hour if it doesn't
  // contain a complete 4 M15 bars — its close is a partial value. Keep the
  // previous fully-closed hour as the "as-of" reference.
  const hours = [...buckets.values()].sort((a, b) => a.time - b.time);
  if (hours.length === 0) return [];
  // Hour is "complete" iff the last M15 bar in the input is at OR past the
  // next hour boundary. Equivalent: bk.count === 4 (HK M15 fits 4 per hour
  // outside the 12:00 lunch — see note below).
  // HK has a 12:00-13:00 lunch break: hour 12 might only have ZERO M15 bars
  // (no trades) which means the bucket won't exist; hour 11 will have 4
  // bars normally. So the "count === 4" rule is fine.
  const lastInputTs = m15Bars[m15Bars.length - 1].time;
  const last = hours[hours.length - 1];
  if (lastInputTs < last.time + 3600 - 1) {
    // Final hour incomplete — drop it. EMA computation will use the
    // previous fully-closed hour as the latest reference.
    return hours.slice(0, -1);
  }
  return hours;
}

/**
 * Standard EMA with SMA seed over the first `period` values.
 * Returns an array same length as values, with NaN for indices < period - 1.
 */
export function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length === 0 || period < 1) return [];
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  const alpha = 2 / (period + 1);
  // Seed: SMA of first `period` values
  let sma = 0;
  for (let i = 0; i < period; i++) sma += values[i];
  sma /= period;
  out[period - 1] = sma;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * alpha + out[i - 1] * (1 - alpha);
  }
  return out;
}

/**
 * EMA21 of the H1 closes, evaluated as-of `ts` (only H1 bars closed before
 * or at ts are used). Returns null if insufficient warmup.
 *
 * Used by Trigger B as the "1H EMA21" reference level. Bias-aware caller
 * decides which side of EMA21 a bar must straddle to fire.
 */
export function getEMA21_1H_AsOf(m15Bars, ts, period = 21) {
  const h1 = resampleM15to1H(m15Bars).filter(b => b.time + 3600 <= ts);
  if (h1.length < period) return null;
  const closes = h1.map(b => b.close);
  const ema = emaSeries(closes, period);
  const last = ema[ema.length - 1];
  return Number.isFinite(last) ? last : null;
}

/**
 * Trigger B reclaim test. Given a closed bar + a level (VWAP or EMA21) +
 * the locked bias direction + the bar's rVol, decide if Trigger B fires.
 *
 * LONG  (bias='BULL'):  open ≤ level AND close > level AND close > open
 * SHORT (bias='BEAR'):  open ≥ level AND close < level AND close < open
 * Plus rVol ≥ threshold.
 *
 * Returns { fires, reason }.
 */
export function validateTriggerBBar({ bar, bias, level, rVol, rVolThreshold }) {
  if (level == null || !Number.isFinite(level)) {
    return { fires: false, reason: 'level unavailable' };
  }
  if (!bar || !Number.isFinite(bar.open) || !Number.isFinite(bar.close)) {
    return { fires: false, reason: 'bar incomplete' };
  }
  if (bias === 'BULL') {
    if (bar.open > level) return { fires: false, reason: `open ${bar.open} > level ${level.toFixed(2)} (need ≤)` };
    if (bar.close <= level) return { fires: false, reason: `close ${bar.close} ≤ level ${level.toFixed(2)} (need >)` };
    if (bar.close <= bar.open) return { fires: false, reason: `bearish body (close ${bar.close} ≤ open ${bar.open})` };
  } else if (bias === 'BEAR') {
    if (bar.open < level) return { fires: false, reason: `open ${bar.open} < level ${level.toFixed(2)} (need ≥)` };
    if (bar.close >= level) return { fires: false, reason: `close ${bar.close} ≥ level ${level.toFixed(2)} (need <)` };
    if (bar.close >= bar.open) return { fires: false, reason: `bullish body (close ${bar.close} ≥ open ${bar.open})` };
  } else {
    return { fires: false, reason: `bias '${bias}' not BULL/BEAR — Trigger B is bias-locked` };
  }
  if (rVol != null && rVol < rVolThreshold) {
    return { fires: false, reason: `rVol ${rVol.toFixed(2)} below threshold ${rVolThreshold}` };
  }
  return { fires: true, reason: `${bias === 'BULL' ? 'reclaim from below' : 'breakdown from above'} (open ${bar.open}, close ${bar.close}, level ${level.toFixed(2)})` };
}
