#!/usr/bin/env node
/**
 * post_open_orb.mjs — ORB trigger computation + chart drawing.
 *
 * Run this at 10:00 SGT (30 min after HK open) to capture the opening
 * range and project entry / stop / T1 / T2 levels for the day.
 *
 * For each index (HSI, HSTECH):
 *   1. Find tab via multi_tab.findTabBySymbol
 *   2. Read M15 bars (switching tab TF to 15 if needed, then restoring)
 *   3. Compute ORB from today's first 30 min (two M15 bars) after 09:30 SGT
 *   4. Generate symmetric long + short triggers
 *   5. Draw ORB H/L + ±1R + ±2R as horizontal lines (orange)
 *   6. Append to today's journal
 *
 * Cleanup: ORB drawings are tracked in asia/state/last_orb_triggers.json
 * (separate from pre-market shapes — running this script re-cleans only its
 * own shapes, doesn't disturb the pre-market levels).
 *
 * Usage:
 *   npm run orb:hsi
 *   node asia/scripts/post_open_orb.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findChartsAcrossTabs,
  readBarsAtResolutionFromTab,
} from "../lib/multi_tab.mjs";
import { computeORB, todaysHKOpenTimestamp } from "../lib/orb.mjs";
import { buildORBTrigger } from "../lib/triggers.mjs";
import { withDrawSession } from "../lib/draw.mjs";
import { atr } from "../lib/atr.mjs";
import { anchoredSessionVWAP, getEMA21_1H_AsOf } from "../lib/vwap_ema.mjs";

process.stdout.on("error", (e) => { if (e.code !== "EPIPE") throw e; });
process.stderr.on("error", (e) => { if (e.code !== "EPIPE") throw e; });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASIA_ROOT = path.resolve(__dirname, "..");
const STATE_FILE = path.join(ASIA_ROOT, "state", "last_orb_triggers.json");
// Structured trigger data consumed by asia/scripts/trade_window_hk.mjs.
// Separate file from STATE_FILE (which holds drawing shape IDs for cleanup).
const TRIGGERS_FILE = path.join(ASIA_ROOT, "state", "orb_triggers.json");

// Colors — clean template (2026-06-08): blue ORB boundaries, green long targets,
// red short targets. Matches the hand-drawn chart style.
const ENTRY_COLOR = "#2196F3";        // blue — ORB boundaries (entry/stop)
const TARGET_COLOR = "#26A69A";       // green — long targets (T1▲/T2▲)
const TARGET_SHORT_COLOR = "#EF5350"; // red — short targets (T1▼/T2▼)

const LINESTYLE_SOLID = 0;

async function loadPriorState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function savePriorState(state) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Persist structured ORB trigger data per instrument for the HK watcher
 * (asia/scripts/trade_window_hk.mjs) to consume. Keyed by contracts.json
 * primary key (e.g. "MHI", "TENCENT") — NOT the tradingview_search pattern.
 * Includes a today_sgt_date stamp so the watcher can reject stale data
 * (e.g. on a Monday morning before ORB has run).
 */
async function saveStructuredTriggers(results, primaryKeys) {
  const todaySgt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

  const payload = {
    computed_at: new Date().toISOString(),
    today_sgt_date: todaySgt,
    instruments: {},
  };

  // results[] is parallel to primaryKeys[] (results.push order in main()).
  for (let i = 0; i < primaryKeys.length; i++) {
    const key = primaryKeys[i];
    const r = results[i];
    if (!r) continue;
    if (r._missing_tab || r._error || r._waiting || r._no_bar_yet) {
      payload.instruments[key] = {
        ok: false,
        reason: r._missing_tab
          ? "no_tab"
          : r._error
          ? `error: ${r._error}`
          : r._waiting
          ? "waiting_for_orb_complete"
          : "no_bar_yet",
      };
      continue;
    }
    payload.instruments[key] = {
      ok: true,
      orb: r.orb,
      long: r.long,
      short: r.short,
      atr_15: r.atr_15,
      atr_15_pct: r.atr_15_pct,
      range_vs_atr: r.range_vs_atr,
      trigger_b: r.trigger_b ?? null,
    };
  }

  await fs.mkdir(path.dirname(TRIGGERS_FILE), { recursive: true });
  await fs.writeFile(TRIGGERS_FILE, JSON.stringify(payload, null, 2), "utf8");
}

/**
 * Wipe this instrument's ORB/target lines (tagged legacy + clean labels) on
 * every pane of every matching tab. Used by the pre-completion paths: when
 * the ORB isn't computable yet, the PRIOR session's lines must still come
 * down — stale levels are worse than no levels (2026-06-12: Wednesday's
 * stale T1▲ masqueraded as Friday's ORB H all morning).
 */
async function cleanORBLines(targets, label) {
  let cleaned = 0;
  const tag = `[ORB ${label}]`;
  for (const target of targets) {
    for (const ci of target.chartIndices) {
      await withDrawSession(target.tab.id, async (draw) => {
        cleaned += await draw.removeByTagPrefix(tag);
        cleaned += await draw.removeByLabelMatch('^(ORB [HL]|T1 [▲▼]|T2 [▲▼])');
      }, { chartIndex: ci });
    }
  }
  return cleaned;
}

/**
 * Process one index: read M15 bars, compute ORB + trigger, draw lines.
 */
async function processIndex(label, priorState) {
  // Every pane on every tab showing this symbol — dedicated ticker tab AND
  // overview-tab panes — gets the same ORB lines.
  const targets = await findChartsAcrossTabs(label);
  if (!targets.length) {
    return { label, _missing_tab: true };
  }
  const tabId = targets[0].tab.id;

  // Read enough M15 bars to cover today + ATR window. Read once from the
  // first matching pane (switches its TF to 15 and restores); the draw below
  // repeats identically on every pane of every tab.
  const { bars } = await readBarsAtResolutionFromTab(tabId, "15", 60, {
    chartIndex: targets[0].chartIndices[0],
  });
  if (!Array.isArray(bars) || bars.length === 0) {
    return { label, _error: "no M15 bars", tabId };
  }

  const orb = computeORB(bars);

  if (orb._waiting || orb._no_bar_yet) {
    // Can't compute today's ORB yet — but the prior session's lines must
    // still come down so nothing stale masquerades as today's levels.
    const cleaned_stale = await cleanORBLines(targets, label);
    if (orb._waiting) {
      return {
        label,
        _waiting: true,
        hk_open_ts: orb.hk_open_ts,
        orb_complete_ts: orb.orb_complete_ts,
        cleaned_stale,
        tabId,
      };
    }
    return { label, _no_bar_yet: true, cleaned_stale, tabId };
  }

  const trigger = buildORBTrigger(orb, bars);

  // ── Initial Trigger B levels (VWAP, EMA21 H1, ATR-14 M15) ───────────────
  // Computed from the same M15 bars we already have. The watcher recomputes
  // these every 15m cycle using IBKR bars; this initial snapshot exists so
  // the dashboard Trigger B section has live values to render BEFORE any
  // watcher is armed. Both watcher and dashboard share the orb_triggers.json
  // shape, so trigger_b nests under the instrument.
  const nowTs = Math.floor(Date.now() / 1000);
  const hkOpenTs = orb.hk_open_ts ?? todaysHKOpenTimestamp();
  const vwap = anchoredSessionVWAP(bars, hkOpenTs);
  const ema21_1h = getEMA21_1H_AsOf(bars, nowTs);
  const atr_15 = bars.length > 14 ? atr(bars, 14) : null;
  trigger.trigger_b = {
    vwap: vwap != null ? Number(vwap.toFixed(2)) : null,
    ema21_1h: ema21_1h != null ? Number(ema21_1h.toFixed(2)) : null,
    atr_15: atr_15 != null ? Number(atr_15.toFixed(2)) : null,
    computed_at: new Date().toISOString(),
  };

  // ORB H = long entry = short stop  (same price)
  // ORB L = long stop  = short entry (same price)
  // Drawing separate STOP lines on top of these caused visual overlap.
  // Solution: just draw the two ORB boundary lines + 4 target lines = 6 total.
  // Labels make the dual role explicit. Computed once, redrawn per pane.
  const lines = [
    // ORB boundaries — blue, solid, thicker. Dual entry/stop role in the label.
    {
      price: trigger.orb.high,
      text: "ORB H · ▲Entry / ▼Stop",
      color: ENTRY_COLOR,
      linewidth: 2,
      linestyle: LINESTYLE_SOLID,
    },
    {
      price: trigger.orb.low,
      text: "ORB L · ▼Entry / ▲Stop",
      color: ENTRY_COLOR,
      linewidth: 2,
      linestyle: LINESTYLE_SOLID,
    },
    // Long targets — green, dashed
    { price: trigger.long.T1, text: "T1 ▲", color: TARGET_COLOR, linewidth: 1, linestyle: 2 },
    { price: trigger.long.T2, text: "T2 ▲", color: TARGET_COLOR, linewidth: 1, linestyle: 2 },
    // Short targets — red, dashed
    { price: trigger.short.T1, text: "T1 ▼", color: TARGET_SHORT_COLOR, linewidth: 1, linestyle: 2 },
    { price: trigger.short.T2, text: "T2 ▼", color: TARGET_SHORT_COLOR, linewidth: 1, linestyle: 2 },
  ];

  const newShapeIds = [];
  let cleaned = 0;
  const tag = `[ORB ${label}]`;

  // Draw on EVERY matching pane of EVERY matching tab so the levels stay
  // consistent everywhere the symbol shows. Each pane cleans first, then
  // draws — converges to one clean set per pane whether or not TradingView's
  // drawing-sync is on.
  let paneCount = 0;
  for (const target of targets) {
  for (const ci of target.chartIndices) {
    paneCount++;
    await withDrawSession(target.tab.id, async (draw) => {
      // Tag-scan cleanup (mirrors US premarket_setup). Removes ANY shape on
      // this pane whose label starts with `[ORB <label>]`, plus the clean
      // (tag-free) auto-drawn ORB/T1/T2 rays. Robust against TV restart /
      // stale state-file tab IDs / lost state files. `priorState` is still
      // loaded for backward-compat journaling but is no longer the cleanup
      // source of truth.
      cleaned += await draw.removeByTagPrefix(tag);
      cleaned += await draw.removeByLabelMatch('^(ORB [HL]|T1 [▲▼]|T2 [▲▼])');
      void priorState; // intentionally unused for cleanup

      for (const { price, text, color, linewidth, linestyle } of lines) {
        const { entity_id } = await draw.hline(price, text, color, {
          linewidth,
          linestyle,
        });
        if (entity_id) newShapeIds.push(entity_id);
      }
    }, { chartIndex: ci });
  }
  }

  return {
    label,
    tabId,
    chart_index: targets[0].chartIndices[0],
    panes: paneCount,
    tabs: targets.length,
    orb: trigger.orb,
    long: trigger.long,
    short: trigger.short,
    atr_15: trigger.atr_15,
    atr_15_pct: trigger.atr_15_pct,
    range_vs_atr: trigger.range_vs_atr,
    trigger_b: trigger.trigger_b,
    cleaned,
    drawn: newShapeIds.length,
    shapeIds: newShapeIds,
  };
}

function formatResult(r) {
  if (r._missing_tab) return `**${r.label}**: _no tab open_`;
  if (r._error) return `**${r.label}**: _error: ${r._error}_`;
  if (r._waiting) {
    const eta = new Date(r.orb_complete_ts * 1000).toISOString();
    return `**${r.label}**: _waiting — ORB completes at ${eta} (wiped ${r.cleaned_stale ?? 0} stale line(s))_`;
  }
  if (r._no_bar_yet) {
    return `**${r.label}**: _09:30 passed but no M15 bar found yet (data lag?) — wiped ${r.cleaned_stale ?? 0} stale line(s)_`;
  }
  return `**${r.label}**: ORB ${Math.round(r.orb.low)}–${Math.round(r.orb.high)} (range ${Math.round(r.orb.range)}, ${r.range_vs_atr ?? "?"}× ATR)
  - Long  → entry ${Math.round(r.long.entry)}, stop ${Math.round(r.long.stop)}, T1 ${Math.round(r.long.T1)}, T2 ${Math.round(r.long.T2)}
  - Short → entry ${Math.round(r.short.entry)}, stop ${Math.round(r.short.stop)}, T1 ${Math.round(r.short.T1)}, T2 ${Math.round(r.short.T2)}
  - Drew ${r.drawn} lines across ${r.panes ?? 1} pane(s) on ${r.tabs ?? 1} tab(s) (cleaned ${r.cleaned})`;
}

async function appendJournal(results) {
  const today = new Date().toISOString().slice(0, 10);
  const journalPath = path.join(ASIA_ROOT, "journal", `${today}.md`);
  let existing = "";
  try {
    existing = await fs.readFile(journalPath, "utf8");
  } catch {
    existing = `# HSI Session — ${today}\n\n_Created by post_open_orb.mjs (pre-market did not run)_\n\n`;
  }

  const orbSection = `

## Post-open ORB (${new Date().toISOString()})

${results.map(formatResult).join("\n\n")}
`;

  // If a previous post-open block exists, replace it; otherwise append
  const POST_OPEN_REGEX = /\n## Post-open ORB[\s\S]*?(?=\n## |\n_Filled by `persist_session_hsi.mjs`|$)/;
  const updated = POST_OPEN_REGEX.test(existing)
    ? existing.replace(POST_OPEN_REGEX, orbSection)
    : existing + orbSection;

  await fs.writeFile(journalPath, updated, "utf8");
  return journalPath;
}

async function main() {
  // Load primary instruments from contracts.json so we iterate dynamically.
  // Adding a new instrument there auto-extends this script.
  const contractsPath = path.join(ASIA_ROOT, "config", "contracts.json");
  const contracts = JSON.parse(await fs.readFile(contractsPath, "utf8"));
  const primaryKeys = Object.keys(contracts.primary).filter((k) => !k.startsWith("_"));

  console.log(`[orb] Computing ORB triggers for ${primaryKeys.length} instruments (${primaryKeys.join(", ")})…`);

  const priorState = await loadPriorState();
  const results = [];
  const newState = {};

  for (const key of primaryKeys) {
    const spec = contracts.primary[key];
    const pattern = spec.tradingview_search || key;
    const r = await processIndex(pattern, priorState);
    // Keep the human-readable label on the result for the journal.
    r.label = r.label || key;
    results.push(r);
    if (r.tabId && r.shapeIds) newState[r.tabId] = r.shapeIds;
    console.log(`[orb]   ${formatResult(r).split("\n")[0]}`);
  }

  await savePriorState(newState);
  await saveStructuredTriggers(results, primaryKeys);
  const journalPath = await appendJournal(results);

  console.log(`[orb] Journal updated: ${journalPath}`);
  console.log(`[orb] Structured triggers: ${TRIGGERS_FILE}`);
  console.log("[orb] Done.");
}

main().catch((err) => {
  console.error("[orb] Fatal:", err);
  process.exit(1);
});
