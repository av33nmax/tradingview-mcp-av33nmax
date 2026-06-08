/**
 * asia/lib/orb.mjs
 *
 * Opening Range (ORB) detection for HSI/HSTECH morning session.
 *
 * HK cash session opens at 09:30 SGT after a pre-open auction. The opening
 * range is the first 30 min (two M15 bars, 09:30-10:00) — its combined
 * [high, low] is the ORB. (Was the single first M15 bar / 15-min pre-2026-06-08.)
 *
 * Bar timestamps from TradingView are unix seconds. SGT = HKT = UTC+8.
 *
 * Pure math, no TV calls.
 */

const HK_OPEN_HOUR_SGT = 9;
const HK_OPEN_MIN_SGT = 30;
const SGT_OFFSET_HOURS = 8; // SGT/HKT = UTC+8

/**
 * Return the unix timestamp (seconds) of today's 09:30 SGT.
 * If `now` is passed (Date object), uses that as "today"; otherwise uses real now.
 */
export function todaysHKOpenTimestamp(now = new Date()) {
  // Construct today's 09:30 SGT in UTC
  // 09:30 SGT = 01:30 UTC
  const utcOpen = new Date(now);
  utcOpen.setUTCHours(
    HK_OPEN_HOUR_SGT - SGT_OFFSET_HOURS,
    HK_OPEN_MIN_SGT,
    0,
    0
  );
  // If the computed time is in the future for "today UTC" (shouldn't happen often
  // but guard for edge cases when running just past midnight UTC), roll back a day.
  // Note: we want TODAY in SGT, which means anchoring to "today UTC + 8h" date.
  // For pre-market script running 08:30 SGT = 00:30 UTC, today UTC = today SGT.
  // For post-open running 09:45 SGT = 01:45 UTC, same — both safe.
  return Math.floor(utcOpen.getTime() / 1000);
}

/**
 * Find the first M15 bar whose start time is >= targetOpenTs.
 * Returns { bar, index } or null if no bar matches.
 */
export function findOpeningBar(bars, targetOpenTs) {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].time >= targetOpenTs) {
      return { bar: bars[i], index: i };
    }
  }
  return null;
}

/**
 * Compute ORB from M15 bars.
 *
 * @param m15Bars   Array of M15 bars (typically last ~30 bars covering today + yesterday)
 * @param opts      { now: Date, hkOpenTs: number } — override for testing
 *
 * Returns:
 *   {
 *     high, low,                  // ORB high / low (= combined H/L of first 30 min / 2 M15 bars)
 *     range,                      // ORB high - low
 *     range_pct,                  // range as % of midpoint
 *     bar_time,                   // unix ts of the ORB bar
 *     bar_index,                  // index in the input bars array
 *     hk_open_ts,                 // resolved 09:30 SGT timestamp
 *     _waiting?: true,            // present if 09:30 hasn't happened yet
 *     _no_bar_yet?: true,         // present if 09:30 passed but no bar matches yet
 *   }
 */
export function computeORB(m15Bars, opts = {}) {
  const now = opts.now ?? new Date();
  const hkOpenTs = opts.hkOpenTs ?? todaysHKOpenTimestamp(now);
  const nowTs = Math.floor(now.getTime() / 1000);

  // If 09:30 hasn't passed yet, can't compute ORB
  if (nowTs < hkOpenTs) {
    return { _waiting: true, hk_open_ts: hkOpenTs };
  }

  // 30-min ORB: the opening range is the first 30 min (two M15 bars,
  // 09:30-10:00), complete only at 10:00 SGT.
  const orbCompleteTs = hkOpenTs + 30 * 60;
  if (nowTs < orbCompleteTs) {
    return { _waiting: true, hk_open_ts: hkOpenTs, orb_complete_ts: orbCompleteTs };
  }

  // ORB = high/low across every M15 bar in [09:30, 10:00).
  const orbBars = (m15Bars || []).filter(
    (b) => b.time >= hkOpenTs && b.time < orbCompleteTs
  );
  if (orbBars.length === 0) {
    return { _no_bar_yet: true, hk_open_ts: hkOpenTs };
  }

  const high = Math.max(...orbBars.map((b) => b.high));
  const low = Math.min(...orbBars.map((b) => b.low));
  const range = high - low;
  const mid = (high + low) / 2;

  return {
    high,
    low,
    range: Number(range.toFixed(4)),
    range_pct: mid ? Number(((range / mid) * 100).toFixed(3)) : null,
    bar_time: orbBars[0].time,
    bar_index: m15Bars.indexOf(orbBars[0]),
    bars: orbBars.length,
    hk_open_ts: hkOpenTs,
  };
}
