/**
 * asia/lib/levels.mjs
 *
 * Prior-session level computation for HSI / MHI / MTW from raw OHLCV bars.
 *
 * Bars are read from the currently active chart via CDP — caller must ensure
 * the chart symbol is the one being analyzed.
 */

import { evaluate, KNOWN_PATHS } from "./cdp_client.mjs";

/**
 * Get the current chart symbol (e.g. "HKEX:HSImain", "HKEX:MTWmain").
 */
export async function getCurrentSymbol() {
  return evaluate(
    `${KNOWN_PATHS.chartApi}._chartWidget.model().mainSeries().symbol()`
  );
}

/**
 * Get the current chart resolution / timeframe (e.g. "D", "60", "15").
 */
export async function getCurrentResolution() {
  return evaluate(
    `${KNOWN_PATHS.chartApi}._chartWidget.model().mainSeries().interval()`
  );
}

/**
 * Pull the most recent N bars from the main series.
 *
 * Uses TradingView's bars.lastIndex() / bars.valueAt(i) API. Values come back
 * as arrays [time, open, high, low, close, volume].
 *
 * Returns array of { time, open, high, low, close, volume }.
 */
export async function pullRecentBars(count = 60) {
  const expr = `
    (() => {
      try {
        const bars = ${KNOWN_PATHS.mainSeriesBars};
        if (!bars || typeof bars.lastIndex !== 'function') return [];
        const lastIdx = bars.lastIndex();
        const firstIdx = bars.firstIndex ? bars.firstIndex() : Math.max(0, lastIdx - ${count} + 1);
        const startIdx = Math.max(firstIdx, lastIdx - ${count} + 1);
        const out = [];
        for (let i = startIdx; i <= lastIdx; i++) {
          const v = bars.valueAt(i);
          if (!v) continue;
          out.push({
            time: v[0],
            open: v[1],
            high: v[2],
            low:  v[3],
            close: v[4],
            volume: v[5] || 0,
          });
        }
        return out;
      } catch (e) { return { _error: e.message }; }
    })()
  `;
  return evaluate(expr);
}

/**
 * Compute prior-session levels from a bars array.
 *
 * For HSI: "prior session" = the most recent completed daily bar.
 *
 * Returns:
 *   {
 *     prev_high, prev_low, prev_close, prev_open,
 *     prev_range_pct,         // (high-low) / close * 100
 *     overnight_high, overnight_low  // last 12 hourly bars after prior close
 *   }
 */
export function computePriorLevels(dailyBars, hourlyBarsLast12 = []) {
  if (!Array.isArray(dailyBars) || dailyBars.length < 2) {
    return {
      prev_high: null,
      prev_low: null,
      prev_close: null,
      prev_open: null,
      prev_range_pct: null,
      overnight_high: null,
      overnight_low: null,
      _error: "insufficient daily bars",
    };
  }

  // Last bar may be the in-progress session; take second-to-last for "prior"
  const prior = dailyBars[dailyBars.length - 2];
  const prev_high = prior.high;
  const prev_low = prior.low;
  const prev_close = prior.close;
  const prev_open = prior.open;
  const prev_range_pct = prev_close
    ? ((prev_high - prev_low) / prev_close) * 100
    : null;

  // Overnight range: post-close US session bars (if hourly provided)
  let overnight_high = null;
  let overnight_low = null;
  if (Array.isArray(hourlyBarsLast12) && hourlyBarsLast12.length > 0) {
    overnight_high = Math.max(...hourlyBarsLast12.map((b) => b.high));
    overnight_low = Math.min(...hourlyBarsLast12.map((b) => b.low));
  }

  return {
    prev_high,
    prev_low,
    prev_close,
    prev_open,
    prev_range_pct: prev_range_pct ? Number(prev_range_pct.toFixed(2)) : null,
    overnight_high,
    overnight_low,
  };
}

/**
 * Compute the most-recent completed HKEX-futures night-session ("T+1") range
 * from intraday bars — the genuine pre-market / overnight equivalent for HK
 * index futures (HSI). The night session runs 17:15 → 03:00 HKT (next morning).
 *
 * HK *cash equities* (Tencent/Alibaba/Xiaomi) have NO night session, so their
 * intraday bars contain no night-window bars and this returns null — meaning
 * the caller simply draws nothing for them (correct: there's no overnight to show).
 *
 * "Most recent" = the last contiguous night block in the data. On a Monday
 * pre-open that is Friday night (no Sat/Sun session); Tue–Fri it is last night.
 *
 * @param {Array<{time:number, high:number, low:number}>} intradayBars
 *        ≤30m bars including extended hours, time in unix SECONDS, oldest→newest.
 * @returns {{high:number, low:number, from:number, to:number, bars:number}|null}
 */
export function computeOvernightRange(intradayBars) {
  if (!Array.isArray(intradayBars) || intradayBars.length === 0) return null;

  const HKT_OFFSET = 8 * 3600; // HKT = UTC+8

  // Assign each bar to a "night-session day" = the EVENING date it belongs to:
  //   17:15–24:00 HKT → that calendar date
  //   00:00–03:00 HKT → the PREVIOUS calendar date (same overnight session)
  // Non-night bars return null. Grouping by this key (rather than a gap
  // threshold) is robust to sparse/missing bars and correctly stitches the
  // across-midnight half of the session onto its evening.
  const nightKey = (t) => {
    const hktSec = t + HKT_OFFSET;
    const dayNum = Math.floor(hktSec / 86400);
    const minOfDay = Math.floor((hktSec - dayNum * 86400) / 60);
    if (minOfDay >= 17 * 60 + 15) return dayNum;
    if (minOfDay < 3 * 60) return dayNum - 1;
    return null;
  };

  const byKey = new Map();
  let maxKey = null;
  for (const b of intradayBars) {
    const k = nightKey(b.time);
    if (k === null) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(b);
    if (maxKey === null || k > maxKey) maxKey = k;
  }
  if (maxKey === null) return null;
  const block = byKey.get(maxKey);

  return {
    high: Math.max(...block.map((b) => b.high)),
    low: Math.min(...block.map((b) => b.low)),
    from: block[0].time,
    to: block[block.length - 1].time,
    bars: block.length,
  };
}
