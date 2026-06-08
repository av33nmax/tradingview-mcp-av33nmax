/**
 * target_selector.js — Layer 2 of the confluence enrichment pipeline.
 *
 * Picks T1 and T2 prices for Trigger A and Trigger B by selecting the
 * "nearest wall" the price would hit FIRST in the trade direction, from
 * a candidate set drawn from multiple confluence sources.
 *
 * Used by:
 *   - multi_timeframe_analysis.js (initial pass — candidates from ORB,
 *     session levels, recent 15m swings; Aurora not yet available)
 *   - premarket_setup.mjs STEP 3 (re-pass after Aurora zones fetched —
 *     full candidate set including Aurora opposing zone edges)
 *
 * Backward-compat note: callers should continue exposing `T1`, `T2` as
 * plain numbers in entry_notes for existing consumers (watcher,
 * premarket drawing, ibkr_orders). The selector adds new metadata
 * fields (T1_source, T2_source, T1_cluster, T2_cluster) alongside.
 */

/**
 * Pick the candidate the price would hit FIRST in the trade direction.
 *
 * @param {Object} args
 * @param {{name: string, value: number|null}[]} args.candidates  All candidate levels.
 * @param {number}  args.entry      Entry price (used for direction filter).
 * @param {boolean} args.isCalls    true = CALLS / long, false = PUTS / short.
 * @param {number|null} [args.beyondPrice=null]  If given, candidate must lie
 *                                               BEYOND this (used for T2 to
 *                                               select the wall after T1).
 * @param {number|null} [args.atr=null]          ATR used for cluster detection.
 * @param {number} [args.clusterK=0.2]           Candidates within clusterK·ATR
 *                                               of the chosen value count as
 *                                               cluster members.
 * @param {number} [args.minDistanceAtr=0]       Minimum distance from entry,
 *                                               in ATR multiples. Candidates
 *                                               closer than minDistanceAtr×atr
 *                                               are REJECTED. Prevents Aurora
 *                                               supply/demand zones sitting
 *                                               ~1 tick from entry from being
 *                                               picked, which produced
 *                                               degenerate R/R on
 *                                               2026-05-19 (e.g. SPY 4.86
 *                                               risk / 0.06 reward = 0.012R).
 *                                               Requires `atr` to be set;
 *                                               ignored otherwise. Default
 *                                               0 = OFF (preserves prior
 *                                               behavior).
 *
 * @returns {{
 *   value: number,
 *   source: string,
 *   cluster: { count: number, members: string[] },
 *   all_eligible: {name: string, value: number}[],
 * } | null}  null when no candidate qualifies.
 */
export function pickTarget({
  candidates,
  entry,
  isCalls,
  beyondPrice = null,
  atr = null,
  clusterK = 0.2,
  minDistanceAtr = 0,
}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (entry == null || !Number.isFinite(entry)) return null;

  // Min-distance floor. Only enforced when both atr and minDistanceAtr are
  // positive; otherwise no-op and prior behavior preserved.
  const minDist =
    atr != null && atr > 0 && minDistanceAtr > 0 ? minDistanceAtr * atr : 0;

  // Direction + beyond filter. Strictly past entry; for T2 also past T1.
  const eligible = candidates.filter((c) => {
    if (c == null || c.value == null || !Number.isFinite(c.value)) return false;
    if (isCalls) {
      if (c.value <= entry) return false;
      if (beyondPrice != null && c.value <= beyondPrice) return false;
    } else {
      if (c.value >= entry) return false;
      if (beyondPrice != null && c.value >= beyondPrice) return false;
    }
    // Min-distance floor (in ATR multiples). Rejects candidates that would
    // produce degenerate R/R when stop is wide relative to target.
    if (minDist > 0 && Math.abs(c.value - entry) < minDist) return false;
    return true;
  });

  if (eligible.length === 0) return null;

  // Pick the FIRST wall: lowest value for CALLS (closest above),
  // highest value for PUTS (closest below).
  const winner = eligible.reduce((best, c) => {
    if (best == null) return c;
    if (isCalls) return c.value < best.value ? c : best;
    return c.value > best.value ? c : best;
  });

  // Cluster detection — how many other candidates sit near the winner.
  const clusterMembers =
    atr != null && atr > 0
      ? eligible.filter((c) => Math.abs(c.value - winner.value) <= clusterK * atr)
      : [winner];

  return {
    value: winner.value,
    source: winner.name,
    cluster: {
      count: clusterMembers.length,
      members: clusterMembers.map((c) => c.name),
    },
    all_eligible: eligible.map((c) => ({ name: c.name, value: c.value })),
  };
}

/**
 * Build the standard candidate set for a target. Used identically for T1
 * and T2 — only the ORB-extension fallback differs.
 *
 * Aurora zones are passed in directly (caller supplies them after STEP 2
 * fetch in premarket_setup.mjs; multi_timeframe_analysis.js passes []).
 *
 * @param {Object} args
 * @param {number|null} args.orbExtension  ORB high+range (T1) or +2×range (T2).
 * @param {string} args.orbExtName         Human label for the ORB extension.
 * @param {Object|null} args.sessionLevels { pdh, pdl, pmh, pml }.
 * @param {Array<{high:number, low:number}>} [args.auroraZones=[]]
 * @param {number|null} args.recentSwing   The "snap-back to swing" price.
 * @param {boolean} args.isCalls
 *
 * @returns {{name: string, value: number|null}[]}
 */
export function buildTargetCandidates({
  orbExtension,
  orbExtName,
  sessionLevels,
  auroraZones = [],
  recentSwing,
  isCalls,
}) {
  const out = [];
  if (orbExtension != null) out.push({ name: orbExtName, value: orbExtension });

  if (sessionLevels) {
    if (isCalls) {
      if (sessionLevels.pdh != null) out.push({ name: 'PDH', value: sessionLevels.pdh });
      if (sessionLevels.pmh != null) out.push({ name: 'PMH', value: sessionLevels.pmh });
    } else {
      if (sessionLevels.pdl != null) out.push({ name: 'PDL', value: sessionLevels.pdl });
      if (sessionLevels.pml != null) out.push({ name: 'PML', value: sessionLevels.pml });
    }
  }

  if (Array.isArray(auroraZones)) {
    for (const z of auroraZones) {
      if (!z) continue;
      // CALLS hits SUPPLY zones from below — low edge is the "first touch"
      // PUTS hits DEMAND zones from above — high edge is the "first touch"
      if (isCalls && z.low != null) {
        out.push({ name: `Aurora_supply@${z.low.toFixed(2)}-${z.high?.toFixed?.(2) ?? '?'}`, value: z.low });
      } else if (!isCalls && z.high != null) {
        out.push({ name: `Aurora_demand@${z.high.toFixed(2)}-${z.low?.toFixed?.(2) ?? '?'}`, value: z.high });
      }
    }
  }

  if (recentSwing != null && Number.isFinite(recentSwing)) {
    out.push({ name: 'recent_swing', value: recentSwing });
  }

  return out;
}

/**
 * Compute the entry-line CONFLUENCE STYLING signal — how many sources
 * confirm the entry direction vs. how many warn against it.
 *
 *   Confirming source = a level the entry has ALREADY CLEARED in the
 *                       trade direction (acts as flipped support/resistance).
 *   Warning source    = a level within K_OPPOSE × ATR overhead (CALLS) /
 *                       underlying (PUTS) — the proximity gate's domain.
 *
 * Used by premarket_setup.mjs to paint [T-A] / [T-B] entry lines with
 * confluence-aware styling. Pure observability — does NOT move the line.
 *
 * @returns {{
 *   confirming: { count: number, sources: string[] },
 *   warning:    { count: number, sources: string[] },
 *   score: number,            // confirming.count - warning.count
 * }}
 */
export function computeEntryConfluence({
  entry,
  isCalls,
  sessionLevels,
  vwap,
  ema21_1H,
  auroraZones = [],
  atr,
  K_OPPOSE = 0.3,
}) {
  const confirming = [];
  const warning = [];

  const oppositeBand = atr != null ? K_OPPOSE * atr : null;

  function classify(name, value) {
    if (value == null || !Number.isFinite(value)) return;
    if (isCalls) {
      if (value < entry) confirming.push(name);
      else if (oppositeBand != null && value - entry <= oppositeBand) warning.push(name);
    } else {
      if (value > entry) confirming.push(name);
      else if (oppositeBand != null && entry - value <= oppositeBand) warning.push(name);
    }
  }

  if (sessionLevels) {
    classify('PDH', sessionLevels.pdh);
    classify('PDL', sessionLevels.pdl);
    classify('PMH', sessionLevels.pmh);
    classify('PML', sessionLevels.pml);
  }
  classify('VWAP', vwap);
  classify('EMA21_1H', ema21_1H);
  if (Array.isArray(auroraZones)) {
    for (const z of auroraZones) {
      if (!z) continue;
      // Treat each zone as ONE confluence point at its near edge.
      const near = isCalls ? z.low : z.high;
      classify(`Aurora@${near?.toFixed?.(2)}`, near);
    }
  }

  return {
    confirming: { count: confirming.length, sources: confirming },
    warning: { count: warning.length, sources: warning },
    score: confirming.length - warning.length,
  };
}
