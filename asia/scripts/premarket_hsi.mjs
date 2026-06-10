#!/usr/bin/env node
/**
 * premarket_hsi.mjs — HSI Morning Pre-Market Setup
 *
 * Run this at ~08:30 SGT, ~1 hour before HK cash open (09:30 SGT).
 *
 * Mirrors the US premarket_setup.mjs flow but for HSI / MHI / MTW.
 *
 * PRECONDITION: TradingView Desktop must be open with the HSI chart loaded
 * as the active tab (any timeframe — the script reads bars directly).
 *
 * Stages:
 *   1. Pull prior session levels (PDH, PDL, PDC) from current HSI chart   [IMPLEMENTED]
 *   2. Pull reference state (A50, CSI300, VHSI, SPX overnight)            [TODO — needs tab mgmt]
 *   3. Multi-TF analysis (D, H4, H1, M15)                                 [TODO]
 *   4. Draw S/R + FVG zones on TradingView                                [TODO]
 *   5. Evaluate gates                                                     [IMPLEMENTED]
 *   6. Post setup card to Discord (#asia-setups)                          [TODO]
 *   7. Write journal entry to asia/journal/YYYY-MM-DD.md                  [IMPLEMENTED]
 *
 * Usage:
 *   npm run premarket:hsi              (from asia/)
 *   node asia/scripts/premarket_hsi.mjs (from repo root)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getClient,
  disconnect,
} from "../lib/cdp_client.mjs";
import { computePriorLevels } from "../lib/levels.mjs";
import {
  readReferenceQuote,
  findTabBySymbol,
  findChartsAcrossTabs,
  readDailyBarsFromTab,
} from "../lib/multi_tab.mjs";
import { analyzeMultiTF } from "../lib/multi_tf.mjs";
import { withDrawSession } from "../lib/draw.mjs";
import { drawSRForSymbol } from "../lib/sr_zones.mjs";
import { evaluatePolicyGate } from "../lib/calendar.mjs";

// Tolerate broken stdout pipes (dashboard may spawn this and disconnect mid-run)
process.stdout.on("error", (err) => {
  if (err.code !== "EPIPE") throw err;
});
process.stderr.on("error", (err) => {
  if (err.code !== "EPIPE") throw err;
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASIA_ROOT = path.resolve(__dirname, "..");

// Toggle Stage 4b multi-TF S/R zones (SZone/RZone). Set DRAW_SR=0 to disable.
const DRAW_SR_ZONES = process.env.DRAW_SR !== "0";

// =============================================================================
// Config loading
// =============================================================================

async function loadConfig() {
  const contracts = JSON.parse(
    await fs.readFile(path.join(ASIA_ROOT, "config/contracts.json"), "utf8")
  );
  const gates = JSON.parse(
    await fs.readFile(path.join(ASIA_ROOT, "config/gates.json"), "utf8")
  );
  return { contracts, gates };
}

// =============================================================================
// Stage 1: Prior session levels — IMPLEMENTED (dual-index, multi-tab)
// =============================================================================

/**
 * Pull prior session levels for one index by finding its tab and reading
 * DAILY bars (switches tab to D, reads, restores TF — see readDailyBarsFromTab).
 * Returns the levels plus the actual symbol found, or { _missing_tab: true }.
 */
async function pullLevelsForIndex(symbolPattern) {
  const found = await findTabBySymbol(symbolPattern);
  if (!found) {
    return { _missing_tab: true, requested: symbolPattern };
  }
  const { bars, original_tf, switched } = await readDailyBarsFromTab(
    found.tab.id,
    60,
    { chartIndex: found.chartIndex }
  );
  if (!Array.isArray(bars) || bars.length === 0) {
    return {
      _error: "no bars returned (D)",
      symbol: found.actualSymbol,
      chart_index: found.chartIndex,
      original_tf,
      switched,
      requested: symbolPattern,
    };
  }
  const levels = computePriorLevels(bars);
  return {
    symbol: found.actualSymbol,
    chart_index: found.chartIndex,
    bar_count: bars.length,
    original_tf,
    switched,
    ...levels,
  };
}

/**
 * Read prior session levels for EVERY primary instrument in parallel.
 *
 * Iterates contracts.primary — adding a new instrument to the config
 * automatically picks it up here.
 *
 * Returns an object keyed by lowercase instrument key:
 *   { mhi: {...}, mtw: {...}, tencent: {...}, ... }
 */
async function pullPriorSessionLevels(primaryInstruments) {
  const keys = Object.keys(primaryInstruments).filter((k) => !k.startsWith("_"));
  console.log(`[stage 1] Reading prior levels for ${keys.length} instruments (${keys.join(", ")})…`);

  const results = await Promise.all(
    keys.map(async (key) => {
      const spec = primaryInstruments[key];
      const pattern = spec.tradingview_search || key;
      const res = await pullLevelsForIndex(pattern);
      return [key.toLowerCase(), res];
    })
  );

  const fmtStatus = (x) => {
    if (x._missing_tab) return "no tab";
    if (x._error) return `error: ${x._error}`;
    const tfNote = x.switched ? ` [TF: ${x.original_tf}→D→${x.original_tf}]` : ` [TF: D]`;
    return `${x.symbol} (${x.bar_count} bars, PDC=${x.prev_close})${tfNote}`;
  };

  const out = {};
  for (const [key, res] of results) {
    out[key] = res;
    console.log(`[stage 1]   ${key.toUpperCase()}: ${fmtStatus(res)}`);
  }
  return out;
}

// =============================================================================
// Stage 2: Reference market state — IMPLEMENTED (multi-tab read)
// =============================================================================

/**
 * Pull reference state by reading background tabs.
 *
 * Requires the user to have these tabs open in TradingView Desktop (any order):
 *   - HSI:VHSI    (HSI volatility index) — VHSI regime gate
 *   - SGX:CN1!    (China A50 futures)    — HSI correlation lead
 *   - SSE:000300  (CSI 300)              — mainland tell
 *   - AMEX:KWEB   (China internet ETF)   — US overnight tell for MTW
 *   - SP:SPX      (S&P 500 cash)         — US overnight tell for HSI
 *
 * Missing tabs are reported as { _missing_tab: true } and don't fail the stage.
 */
async function pullReferenceState() {
  console.log("[stage 2] Reading reference tabs (non-disruptive)…");

  const [a50, csi300, vhsi, kweb, spx] = await Promise.all([
    readReferenceQuote("CN1!").catch((e) => ({ _error: e.message })),
    readReferenceQuote("000300").catch((e) => ({ _error: e.message })),
    readReferenceQuote("VHSI").catch((e) => ({ _error: e.message })),
    readReferenceQuote("KWEB").catch((e) => ({ _error: e.message })),
    readReferenceQuote("SPX").catch((e) => ({ _error: e.message })),
  ]);

  // VHSI regime classification
  let vhsi_with_regime = { ...vhsi };
  if (vhsi.last != null) {
    if (vhsi.last < 15) vhsi_with_regime.regime = "dead_zone";
    else if (vhsi.last > 35) vhsi_with_regime.regime = "panic";
    else vhsi_with_regime.regime = "normal";
  }

  // Log what we found
  const refs = [a50, csi300, vhsi, kweb, spx];
  const found = refs.filter((q) => q.last != null).length;
  console.log(`[stage 2] Got ${found}/${refs.length} reference quotes`);

  return {
    a50,
    csi300,
    vhsi: vhsi_with_regime,
    kweb,
    spx_overnight: {
      close: spx.last ?? null,
      change_pct: spx.change_pct ?? null,
      _missing_tab: spx._missing_tab,
      _error: spx._error,
    },
  };
}

// =============================================================================
// Stage 3: Multi-TF analysis — IMPLEMENTED (per index, D/H4/H1/M15)
// =============================================================================

/**
 * Run multi-TF analysis for one index by finding its tab and analyzing it.
 * Returns the analysis object or { _missing_tab: true }.
 */
async function analyzeIndex(symbolPattern) {
  const found = await findTabBySymbol(symbolPattern);
  if (!found) {
    return { _missing_tab: true, requested: symbolPattern };
  }
  return analyzeMultiTF(found.tab.id, found.actualSymbol, {
    chartIndex: found.chartIndex,
  });
}

/**
 * Stage 3 entry — analyze EVERY primary instrument.
 *
 * Sequential per-instrument (each TF read inside an instrument is sequential
 * because the same tab can't be on two resolutions at once). Across instruments
 * we'd parallelize, but readBarsAtResolutionFromTab opens fresh CDP sessions,
 * so concurrent calls to different tabs work fine — keeping sequential for
 * cleaner logs and lower memory peak.
 */
async function multiTFAnalysis(primaryInstruments) {
  const keys = Object.keys(primaryInstruments).filter((k) => !k.startsWith("_"));
  console.log(`[stage 3] Running multi-TF analysis (D/H4/H1/M15) for ${keys.length} instruments…`);

  const out = {};
  for (const key of keys) {
    const spec = primaryInstruments[key];
    const pattern = spec.tradingview_search || key;
    out[key.toLowerCase()] = await analyzeIndex(pattern);
  }

  const summarise = (a) => {
    if (a._missing_tab) return "no tab";
    return `align=${a.trend_alignment}, levels=${a.key_levels.length}, fvgs=${a.fvg_zones.length}`;
  };
  for (const key of keys) {
    console.log(`[stage 3]   ${key.toUpperCase()}: ${summarise(out[key.toLowerCase()])}`);
  }
  return out;
}

// =============================================================================
// Stage 4: Draw S/R + FVG on TradingView — IMPLEMENTED
// =============================================================================

const STATE_FILE = path.join(ASIA_ROOT, "state", "last_drawn_shapes.json");

/**
 * Load previously-drawn shape IDs (grouped by tab ID).
 * Returns {} on first run or if file missing/corrupt.
 */
async function loadPriorShapeIds() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function savePriorShapeIds(state) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

const SWING_HIGH_COLOR = "#E91E63"; // red
const SWING_LOW_COLOR = "#00C853"; // green
const FVG_BULL_COLOR = "#00C853"; // green (transparency comes from rectangle override)
const FVG_BEAR_COLOR = "#E91E63"; // red   (transparency comes from rectangle override)
const OVERNIGHT_COLOR = "#29B6F6"; // light blue — overnight (night-session) range, drawn dashed

/**
 * Draw key levels + FVG zones for one index on its tab.
 * Cleans up prior shapes for that tab first.
 */
async function drawForIndex(indexLabel, mtfAnalysis, priorShapeIds) {
  if (!mtfAnalysis || mtfAnalysis._missing_tab || mtfAnalysis._error) {
    return { drawn: 0, cleaned: 0, _skipped: indexLabel };
  }

  // Find EVERY pane on EVERY tab showing this symbol — the dedicated
  // multi-pane ticker tab (15m/5m/1m) AND any overview-tab pane. Levels must
  // stay consistent everywhere the symbol is displayed.
  const targets = await findChartsAcrossTabs(indexLabel);
  if (!targets.length) return { drawn: 0, cleaned: 0, _skipped: indexLabel };
  const tabId = targets[0].tab.id;

  const newShapeIds = [];
  let cleaned = 0;
  const tag = `[asia-pm ${indexLabel}]`;

  // Pre-open reference levels (same across panes) — instrument-aware:
  //   • futures (night session): PMH/PML overnight range (dashed) AND PDH/PDL
  //     prior day (solid). Was either/or until 2026-06-10 — the HSI bounce that
  //     day died exactly at the journaled-but-undrawn PDL 24,373. Prior-day
  //     levels matter for futures too.
  //   • cash stocks (no night session): PDH/PDL only.
  // Purple; clean labels (no tag) — cleaned via removeByLabelMatch.
  const PM_COLOR = "#AB47BC";
  const on = mtfAnalysis.overnight;
  const refLevels = [];
  if (on && on.high != null && on.low != null) {
    refLevels.push({ price: on.high, label: "PMH", linestyle: 2 });
    refLevels.push({ price: on.low, label: "PML", linestyle: 2 });
  }
  if (mtfAnalysis.prior_high != null && mtfAnalysis.prior_low != null) {
    // Skip a PD line that sits within 0.05% of its overnight twin — the PM
    // line already marks that price; a second label there is clutter.
    const near = (a, b) => b != null && Math.abs(a - b) / a < 0.0005;
    const pmh = refLevels[0]?.price ?? null;
    const pml = refLevels[1]?.price ?? null;
    if (!near(mtfAnalysis.prior_high, pmh))
      refLevels.push({ price: mtfAnalysis.prior_high, label: "PDH", linestyle: 0 });
    if (!near(mtfAnalysis.prior_low, pml))
      refLevels.push({ price: mtfAnalysis.prior_low, label: "PDL", linestyle: 0 });
  }

  // Daily swing R/S levels + FVG zones — DISABLED 2026-06-08 (decluttered to
  // match the clean template). Flip these to true to re-enable.
  const DRAW_SWINGS = false;
  const DRAW_FVG = false;

  // Draw on EVERY matching pane of EVERY matching tab. Each pane cleans
  // first, then draws — so the end state converges to one clean set per pane
  // whether or not TradingView's drawing-sync is on.
  let paneCount = 0;
  for (const target of targets) {
  for (const ci of target.chartIndices) {
    paneCount++;
    await withDrawSession(target.tab.id, async (draw) => {
      // Tag-scan cleanup (mirrors US premarket_setup). Removes ANY shape on
      // this pane whose label starts with `[asia-pm <label>]`, plus the clean
      // (tag-free) auto-drawn PMH/PML/PDH/PDL rays. Robust against TV restart /
      // stale state-file tab IDs / lost state files.
      cleaned += await draw.removeByTagPrefix(tag);
      cleaned += await draw.removeByLabelMatch('^(PMH|PML|PDH|PDL)( |$)');
      void priorShapeIds; // intentionally unused for cleanup

      for (const level of (DRAW_SWINGS ? (mtfAnalysis.key_levels || []) : [])) {
        const color =
          level.type === "high" ? SWING_HIGH_COLOR : SWING_LOW_COLOR;
        const text = `${tag} ${level.type === "high" ? "↑R" : "↓S"} ${Math.round(level.price)}`;
        const { entity_id } = await draw.hline(level.price, text, color);
        if (entity_id) newShapeIds.push(entity_id);
      }

      const anchorTime = draw.lastBarTime();
      const futureTime = anchorTime + 3 * 24 * 3600;
      for (const fvg of (DRAW_FVG ? (mtfAnalysis.fvg_zones || []) : [])) {
        const color =
          fvg.type === "bullish" ? FVG_BULL_COLOR : FVG_BEAR_COLOR;
        const text = `${tag} FVG ${fvg.type[0].toUpperCase()}`;
        const { entity_id } = await draw.rectangle(
          fvg.low,
          fvg.high,
          fvg.time,
          futureTime,
          color,
          text
        );
        if (entity_id) newShapeIds.push(entity_id);
      }

      for (const lv of refLevels) {
        const r = await draw.hline(lv.price, lv.label, PM_COLOR, { linestyle: lv.linestyle });
        if (r.entity_id) newShapeIds.push(r.entity_id);
      }
    }, { chartIndex: ci });
  }
  }

  return {
    tabId,
    chart_index: targets[0].chartIndices[0],
    panes: paneCount,
    tabs: targets.length,
    drawn: newShapeIds.length,
    cleaned,
    shapeIds: newShapeIds,
  };
}

/**
 * Stage 4 entry — draw for EVERY primary instrument using Stage 3 output.
 * Iterates the primary contracts dict; mtfAnalysis is keyed by lowercase
 * instrument key (matches Stage 3's output shape).
 */
async function drawLevelsOnChart(mtfAnalysis, primaryInstruments) {
  const keys = Object.keys(primaryInstruments).filter((k) => !k.startsWith("_"));
  console.log(`[stage 4] Cleaning prior shapes + drawing fresh levels for ${keys.length} instruments…`);

  const priorShapeIds = await loadPriorShapeIds();
  const newState = {};
  const results = [];

  for (const key of keys) {
    const spec = primaryInstruments[key];
    const pattern = spec.tradingview_search || key;
    const res = await drawForIndex(pattern, mtfAnalysis[key.toLowerCase()], priorShapeIds);
    results.push({ index: key, ...res });
    if (res.tabId && res.shapeIds) {
      newState[res.tabId] = res.shapeIds;
    }
    console.log(
      `[stage 4]   ${key.toUpperCase()}: ${res._skipped ? "skipped (no tab)" : `cleaned ${res.cleaned}, drew ${res.drawn} across ${res.panes ?? 1} pane(s) on ${res.tabs ?? 1} tab(s)`}`
    );
  }

  await savePriorShapeIds(newState);

  return {
    results,
    total_drawn: results.reduce((s, r) => s + (r.drawn || 0), 0),
    total_cleaned: results.reduce((s, r) => s + (r.cleaned || 0), 0),
  };
}

// =============================================================================
// Stage 4b: Multi-TF S/R zones — IMPLEMENTED (shared lib)
// =============================================================================

/**
 * Draw multi-TF S/R zones (SZone/RZone) for every primary instrument.
 * Best-effort: per-instrument errors are logged and skipped; never throws.
 * Shares asia/lib/sr_zones.mjs with the US premarket + the standalone CLI.
 */
async function drawSRZones(primaryInstruments) {
  const keys = Object.keys(primaryInstruments).filter((k) => !k.startsWith("_"));
  console.log(`[stage 4b] Drawing multi-TF S/R zones for ${keys.length} instruments…`);
  for (const key of keys) {
    const spec = primaryInstruments[key];
    const pattern = spec.tradingview_search || key;
    try {
      const r = await drawSRForSymbol(pattern);
      console.log(`[stage 4b]   ${key.toUpperCase()}: ${r._missing ? "no tab" : `${r.R}R/${r.S}S @ ${r.lastPrice}`}`);
    } catch (e) {
      console.log(`[stage 4b]   ${key.toUpperCase()}: error ${e.message}`);
    }
  }
}

// =============================================================================
// Stage 5: Run gates — IMPLEMENTED
// =============================================================================

/**
 * Parse "HH:MM-HH:MM" into { startMin, endMin } as minutes past midnight SGT.
 */
function parseWindow(w) {
  const [start, end] = w.split("-");
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return { raw: w, startMin: sh * 60 + sm, endMin: eh * 60 + em };
}

/**
 * Read the A50 correlation state file and return a gate status string.
 * "evaluated_at_open" if file missing or for a different SGT date.
 */
async function evaluateA50Correlation() {
  try {
    const raw = await fs.readFile(
      path.join(ASIA_ROOT, "state", "a50_correlation.json"),
      "utf8"
    );
    const data = JSON.parse(raw);

    // Stale-check: only honor today's verdict
    const todaySgt = (() => {
      const sgt = new Date(Date.now() + 8 * 60 * 60 * 1000);
      return sgt.toISOString().slice(0, 10);
    })();
    if (data.today_sgt_date !== todaySgt) {
      return "evaluated_at_open";
    }

    if (data.status === "pass") return `pass (${data.detail})`;
    if (data.status === "fail") return `fail (${data.detail})`;
    return `unknown_a50_${data.status} (${data.detail})`;
  } catch {
    return "evaluated_at_open";
  }
}

/**
 * Evaluate the session_window gate.
 * SGT = UTC+8. Returns "pass (in X)" if in window, "deferred (next X in Y)" otherwise.
 */
function evaluateSessionWindow(gateConfig) {
  const allowed = gateConfig.allowed_windows_sgt || [];
  if (allowed.length === 0) return "pass (no windows configured)";

  const now = new Date();
  // Shift UTC into SGT-equivalent so UTC-hour fields read as SGT-hour
  const sgt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const nowMin = sgt.getUTCHours() * 60 + sgt.getUTCMinutes();

  const windows = allowed.map(parseWindow);
  const inWindow = windows.find(
    (w) => nowMin >= w.startMin && nowMin <= w.endMin
  );
  if (inWindow) {
    return `pass (in window ${inWindow.raw} SGT)`;
  }

  // Find next window starting today
  const next = windows.find((w) => w.startMin > nowMin);
  if (next) {
    const mins = next.startMin - nowMin;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const eta = h > 0 ? `${h}h${m}m` : `${m}m`;
    return `deferred (next ${next.raw} SGT in ${eta})`;
  }

  // All today's windows passed — next is tomorrow's first
  const tomorrow = windows[0];
  const minsToMidnight = 24 * 60 - nowMin;
  const totalMins = minsToMidnight + tomorrow.startMin;
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return `deferred (next ${tomorrow.raw} SGT tomorrow, in ${h}h${m}m)`;
}

async function evaluateGates(gates, refState, priorLevels) {
  const results = {};

  // VHSI regime
  if (gates.vhsi_regime?.enabled) {
    const v = refState.vhsi?.last;
    if (refState.vhsi?._missing_tab) {
      results.vhsi_regime = "unknown_no_vhsi_tab";
    } else if (v == null) {
      results.vhsi_regime = "unknown_data_missing";
    } else if (v >= gates.vhsi_regime.min && v <= gates.vhsi_regime.max) {
      results.vhsi_regime = `pass (VHSI=${v}, regime=${refState.vhsi.regime})`;
    } else {
      results.vhsi_regime = `fail (VHSI=${v} outside ${gates.vhsi_regime.min}-${gates.vhsi_regime.max}, regime=${refState.vhsi.regime})`;
    }
  }

  // A50 correlation — reads asia/state/a50_correlation.json if exists and
  // is for today (SGT). If missing or stale, stays as "evaluated_at_open".
  if (gates.a50_correlation?.enabled) {
    results.a50_correlation = await evaluateA50Correlation();
  }

  // China policy blackout — uses asia/state/policy_events.json (refreshed by
  // `npm run refresh:calendar`). Returns "pass"/"fail" with detail, or an
  // unknown_* status when the calendar file is missing or stale.
  if (gates.china_policy_blackout?.enabled) {
    const policyFile = path.join(ASIA_ROOT, "state", "policy_events.json");
    const windowMin = gates.china_policy_blackout.blackout_minutes ?? 30;
    const verdict = await evaluatePolicyGate(policyFile, new Date(), windowMin);
    results.china_policy_blackout =
      verdict.status === "pass"
        ? `pass (${verdict.detail})`
        : verdict.status === "fail"
        ? `fail (${verdict.detail})`
        : verdict.status; // unknown_no_calendar | unknown_calendar_stale
  }

  // Session window — checks if current SGT time is in any allowed window.
  // Cheap: pure time math, no external data. Re-evaluates on every dashboard
  // poll (every 30s) so the chip flips green → gray → green as we move
  // through 09:30-10:30, lunch, 13:00-13:30, etc.
  if (gates.session_window?.enabled) {
    results.session_window = evaluateSessionWindow(gates.session_window);
  }

  // Daily trade cap — evaluated at trade time
  if (gates.daily_trade_cap?.enabled) {
    results.daily_trade_cap = "evaluated_at_entry";
  }

  // Manual dashboard Y/N — binding, set in dashboard
  if (gates.manual_dashboard_yn?.enabled) {
    results.manual_dashboard_yn = `default=${gates.manual_dashboard_yn.default}`;
  }

  // Correlation chase filter — evaluated at trade time
  if (gates.correlation_chase_filter?.enabled) {
    results.correlation_chase_filter = "evaluated_at_entry";
  }

  // Pre-market verdict
  const entries = Object.entries(results);
  const failed = entries.filter(([, v]) => String(v).startsWith("fail"));
  // Any "unknown_*" result means a gate that SHOULD be evaluable pre-market
  // doesn't have its data yet (missing tab, missing calendar, etc.)
  const unknownGates = entries.filter(([, v]) =>
    String(v).startsWith("unknown_")
  );

  // Per-instrument level health — iterate over priorLevels keys (which are
  // populated from contracts.primary). If NO instrument has data → skip.
  // If SOME instruments are missing → partial review (others can still trade).
  const instrumentKeys = Object.keys(priorLevels || {}).filter(
    (k) => !k.startsWith("_")
  );
  const okList = instrumentKeys.filter(
    (k) => priorLevels?.[k]?.prev_close != null
  );
  const missingList = instrumentKeys.filter(
    (k) => priorLevels?.[k]?.prev_close == null
  );
  const allLevelsBroken = okList.length === 0 && instrumentKeys.length > 0;
  const someLevelsMissing = missingList.length > 0;

  if (failed.length > 0) {
    results._premarket_verdict = "skip_session";
  } else if (allLevelsBroken) {
    results._premarket_verdict = "skip_session_no_contract_data";
    results._verdict_reasons = `No instruments returned bars (${instrumentKeys.join(", ")})`;
  } else if (someLevelsMissing || unknownGates.length > 0) {
    const reasons = [];
    for (const k of missingList) reasons.push(`${k.toUpperCase()} tab missing → ${k.toUpperCase()} blocked`);
    reasons.push(...unknownGates.map(([k, v]) => `${k}=${v}`));
    results._premarket_verdict = "proceed_partial_review_needed";
    results._verdict_reasons = reasons.join("; ");
  } else {
    results._premarket_verdict = "proceed_to_open";
  }

  return results;
}

// =============================================================================
// Stage 6: Discord setup card — TODO
// =============================================================================

async function postSetupCard(payload) {
  const webhook = process.env.DISCORD_WEBHOOK_HSI;
  if (!webhook) {
    console.log("[stage 6] DISCORD_WEBHOOK_HSI not set — skipping Discord post");
    return { posted: false, reason: "no_webhook" };
  }
  // TODO: format embed and POST
  console.log("[stage 6] TODO: implement Discord embed posting");
  return { posted: false, _todo: true };
}

// =============================================================================
// Stage 7: Write journal entry — IMPLEMENTED
// =============================================================================

async function writeJournalEntry(plan) {
  const today = new Date().toISOString().slice(0, 10);
  const journalDir = path.join(ASIA_ROOT, "journal");
  await fs.mkdir(journalDir, { recursive: true });
  const journalPath = path.join(journalDir, `${today}.md`);
  const content = renderJournalMarkdown(plan, today);
  await fs.writeFile(journalPath, content, "utf8");
  return journalPath;
}

/**
 * Write structured bias + verdict per instrument for downstream consumers
 * (the HK watcher needs this to bias-lock Trigger B without parsing
 * markdown). Keyed by contracts.json primary key. Stamped with HK calendar
 * date so the watcher can reject stale state.
 */
async function writePremarketState(plan) {
  const stateDir = path.join(ASIA_ROOT, "state");
  await fs.mkdir(stateDir, { recursive: true });
  const todaySgt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const instruments = {};
  const primaryKeys = Object.keys(plan.primary).filter((k) => !k.startsWith("_"));
  for (const key of primaryKeys) {
    const m = plan.mtfAnalysis?.[key.toLowerCase()] || {};
    const alignment = m.trend_alignment ?? null;
    let bias = null;
    let direction = null;
    if (typeof alignment === "string") {
      if (alignment.startsWith("bullish")) { bias = "BULL"; direction = "CALLS"; }
      else if (alignment.startsWith("bearish")) { bias = "BEAR"; direction = "PUTS"; }
      else if (alignment === "mixed") { bias = "NEUTRAL"; }
    }
    instruments[key] = {
      bias,
      alignment,
      direction,
      ...(m._error ? { error: m._error } : {}),
    };
  }
  const payload = {
    computed_at: new Date().toISOString(),
    today_sgt_date: todaySgt,
    verdict: plan.gateResults?._premarket_verdict ?? null,
    instruments,
  };
  const statePath = path.join(stateDir, "premarket_state.json");
  await fs.writeFile(statePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return statePath;
}

function fmt(v, suffix = "") {
  if (v == null) return "_TBD_";
  if (typeof v === "number") return `${v.toLocaleString()}${suffix}`;
  return `${v}${suffix}`;
}

function refRow(label, q) {
  if (!q) return `- **${label}**: _no data_`;
  if (q._missing_tab) return `- **${label}**: _no tab open in TradingView_`;
  if (q._error) return `- **${label}**: _error: ${q._error}_`;
  const last = fmt(q.last);
  const chg = q.change_pct != null ? `${q.change_pct >= 0 ? "+" : ""}${q.change_pct}%` : "_TBD_";
  const extra = q._regime ? ` _(regime: ${q._regime})_` : "";
  return `- **${label}**: ${last}  (${chg})${extra}`;
}

function indexLevelsBlock(label, descriptor, idx) {
  if (!idx || idx._missing_tab) {
    return `### ${label}\n\n_${descriptor} — no tab open in TradingView._\n`;
  }
  if (idx._error) {
    return `### ${label}\n\n_${descriptor} — error reading bars: ${idx._error}_\n`;
  }
  const tfNote = idx.switched
    ? ` (chart was on \`${idx.original_tf}\`, temporarily switched to \`D\` and restored)`
    : " (chart was already on `D`)";
  return `### ${label}

_${descriptor} · source \`${idx.symbol}\` — ${idx.bar_count} daily bars${tfNote}_

| Level | Value |
|---|---|
| Prior High (PDH) | ${fmt(idx.prev_high)} |
| Prior Low  (PDL) | ${fmt(idx.prev_low)} |
| Prior Close (PDC) | ${fmt(idx.prev_close)} |
| Prior Open | ${fmt(idx.prev_open)} |
| Prior Range | ${fmt(idx.prev_range_pct, "%")} |
`;
}

function trendEmoji(t) {
  if (t === "bullish") return "🟢 bullish";
  if (t === "bearish") return "🔴 bearish";
  if (t === "neutral") return "⚪ neutral";
  return `_${t ?? "?"}_`;
}

function alignmentLabel(a) {
  switch (a) {
    case "bullish_all": return "🟢🟢🟢 **all bullish**";
    case "bearish_all": return "🔴🔴🔴 **all bearish**";
    case "bullish_majority": return "🟢🟢 bullish majority";
    case "bearish_majority": return "🔴🔴 bearish majority";
    case "mixed": return "⚪ mixed";
    case "unknown": return "_unknown_";
    default: return `_${a ?? "?"}_`;
  }
}

function mtfBlock(label, descriptor, mtf) {
  if (!mtf || mtf._missing_tab) {
    return `### ${label}\n\n_${descriptor} — no tab open._\n`;
  }
  if (mtf._error) {
    return `### ${label}\n\n_${descriptor} — error: ${mtf._error}_\n`;
  }

  const tfRow = (code, displayLabel) => {
    const r = mtf.timeframes?.[code];
    if (!r) return `| ${displayLabel} | _no data_ | — |`;
    return `| ${displayLabel} | ${trendEmoji(r.trend)} | ${r.bar_count} bars |`;
  };

  const levels = (mtf.key_levels || [])
    .slice(0, 5)
    .map(
      (l) =>
        `- ${l.type === "high" ? "swing high" : "swing low"} @ **${fmt(l.price)}** (${l.tf})`
    )
    .join("\n") || "_(none)_";

  const fvgs = (mtf.fvg_zones || [])
    .slice(0, 3)
    .map(
      (f) =>
        `- ${f.type === "bullish" ? "🟢 bullish" : "🔴 bearish"} FVG: ${fmt(f.low)} → ${fmt(f.high)} (${f.tf})`
    )
    .join("\n") || "_(none)_";

  const on = mtf.overnight;
  const overnight =
    on && on.high != null
      ? `🔵 ON-H **${fmt(on.high)}** / ON-L **${fmt(on.low)}**  _(${Math.round(on.high - on.low)} pts · ${on.bars}× M15)_`
      : "_(none — cash equity has no night session)_";

  return `### ${label}

_${descriptor} · source \`${mtf.symbol}\`_

| TF | Trend | Bars |
|---|---|---|
${tfRow("D", "Daily")}
${tfRow("240", "H4")}
${tfRow("60", "H1")}
${tfRow("15", "M15")}

**Alignment:** ${alignmentLabel(mtf.trend_alignment)}

**Key levels (top 5 D-swings):**
${levels}

**Unfilled FVGs (top 3 H1):**
${fvgs}

**Overnight range (night session 17:15–03:00 HKT):**
${overnight}
`;
}

function renderJournalMarkdown(plan, dateStr) {
  const p = plan.priorLevels;
  const r = plan.refState;
  const g = plan.gateResults;
  const m = plan.mtfAnalysis;
  const d = plan.drawResult;
  const primary = plan.primary || {};

  // Iterate primary instruments in config order. Each renders an entry in
  // Stage 1 (prior levels) and Stage 3 (multi-TF).
  const primaryKeys = Object.keys(primary).filter((k) => !k.startsWith("_"));
  const stage1Blocks = primaryKeys
    .map((k) =>
      indexLevelsBlock(k, primary[k].name || k, p[k.toLowerCase()])
    )
    .join("\n");
  const stage3Blocks = primaryKeys
    .map((k) => mtfBlock(k, primary[k].name || k, m[k.toLowerCase()]))
    .join("\n");

  return `# Asia Session — ${dateStr}

_Generated by \`premarket_hsi.mjs\` at ${new Date().toISOString()}_
_Instruments: ${primaryKeys.join(", ")}_

## Stage 1 — Prior Session Levels

${stage1Blocks}

## Stage 2 — Reference State

**Index correlation feed:**
${refRow("China A50 (SGX:CN1!)", r.a50)}
${refRow("CSI 300 (SSE:000300)", r.csi300)}
${refRow("VHSI (HSI:VHSI)", { ...r.vhsi, _regime: r.vhsi.regime })}
${refRow("SPX overnight", { last: r.spx_overnight.close, change_pct: r.spx_overnight.change_pct, _missing_tab: r.spx_overnight._missing_tab, _error: r.spx_overnight._error })}

**Tech / single-stock correlation feed:**
${refRow("KWEB overnight (AMEX:KWEB)", r.kweb)}

## Stage 3 — Multi-TF Analysis

${stage3Blocks}

## Stage 4 — Chart Drawings

_Drew **${d.total_drawn}** shapes (cleaned **${d.total_cleaned}** from prior run)._

${(d.results || [])
  .map(
    (r) =>
      `- **${r.index}**: ${r._skipped ? "_skipped (no tab)_" : `cleaned ${r.cleaned}, drew ${r.drawn} across ${r.panes ?? 1} pane(s) on ${r.tabs ?? 1} tab(s)`}`
  )
  .join("\n")}

_Drawings are tagged \`[asia-pm <INDEX>]\` and auto-cleaned on next \`premarket:hsi\` run. Manual deletes are safe._

## Stage 5 — Gate Evaluation

${Object.entries(g)
  .filter(([k]) => !k.startsWith("_"))
  .map(([k, v]) => `- **${k}**: ${v}`)
  .join("\n")}

**Pre-market verdict:** \`${g._premarket_verdict ?? "?"}\`

## Plan

_To be filled in by hand (or by post-open watcher), referencing the levels above._

- [ ] Trade 1 setup:
- [ ] Trade 2 setup:
- [ ] Trade 3 setup:

## Post-session

_Filled by \`persist_session_hsi.mjs\` at session end._
`;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("[premarket_hsi] Starting HSI pre-market routine…");

  const { contracts, gates } = await loadConfig();
  const primaryKeys = Object.keys(contracts.primary).filter((k) => !k.startsWith("_"));
  const refKeys = Object.keys(contracts.reference || {}).filter((k) => !k.startsWith("_"));
  const gateCount = Object.keys(gates).filter((k) => !k.startsWith("_")).length;
  console.log(
    `[premarket_hsi] Loaded: trade=${primaryKeys.length} (${primaryKeys.join(",")}), confluence=${refKeys.length} (${refKeys.join(",")}), gates=${gateCount}`
  );

  let priorLevels;
  let refState;
  let mtfAnalysis;
  let drawResult = { total_drawn: 0, total_cleaned: 0, results: [] };

  try {
    await getClient(); // throws if TradingView isn't running
    console.log("[premarket_hsi] CDP connection established");

    priorLevels = await pullPriorSessionLevels(contracts.primary);
    refState = await pullReferenceState();
    mtfAnalysis = await multiTFAnalysis(contracts.primary);
    drawResult = await drawLevelsOnChart(mtfAnalysis, contracts.primary);
  } catch (err) {
    console.error(`[premarket_hsi] CDP/data error: ${err.message}`);
    console.error("[premarket_hsi] Continuing in degraded mode — journal will show TBD");
    // Build empty error-state objects for every primary instrument
    priorLevels = Object.fromEntries(
      primaryKeys.map((k) => [k.toLowerCase(), { _error: err.message }])
    );
    refState = {
      a50: { _error: err.message },
      csi300: { _error: err.message },
      vhsi: { _error: err.message },
      kweb: { _error: err.message },
      spx_overnight: { close: null, change_pct: null, _error: err.message },
    };
    mtfAnalysis = Object.fromEntries(
      primaryKeys.map((k) => [k.toLowerCase(), { _error: err.message }])
    );
  } finally {
    await disconnect().catch(() => {});
  }

  // Stage 4b: Multi-TF S/R zones — best-effort, isolated from the data/journal
  // flow (opens its own CDP sessions; never throws upward).
  if (DRAW_SR_ZONES) {
    try { await drawSRZones(contracts.primary); }
    catch (e) { console.error(`[stage 4b] S/R zones failed: ${e.message}`); }
  }

  const gateResults = await evaluateGates(gates, refState, priorLevels);
  const plan = {
    priorLevels,
    refState,
    mtfAnalysis,
    gateResults,
    drawResult,
    primary: contracts.primary, // so journal renderer can iterate
  };

  await postSetupCard(plan);
  const journalPath = await writeJournalEntry(plan);
  const statePath = await writePremarketState(plan);

  console.log(`[premarket_hsi] Journal: ${journalPath}`);
  console.log(`[premarket_hsi] Structured state: ${statePath}`);
  console.log(
    `[premarket_hsi] Pre-market verdict: ${gateResults._premarket_verdict}`
  );
  console.log("[premarket_hsi] Done.");
}

main().catch((err) => {
  console.error("[premarket_hsi] Fatal:", err);
  process.exit(1);
});
