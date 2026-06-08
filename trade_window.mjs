/**
 * trade_window.mjs — time-bounded candle-close validator + auto-notify + order
 * placement for Trigger A (ORB breakout).
 *
 * Usage:
 *   node trade_window.mjs <SPY|QQQ> [--until HH:MM] [--test]
 *
 * What it does:
 *   1. Loads entry_notes from latest_entry_notes.json (requires fresh premarket_setup)
 *   2. Verifies: ticker tradeable, entry_notes not stale, one-trade-per-day OK
 *   3. Connects to IBKR paper TWS
 *   4. Loops every 15m aligned to candle closes (:00, :15, :30, :45 + 30s):
 *        - Pulls last N 15m TRADES bars
 *        - Finds most recent completed bar
 *        - Validates: close crossed trigger? rVol ≥ 1.2? in RTH window?
 *   5. On trigger fire:
 *        - macOS notification with Submarine sound
 *        - Picks 0DTE strike with premium in $0.50-$0.90, nearest-ATM
 *        - Prompts "type YES"
 *        - Places MKT DAY order with transmit=false (two-gate safety)
 *        - Records trade to traded_today.json, exits loop
 *   6. Auto-stops at --until time (default 23:00 SGT)
 *   7. Ctrl+C exits cleanly
 *
 * Path A systematic trader commitment:
 *   - 15m close + rVol ≥ 1.2 discipline (no tick-touch)
 *   - Human YES gate + TWS Transmit click (two human gates)
 *   - One-trade-per-day hard-enforced via persistent flag file
 *   - Stale entry_notes refused (>4h = must re-run premarket_setup)
 */
// EPIPE tolerance — when the dashboard server spawns this watcher and its
// stdout pipe gets closed mid-session, subsequent console.* writes would
// crash the watcher (and lose any in-flight bracket monitoring). Swallow
// EPIPE silently so the watcher keeps running even if no one is reading
// its log output. The fire path itself doesn't depend on stdout.
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { IBApi, EventName } from '@stoqey/ib';
import { IBKR_CONFIG, CLIENT_IDS, tradeWindowClientId, isInfoCode } from './ibkr_config.mjs';
import {
  reqHistoricalBars,
  resolveStockConId,
  getOptionChainParams,
  pick0DTEExpiry,
  pickFridayWeeklyExpiry,
  pickStrikeInRange,
  nearestStrikes,
  queryOptionPremium,
  promptYes,
  printOrderSpec,
  placeStagedOrder,
  placeOCABracketExits,
  placeOCALadderExits,
  placeTrailingStop,
  printTrailingSpec,
  placeFixedStop,
  printFixedStopSpec,
  modifyStopToBreakeven,
  printBracketSpec,
  nextReqId,
} from './ibkr_orders.mjs';
import {
  hasTradedToday,
  getTradeCount,
  recordTrade,
  formatBlockedMessage,
  MAX_TRADES_PER_DAY,
} from './one_trade_per_day.mjs';
import { discordNotify, DISCORD_ENABLED } from './discord_notify.mjs';
import { isTradingEnabledForToday, formatStatus as manualYnStatus } from './manual_yn.mjs';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_NOTES_FILE = path.join(REPO_ROOT, 'latest_entry_notes.json');

// Ticker-class sets — drives expiry selection (0DTE for ETFs, Friday weekly
// for stocks), correlation-gate scope (ETF-only), and per-ticker rVol /
// PREMIUM_RANGE calibration. Stocks added 2026-05-06 alongside the VIX
// volatility-regime gate.
const ETF_TICKERS = new Set(['SPY', 'QQQ', 'IWM']);
const STOCK_TICKERS = new Set(['AAPL', 'NVDA', 'AMZN']);
const isETF = (t) => ETF_TICKERS.has(t);

// ─── Config ──────────────────────────────────────────────────────────────────
// Per-ticker premium range. SPY/QQQ trade in the high-$600s/$700s where
// near-the-money 0DTE option premiums naturally land in $0.50–$0.90. IWM
// trades around $270–$280; its option-chain economics are different and
// near-ATM 0DTE puts often fall outside the SPY/QQQ band — confirmed live
// 2026-04-29 when an IWM Trigger B fired but `handleTriggered()` aborted at
// the strike picker with "no strike in $0.5-$0.9 premium range". The IWM
// band [0.30, 0.70] was validated against the live 0DTE chain at 10:15 ET
// (catches 271P @ $0.34 and 272P @ $0.56). Note the new band biases
// somewhat OTM — keep an eye on whether ATM would suit Trigger B better.
// PREMIUM_MIN/MAX are derived from PREMIUM_RANGE[ticker] further down, after
// parseArgs() resolves the active ticker (line ~140).
const PREMIUM_RANGE = {
  // SPY floor widened 0.50 → 0.30 (2026-05-08): symmetric with QQQ change
  // (same PR thread). Same rationale — late-trigger setups where close has
  // moved well above entry leave near-ATM strikes priced above $0.90, while
  // the OTM-from-spot strikes that would land in $0.30–$0.50 were excluded
  // by the old floor. No specific SPY failure case observed yet today, but
  // same dynamics apply as QQQ. Realized-loss cap unchanged.
  SPY: [0.30, 0.90],
  // QQQ floor widened 0.50 → 0.30 (2026-05-08): the original $0.50 floor
  // assumed the entry trigger fires while close ≈ entry, so near-ATM 0DTE
  // strikes naturally print $0.50–$0.90. But on a fast-moving day a fire can
  // happen with close already well above entry (e.g. today QQQ fired at 705.54
  // with entry 702.75, T1 706.00 — already 75% of the way to T1). At that
  // spot, strikes around `entry` are in-the-money relative to current price,
  // so the picker queries 7 strikes that all price >$0.90 and aborts. Lower
  // floor catches OTM-from-spot strikes ($0.30–$0.50 range) on these
  // late-trigger scenarios. Realized loss is still STP-bounded to ~$10/contract
  // regardless of fill premium. Marginal-trade tradeoff: more fires on chase
  // setups vs. more skipped legitimate-but-late entries.
  QQQ: [0.30, 0.90],
  IWM: [0.30, 0.70],
  // Stock weeklies (added 2026-05-06): near-ATM Friday expiries on $200+
  // names print $1.50–$3.00. $3.00 upper bound caps single-fire capital
  // deployed (~$600 at qty=2). Realized loss is still STP-bounded to
  // ~$10/contract regardless of fill premium, so this band controls
  // capital-at-risk, not loss-at-risk.
  //
  // Lower bound widened from $0.80 → $0.30 (2026-05-08): on AAPL today
  // a Trigger A fired (close=293.94 > entry=293.66, rVol=1.33) but the
  // strike picker rejected all 7 queried strikes (295C–325C) because
  // near-ATM strikes printed >$3 and OTM-but-tradeable strikes (305C-
  // 310C range) printed $0.30–$0.80, BELOW the $0.80 floor. Cheaper
  // strikes have lower delta but start from a smaller base — on a
  // successful T1 move they often deliver BETTER R-multiple in option-
  // premium terms (100%+ vs 30–60% for near-ATM). Worth the trade-off.
  AAPL: [0.30, 3.00],
  NVDA: [0.30, 3.00],
  AMZN: [0.30, 3.00],
};
const DEFAULT_PREMIUM_RANGE = [0.50, 0.90];
// Position size: 2 contracts per fire. User decision 2026-05-05 after the
// $0.10 option-premium STP demonstrated bounded realized loss in production
// (today's QQQ stop fired clean at $0.78 trigger, $12 realized). qty=2
// doubles the win/loss size symmetrically without tripping the qty≥3
// auto-trim ladder (still pending paper validation) — fires stay on the
// binary OCA bracket (T1 + STP).
//
// MAX_RISK_USD removed 2026-05-05. Was a $100 expires-worthless ceiling
// designed to abort fills with abnormally high premiums; superseded by the
// option-premium STP which bounds realized loss to ~$10/contract regardless
// of entry premium. The expires-worthless scenario isn't the binding
// constraint anymore — gap risk past the STP is the only edge case left,
// and that's a tail risk inherent to 0DTE that no $-cap can prevent.
const FIXED_QTY_PER_TRADE = 2;
// Stop loss is a true STP order on the OPTION premium. When option mid
// drops to (fillPrice - OPTION_STOP_OFFSET_USD), the STP fires and exits
// at market. Decoupled from underlying behavior — loss bounded purely by
// premium move. User decision 2026-05-04: simple FIXED $0.10 offset
// regardless of qty (per-trade $ loss now scales with qty: $10/contract).
//   Replaces the prior 2026-05-02 design (MAX_LOSS_PER_TRADE_USD=$60 cap
//   that was divided by qty); user wanted simpler "always $0.10" rule.
const OPTION_STOP_OFFSET_USD = 0.10;
const MAX_LOSS_PER_TRADE_USD = 60;   // legacy — retained for reference / discord copy
// Per-ticker trail width for runner mode (--trailing-runner). When enabled,
// the watcher places ONE TRAIL order on the option contract instead of the
// OCA bracket. Initial stop = fillPrice - TRAIL_WIDTH; thereafter the stop
// trails the high-water mark of the option premium at this fixed distance.
//
// Sizing rationale (moderate trail, user decision 2026-05-13):
//   ETFs $0.40  — SPY/QQQ/IWM 0DTE typically swing $0.20-0.40 on 5m bars;
//                 $0.40 survives normal noise without being so wide that
//                 a chop day blows up the week.
//   Stocks $0.70 — AAPL/AMZN/NVDA weeklies are thicker premium-wise with
//                  $0.30-0.60 typical bar-to-bar swings, so the trail
//                  scales proportionally.
//
// Max loss per trade (qty=2): ETFs $80, stocks $140 — 4-7× the existing
// $0.10 OPTION_STOP_OFFSET_USD, accepted in exchange for runner upside.
const TRAIL_WIDTH_USD = {
  SPY: 0.40, QQQ: 0.40, IWM: 0.40,
  AAPL: 0.70, NVDA: 0.70, AMZN: 0.70,
};
const DEFAULT_TRAIL_WIDTH = 0.40;
// ─── Fixed-stop config (2026-06-03/04) ───────────────────────────────────────
// The trailing stop is retired (it failed to ratchet on cheap/fast 0DTE premium
// — SPY 753P spiked 0.48→1.22→0.47 and the trail stayed pinned at entry). It is
// replaced by ONE fixed STP a flat dollar amount below the fill:
//   stopPrice = roundStopToTick(fillPrice − STOP_DISTANCE_USD)
// User decision 2026-06-04 (US): flat $0.10, uniform across tickers AND premiums
// → a constant $20 risk per 2-lot regardless of premium (0.40→0.30, 0.94→0.84,
// 1.42→1.32). "Tight primary": the STP is the hard floor; the user manages
// upside manually. Override with WATCHER_STOP_USD. (HK uses a 15% rule instead —
// see asia/scripts/trade_window_hk.mjs — because HKD premiums span ~1–7 HKD.)
const STOP_DISTANCE_USD = (() => {
  const v = Number(process.env.WATCHER_STOP_USD ?? 0.10);
  return Number.isFinite(v) && v > 0 ? v : 0.10;
})();
// Round an option stop to a valid exchange tick: $0.01 below $3.00, $0.05 at/above.
function roundStopToTick(p) {
  if (!(p > 0)) return 0.01;
  const tick = p >= 3 ? 0.05 : 0.01;
  return Math.max(0.01, Math.round((Math.round(p / tick) * tick) * 100) / 100);
}
// Number of strikes to query in prewarm + live-fetch fallback. Smaller =
// faster (each strike costs ~200ms IBKR pacing). 7 strikes covers any
// reasonable PREMIUM_RANGE (entry ± 3 strikes is always enough to find a
// match in the $0.30-$0.90 band across SPY/QQQ/IWM). Reduced from 20 →
// 7 on 2026-05-02 so periodic prewarm refresh can run more frequently
// without blowing past IBKR pacing budget.
const STRIKES_TO_QUERY = 7;
// Periodic prewarm refresh — runs in addition to the post-check refresh,
// so the cache is at most ~5 min stale at fire time (was 14 min on
// 2026-05-01 QQQ #1, where cached $0.62 vs fresh $1.41 = +127% drift).
const PREWARM_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// Gated sniper tier — enables Trigger A firing on mid-window 5m closes
// (HH:05/10/20/25/35/40/50/55) instead of waiting for the 15m close.
// Three gates:
//   Rule 1 — only fire on mid-window 5m closes (≤10 min before 15m boundary)
//   Rule 2 — bar close (= running 15m close) must be past entry threshold
//   Rule 3 — on the NEXT 5m bar's close after sniper fire, if running 15m
//            close has dropped back across entry, send market sell to
//            abort the position (avoids the full -1R stop on fakeouts)
//
// Validated by 30-day backtest (2026-05-02): same-window edge +9R vs 15m
// baseline, multi-window edge -4.5R, FP penalty -3R. Net +1.5R on
// underlying-R alone. Theta-aware option P&L will likely flip the multi-
// window losses to bigger losses (40-70min holds bleed theta), but Rule 3
// abort caps that bleeding by exiting before the structural stop fires.
//
// Flip to false to disable sniper entirely and revert to 15m-only.
// Disabled 2026-05-13 per user — "I want fires only based on 15mins
// candle close confirmation, I'm convinced sniper is not working".
// Anchored to multiple chop-day losses where mid-window 5m fires
// chased fakeouts that the 15m close itself rejected. Watcher now
// wakes on 15m boundaries only (stepMin = 15) and the sniper
// validator returns early with 'sniper disabled'.
const SNIPER_ENABLED = false;
const SNIPER_FAKEOUT_ABORT_ENABLED = true;  // Rule 3
// Auto-trim ladder Tier 1 placement: tier1 = entry ± TIER1_STOP_DIST_FACTOR × |stop − entry|
// Started at 0.5 (half-way between entry and stop in price-distance terms).
// Tightened to 0.3 on 2026-05-01 after a chop-day where Tier 1 at +0.5×stop never
// fired despite QQQ getting close (high 675.33 vs Tier 1 676.89). At 0.3, that
// trade's Tier 1 would have been at 675.36 — within reach. Trade-off: smaller
// runner on real trend days (we trim 33% sooner). Reversible single constant.
const TIER1_STOP_DIST_FACTOR = 0.3;
// STAGED_MODE = false → entry order auto-transmits (YES prompt is the sole gate)
// STAGED_MODE = true  → entry order stages in TWS, requires manual Transmit click
// Starting with auto-transmit for paper testing. Flip to true for live or to
// re-add the second-gate click safety.
const STAGED_MODE = false;
const BRACKET_ENABLED = true;              // auto-place T1 + stop as OCA after fill
// Per-ticker rVol (relative volume) thresholds — the minimum relative
// volume required before a fire is allowed. Neutral defaults below
// (1.0 = require at least average volume). These are strategy parameters:
// calibrate them to your own backtest and risk tolerance per ticker.
const RVOL_THRESHOLDS = {
  SPY: 1.0, QQQ: 1.0, IWM: 1.0,
  AAPL: 1.0, NVDA: 1.0, AMZN: 1.0,
};
// RVOL_THRESHOLD (per-ticker scalar) is derived after parseArgs resolves
// the active ticker — see line ~204 alongside PREMIUM_MIN/PREMIUM_MAX.
const VOLUME_LOOKBACK_BARS = 20;
const STALE_ENTRY_NOTES_HOURS = 4;
const TIME_STOP_ET_HOUR = 14;              // 14:00 ET — no new entries after
const ORB_COMPLETE_ET_HOUR = 10;           // 30-min ORB completes 10:00 ET (was 09:45 / 15-min, 2026-06-08)
const ORB_COMPLETE_ET_MIN = 0;

// ─── Arg parsing ─────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const ticker = args[0]?.toUpperCase();
  if (!ETF_TICKERS.has(ticker) && !STOCK_TICKERS.has(ticker)) {
    console.error('Usage: node trade_window.mjs <SPY|QQQ|IWM|AAPL|NVDA|AMZN> [--until HH:MM] [--test]');
    process.exit(1);
  }

  // Default now 02:00 SGT (covers the full 10:00-14:00 ET trade window per
  // rules.json). If the target time is already past today (script started
  // late), auto-roll to tomorrow — otherwise the watcher would refuse to
  // start for the common 9 PM SGT start + 2 AM SGT stop pattern.
  let untilStr = '02:00';
  const untilIdx = args.indexOf('--until');
  if (untilIdx >= 0 && args[untilIdx + 1]) untilStr = args[untilIdx + 1];

  const [h, m] = untilStr.split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    console.error(`Invalid --until time: ${untilStr}. Expected HH:MM.`);
    process.exit(1);
  }
  const until = new Date();
  until.setHours(h, m, 0, 0);
  if (until.getTime() <= Date.now()) {
    // Roll to tomorrow — handles the "start at 9 PM, stop at 2 AM" case
    until.setDate(until.getDate() + 1);
  }
  // Sanity cap: never run longer than 24 hours from now
  const maxUntil = Date.now() + 24 * 60 * 60 * 1000;
  if (until.getTime() > maxUntil) {
    console.error(`--until ${untilStr} resolves to more than 24h away. Exiting.`);
    process.exit(1);
  }

  const testMode = args.includes('--test');
  const testFire = args.includes('--test-fire');
  // --auto-fire (alias --no-yes-gate): suppress the portal confirm prompt and
  // place the order immediately when a trigger fires. User manages exits from
  // TWS directly. OCA bracket (T1 + option-stop) still arms as normal — only
  // the human-confirmation gate is removed. Default OFF preserves the prior
  // behavior. See user request 2026-05-09: "I want to suppress the trigger
  // from portal so that the program will do its job. Ill manage the trades
  // from my TWS."
  const autoFire = args.includes('--auto-fire') || args.includes('--no-yes-gate');
  // --confirm-fire (alias --1m-confirm): after Trigger A or A_SNIPER fires,
  // wait 60s and confirm via the next 1m bar that the breakout is sticking
  // before placing the order. Rejects fakeout-wick fires. Skips Trigger B
  // (different entry logic — VWAP rejection, not breakout). Default OFF.
  // See user request 2026-05-12 after the NVDA wick-stop cluster on
  // 2026-05-11. Backed by the 9-session retrospective in
  // journal/1m-confirmation-analysis-2026-05-12.md.
  const confirmFire = args.includes('--confirm-fire') || args.includes('--1m-confirm');
  // --trailing-runner (alias --trail): after fill, place a single TRAIL SELL
  // on the option contract instead of the OCA bracket (T1/T2/stop). Trail
  // width is per-ticker (TRAIL_WIDTH_USD). TV chart still draws T1/T2 lines
  // — those are now mental-map only, not enforced as exit orders. User
  // decision 2026-05-13: "rather than profit-taking at T1 & T2, what if I
  // keep the stop-loss as trailing… and keep the same width as the price
  // moves upwards from a premium perspective." Default OFF (per-ticker
  // toggle in the dashboard arm UI flips this on for that ticker only).
  // 2026-06-03 (user decision): a single option-premium stop is the ONLY exit;
  // the OCA bracket / ladder is retired. FIRST it was a trailing stop, but that
  // failed to ratchet on cheap/fast 0DTE premium (SPY 753P spiked 0.48→1.22→0.47,
  // trail stayed pinned at entry), so LATER the same day it became a FIXED stop at
  // STOP_DISTANCE_USD below fill (see placeFixedStop). Still a market exit on triggerMethod=1
  // (live bid). Flag name kept for compatibility. Default ON; --no-trailing restores
  // the old bracket.
  const trailingRunner = !args.includes('--no-trailing');
  return { ticker, until, untilStr, testMode, testFire, autoFire, confirmFire, trailingRunner };
}

const { ticker, until, untilStr, testMode, testFire, autoFire, confirmFire, trailingRunner } = parseArgs();

// ─── Exit alerting ───────────────────────────────────────────────────────────
// Every exit path used to be silent — Discord only fired on trades, so a watcher
// that crashed, was killed (dashboard/SIGTERM), hit --until, or failed startup
// validation just vanished with no ping. notifyExit() alerts on ANY exit, with a
// 3s backstop so a hung webhook can't wedge shutdown. The global handlers below
// catch crashes + kill signals; explicit exit sites route through it too.
let _exitAlertSent = false;
function notifyExit(reason, code = 0) {
  if (_exitAlertSent) { process.exit(code); return; }
  _exitAlertSent = true;
  const emoji = code === 0 ? '🟡' : '🔴';
  const force = setTimeout(() => process.exit(code), 3000);
  Promise.resolve(discordNotify(`${emoji} **${ticker} watcher exited** (code ${code}) — ${reason}`))
    .catch(() => {})
    .finally(() => { clearTimeout(force); process.exit(code); });
}
process.on('uncaughtException', (e) => notifyExit(`crashed — ${e?.stack?.split('\n')[0] ?? e?.message ?? e}`, 1));
process.on('unhandledRejection', (e) => notifyExit(`unhandled rejection — ${e?.message ?? e}`, 1));
process.on('SIGTERM', () => notifyExit('stopped (SIGTERM — dashboard/kill)', 0));

const [PREMIUM_MIN, PREMIUM_MAX] = PREMIUM_RANGE[ticker] ?? DEFAULT_PREMIUM_RANGE;
const RVOL_THRESHOLD = RVOL_THRESHOLDS[ticker] ?? 1.2;
const TRAIL_WIDTH = TRAIL_WIDTH_USD[ticker] ?? DEFAULT_TRAIL_WIDTH;

// ─── Load entry_notes ────────────────────────────────────────────────────────
function loadEntryNotes(ticker) {
  if (!fs.existsSync(ENTRY_NOTES_FILE)) {
    console.error(`❌ ${path.basename(ENTRY_NOTES_FILE)} not found. Run premarket_setup.mjs first.`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(ENTRY_NOTES_FILE, 'utf8'));
  const ageHrs = (Date.now() - new Date(raw.generatedAt).getTime()) / 3600000;
  if (ageHrs > STALE_ENTRY_NOTES_HOURS) {
    console.error(`❌ entry_notes is ${ageHrs.toFixed(1)}h old (>${STALE_ENTRY_NOTES_HOURS}h stale threshold).`);
    console.error(`   Re-run premarket_setup.mjs for fresh values.`);
    process.exit(1);
  }
  const t = raw.tickers?.[ticker];
  if (!t) { console.error(`❌ ${ticker} not in entry_notes.`); process.exit(1); }
  if (!t.entry_notes) {
    console.error(`❌ ${ticker} shows ${t.bias} (aligned=${t.aligned}) — no trade signal. Aborting.`);
    process.exit(0);
  }
  return {
    data: t.entry_notes,
    ageHrs,
    auroraZones: Array.isArray(t.aurora_zones) ? t.aurora_zones : [],
    sessionLevels: t.session_levels && typeof t.session_levels === 'object' ? t.session_levels : null,
  };
}

// Mutable bindings so reloadEntryNotesIfChanged() can refresh them mid-session
// when premarket re-runs and writes a new latest_entry_notes.json. Trade count,
// open OCA brackets, and prewarm cache carry forward unchanged across reloads.
let { data: entryNotes, ageHrs, auroraZones, sessionLevels } = loadEntryNotes(ticker);
let direction = entryNotes.direction;
let triggerA = entryNotes.trigger_a;
let entryPrice = triggerA.entry;
let lastLoadedGeneratedAt = (() => {
  try { return JSON.parse(fs.readFileSync(ENTRY_NOTES_FILE, 'utf8')).generatedAt; }
  catch { return null; }
})();

/**
 * Hot-reload entry_notes if `latest_entry_notes.json` has been rewritten
 * since the last load (e.g. a mid-session premarket re-run flipped the
 * bias). Carries trade count, open OCA brackets, and prewarm cache forward.
 *
 * Anchor case 2026-04-30: SPY watcher booted at 10:01 ET with PUTS
 * direction. Premarket re-ran at 10:32 ET, atomic-rewrote entry_notes
 * to BULL/CALLS. Dashboard read the file (showed BULL/CALLS) but the
 * watcher's in-memory snapshot was stale (still PUTS). User took a
 * manual CALLS scalp expecting auto-fire backup that never came.
 *
 * Returns true if reloaded, false otherwise. Lenient on file errors
 * (keep running with old levels) and on transient NO_TRADE state
 * (don't crash if the new payload has entry_notes: null).
 */
function reloadEntryNotesIfChanged() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(ENTRY_NOTES_FILE, 'utf8')); }
  catch (e) {
    // Don't crash on a transient read error — keep the old in-memory state.
    return false;
  }
  if (!raw?.generatedAt || raw.generatedAt === lastLoadedGeneratedAt) return false;

  const t = raw.tickers?.[ticker];
  if (!t?.entry_notes) {
    // The new write doesn't have a tradeable signal for this ticker (e.g.
    // bias flipped to NO_TRADE mid-session). Keep the old levels — any
    // open bracket is still valid against original levels; new fires will
    // just not happen if the validator finds nothing matching.
    console.log(`   ℹ entry_notes refreshed but ${ticker} now shows ${t?.bias ?? 'unknown'} (no entry) — keeping old levels`);
    lastLoadedGeneratedAt = raw.generatedAt;
    return false;
  }
  const newEntryNotes = t.entry_notes;
  const newDirection = newEntryNotes.direction;
  const newTriggerA = newEntryNotes.trigger_a;
  const newEntryPrice = newTriggerA?.entry;
  if (newEntryPrice == null) {
    // Trigger A entry missing — can't fire on it. Skip the swap.
    console.log(`   ℹ entry_notes refreshed but trigger_a.entry is null for ${ticker} — keeping old levels`);
    lastLoadedGeneratedAt = raw.generatedAt;
    return false;
  }

  const oldDir = direction;
  const oldEntry = entryPrice;
  entryNotes  = newEntryNotes;
  direction   = newDirection;
  triggerA    = newTriggerA;
  entryPrice  = newEntryPrice;
  auroraZones = Array.isArray(t.aurora_zones) ? t.aurora_zones : [];
  sessionLevels = t.session_levels && typeof t.session_levels === 'object' ? t.session_levels : null;
  lastLoadedGeneratedAt = raw.generatedAt;
  console.log(
    `   🔄 entry_notes reloaded — direction ${oldDir}→${direction}, ` +
    `entry ${oldEntry?.toFixed?.(2) ?? oldEntry}→${entryPrice.toFixed(2)}, ` +
    `${auroraZones.length} Aurora zone(s), ` +
    `session_levels=${sessionLevels ? `PDH${sessionLevels.pdh ?? '—'}/PDL${sessionLevels.pdl ?? '—'}/PMH${sessionLevels.pmh ?? '—'}/PML${sessionLevels.pml ?? '—'}` : 'none'} ` +
    `(file mtime: ${raw.generatedAt})`
  );
  emitLoadedLevelsMarker();
  return true;
}

/**
 * Emit a structured marker so the dashboard can show what the watcher
 * actually has loaded (instead of inferring from the file). Fix #2 of
 * the P0 watcher hot-reload work — kills the chart-vs-watcher display
 * divergence at the source.
 */
function emitLoadedLevelsMarker() {
  const payload = {
    ticker,
    direction,
    entry: entryPrice,
    trigger_a: triggerA,                    // includes T1_source, T2_source,
                                            // T1_cluster, T2_cluster, confluence
                                            // (Layer 1+2+3 metadata)
    trigger_b: entryNotes?.trigger_b ?? null, // includes per_candidate.{vwap,ema21_1H}
                                              // .{T1, T2, T1_source, T2_source,
                                              //   T1_cluster, T2_cluster, confluence}
    auroraZoneCount: auroraZones.length,
    session_levels: sessionLevels ?? null,
    generatedAt: lastLoadedGeneratedAt,
  };
  console.log(`__LOADED_LEVELS__ ${JSON.stringify(payload)}`);
}

// ─── One-trade-per-day check at startup ──────────────────────────────────────
if (hasTradedToday(ticker)) {
  console.error(formatBlockedMessage(ticker));
  // Emit a structured marker so the dashboard can render this exit as a
  // calm "✓ Daily cap reached" pill instead of an angry red "Exited (1)".
  console.log('__EXIT_REASON__ trade_cap');
  process.exit(0);
}

// ─── Time helpers ────────────────────────────────────────────────────────────
function nowInTZ(tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = fmt.formatToParts(new Date());
  return {
    h: parseInt(parts.find(p => p.type === 'hour').value, 10),
    m: parseInt(parts.find(p => p.type === 'minute').value, 10),
    s: parseInt(parts.find(p => p.type === 'second').value, 10),
  };
}

function nowETStr() {
  const { h, m, s } = nowInTZ('America/New_York');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ET`;
}

/**
 * Format a 15m bar's CLOSE time in ET (HH:MM). IBKR's bar.time is the bar's
 * OPEN timestamp (Unix seconds), but TradingView and the user's mental model
 * use close times. So `bar[10:30 ET]` here means "the candle that closed at
 * 10:30 ET" (i.e. opened at 10:15 ET) — matches what you see on a TV chart.
 */
function barCloseETStr(barOpenTimeSec) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  }).format(new Date((barOpenTimeSec + 15 * 60) * 1000));
}

function isWithinTradingWindow() {
  const { h, m } = nowInTZ('America/New_York');
  const mins = h * 60 + m;
  const orbMins = ORB_COMPLETE_ET_HOUR * 60 + ORB_COMPLETE_ET_MIN;
  const timeStopMins = TIME_STOP_ET_HOUR * 60;
  return mins >= orbMins && mins < timeStopMins;
}

function nextCandleBoundary() {
  // Wake 5s after each boundary close. Granularity depends on SNIPER_ENABLED:
  //   5m boundaries when sniper is active (8 wake-ups per hour)
  //   15m boundaries when sniper is disabled (4 wake-ups per hour, original)
  // The dispatcher in runOneCheck() then decides whether to run the 15m
  // validators (Trigger A/B) or the 5m sniper validator based on whether
  // the wake-up landed on a 15m boundary.
  const now = new Date();
  const m = now.getMinutes();
  const stepMin = SNIPER_ENABLED ? 5 : 15;
  const next = Math.floor(m / stepMin) * stepMin + stepMin;
  const target = new Date(now);
  target.setSeconds(5);
  target.setMilliseconds(0);
  target.setMinutes(next);
  if (target.getTime() - now.getTime() < 5000) {
    target.setTime(target.getTime() + stepMin * 60 * 1000);
  }
  return target;
}

// ─── IBKR connection ─────────────────────────────────────────────────────────
// Per-ticker clientId so concurrent SPY/QQQ/IWM watchers don't collide on
// reqHistoricalData reqIds (caused IWM 0-bar issue on 2026-04-28).
const watcherClientId = tradeWindowClientId(ticker);
const ib = new IBApi({ host: IBKR_CONFIG.host, port: IBKR_CONFIG.port, clientId: watcherClientId });

let nextOrderId = null;
const errorCounts = new Map();

ib.on(EventName.nextValidId, (id) => { nextOrderId = id; });

// ─── Execution persistence (rollover-proof) ─────────────────────────────────
// IBKR's reqExecutions API only returns executions from the current trading
// day; after the 18:00 ET rollover, yesterday's fills become inaccessible
// even though they remain in the user's permanent records. To ensure we
// have a record regardless of when the user runs persist_session.mjs, write
// every fill to journal/executions-raw/<date>-<ticker>.jsonl as it happens.
// scripts/persist_session.mjs consolidates these per-day later.
//
// We listen to execDetails (one event per partial fill) which IBKR pushes
// automatically for orders placed by this client. No reqExecutions call
// needed — execDetails fires whenever this watcher's own orders fill or
// when its OCA bracket legs trigger.
//
// Repo root for journal output (declared here so it's in scope for both
// the executions and the check-marker JSONL writers below).
const REPO_ROOT_FOR_JOURNAL = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const EXECS_RAW_DIR = path.join(REPO_ROOT_FOR_JOURNAL, 'journal', 'executions-raw');

function ensureExecsDir() {
  if (!fs.existsSync(EXECS_RAW_DIR)) {
    fs.mkdirSync(EXECS_RAW_DIR, { recursive: true });
  }
}

function execsJsonlPath(dateET) {
  return path.join(EXECS_RAW_DIR, `${dateET}-${ticker}.jsonl`);
}

ib.on(EventName.execDetails, (reqId, contract, execution) => {
  if (!execution || !execution.execId) return;
  const record = {
    execId: String(execution.execId),
    orderId: Number(execution.orderId ?? 0),
    permId: execution.permId,
    symbol: contract.symbol ?? '?',
    secType: contract.secType ?? '?',
    expiry: contract.lastTradeDateOrContractMonth,
    strike: contract.strike,
    right: contract.right,
    side: String(execution.side ?? '?'),
    qty: Number(execution.shares ?? 0),
    price: Number(execution.price ?? 0),
    time: String(execution.time ?? ''),
    account: String(execution.acctNumber ?? ''),
    exchange: typeof execution.exchange === 'string' ? execution.exchange : undefined,
    capturedAt: new Date().toISOString(),
  };
  try {
    ensureExecsDir();
    // Use the bar's ET date (not capturedAt date) so this groups by trading
    // day in the same way IBKR groups them.
    const m = record.time.match(/^(\d{4})(\d{2})(\d{2})/);
    const dateET = m ? `${m[1]}-${m[2]}-${m[3]}` : dateETStr();
    fs.appendFileSync(execsJsonlPath(dateET), JSON.stringify(record) + '\n');
  } catch (e) {
    // Persistence failure must not break the trader. Log once.
    console.log(`   ⚠ execution JSONL append failed: ${e.message}`);
  }
});

ib.on(EventName.error, (err, code, reqId) => {
  if (isInfoCode(code)) return;
  // Previously suppressed: 162 (historical data pacing/no-data). Now we surface
  // it because that's exactly the signal we need to diagnose "0 bars" issues.
  // Other known-noisy codes still silenced:
  //   200 = contract not found (happens during strike scans for expired strikes)
  //   300 = can't find contract
  //   354 = no market data subscription
  //   2137 = common TWS warning we don't care about
  if (code === 200 || code === 300 || code === 354 || code === 2137) return;
  errorCounts.set(code, (errorCounts.get(code) || 0) + 1);
  if (errorCounts.get(code) === 1) {
    console.log(`   [first] error [code=${code}  reqId=${reqId}]  ${err?.message || err}`);
  }
});

function connectIB() {
  return new Promise((resolve, reject) => {
    const handler = () => { ib.off(EventName.connected, handler); resolve(); };
    ib.on(EventName.connected, handler);
    ib.connect();
    setTimeout(() => reject(new Error('connection timeout after 10s')), 10000);
  });
}

// ─── Trigger B helpers (VWAP / 1H EMA21 / ATR computed from the 15m bars) ──
const ATR_PERIOD = 14;
const STRUCTURE_CHECK_K = 0.25; // mirror multi_timeframe_analysis.js LIVE value

/**
 * Session-anchored VWAP from 15m TRADES bars. Anchor = most recent
 * 9:30 ET = 13:30 UTC. Returns VWAP as of the last bar (or null if no bars
 * are within the current session anchor window).
 */
function computeSessionVWAP(bars) {
  if (!bars.length) return null;
  const last = bars[bars.length - 1];
  const lastDate = new Date(last.time * 1000);
  const y = lastDate.getUTCFullYear(), m = lastDate.getUTCMonth(), d = lastDate.getUTCDate();
  const anchor930 = Date.UTC(y, m, d, 13, 30, 0) / 1000;
  let anchor = anchor930;
  if (last.time < anchor930) anchor = anchor930 - 86400;
  let cumPV = 0, cumV = 0, vwap = null;
  for (const b of bars) {
    if (b.time < anchor) continue;
    const typical = (b.high + b.low + b.close) / 3;
    cumPV += typical * b.volume;
    cumV += b.volume;
    if (cumV > 0) vwap = cumPV / cumV;
  }
  return vwap;
}

/** Resample 15m bars → 1H bars aligned to UTC hour boundaries. */
function resampleTo1H(bars) {
  const byHour = new Map();
  for (const bar of bars) {
    const hourTs = Math.floor(bar.time / 3600) * 3600;
    if (!byHour.has(hourTs)) byHour.set(hourTs, []);
    byHour.get(hourTs).push(bar);
  }
  const out = [];
  for (const [hourTs, group] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
    group.sort((a, b) => a.time - b.time);
    out.push({
      time: hourTs,
      open: group[0].open,
      high: Math.max(...group.map(b => b.high)),
      low: Math.min(...group.map(b => b.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, b) => s + b.volume, 0),
    });
  }
  return out;
}

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = values[0];
  out.push(prev);
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** 1H EMA21 value as of the most recent 1H bar that CLOSED at or before `ts`. */
function getEMA21_1H_AsOf(bars, ts) {
  const oneHourBars = resampleTo1H(bars);
  if (oneHourBars.length < 21) return null;
  const closes = oneHourBars.map(b => b.close);
  const ema = emaSeries(closes, 21);
  let lastIdx = -1;
  for (let i = 0; i < oneHourBars.length; i++) {
    if (oneHourBars[i].time + 3600 <= ts) lastIdx = i;
    else break;
  }
  return lastIdx >= 0 ? ema[lastIdx] : null;
}

/**
 * Standard 12/26/9 MACD line (fast EMA − slow EMA) computed across an array
 * of closes. Returns array of same length as input. Early indices before the
 * slow EMA settles will be near zero / unreliable — caller should require
 * `closes.length >= 35` (26 for slow EMA + 9 for signal warmup) before
 * trusting divergence comparisons.
 */
function macdLine(closes) {
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  return fast.map((v, i) => v - slow[i]);
}

/**
 * Detect classic regular divergence between the current (last-closed) bar
 * and the prior swing in `lookback` bars. Returns { hasDivergence, ... } or
 * null if insufficient data.
 *
 *   isLong=true  (long signal):  BEARISH divergence is the anti-signal —
 *                                current bar.high > prior swing high BUT
 *                                current MACD < MACD at prior swing.
 *   isLong=false (short signal): BULLISH divergence is the anti-signal —
 *                                current bar.low < prior swing low BUT
 *                                current MACD > MACD at prior swing.
 *
 * "Swing" simplified to the max/min over the prior lookback bars (excluding
 * current). Sophisticated N-bar local-extrema detection deferred — this
 * heuristic catches the strongest divergence cases. False positives possible
 * on choppy ranges; nearMiss machinery measures the cost over time.
 */
function detectDivergence(bars, isLong, lookback = 20) {
  if (bars.length < 35) return null;                                  // need full MACD warmup
  const closes = bars.map(b => b.close);
  const macd = macdLine(closes);
  const N = bars.length;
  const start = Math.max(0, N - lookback - 1);
  const priorSlice = bars.slice(start, N - 1);                        // exclude current
  if (priorSlice.length === 0) return null;
  let priorIdx = start;
  if (isLong) {
    let priorHi = -Infinity;
    for (let i = start; i < N - 1; i++) {
      if (bars[i].high > priorHi) { priorHi = bars[i].high; priorIdx = i; }
    }
    const cur = bars[N - 1];
    const hasDivergence = cur.high > priorHi && macd[N - 1] < macd[priorIdx];
    return {
      hasDivergence,
      kind: 'bearish',
      priorSwingPrice: priorHi,
      priorSwingMACD: macd[priorIdx],
      currentExtreme: cur.high,
      currentMACD: macd[N - 1],
    };
  } else {
    let priorLo = Infinity;
    for (let i = start; i < N - 1; i++) {
      if (bars[i].low < priorLo) { priorLo = bars[i].low; priorIdx = i; }
    }
    const cur = bars[N - 1];
    const hasDivergence = cur.low < priorLo && macd[N - 1] > macd[priorIdx];
    return {
      hasDivergence,
      kind: 'bullish',
      priorSwingPrice: priorLo,
      priorSwingMACD: macd[priorIdx],
      currentExtreme: cur.low,
      currentMACD: macd[N - 1],
    };
  }
}

/**
 * Find the nearest opposing Aurora supply/demand zone relative to a trade
 * entry. Returns the zone closest to `entry` on the side that creates a
 * "wall" against the trade direction:
 *   - LONG  (CALLS): nearest supply zone with low > entry  (price rising
 *                    into a wall)
 *   - SHORT (PUTS):  nearest demand zone with high < entry (price falling
 *                    into a floor)
 *
 * Returns null if no opposing zone exists or `zones` is empty.
 *
 * Gate caller computes distance: `distance = isLong ? (zone.low - entry)
 *                                                   : (entry - zone.high)`
 * and suppresses the fire if distance < threshold (0.5 × ATR by default).
 */
function nearestOpposingZone(zones, entry, isLong) {
  if (!Array.isArray(zones) || zones.length === 0) return null;
  if (isLong) {
    let best = null;
    for (const z of zones) {
      if (z.low > entry && (best == null || z.low < best.low)) best = z;
    }
    return best;
  } else {
    let best = null;
    for (const z of zones) {
      if (z.high < entry && (best == null || z.high > best.high)) best = z;
    }
    return best;
  }
}

const AURORA_CONFLICT_K = 0.5;          // suppress fire when nearest opposing zone within 0.5 × ATR
const SESSION_LEVEL_K   = 0.3;          // suppress fire when nearest opposing session level (PDH/PDL/PMH/PML) within 0.3 × ATR

/**
 * Nearest opposing session level — returns the closest of {PDH, PDL, PMH, PML}
 * on the side that would resist the trade direction:
 *   isLong  → nearest level ABOVE entry (overhead resistance / magnet)
 *   isShort → nearest level BELOW entry (underlying support / bounce)
 *
 * All four levels are considered equally; PDH/PDL aren't ranked higher than
 * PMH/PML at this stage — that's a calibration question for after we have
 * near-miss data. Returns { name, value } or null if no qualifying level.
 */
function nearestOpposingSessionLevel(sessionLevels, entry, isLong) {
  if (!sessionLevels) return null;
  const candidates = [
    { name: 'PDH', value: sessionLevels.pdh },
    { name: 'PDL', value: sessionLevels.pdl },
    { name: 'PMH', value: sessionLevels.pmh },
    { name: 'PML', value: sessionLevels.pml },
  ].filter(c => c.value != null && Number.isFinite(c.value));

  if (isLong) {
    let best = null;
    for (const c of candidates) {
      if (c.value > entry && (best == null || c.value < best.value)) best = c;
    }
    return best;
  } else {
    let best = null;
    for (const c of candidates) {
      if (c.value < entry && (best == null || c.value > best.value)) best = c;
    }
    return best;
  }
}

/** ATR(14) on 15m bars. Returns null if we don't have enough bars. */
function computeATR(bars, period = ATR_PERIOD) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i], prev = bars[i - 1];
    trs.push(Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    ));
  }
  const window = trs.slice(-period);
  return window.reduce((s, t) => s + t, 0) / window.length;
}

// ─── Notifications ───────────────────────────────────────────────────────────
function notify(title, message, sound = 'Submarine') {
  const esc = (s) => String(s).replace(/'/g, "\\'").replace(/"/g, '\\"');
  try {
    execSync(`osascript -e 'display notification "${esc(message)}" with title "${esc(title)}" sound name "${sound}"'`);
  } catch {}
}

// ─── Candle-close validator ──────────────────────────────────────────────────

// Repo root → journal/watcher-checks-raw/ holds per-ticker per-day JSONL files.
// REPO_ROOT_FOR_JOURNAL is declared earlier (alongside the executions JSONL
// writer) so it's in scope by the time the execDetails listener runs.
const CHECKS_RAW_DIR = path.join(REPO_ROOT_FOR_JOURNAL, 'journal', 'watcher-checks-raw');

function ensureChecksDir() {
  if (!fs.existsSync(CHECKS_RAW_DIR)) {
    fs.mkdirSync(CHECKS_RAW_DIR, { recursive: true });
  }
}

function checksJsonlPath(dateET) {
  return path.join(CHECKS_RAW_DIR, `${dateET}-${ticker}.jsonl`);
}

function dateETStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());  // YYYY-MM-DD
}

// Helper that emits a __CHECK__ marker on EVERY return path so the dashboard
// can render every validation attempt in the last-check row, including early
// failures like insufficient bars or stale data. Also appends to a JSONL
// file so the full check history survives dashboard restarts and is
// available for the May 12 sniper analysis routine.
function emitCheckMarker(payload) {
  const json = JSON.stringify(payload);
  console.log(`__CHECK__ ${json}`);
  try {
    ensureChecksDir();
    const record = { ...payload, emittedAt: new Date().toISOString() };
    fs.appendFileSync(checksJsonlPath(dateETStr()), JSON.stringify(record) + '\n');
  } catch (e) {
    // Persistence failure must not break the trader. Log once and move on.
    console.log(`   ⚠ check-marker JSONL append failed: ${e.message}`);
  }
}

// Track consecutive 0-bar responses across calls — we warn the user if IBKR
// appears to be starved (usually means TWS pacing, permissions, or dead feed).
let consecutiveZeroBars = 0;

// Shared ATR15 cache. validateTriggerA computes it from 15m bars; sniper
// validators reuse the most recent value. Worst case ~5 min stale (last
// 15m boundary check), close enough for stop-distance/T1 math.
let _lastATR15 = null;

// Active sniper position state for Rule 3 (fakeout abort). Set after a
// sniper fire fills; cleared on T1/stop hit, on Rule 3 abort, or on
// process shutdown. The 'rule3DueAfter' field is the epoch-second cutoff:
// after the next 5m bar closes (this time + 5min), check if running 15m
// close is back across entry — if yes, market-sell to flat the position.
let _activeSniperPosition = null;

// Try a few duration widths if IBKR returns an empty result. Some TWS setups
// (paper account without market data subscriptions, pacing after a long run)
// return [] for '1 D' but will return data for '5 D' or '10 D'.
async function fetchStockBarsWithRetry(stockContract) {
  const durations = ['2 D', '5 D', '10 D'];
  for (const duration of durations) {
    const bars = await reqHistoricalBars(ib, stockContract, duration, '15 mins', 'TRADES', 1);
    if (bars.length > 0) {
      if (duration !== '2 D') {
        console.log(`   (IBKR returned 0 bars on 2 D, recovered with ${duration})`);
      }
      return { bars, duration };
    }
  }
  return { bars: [], duration: durations[durations.length - 1] };
}

/**
 * Fetch + sanity-check stock bars. Returns { bars: [...sorted], lastClosed,
 * priorBars, error: null } on success or { bars: [], error: { reason, ...meta } }
 * on any sanity failure (zero bars, insufficient, stale, etc.). The error
 * payload includes the data needed to emit a __CHECK__ marker.
 *
 * Shared by validateTriggerA and validateTriggerB so both validators see the
 * same bars + same sanity gating per check (single fetch, single set of
 * markers for "data unhealthy" cases).
 */
async function fetchAndValidateBars() {
  const stockContract = { symbol: ticker, secType: 'STK', exchange: 'SMART', currency: 'USD' };

  // Compute the OPEN time of the most recently closed 15m bar. We expect
  // IBKR to return a bars array whose last element has this open time.
  // If it doesn't (because IBKR hasn't materialized the just-closed bar
  // yet), poll every 3s up to 30s before giving up. This shaves typical
  // bar-availability latency from ~30s (old fixed buffer) to ~5-15s.
  const nowSecAtStart = Math.floor(Date.now() / 1000);
  const lastBoundarySec = Math.floor(nowSecAtStart / 900) * 900;
  const expectedLastClosedOpenSec = lastBoundarySec - 900;

  let bars = [];
  let duration = '2 D';
  const POLL_INTERVAL_MS = 3000;
  const MAX_POLL_MS = 30_000;
  const pollStart = Date.now();
  let pollAttempt = 0;
  while (true) {
    pollAttempt++;
    ({ bars, duration } = await fetchStockBarsWithRetry(stockContract));
    const haveExpected = bars.length && bars[bars.length - 1].time >= expectedLastClosedOpenSec;
    if (haveExpected) {
      if (pollAttempt > 1) {
        const waitedSec = Math.round((Date.now() - pollStart) / 1000);
        console.log(`   (bar materialized after ${waitedSec}s of polling, ${pollAttempt} attempts)`);
      }
      break;
    }
    if (Date.now() - pollStart >= MAX_POLL_MS) {
      // Give up polling — fall through to the existing error paths below.
      // bars may still be non-empty (just stale); error handling treats it.
      if (bars.length) {
        const lastET = barCloseETStr(bars[bars.length - 1].time);
        console.log(`   ⚠ giving up polling after ${Math.round(MAX_POLL_MS/1000)}s — last bar still ${lastET}, expected newer`);
      }
      break;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const barTimeET = bars.length ? barCloseETStr(bars[bars.length - 1].time) : null;

  if (bars.length === 0) {
    consecutiveZeroBars++;
    const reason = consecutiveZeroBars >= 3
      ? `IBKR returned 0 bars (duration ${duration}) — ${consecutiveZeroBars} consecutive. TWS feed likely degraded.`
      : `IBKR returned 0 bars (duration ${duration})`;
    if (consecutiveZeroBars === 3) {
      console.log(`⚠ IBKR historical data appears degraded: 3 consecutive 0-bar responses.`);
      console.log(`  Check TWS on the other laptop. Restart TWS if needed, then re-arm the watcher.`);
    }
    return { bars: [], error: { reason, close: null, rVol: null, barTime: null } };
  }
  consecutiveZeroBars = 0;

  if (bars.length < VOLUME_LOOKBACK_BARS + 1) {
    return { bars: [], error: { reason: `insufficient bars (${bars.length}, need ${VOLUME_LOOKBACK_BARS + 1}+)`, close: null, rVol: null, barTime: barTimeET } };
  }

  bars.sort((a, b) => a.time - b.time);
  const completed = bars.filter(b => b.time + 15 * 60 <= nowSec);
  if (completed.length < VOLUME_LOOKBACK_BARS + 1) {
    return { bars: [], error: { reason: `only ${completed.length} completed bars (need ${VOLUME_LOOKBACK_BARS + 1}+)`, close: null, rVol: null, barTime: barTimeET } };
  }

  const lastClosed = completed[completed.length - 1];
  const priorBars = completed.slice(-(VOLUME_LOOKBACK_BARS + 1), -1);
  const barAgeMin = (nowSec - lastClosed.time - 15 * 60) / 60;
  if (barAgeMin > 20) {
    const lastBarTime = barCloseETStr(lastClosed.time);
    return { bars: [], error: { reason: `stale bar (${barAgeMin.toFixed(0)}m old) — market may be closed`, close: lastClosed.close, rVol: null, barTime: lastBarTime } };
  }

  return { bars: completed, lastClosed, priorBars, error: null };
}

/**
 * Trigger A validator — 15m close beyond ORB high/low + rVol ≥ threshold +
 * within RTH entry window. Uses entry_notes.trigger_a levels (loaded at startup).
 *
 * Returns { triggered: boolean, reason: string, signal?: {...} } where signal
 * (when triggered) carries everything handleTriggered() needs to place the order.
 */
async function validateTriggerA() {
  // Pullback-only setup: trigger_a.entry is null (no clean ORB breakout). Skip
  // Trigger A entirely — Trigger B carries the signal. Without this guard the
  // null entryPrice crashes at the .toFixed() summary line below.
  if (entryPrice == null) {
    return { triggered: false, reason: 'Trigger A inactive — no ORB breakout entry (pullback-only; Trigger B active)' };
  }
  const fetched = await fetchAndValidateBars();
  if (fetched.error) {
    emitCheckMarker({ ticker, triggerType: 'A', triggered: false, ...fetched.error, entryPrice, direction });
    return { triggered: false, reason: fetched.error.reason };
  }
  const { lastClosed, priorBars } = fetched;

  const avgVol = priorBars.reduce((s, b) => s + b.volume, 0) / priorBars.length;
  const rVol = avgVol > 0 ? lastClosed.volume / avgVol : 0;
  const crossed = direction === 'CALLS' ? lastClosed.close > entryPrice : lastClosed.close < entryPrice;
  const lastBarTime = barCloseETStr(lastClosed.time);
  const cmp = direction === 'CALLS' ? '>' : '<';
  const summary = `bar[${lastBarTime} ET] close=${lastClosed.close.toFixed(2)} ${cmp}${entryPrice.toFixed(2)}=${crossed ? 'YES' : 'no'} rVol=${rVol.toFixed(2)}`;
  const basePayload = { ticker, triggerType: 'A', barTime: lastBarTime, close: lastClosed.close, rVol, entryPrice, direction };

  if (!crossed) {
    emitCheckMarker({ ...basePayload, triggered: false, reason: summary });
    return { triggered: false, reason: summary };
  }
  // Pattern matched (close crossed entry). All blocked branches below
  // attach a `nearMiss` payload so persist_session.mjs can simulate the
  // would-be trade outcome from subsequent bars. This is the data layer
  // for empirically retuning rVol thresholds, time windows, and any
  // future numeric gate (per-ticker calibration roadmap Item 2).
  const wouldHaveFiredA = {
    entry: entryPrice,
    stop: triggerA.stop ?? null,
    T1: triggerA.T1 ?? null,
    T2: triggerA.T2 ?? null,
    direction,
  };
  // ─── MACD divergence gate ────────────────────────────────────────────────
  // Bearish divergence on a long breakout (or bullish on a short) is the
  // strongest single-bar anti-signal — price is making a new extreme but
  // MACD isn't confirming. Suppress at fire time. nearMiss machinery
  // captures cost; reverse if 30+ samples show net-negative R impact.
  const isLongA = direction === 'CALLS';
  const divA = detectDivergence(fetched.bars, isLongA);
  if (divA?.hasDivergence) {
    const reason = `${summary} BUT ${divA.kind} divergence: cur ${isLongA?'high':'low'}=${divA.currentExtreme.toFixed(2)} ${isLongA?'>':'<'} prior swing ${divA.priorSwingPrice.toFixed(2)}, MACD ${divA.currentMACD.toFixed(4)} ${isLongA?'<':'>'} prior ${divA.priorSwingMACD.toFixed(4)}`;
    const nearMiss = {
      blockedBy: 'divergence',
      actualValue: { currentMACD: divA.currentMACD, priorSwingMACD: divA.priorSwingMACD, currentPrice: divA.currentExtreme, priorSwingPrice: divA.priorSwingPrice },
      thresholdValue: divA.kind === 'bearish' ? 'currentMACD >= priorSwingMACD when newer high' : 'currentMACD <= priorSwingMACD when newer low',
      wouldHaveFired: wouldHaveFiredA,
    };
    emitCheckMarker({ ...basePayload, triggered: false, reason, nearMiss });
    return { triggered: false, reason };
  }
  // ─── Aurora confluence gate (chop-trap suppression) ──────────────────────
  // Aurora supply/demand zones drawn on the TV chart are persisted into
  // entry_notes by premarket_setup.mjs. At fire time, if the nearest
  // OPPOSING zone (supply for long / demand for short) sits within
  // AURORA_CONFLICT_K × ATR15 of entry, the breakout is firing into a
  // wall — chop-trap setups that yesterday's manual trades reinforced.
  // Lenient when no Aurora zones are available (premarket fetch failed or
  // Aurora not loaded) — let the trade fire on the existing logic alone.
  const atr15A = computeATR(fetched.bars);
  if (atr15A != null) _lastATR15 = atr15A;  // share with sniper
  if (auroraZones.length > 0 && atr15A != null) {
    const opposing = nearestOpposingZone(auroraZones, entryPrice, isLongA);
    if (opposing) {
      const distance = isLongA ? (opposing.low - entryPrice) : (entryPrice - opposing.high);
      const threshold = AURORA_CONFLICT_K * atr15A;
      if (distance < threshold) {
        const reason = `${summary} BUT Aurora ${isLongA?'supply':'demand'} zone ${isLongA?`@ ${opposing.low.toFixed(2)}-${opposing.high.toFixed(2)}`:`@ ${opposing.low.toFixed(2)}-${opposing.high.toFixed(2)}`} within ${threshold.toFixed(2)} (=${AURORA_CONFLICT_K}×ATR) of entry ${entryPrice.toFixed(2)} — chop-trap, suppressing`;
        const nearMiss = {
          blockedBy: 'aurora_conflict',
          actualValue: distance,
          thresholdValue: threshold,
          wouldHaveFired: wouldHaveFiredA,
          opposingZone: opposing,
        };
        emitCheckMarker({ ...basePayload, triggered: false, reason, nearMiss });
        return { triggered: false, reason };
      }
    }
  }
  // ─── Session-level proximity gate ────────────────────────────────────────
  // PDH / PDL / PMH / PML often act as magnets (price is drawn toward them)
  // and rejection points (price stalls or reverses on contact). When a long
  // fires within SESSION_LEVEL_K × ATR15 BELOW the nearest overhead session
  // level (or a short within the same threshold ABOVE the nearest underlying
  // session level), the breakout is firing into a likely rejection zone —
  // suppress. Lenient when sessionLevels is missing or no qualifying level
  // exists on the relevant side. nearMiss machinery captures cost so the
  // gate's K and net-R impact can be evaluated after ≥30 samples.
  if (sessionLevels && atr15A != null) {
    const opposing = nearestOpposingSessionLevel(sessionLevels, entryPrice, isLongA);
    if (opposing) {
      const distance = isLongA ? (opposing.value - entryPrice) : (entryPrice - opposing.value);
      const threshold = SESSION_LEVEL_K * atr15A;
      if (distance < threshold) {
        const reason = `${summary} BUT ${opposing.name} @ ${opposing.value.toFixed(2)} within ${threshold.toFixed(2)} (=${SESSION_LEVEL_K}×ATR) ${isLongA ? 'overhead of' : 'below'} entry ${entryPrice.toFixed(2)} — likely magnet/rejection, suppressing`;
        const nearMiss = {
          blockedBy: 'session_level_proximity',
          actualValue: distance,
          thresholdValue: threshold,
          wouldHaveFired: wouldHaveFiredA,
          opposingLevel: { name: opposing.name, value: opposing.value },
        };
        emitCheckMarker({ ...basePayload, triggered: false, reason, nearMiss });
        return { triggered: false, reason };
      }
    }
  }
  if (rVol < RVOL_THRESHOLD) {
    const reason = `${summary} (rVol below ${RVOL_THRESHOLD})`;
    const nearMiss = {
      blockedBy: 'rVol',
      actualValue: rVol,
      thresholdValue: RVOL_THRESHOLD,
      wouldHaveFired: wouldHaveFiredA,
    };
    emitCheckMarker({ ...basePayload, triggered: false, reason, nearMiss });
    return { triggered: false, reason };
  }
  if (!isWithinTradingWindow()) {
    const reason = `${summary} BUT outside trading window [10:00-14:00 ET]`;
    const nearMiss = {
      blockedBy: 'window',
      actualValue: null,                                 // time-of-day, not a numeric value
      thresholdValue: 'within [10:00, 14:00) ET',
      wouldHaveFired: wouldHaveFiredA,
    };
    emitCheckMarker({ ...basePayload, triggered: false, reason, nearMiss });
    return { triggered: false, reason };
  }

  emitCheckMarker({ ...basePayload, triggered: true, reason: summary });
  return {
    triggered: true,
    reason: summary,
    signal: {
      triggerType: 'A',
      direction,
      entry: entryPrice,
      stop: triggerA.stop,
      T1: triggerA.T1,
      T2: triggerA.T2 ?? null,
      atr15: atr15A,
      // Bar context propagated so handleTriggered's downstream gates
      // (VIX, correlation, chase) can emit __CHECK__ markers anchored
      // to the actual bar — rather than barTime: null, which the
      // persist_session near-miss simulator drops.
      barTime: lastBarTime,
      close: lastClosed.close,
      rVol,
    },
  };
}

/**
 * Trigger B validator — pullback-and-reclaim of session VWAP or 1H EMA21.
 * LONG  = bar.open ≤ level AND bar.close > level AND bullish (close > open)
 * SHORT = bar.open ≥ level AND bar.close < level AND bearish (close < open)
 * + rVol ≥ threshold + within RTH window. First-touched between VWAP / EMA21
 * wins (VWAP checked first).
 *
 * Direction comes from entry_notes (matches the bias that passed the
 * structure check at premarket time). Returns { triggered, reason, signal? }
 * with the same shape as validateTriggerA so the main loop treats them
 * uniformly.
 */
async function validateTriggerB() {
  const fetched = await fetchAndValidateBars();
  if (fetched.error) {
    emitCheckMarker({ ticker, triggerType: 'B', triggered: false, ...fetched.error, direction });
    return { triggered: false, reason: fetched.error.reason };
  }
  const { bars, lastClosed } = fetched;

  const vwap = computeSessionVWAP(bars);
  const ema21_1H = getEMA21_1H_AsOf(bars, lastClosed.time);
  const atr = computeATR(bars);
  const lastBarTime = barCloseETStr(lastClosed.time);

  const avgVol = fetched.priorBars.reduce((s, b) => s + b.volume, 0) / fetched.priorBars.length;
  const rVol = avgVol > 0 ? lastClosed.volume / avgVol : 0;
  const basePayload = { ticker, triggerType: 'B', barTime: lastBarTime, close: lastClosed.close, rVol, direction };

  if (vwap == null && ema21_1H == null) {
    const reason = `neither VWAP nor 1H EMA21 computable yet`;
    emitCheckMarker({ ...basePayload, triggered: false, reason });
    return { triggered: false, reason };
  }
  if (atr == null) {
    const reason = `ATR not yet computable`;
    emitCheckMarker({ ...basePayload, triggered: false, reason });
    return { triggered: false, reason };
  }

  const levels = [
    { name: 'VWAP', value: vwap },
    { name: 'EMA21_1H', value: ema21_1H },
  ].filter(l => l.value != null);

  for (const lvl of levels) {
    const isLong = direction === 'CALLS';
    const isShort = direction === 'PUTS';
    const longReclaim  = isLong  && lastClosed.open <= lvl.value && lastClosed.close > lvl.value && lastClosed.close > lastClosed.open;
    const shortReject  = isShort && lastClosed.open >= lvl.value && lastClosed.close < lvl.value && lastClosed.close < lastClosed.open;

    if (longReclaim || shortReject) {
      const summary = `bar[${lastBarTime} ET] ${lvl.name} ${isLong ? 'reclaim' : 'reject'} @ ${lvl.value.toFixed(2)} close=${lastClosed.close.toFixed(2)} rVol=${rVol.toFixed(2)}`;
      // Pattern matched. Compute would-be levels once so all blocked
      // branches and the fire branch use identical math (and the nearMiss
      // simulator in persist_session.mjs has authoritative entry/stop/T1).
      const entry = lvl.value;
      const stop = isLong ? entry - atr : entry + atr;
      const T1 = isLong ? entry + atr : entry - atr;
      const wouldHaveFiredB = {
        subType: lvl.name,
        entry,
        stop,
        T1,
        T2: null,
        direction,
      };
      // ─── Gate 1: structure check (port from Trigger A's K=0.25 logic) ─────
      // Trigger A enforces orb.high >= ema21_1H - K*atr (BULL) / orb.low <=
      // ema21_1H + K*atr (BEAR) at premarket time. Trigger B has had no
      // equivalent — and yesterday's 2026-04-29 SPY −$20 trade was a Trigger
      // B PUTS fire while watcher direction was PUTS but premarket bias was
      // BULL. The structure check at fire time catches the case where the
      // entry level sits on the wrong side of the 1H trend.
      //
      // Degenerate when level == ema21_1H itself (firing on EMA21 pullback):
      // check becomes ema21_1H ?? ema21_1H ± K*atr, always true → no harm.
      // When ema21_1H is null (insufficient bars for 1H EMA), skip the check
      // (lenient fallback matching Trigger A's `: true` default).
      const STRUCTURE_CHECK_K = 0.25;
      const structureSupportsB = ema21_1H == null
        ? true
        : isLong
          ? lvl.value >= ema21_1H - STRUCTURE_CHECK_K * atr
          : lvl.value <= ema21_1H + STRUCTURE_CHECK_K * atr;
      if (!structureSupportsB) {
        const threshold = isLong
          ? ema21_1H - STRUCTURE_CHECK_K * atr
          : ema21_1H + STRUCTURE_CHECK_K * atr;
        const reason = `${summary} BUT structure check failed: ${lvl.name}=${lvl.value.toFixed(2)} ${isLong ? '<' : '>'} 1H_EMA21 ${ema21_1H.toFixed(2)} ${isLong ? '−' : '+'} 0.25×ATR (=${threshold.toFixed(2)})`;
        const nearMiss = {
          blockedBy: 'structure_b',
          actualValue: lvl.value,
          thresholdValue: threshold,
          wouldHaveFired: wouldHaveFiredB,
        };
        emitCheckMarker({ ...basePayload, triggered: false, reason, level: lvl.value, levelName: lvl.name, nearMiss });
        return { triggered: false, reason };
      }
      // ─── Gate 2: no-fire on the final ORB bar (10:00) ────────────────────
      // Trigger B is conceptually a pullback in an established trend. With the
      // 30-min ORB (09:30–10:00) the trade window opens at 10:00, but the 10:00
      // bar (09:45–10:00 close) is still the back half of the opening range —
      // no post-ORB structure to pull back from. A "VWAP reject" there is the
      // textbook open-bar fakeout (anchor: 2026-04-29 SPY 09:45 reject @ 710.39
      // close 710.04, then reclaimed VWAP, stop hit). Fires start 10:15.
      // Trigger A is exempt — it's a breakout off the ORB itself.
      if (lastBarTime === '10:00') {
        const reason = `${summary} BUT bar=10:00 (final ORB bar) — Trigger B suppressed: requires ≥ 1 post-ORB bar of session structure`;
        const nearMiss = {
          blockedBy: 'first_bar',
          actualValue: '10:00',
          thresholdValue: 'bar > 10:00',
          wouldHaveFired: wouldHaveFiredB,
        };
        emitCheckMarker({ ...basePayload, triggered: false, reason, level: lvl.value, levelName: lvl.name, nearMiss });
        return { triggered: false, reason };
      }
      // ─── MACD divergence gate (mirror of Trigger A's check) ──────────────
      const divB = detectDivergence(bars, isLong);
      if (divB?.hasDivergence) {
        const reason = `${summary} BUT ${divB.kind} divergence: cur ${isLong?'high':'low'}=${divB.currentExtreme.toFixed(2)} ${isLong?'>':'<'} prior swing ${divB.priorSwingPrice.toFixed(2)}, MACD ${divB.currentMACD.toFixed(4)} ${isLong?'<':'>'} prior ${divB.priorSwingMACD.toFixed(4)}`;
        const nearMiss = {
          blockedBy: 'divergence',
          actualValue: { currentMACD: divB.currentMACD, priorSwingMACD: divB.priorSwingMACD, currentPrice: divB.currentExtreme, priorSwingPrice: divB.priorSwingPrice },
          thresholdValue: divB.kind === 'bearish' ? 'currentMACD >= priorSwingMACD when newer high' : 'currentMACD <= priorSwingMACD when newer low',
          wouldHaveFired: wouldHaveFiredB,
        };
        emitCheckMarker({ ...basePayload, triggered: false, reason, level: lvl.value, levelName: lvl.name, nearMiss });
        return { triggered: false, reason };
      }
      // ─── Aurora confluence gate (mirror of Trigger A's check) ────────────
      if (auroraZones.length > 0 && atr != null) {
        const opposingB = nearestOpposingZone(auroraZones, entry, isLong);
        if (opposingB) {
          const distance = isLong ? (opposingB.low - entry) : (entry - opposingB.high);
          const threshold = AURORA_CONFLICT_K * atr;
          if (distance < threshold) {
            const reason = `${summary} BUT Aurora ${isLong?'supply':'demand'} zone @ ${opposingB.low.toFixed(2)}-${opposingB.high.toFixed(2)} within ${threshold.toFixed(2)} (=${AURORA_CONFLICT_K}×ATR) of entry ${entry.toFixed(2)} — chop-trap, suppressing`;
            const nearMiss = {
              blockedBy: 'aurora_conflict',
              actualValue: distance,
              thresholdValue: threshold,
              wouldHaveFired: wouldHaveFiredB,
              opposingZone: opposingB,
            };
            emitCheckMarker({ ...basePayload, triggered: false, reason, level: lvl.value, levelName: lvl.name, nearMiss });
            return { triggered: false, reason };
          }
        }
      }
      // ─── Session-level proximity gate (mirror of Trigger A's check) ──────
      if (sessionLevels && atr != null) {
        const opposingSL = nearestOpposingSessionLevel(sessionLevels, entry, isLong);
        if (opposingSL) {
          const distance = isLong ? (opposingSL.value - entry) : (entry - opposingSL.value);
          const threshold = SESSION_LEVEL_K * atr;
          if (distance < threshold) {
            const reason = `${summary} BUT ${opposingSL.name} @ ${opposingSL.value.toFixed(2)} within ${threshold.toFixed(2)} (=${SESSION_LEVEL_K}×ATR) ${isLong ? 'overhead of' : 'below'} entry ${entry.toFixed(2)} — likely magnet/rejection, suppressing`;
            const nearMiss = {
              blockedBy: 'session_level_proximity',
              actualValue: distance,
              thresholdValue: threshold,
              wouldHaveFired: wouldHaveFiredB,
              opposingLevel: { name: opposingSL.name, value: opposingSL.value },
            };
            emitCheckMarker({ ...basePayload, triggered: false, reason, level: lvl.value, levelName: lvl.name, nearMiss });
            return { triggered: false, reason };
          }
        }
      }
      if (rVol < RVOL_THRESHOLD) {
        const reason = `${summary} (rVol below ${RVOL_THRESHOLD})`;
        const nearMiss = {
          blockedBy: 'rVol',
          actualValue: rVol,
          thresholdValue: RVOL_THRESHOLD,
          wouldHaveFired: wouldHaveFiredB,
        };
        emitCheckMarker({ ...basePayload, triggered: false, reason, level: lvl.value, levelName: lvl.name, nearMiss });
        return { triggered: false, reason };
      }
      if (!isWithinTradingWindow()) {
        const reason = `${summary} BUT outside trading window [10:00-14:00 ET]`;
        const nearMiss = {
          blockedBy: 'window',
          actualValue: null,
          thresholdValue: 'within [10:00, 14:00) ET',
          wouldHaveFired: wouldHaveFiredB,
        };
        emitCheckMarker({ ...basePayload, triggered: false, reason, level: lvl.value, levelName: lvl.name, nearMiss });
        return { triggered: false, reason };
      }
      emitCheckMarker({ ...basePayload, triggered: true, reason: summary, level: lvl.value, levelName: lvl.name });
      return {
        triggered: true,
        reason: summary,
        signal: {
          triggerType: 'B',
          subType: lvl.name,
          direction,
          entry,
          stop,
          T1,
          T2: null,
          atr15: atr,
          // Bar context for downstream gate __CHECK__ markers (VIX,
          // correlation, chase). Without these, gates emit barTime: null
          // and persist_session drops them from the near-miss journal.
          barTime: lastBarTime,
          close: lastClosed.close,
          rVol,
        },
      };
    }
  }

  // No reclaim pattern matched on this bar
  const summary = `bar[${lastBarTime} ET] no B reclaim (vwap=${vwap?.toFixed(2) ?? '—'}, ema21_1H=${ema21_1H?.toFixed(2) ?? '—'}, close=${lastClosed.close.toFixed(2)})`;
  emitCheckMarker({ ...basePayload, triggered: false, reason: summary });
  return { triggered: false, reason: summary };
}

// ─── Gated sniper: 5m mid-window Trigger A + Rule 3 fakeout abort ───────────

/**
 * Fetch 5m bars for sniper evaluation. Returns a sorted array of completed
 * 5m bars or null on fetch failure. Light-weight version of fetchAndValidateBars
 * (no retry loop, no full sanity gating — sniper is best-effort).
 */
async function fetchSniper5mBars() {
  const stockContract = { symbol: ticker, secType: 'STK', exchange: 'SMART', currency: 'USD' };
  try {
    const bars = await reqHistoricalBars(ib, stockContract, '1 D', '5 mins', 'TRADES', 1);
    if (!bars.length) return null;
    bars.sort((a, b) => a.time - b.time);
    const nowSec = Math.floor(Date.now() / 1000);
    const completed = bars.filter(b => b.time + 5 * 60 <= nowSec);
    return completed.length ? completed : null;
  } catch (e) {
    console.log(`   ⚠ sniper 5m bar fetch failed: ${e.message}`);
    return null;
  }
}

/**
 * Sniper Trigger A validator. Fires on a mid-window 5m close that crosses
 * entry. Three structural rules (per 2026-05-02 design):
 *
 *   Rule 1: Position constraint. Only mid-window 5m closes — i.e., bars
 *           closing at HH:05/10/20/25/35/40/50/55. Skip the bar closing
 *           ON a 15m boundary (closeMinutes % 15 === 0) because that's
 *           the 15m close itself.
 *   Rule 2: Structural alignment. The 5m close (= running 15m close at
 *           that moment) must be past the entry threshold. For CALLS:
 *           close > entry. For PUTS: close < entry.
 *   Rule 3: Implemented separately in checkSniperFakeoutAbort() below.
 *
 * Returns the same shape as validateTriggerA: { triggered, reason, signal }.
 * triggerType is 'A_SNIPER' (vs 'A' for the 15m baseline) so handleTriggered
 * can label correctly and track active sniper position state.
 */
async function validateSniperTrigger() {
  if (!SNIPER_ENABLED) return { triggered: false, reason: 'sniper disabled' };
  // Sniper is a Trigger A variant — inactive when there's no ORB breakout entry.
  if (entryPrice == null) return { triggered: false, reason: 'sniper inactive — no ORB breakout entry (pullback-only)' };

  const bars = await fetchSniper5mBars();
  if (!bars || bars.length === 0) return { triggered: false, reason: 'no 5m bars available' };

  const lastClosed = bars[bars.length - 1];
  const closeTimeSec = lastClosed.time + 5 * 60;
  const closeET = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(closeTimeSec * 1000));
  const closeHHMM = `${closeET.find(p=>p.type==='hour').value}:${closeET.find(p=>p.type==='minute').value}`;
  const closeMinutes = Number(closeET.find(p=>p.type==='hour').value) * 60 + Number(closeET.find(p=>p.type==='minute').value);

  const basePayload = { ticker, triggerType: 'A_SNIPER', barTime: closeHHMM, close: lastClosed.close, entryPrice, direction };

  // Rule 1 — only mid-window 5m closes. The bar closing at HH:00/15/30/45
  // is a 15m boundary; the 15m validator will handle that case.
  if (closeMinutes % 15 === 0) {
    return { triggered: false, reason: `5m close at ${closeHHMM} is a 15m boundary — sniper-ineligible (Rule 1)` };
  }

  // Trade-window check (10:00 ET → 14:00 ET, matches Trigger A window)
  if (closeMinutes < 9 * 60 + 45 || closeMinutes >= 14 * 60) {
    return { triggered: false, reason: `5m close at ${closeHHMM} outside trade window` };
  }

  // Sniper-specific window: ONLY allow sniper Trigger A fires before 10:45 ET.
  // Anchor: 2026-05-04 the strategy fired 3 sniper trades at 11:06 ET (one
  // each on SPY/QQQ/IWM, within 4 seconds — correlated noise spike) and all
  // three stopped out for −$11 each. Pattern: post-power-hour sniper fires
  // are predominantly chop / mean-reversion, not clean breakout continuation.
  // Trigger B (pullback reclaim) is NOT subject to this — it's a different
  // thesis that's still valid mid-day.
  if (closeMinutes >= 10 * 60 + 45) {
    const reason = `5m close at ${closeHHMM} past sniper window cutoff 10:45 ET — post-power-hour sniper fires showed 0/3 win rate on 2026-05-04, suppressing`;
    emitCheckMarker({ ...basePayload, triggered: false, reason });
    return { triggered: false, reason };
  }

  // Rule 2 — bar close past entry threshold (the 5m close IS the running
  // 15m close at this instant, so this also satisfies "running 15m close
  // is past entry" structurally).
  const isCalls = direction === 'CALLS';
  const crossed = isCalls ? lastClosed.close > entryPrice : lastClosed.close < entryPrice;
  const cmp = isCalls ? '>' : '<';
  const summary = `5m bar[${closeHHMM}] close=${lastClosed.close.toFixed(2)} ${cmp}${entryPrice.toFixed(2)}=${crossed ? 'YES' : 'no'}`;

  if (!crossed) {
    emitCheckMarker({ ...basePayload, triggered: false, reason: summary });
    return { triggered: false, reason: summary };
  }

  // All sniper rules pass — fire.
  emitCheckMarker({ ...basePayload, triggered: true, reason: summary });
  console.log(`   🎯 SNIPER FIRED — ${summary} (mid-window close, structural alignment ✓)`);
  return {
    triggered: true,
    reason: summary,
    signal: {
      triggerType: 'A_SNIPER',
      direction,
      entry: entryPrice,
      stop: triggerA.stop,
      T1: triggerA.T1,
      T2: triggerA.T2 ?? null,
      atr15: _lastATR15,                  // shared from validateTriggerA's last computation
      sniperFireTimeSec: closeTimeSec,    // for Rule 3 timing
      sniperBarClose: lastClosed.close,
      // Bar context for downstream gate __CHECK__ markers (VIX, correlation,
      // chase). Mirrors the additions on Trigger A and Trigger B.
      barTime: closeHHMM,
      close: lastClosed.close,
    },
  };
}

/**
 * Rule 3 — fakeout abort. Called at each 5m boundary while a sniper
 * position is open. On the NEXT 5m bar's close after sniper fire, if the
 * running 15m close (= last 5m close) is back ACROSS the entry threshold
 * (below for CALLS, above for PUTS), the sniper fired into a fakeout.
 * Send a market sell on the option to flat the position. Cancels the OCA
 * bracket via ocaType=1 cascade.
 *
 * Returns true if abort fired, false otherwise.
 */
async function checkSniperFakeoutAbort() {
  if (!SNIPER_FAKEOUT_ABORT_ENABLED) return false;
  if (!_activeSniperPosition) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec < _activeSniperPosition.rule3DueAfterSec) {
    // Not yet due — sniper fire was in this 5m window, wait for next bar
    return false;
  }

  const bars = await fetchSniper5mBars();
  if (!bars || bars.length === 0) {
    console.log('   ⚠ Rule 3 check skipped — no 5m bars to evaluate');
    return false;
  }

  // Find the 5m bar that closes AFTER sniper fire (i.e., the first bar
  // whose close time > sniperFireTimeSec).
  const nextBarAfterFire = bars.find(b => (b.time + 5 * 60) > _activeSniperPosition.sniperFireTimeSec);
  if (!nextBarAfterFire) {
    console.log('   (Rule 3: no post-fire 5m bar yet)');
    return false;
  }

  const isCalls = _activeSniperPosition.direction === 'CALLS';
  const stillAligned = isCalls
    ? nextBarAfterFire.close > _activeSniperPosition.entry
    : nextBarAfterFire.close < _activeSniperPosition.entry;

  if (stillAligned) {
    console.log(`   ✓ Rule 3 check passed — running 15m close ${nextBarAfterFire.close.toFixed(2)} still ${isCalls ? 'above' : 'below'} entry ${_activeSniperPosition.entry.toFixed(2)}`);
    // Position keeps riding T1/stop normally. Clear the Rule 3 watch
    // (only one check; if alignment held, we don't re-check).
    _activeSniperPosition = null;
    return false;
  }

  // FAKEOUT — abort. Send a market sell on the option contract to flat
  // the position. The OCA bracket's ocaType=1 will cancel the remaining
  // T1+stop legs once this market sell fills.
  console.log(`\n🚨 SNIPER FAKEOUT ABORT (Rule 3)`);
  console.log(`   Entry threshold: ${_activeSniperPosition.entry.toFixed(2)}`);
  console.log(`   Sniper fired at ${_activeSniperPosition.sniperBarClose.toFixed(2)} on ${_activeSniperPosition.fireBarHHMM} 5m close`);
  console.log(`   Running 15m close at next bar: ${nextBarAfterFire.close.toFixed(2)} — alignment broken`);
  console.log(`   Sending market sell to flat position before structural stop fires...`);

  try {
    const abortOrderId = nextOrderId++;
    const optContract = {
      symbol: ticker, secType: 'OPT', exchange: 'SMART', currency: 'USD',
      lastTradeDateOrContractMonth: _activeSniperPosition.expiry,
      strike: _activeSniperPosition.strike,
      right: _activeSniperPosition.right,
      multiplier: '100',
    };
    const abortOrder = {
      action: 'SELL',
      totalQuantity: _activeSniperPosition.qty,
      orderType: 'MKT',
      tif: 'DAY',
      orderRef: 'SNIPER_RULE3_ABORT',
      transmit: true,
      firmQuoteOnly: false,
      eTradeOnly: false,
    };
    ib.placeOrder(abortOrderId, optContract, abortOrder);
    console.log(`   ⏎ market sell submitted (orderId=${abortOrderId}). OCA bracket will cancel via ocaType=1 cascade.`);
    discordNotify(
      `🚨 **${ticker} ${_activeSniperPosition.strike}${_activeSniperPosition.right}** sniper RULE 3 ABORT\n` +
      `Entry ${_activeSniperPosition.entry.toFixed(2)}, sniper fired at ${_activeSniperPosition.sniperBarClose.toFixed(2)} ` +
      `but running 15m close at next bar = ${nextBarAfterFire.close.toFixed(2)} (alignment broken)\n` +
      `Market sell submitted to flat before structural stop fires.`,
    );
  } catch (e) {
    console.log(`   ⚠ Rule 3 abort failed: ${e.message} — manually flatten in TWS NOW`);
    discordNotify(
      `🚨 **${ticker} ${_activeSniperPosition.strike}${_activeSniperPosition.right}** RULE 3 ABORT FAILED\n` +
      `Error: ${e.message}\nMANUALLY FLATTEN POSITION IN TWS NOW.`,
    );
  } finally {
    _activeSniperPosition = null;
  }
  return true;
}

// ─── Auto-trim ladder: tier qty allocation + price computation ───────────────
//
// Returns null when totalQty < 3 (caller falls through to placeOCABracketExits
// for the binary 2-leg OCA). Returns [t1Qty, t2Qty, t3Qty] for qty ≥ 3.
//
// Allocation: equal partitions with the runner (tier 3) absorbing the
// remainder. For qty=3 → [1,1,1] clean. For qty=4 → [1,1,2] runner-heavy.
// For qty=6 → [2,2,2] balanced. For qty=10 → [3,3,4] runner-heavy.
function allocateTierQtys(totalQty) {
  if (!Number.isInteger(totalQty) || totalQty < 3) return null;
  const split = Math.floor(totalQty / 3);
  return [split, split, totalQty - 2 * split];
}

/**
 * Tier price computation, derived from the existing signal's entry/stop/T1/T2.
 *
 *   tier1 = entry ± TIER1_STOP_DIST_FACTOR × |stop − entry|   (early scalp;
 *                                              tightened to 0.3 from initial 0.5
 *                                              on 2026-05-01 after chop-day pain)
 *   tier2 = T1                                (system's existing first target)
 *   tier3 = T2 ?? (2 × T1 − entry)            (runner — T2 if available, else
 *                                              one more range-unit past T1)
 *
 * Sign by direction: CALLS rise, PUTS fall.
 */
function computeTierPrices({ entry, stop, T1, T2, direction }) {
  const stopDistance = Math.abs(stop - entry);
  const tier1Offset = TIER1_STOP_DIST_FACTOR * stopDistance;
  const isCalls = direction === 'CALLS';
  const tier1 = isCalls ? entry + tier1Offset : entry - tier1Offset;
  const tier2 = T1;
  const tier3 = (T2 != null) ? T2 : (2 * T1 - entry);
  return { tier1, tier2, tier3 };
}

/**
 * Print a multi-tier ladder summary box, like printBracketSpec but for the
 * 3-tier scale-out structure.
 */
function printLadderSpec({
  ticker, direction, strike, right, totalQty,
  tier1, tier2, tier3, tierQtys, stopPrice,
  entryUnderlying,
  tierOrderIds, stopOrderId, ocaGroup,
  stopIsOptionPrice = false,
  fillPrice = null,
}) {
  const rightLabel = direction === 'CALLS' ? 'CALL' : 'PUT';
  const cmpT  = direction === 'CALLS' ? '>=' : '<=';
  const cmpS  = direction === 'CALLS' ? '<=' : '>=';
  console.log(`\n────────────────────────────────────────────────────────────────`);
  console.log(`  OCA LADDER — auto-trim 3-tier scale-out armed in TWS`);
  console.log(`────────────────────────────────────────────────────────────────`);
  console.log(`  Contract:     ${ticker} ${strike} ${rightLabel} · ${totalQty} contract(s)`);
  console.log(`  Tier 1:       SELL ${tierQtys[0]} MKT when ${ticker} ${cmpT} ${tier1.toFixed(2)}   (orderId=${tierOrderIds[0]})  [+${TIER1_STOP_DIST_FACTOR}×stop-distance]`);
  console.log(`  Tier 2:       SELL ${tierQtys[1]} MKT when ${ticker} ${cmpT} ${tier2.toFixed(2)}   (orderId=${tierOrderIds[1]})  [T1]`);
  console.log(`  Tier 3:       SELL ${tierQtys[2]} MKT when ${ticker} ${cmpT} ${tier3.toFixed(2)}   (orderId=${tierOrderIds[2]})  [T2/runner]`);
  if (stopIsOptionPrice) {
    console.log(`  Stop:         SELL ${totalQty} STP @ option $${stopPrice.toFixed(2)}   (orderId=${stopOrderId})  [option premium, auto-reduces as tiers fill]`);
  } else {
    console.log(`  Stop:         SELL ${totalQty} MKT when ${ticker} ${cmpS} ${stopPrice.toFixed(2)}   (orderId=${stopOrderId})  [auto-reduces as tiers fill]`);
  }
  console.log(`  OCA group:    ${ocaGroup}   (ocaType=2: REDUCE_WITH_BLOCK)`);
  if (entryUnderlying != null) {
    const t1Dist = Math.abs(tier1 - entryUnderlying).toFixed(2);
    const t2Dist = Math.abs(tier2 - entryUnderlying).toFixed(2);
    const t3Dist = Math.abs(tier3 - entryUnderlying).toFixed(2);
    if (stopIsOptionPrice && fillPrice != null) {
      const optDist = (fillPrice - stopPrice).toFixed(2);
      console.log(`  Distances:    T1 +$${t1Dist}  ·  T2 +$${t2Dist}  ·  T3 +$${t3Dist} (underlying)  ·  stop −$${optDist} on option premium (fill $${fillPrice.toFixed(2)} → stop $${stopPrice.toFixed(2)})`);
      console.log(`  Max realized loss: $${(totalQty * (fillPrice - stopPrice) * 100).toFixed(2)}  (= $${(fillPrice - stopPrice).toFixed(2)} × 100 × ${totalQty})`);
    } else {
      const sDist  = Math.abs(entryUnderlying - stopPrice).toFixed(2);
      console.log(`  Distances:    T1 +$${t1Dist}  ·  T2 +$${t2Dist}  ·  T3 +$${t3Dist}  ·  stop −$${sDist}  (from entry ${entryUnderlying.toFixed(2)})`);
    }
    // Note: BE-slide on tier-1-fill currently uses underlying-PriceCondition.
    // With option-premium stops above, the BE concept is fillPrice (option)
    // rather than entryUnderlying. modifyStopToBreakeven needs an option-stop
    // variant before auto-trim ladder ships live. Tracked in ROADMAP.
    console.log(`  When T1 fills → stop slides to BE for remaining ${totalQty - tierQtys[0]} contract(s)`);
  }
  console.log(`────────────────────────────────────────────────────────────────`);
}

// ─── Order placement flow on trigger fire ────────────────────────────────────
/**
 * Handle a triggered signal (A or B). The signal carries:
 *   triggerType: 'A' | 'B'
 *   subType?:    'VWAP' | 'EMA21_1H'  (B only)
 *   direction:   'CALLS' | 'PUTS'
 *   entry:       price level (ORB high/low for A, reclaimed level for B)
 *   stop:        underlying stop price
 *   T1:          underlying T1 price
 *   T2?:         underlying T2 price (informational; bracket only uses T1)
 *
 * The function uses signal.entry / signal.stop / signal.T1 throughout — no
 * references to the global triggerA/entryPrice/direction once the signal is
 * received. This makes A and B genuinely interchangeable.
 */
/**
 * Fetch the live last/mid price for an underlying STK symbol via a one-shot
 * IBKR market-data snapshot. Returns null if no price arrives within the
 * timeout — used for the chase-guard live-tick check, which is fail-open.
 *
 * Falls back to mid-of-bid-ask when last is unavailable. Cancels the
 * subscription cleanly on resolve / timeout.
 */
async function getLiveUnderlyingPrice(symbol, timeoutMs = 800) {
  return new Promise((resolve) => {
    const reqId = nextReqId();
    const contract = { symbol, secType: 'STK', exchange: 'SMART', currency: 'USD' };
    let last = null, bid = null, ask = null;
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      ib.off(EventName.tickPrice, onTickPrice);
      ib.off(EventName.tickSnapshotEnd, onSnapshotEnd);
      try { ib.cancelMktData(reqId); } catch { /* ignore */ }
      const px = (last != null && last > 0) ? last
        : (bid != null && bid > 0 && ask != null && ask > 0) ? (bid + ask) / 2
        : null;
      resolve(px);
    };
    const onTickPrice = (id, tickType, price /*, attr*/) => {
      if (id !== reqId || price == null || price <= 0) return;
      if (tickType === 4) last = price;          // last trade
      else if (tickType === 1) bid = price;      // bid
      else if (tickType === 2) ask = price;      // ask
    };
    const onSnapshotEnd = (id) => { if (id === reqId) finish(); };
    ib.on(EventName.tickPrice, onTickPrice);
    ib.on(EventName.tickSnapshotEnd, onSnapshotEnd);
    try {
      ib.reqMktData(reqId, contract, '', true /* snapshot */, false, []);
    } catch { finish(); return; }
    setTimeout(finish, timeoutMs);
  });
}

/**
 * Check correlated SPY/QQQ/IWM tickers for recent same-direction fires.
 * Returns the offending trade record if any exists, else null.
 *
 * Implementation reads `traded_today.json` (already maintained by
 * recordTrade). Looks for trades on OTHER tickers in the same direction,
 * recorded within CORRELATION_WINDOW_SEC. Today's anchor: 2026-05-04
 * 11:06 ET burst — IWM, QQQ, SPY all fired CALLS within 4 seconds and
 * all stopped out for −$11 each.
 *
 * Simplification vs the full roadmap design (which calls for a 0.3×ATR
 * stalling check on the open position): we use time-windowed proximity as
 * a proxy. A correlated fire within 5 minutes means the prior position is
 * by definition still in its "stalling" window — there hasn't been time
 * for a clean structural separation. Refine to the ATR-based version once
 * we have ≥30 sessions of correlated-suppression data.
 */
// ─── Ticker-aware expiry resolver ────────────────────────────────────────
// ETFs: today's 0DTE.
// Stocks (AAPL/NVDA/AMZN): today's 0DTE if it exists in the chain,
// else fall back to Friday weekly.
//
// Updated 2026-05-08 (user request): AAPL/NVDA/AMZN now have Mon/Wed/Fri
// expiries available in IBKR's chain (verified by probe). The strategy
// previously hardcoded Friday weekly for stocks, missing Mon/Wed 0DTE
// opportunities. Now: prefer today's 0DTE when listed (M/W/F), else fall
// back to Friday weekly (Tue/Thu and any day where today's expiry is
// missing). Behavior on Tue/Thu unchanged — fewer same-day expiries trade
// there, so falling back to Friday avoids unverified short-DTE economics.
function pickExpiryForTicker(ticker, expirations) {
  if (isETF(ticker)) return pick0DTEExpiry(expirations);
  // Stocks: try today's 0DTE first, then Friday weekly.
  const etFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const todayYMD = etFmt.format(new Date()).replace(/-/g, '');
  if (expirations.has(todayYMD)) return todayYMD;
  return pickFridayWeeklyExpiry(expirations);
}

// ─── VIX volatility-regime gate (Option A hard veto + Option B always-log)
// User decision 2026-05-06: VIX rising hard while we're trying to fire
// CALLS is an adverse-regime signal (vol expansion = equity selloff).
// Symmetric for PUTS. Hard-veto threshold: |VIX intraday %| ≥ 1.5 AND
// last 5m VIX bar moving in the adverse direction. Always log vixState
// on the fire payload regardless of veto outcome — collects data for
// later threshold tuning. Applies to all 6 tickers.
const VIX_INTRADAY_THRESHOLD_PCT = 1.5;
const VIX_CACHE_TTL_MS = 60 * 1000;
const VIX_CONTRACT = { symbol: 'VIX', secType: 'IND', exchange: 'CBOE', currency: 'USD' };
let _vixCache = { state: null, fetchedAt: 0 };

async function fetchVixSnapshot(ib) {
  try {
    const bars = await reqHistoricalBars(ib, VIX_CONTRACT, '1 D', '5 mins', 'TRADES', 1);
    if (!bars || bars.length < 2) return null;
    const open = bars[0].open;
    const last = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    return {
      open, current: last.close, prevClose: prev.close,
      intradayPct: ((last.close - open) / open) * 100,
      lastBarRising: last.close > prev.close,
      lastBarFalling: last.close < prev.close,
    };
  } catch (e) {
    return null;
  }
}

async function getVixState(ib) {
  if (_vixCache.state && (Date.now() - _vixCache.fetchedAt) < VIX_CACHE_TTL_MS) {
    return _vixCache.state;
  }
  const fresh = await fetchVixSnapshot(ib);
  if (fresh) _vixCache = { state: fresh, fetchedAt: Date.now() };
  return fresh;
}

function checkVixAdverse(vixState, direction) {
  if (!vixState) return null;
  if (direction === 'CALLS' && vixState.intradayPct > VIX_INTRADAY_THRESHOLD_PCT && vixState.lastBarRising) {
    return `VIX +${vixState.intradayPct.toFixed(2)}% intraday and rising on last 5m bar — adverse for CALLS`;
  }
  if (direction === 'PUTS' && vixState.intradayPct < -VIX_INTRADAY_THRESHOLD_PCT && vixState.lastBarFalling) {
    return `VIX ${vixState.intradayPct.toFixed(2)}% intraday and falling on last 5m bar — adverse for PUTS`;
  }
  return null;
}

const CORRELATION_WINDOW_SEC = 5 * 60;
const CORRELATED_TICKERS = ['SPY', 'QQQ', 'IWM'];
function checkCorrelatedRecentFire(thisTicker, thisDirection) {
  try {
    const tradedFile = path.join(REPO_ROOT, 'traded_today.json');
    if (!fs.existsSync(tradedFile)) return null;
    const data = JSON.parse(fs.readFileSync(tradedFile, 'utf8'));
    if (!Array.isArray(data?.trades)) return null;
    const cutoffMs = Date.now() - CORRELATION_WINDOW_SEC * 1000;
    for (const t of data.trades) {
      if (!t || t.ticker === thisTicker) continue;
      if (!CORRELATED_TICKERS.includes(t.ticker)) continue;
      if (t.direction !== thisDirection) continue;
      const recordedMs = t.recordedAt ? new Date(t.recordedAt).getTime() : 0;
      if (recordedMs >= cutoffMs) {
        return t;  // correlated, same-direction, within window
      }
    }
  } catch (e) {
    // Lenient — if read fails, fall through to fire (gate is best-effort)
  }
  return null;
}

async function handleTriggered(signal) {
  const triggerType = signal.triggerType;
  const subType = signal.subType ?? null;
  const sigDir = signal.direction;
  const sigEntry = signal.entry;
  const sigStop = signal.stop;
  const sigT1 = signal.T1;
  const sigT2 = signal.T2 ?? null;
  // Bar context the validator just captured at fire time. Threading these
  // into gate __CHECK__ markers below means VIX/correlation/chase suppressions
  // arrive at the dashboard's check parser with a real barTime — and survive
  // persist_session.mjs's near-miss filter, so the May 12 sniper agent sees
  // every gate decision (not just the lucky-bar ones).
  const sigBarTime = signal.barTime ?? null;
  const sigClose = signal.close ?? null;
  const triggerLabel = triggerType === 'B'
    ? `Trigger B${subType ? ` (${subType})` : ''}`
    : triggerType === 'A_SNIPER'
      ? `Trigger A SNIPER (mid-window 5m)`
      : `Trigger A`;

  // ─── VIX gate (hard veto + always-log; applies to all 6 tickers) ─────────
  const vixState = await getVixState(ib);
  const vixAdverseReason = checkVixAdverse(vixState, sigDir);
  if (vixAdverseReason) {
    console.log(`\n⛔ VIX GATE: ${vixAdverseReason}`);
    // Route through emitCheckMarker (not raw console.log) so the suppression
    // ALSO gets written to journal/watcher-checks-raw/<date>-<ticker>.jsonl,
    // not just stdout. persist_session reads that JSONL — without this, gate
    // decisions never landed in the persisted near-miss outcomes (anchor
    // 2026-05-08 IWM: 2 VIX-adverse PUTS suppressed, visible in Discord but
    // missing from journal/near-miss-outcomes-2026-05-08.json).
    emitCheckMarker({
      ticker, triggerType, barTime: sigBarTime,
      close: sigClose, direction: sigDir,
      triggered: false, reason: vixAdverseReason,
      nearMiss: {
        blockedBy: 'vix_adverse_regime',
        actualValue: { intradayPct: Number(vixState.intradayPct.toFixed(2)), barDirection: vixState.lastBarRising ? 'rising' : (vixState.lastBarFalling ? 'falling' : 'flat') },
        thresholdValue: { intradayPct: VIX_INTRADAY_THRESHOLD_PCT },
        wouldHaveFired: { entry: sigEntry, stop: sigStop, T1: sigT1, T2: sigT2, direction: sigDir },
      },
    });
    discordNotify(
      `⛔ **${ticker} ${triggerLabel}** VIX gate suppressed\n${vixAdverseReason}. No order placed.`,
      'high',
    );
    return false;
  }

  // ─── Cross-ticker correlation gate ───────────────────────────────────────
  // Anchor: 2026-05-04 the strategy fired three CALLS sniper trades within
  // 4 seconds at 11:06 ET (IWM @ 53s, QQQ @ 55s, SPY @ 57s) and all three
  // stopped out at exactly the new $0.10 option-premium stop for −$11 each.
  // These weren't independent signals — SPY/QQQ/IWM are highly correlated
  // ETFs, so a single market-wide momentum spike triggers all three. When
  // the move is genuine, this triples the upside; when it's chop, this
  // triples the downside. Today was the chop side.
  //
  // Defense: when ticker X is about to fire, check traded_today.json for
  // any same-direction OPT trade on a correlated ticker (Y or Z) recorded
  // within CORRELATION_WINDOW_SEC. If found, suppress — the signal isn't
  // independent.
  // Correlation gate is ETF-cohort-only — stock fires (AAPL/NVDA/AMZN) skip it.
  const correlated = isETF(ticker) ? checkCorrelatedRecentFire(ticker, sigDir) : null;
  if (correlated) {
    const ageSec = ((Date.now() - new Date(correlated.recordedAt).getTime()) / 1000).toFixed(0);
    const reason = `Correlated fire: ${correlated.ticker} ${correlated.strike}${correlated.right} ${sigDir} fired ${ageSec}s ago (within ${CORRELATION_WINDOW_SEC}s window) — likely shared market spike, suppressing`;
    console.log(`\n⛔ CORRELATION GATE: ${reason}`);
    // Persist via emitCheckMarker (see VIX-gate comment above).
    emitCheckMarker({
      ticker, triggerType, barTime: sigBarTime,
      close: sigClose, direction: sigDir,
      triggered: false, reason,
      nearMiss: {
        blockedBy: 'correlated_position_stalling',
        actualValue: { correlated: correlated.ticker, ageSec: Number(ageSec) },
        thresholdValue: { window: CORRELATION_WINDOW_SEC },
        wouldHaveFired: { entry: sigEntry, stop: sigStop, T1: sigT1, T2: sigT2, direction: sigDir },
      },
    });
    discordNotify(
      `⛔ **${ticker} ${triggerLabel}** correlation gate suppressed\n` +
      `${correlated.ticker} ${sigDir} fired ${ageSec}s ago — same market spike, not independent signal. No order placed.`,
    );
    return false;
  }

  // ─── Chase guard (5m bar + live tick) ────────────────────────────────────
  // Anchor: 2026-05-04 SPY 722C trade lost $3 in 2-second hold because the
  // underlying had already moved past T1 between bar-close (10:20:00) and
  // BUY MKT fill (10:20:28). Two layers:
  //
  //   Layer A (5m bar): if the firing 5m bar's close is already past T1, the
  //                     move has been chased before the bar even closed.
  //   Layer B (live tick): if the firing bar closed BELOW T1 but the live
  //                        underlying tick has since moved past T1, the move
  //                        completed in the order-routing latency window.
  //                        This is the failure mode that hit SPY today.
  //
  // Lenient on data failure for both layers — fail-open (gate is best-effort).
  if (Number.isFinite(sigT1)) {
    const isCalls = sigDir === 'CALLS';
    let suppressReason = null;
    let suppressActual = null;
    try {
      const fiveBars = await fetchSniper5mBars();
      if (fiveBars && fiveBars.length > 0) {
        const last5 = fiveBars[fiveBars.length - 1];
        const exceeded5m = isCalls ? last5.close > sigT1 : last5.close < sigT1;
        if (exceeded5m) {
          suppressReason = `Chase guard (Layer A): last 5m close ${last5.close.toFixed(2)} already ${isCalls ? '>' : '<'} T1 ${sigT1.toFixed(2)}`;
          suppressActual = last5.close;
        }
      }
    } catch (e) {
      console.log(`   ⚠ chase guard 5m check failed: ${e.message}`);
    }
    if (!suppressReason) {
      try {
        const livePx = await getLiveUnderlyingPrice(ticker, 800);
        if (livePx != null && Number.isFinite(livePx)) {
          const exceededLive = isCalls ? livePx > sigT1 : livePx < sigT1;
          if (exceededLive) {
            suppressReason = `Chase guard (Layer B): live tick ${livePx.toFixed(2)} already ${isCalls ? '>' : '<'} T1 ${sigT1.toFixed(2)} — moved past during order-routing latency`;
            suppressActual = livePx;
          }
        } else {
          console.log(`   ℹ chase guard live-tick unavailable (no quote within 800ms) — relying on 5m check only`);
        }
      } catch (e) {
        console.log(`   ⚠ chase guard live-tick check failed: ${e.message}`);
      }
    }
    if (suppressReason) {
      console.log(`\n⛔ CHASE GUARD: ${suppressReason} — suppressing`);
      // Persist via emitCheckMarker (see VIX-gate comment above).
      emitCheckMarker({
        ticker, triggerType, barTime: sigBarTime,
        close: suppressActual, direction: sigDir,
        triggered: false, reason: suppressReason,
        nearMiss: {
          blockedBy: 't1_already_exceeded',
          actualValue: suppressActual,
          thresholdValue: sigT1,
          wouldHaveFired: { entry: sigEntry, stop: sigStop, T1: sigT1, T2: sigT2, direction: sigDir },
        },
      });
      discordNotify(
        `⛔ **${ticker} ${triggerLabel}** chase guard suppressed\n${suppressReason}. No order placed.`,
      );
      return false;
    }
  }

  // ─── 1m confirmation gate (--confirm-fire) ───────────────────────────────
  // After Trigger A or A_SNIPER fires, wait 60s and check that the next 1m
  // bar STILL closes on the breakout side of entry. Rejects fakeout wicks
  // where the trigger bar's close was just a brief poke across entry that
  // immediately reverted (anchor: 2026-05-11 NVDA, 3 fires all wick-stopped).
  //
  // Skips Trigger B — its entry logic is VWAP rejection, not breakout, so
  // the same confirmation pattern doesn't apply.
  //
  // Default OFF. Enable via --confirm-fire CLI flag (the dashboard's start
  // route forwards this when WATCHER_CONFIRM_FIRE=1 is set in .env.local).
  if (confirmFire && (triggerType === 'A' || triggerType === 'A_SNIPER')) {
    console.log(`\n⏳ 1m-CONFIRM: waiting 60s for the next 1m bar to confirm momentum...`);
    await new Promise(r => setTimeout(r, 60_000));
    try {
      const stockContract = { symbol: ticker, secType: 'STK', exchange: 'SMART', currency: 'USD' };
      // Request 120 seconds of 1-min bars; we want the most-recently-closed one.
      const bars1m = await reqHistoricalBars(ib, stockContract, '120 S', '1 min', 'TRADES', 1);
      const last1m = bars1m && bars1m.length ? bars1m[bars1m.length - 1] : null;
      if (!last1m) {
        // Lenient: if 1m fetch fails (feed degradation), fall through and fire.
        // The watcher should not be blocked by a bar-fetch glitch.
        console.log(`   ⚠ 1m-CONFIRM: bar fetch returned empty — proceeding without confirmation (lenient fallback)`);
      } else {
        const confirmed = sigDir === 'CALLS'
          ? last1m.close > sigEntry
          : last1m.close < sigEntry;
        const verdict = confirmed
          ? `✅ confirmed (1m close ${last1m.close.toFixed(2)} ${sigDir === 'CALLS' ? '>' : '<'} entry ${sigEntry.toFixed(2)})`
          : `⛔ reverted (1m close ${last1m.close.toFixed(2)} ${sigDir === 'CALLS' ? '<=' : '>='} entry ${sigEntry.toFixed(2)})`;
        console.log(`   1m-CONFIRM: ${verdict}`);
        if (!confirmed) {
          const reason = `1m confirmation failed: bar close ${last1m.close.toFixed(2)} ${sigDir === 'CALLS' ? 'fell back to/below' : 'rose back to/above'} entry ${sigEntry.toFixed(2)} — fakeout wick suppressed`;
          emitCheckMarker({
            ticker, triggerType, barTime: sigBarTime,
            close: last1m.close, direction: sigDir,
            triggered: false, reason,
            nearMiss: {
              blockedBy: '1m_confirmation_fail',
              actualValue: last1m.close,
              thresholdValue: sigEntry,
              wouldHaveFired: { entry: sigEntry, stop: sigStop, T1: sigT1, T2: sigT2, direction: sigDir },
            },
          });
          discordNotify(
            `⛔ **${ticker} ${triggerLabel}** 1m confirmation failed\n` +
            `Next 1m closed ${last1m.close.toFixed(2)} (entry ${sigEntry.toFixed(2)}, ${sigDir}). Fakeout wick — no order placed.`,
          );
          return false;
        }
      }
    } catch (e) {
      // Lenient on errors — see comment above.
      console.log(`   ⚠ 1m-CONFIRM: error during 1m bar fetch (${e.message}) — proceeding without confirmation`);
    }
  }

  notify(
    `🎯 ${ticker} ${triggerLabel}`,
    autoFire
      ? `${sigDir} fired & placing order automatically — manage in TWS`
      : `${sigDir} setup fired — switch to terminal to confirm`,
  );
  discordNotify(
    `🎯 **${ticker} ${triggerLabel} fired** — ${sigDir}\n` +
    `Mode: ${IBKR_CONFIG.port === 7496 ? '🔴 LIVE' : '📋 PAPER'} (port ${IBKR_CONFIG.port})\n` +
    `Entry: ${sigEntry.toFixed(2)}  Stop: ${sigStop.toFixed(2)}  ` +
    `T1: ${sigT1.toFixed(2)}  T2: ${Number.isFinite(sigT2) ? sigT2.toFixed(2) : '—'}\n` +
    (autoFire
      // Don't claim "placing now" — the session kill switch is checked AFTER
      // this alert and may still block. If blocked, a 🚫 follow-up fires.
      ? `⚡ AUTO-FIRE armed — order places now ONLY IF "Trading · ENABLED" is on for today`
      : `Per-fire YES gate ON — confirm in the dashboard/terminal to place`),
  );

  // Try the prewarm cache first — sub-50ms pick if hot. On miss/stale, falls
  // through to the live query (the original 5-15s path) so the trade still
  // happens, just with the latency that prewarm was meant to eliminate.
  let pick = pickFromCache(sigDir, sigEntry);
  let expiry = _optionCache.expiry;
  if (pick) {
    console.log(`   ⚡ option chain cache hit — strike picked instantly`);
  } else {
    if (_optionCache.premiums) {
      const ageS = ((Date.now() - _optionCache.premiums.fetchedAt) / 1000).toFixed(0);
      console.log(`   (cache ${_optionCache.premiums.direction !== sigDir ? 'wrong direction' : `${ageS}s old, miss`}, fetching live)`);
    }
    const conId = await resolveStockConId(ib, ticker);
    const { expirations } = await getOptionChainParams(ib, ticker, conId);
    expiry = pickExpiryForTicker(ticker, expirations);
    if (!expiry) { console.log(`   ⚠ no expiry resolved for ${ticker} (expected ${isETF(ticker) ? '0DTE today' : 'nearest Friday weekly'}) — aborting`); return false; }

    pick = await pickStrikeInRange({
      ib, ticker, expiry, entryPrice: sigEntry, direction: sigDir,
      premiumMin: PREMIUM_MIN, premiumMax: PREMIUM_MAX,
      strikesToQuery: STRIKES_TO_QUERY,
    });
  }
  if (!pick) {
    console.log(`   ⚠ no strike in $${PREMIUM_MIN}-$${PREMIUM_MAX} premium range — aborting`);
    return false;
  }
  if (!expiry) { console.log(`   ⚠ no expiry resolved for ${ticker} — aborting`); return false; }
  console.log(`   selected: ${pick.strike} ${sigDir === 'CALLS' ? 'CALL' : 'PUT'} @ est $${pick.mid.toFixed(2)}`);

  // Premium refresh at fire time (anchor 2026-05-01 QQQ #1: prewarm cache
  // estimated $0.62, actual fill $1.41 — 2.3× the estimate. Cap check passed
  // pre-fire, real risk was $423 over the $300 cap). Re-query a single
  // fresh mid for the picked strike before the cap check so cap math AND
  // the prompt payload reflect what the user is actually about to pay.
  // Adds ~200-500ms to the fire path; falls through to the cached mid on
  // query failure (don't let an IBKR hiccup block a real fire).
  const right = sigDir === 'CALLS' ? 'C' : 'P';
  let freshMid = pick.mid;
  let freshMidStale = false;
  try {
    const fm = await queryOptionPremium(ib, ticker, expiry, pick.strike, right);
    if (fm != null && fm > 0) {
      freshMid = fm;
      const drift = ((fm - pick.mid) / pick.mid * 100).toFixed(0);
      console.log(`   premium refresh: cached $${pick.mid.toFixed(2)} → fresh $${fm.toFixed(2)} (${drift >= 0 ? '+' : ''}${drift}%)`);
    } else {
      freshMidStale = true;
      console.log(`   ⚠ fresh premium query returned null/zero — falling back to cached $${pick.mid.toFixed(2)}`);
    }
  } catch (e) {
    freshMidStale = true;
    console.log(`   ⚠ fresh premium query failed (${e.message}) — falling back to cached $${pick.mid.toFixed(2)}`);
  }

  // Premium band check at fire time. Strategy thesis is "cheap options
  // only" — buying premium > PREMIUM_MAX changes the IV/delta profile
  // significantly. Anchor 2026-05-01: cached QQQ 675C @ $0.62 (in band)
  // → fresh $1.41 at fire time (+127% drift, well above $0.90 ceiling).
  // The strike picker only sees cached prices; this gate catches strikes
  // that drifted out of band between cache and fire. Aborts before the
  // cap check so the reason is "drift out of band" not "risk cap blown."
  if (freshMid > PREMIUM_MAX) {
    console.log(`   ⚠ fresh premium $${freshMid.toFixed(2)} > $${PREMIUM_MAX} band ceiling — strike drifted out of "cheap option" band, aborting`);
    return false;
  }

  // Fixed qty per trade. Realized loss is bounded by the OPTION_STOP_OFFSET_USD
  // STP, not by a premium-times-qty ceiling — see top-of-file comment for the
  // 2026-05-05 simplification. riskUsd here is the expires-worthless theoretical
  // max, kept only for telemetry / dashboard display.
  const qty = FIXED_QTY_PER_TRADE;
  const riskUsd = qty * freshMid * 100;

  // Marker-first ordering: emit __PROMPT_YES__ BEFORE the human-readable
  // printOrderSpec preamble. The marker carries the full prompt payload as
  // JSON so the dashboard can render the modal immediately on receipt — the
  // 25-line spec preamble then streams in below as live-tape context. Saves
  // the cumulative SSE re-render time of those lines (~150-250ms) before
  // the modal pops. CLI users see the marker as a noise line at the top
  // of the spec, then the readable preamble; YES prompt still works.
  // (Pre-2026-04-29 the marker was emitted AFTER the preamble, so the
  // dashboard only popped the modal once all 25 spec lines had streamed.)
  const sigATR = signal.atr15 ?? null;
  const stopDistance = Math.abs(sigEntry - sigStop);
  const atrMultiple = sigATR && sigATR > 0 ? stopDistance / sigATR : null;
  const promptPayload = {
    ticker,
    triggerType,
    subType,
    direction: sigDir,
    strike: pick.strike,
    expiry,
    qty,
    premiumEst: freshMid,
    premiumCached: pick.mid,
    premiumStale: freshMidStale,
    underlyingEntry: sigEntry,
    stop: sigStop,
    T1: sigT1,
    T2: sigT2,
    atr15: sigATR,
    stopDistance,
    atrMultiple,
    riskUsd,
    vixState: vixState ? {
      open: Number(vixState.open.toFixed(2)),
      current: Number(vixState.current.toFixed(2)),
      intradayPct: Number(vixState.intradayPct.toFixed(2)),
      barDirection: vixState.lastBarRising ? 'rising' : (vixState.lastBarFalling ? 'falling' : 'flat'),
    } : null,
    bracket: BRACKET_ENABLED ? { t1: sigT1, stop: sigStop } : null,
  };
  // Emit __PROMPT_YES__ ONLY when the YES gate is enabled. In auto-fire
  // mode we skip both the marker (so the dashboard doesn't pop a modal)
  // and the readline prompt below — order placement proceeds immediately.
  if (!autoFire) {
    console.log(`__PROMPT_YES__ ${JSON.stringify(promptPayload)}`);
  }

  printOrderSpec({
    ticker, direction: sigDir, strike: pick.strike, expiry, qty, premiumEst: freshMid,
    entryPrice: sigEntry,
    exitSpec: { entry: sigEntry, stop: sigStop, T1: sigT1, T2: sigT2 },
    port: IBKR_CONFIG.port, staged: STAGED_MODE,
  });

  if (!STAGED_MODE) {
    const live = IBKR_CONFIG.port === 7496;
    if (autoFire) {
      console.log(`\n⚡ AUTO-FIRE mode — placing order immediately (no portal YES required).`);
    } else {
      console.log(`\n⚠ AUTO-TRANSMIT mode — typing YES will submit the order to the market immediately.`);
    }
    if (live) {
      console.log(`  🔴 LIVE account (port ${IBKR_CONFIG.port}) — REAL MONEY at risk`);
    } else {
      console.log(`  📋 paper account (port ${IBKR_CONFIG.port}) — no real money at risk`);
    }
  }

  // Session-level kill switch — layered on top of the YES prompt.
  // Reads ./manual_yn.json (toggled from the dashboard at /api/manual-yn).
  // When OFF: skip even prompting. Log the would-fire to JSONL + Discord
  // for visibility into what the watcher saw, but do NOT submit any order.
  if (!isTradingEnabledForToday()) {
    const status = manualYnStatus();
    const isLivePort = IBKR_CONFIG.port === 7496;
    console.log(`\n🚧 BLOCKED by manual_dashboard_yn: ${status}`);
    console.log(`   Order NOT placed. Enable trading from the dashboard to send orders today.`);
    emitCheckMarker({
      ticker, triggerType: triggerType ?? '?',
      triggered: true,
      blockedBy: 'manual_dashboard_yn',
      reason: `gate blocked: ${status}`,
      entryPrice: sigEntry, direction: sigDir,
      strike: pick?.strike, expiry,
      wouldHaveFired: {
        entry: sigEntry, stop: sigStop, T1: sigT1, T2: sigT2 ?? null, direction: sigDir,
      },
    });
    if (DISCORD_ENABLED) {
      // Full trade plan in the blocked alert so the operator can evaluate
      // (and manually act if they choose) without digging through logs.
      const rr1 =
        (Number.isFinite(sigEntry) && Number.isFinite(sigStop) && Number.isFinite(sigT1) &&
         Math.abs(sigStop - sigEntry) > 0)
          ? (Math.abs(sigT1 - sigEntry) / Math.abs(sigStop - sigEntry)).toFixed(2)
          : '?';
      const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
      await discordNotify(
        `🚫 ${ticker} ${sigDir} (Trigger ${triggerType ?? '?'}) FIRED — but NO order was sent.\n` +
        `Reason: trading is DISABLED for today (session kill switch).\n` +
        `\n` +
        `📊 Trade plan that would have fired:\n` +
        `  Bar:    ${sigBarTime ?? '?'} ET${Number.isFinite(sigClose) ? ` · close ${fmt(sigClose)}` : ''}\n` +
        `  Entry:  ${fmt(sigEntry)}     Stop: ${fmt(sigStop)}\n` +
        `  T1:     ${fmt(sigT1)}     T2:   ${fmt(sigT2)}   (T1 R/R ${rr1})\n` +
        `  Option: ${pick?.strike ?? '?'}${right} exp ${expiry} · ~$${fmt(freshMid)} × ${qty}\n` +
        `\n` +
        `👉 FIX: click "ENABLE TRADING" on the dashboard to arm this session.\n` +
        `   (Resets to DISABLED automatically each ET day — re-enable daily.)\n` +
        `   Auto-fire skips the per-fire YES, but NOT this daily session switch.\n` +
        `Gate state: ${status}\n` +
        `Account: ${isLivePort ? '🔴 LIVE' : '📋 paper'} (port ${IBKR_CONFIG.port})`
      );
    }
    return false;
  }

  // Auto-fire bypasses the readline prompt entirely. With it OFF (default),
  // we still wait for the user's YES from the dashboard or terminal.
  if (!autoFire) {
    const answer = await promptYes(`\nType "YES" to ${STAGED_MODE ? 'STAGE in TWS' : 'FIRE NOW'}, anything else to abort: `);
    if (answer !== 'YES') { console.log(`   aborted — no order placed`); return false; }
  } else {
    console.log(`   ⚡ AUTO-FIRE: bypassing YES gate, order placement starting now`);
  }

  if (nextOrderId == null) {
    ib.reqIds(-1);
    await new Promise(r => setTimeout(r, 1500));
  }
  if (nextOrderId == null) { console.log(`   ❌ no order ID from TWS`); return false; }

  const orderId = nextOrderId++;
  const { contract } = placeStagedOrder({
    ib, ticker, expiry, strike: pick.strike, qty, direction: sigDir, orderId, staged: STAGED_MODE,
  });

  console.log(`\n${STAGED_MODE ? '✅ Order STAGED in TWS' : '🚀 Order SUBMITTED'} (orderId=${orderId}).`);
  if (STAGED_MODE) {
    console.log(`   Go to TWS Orders tab → click Transmit on the "Pending Transmission" row.`);
  }

  // Auto-arm OCA bracket exits once the entry fills
  let bracketArmed = false;
  const underlyingConId = await resolveStockConId(ib, ticker);
  const t1Price = sigT1;
  const stopPrice = sigStop;

  ib.on(EventName.orderStatus, async (id, status, filled, remaining, avgFillPrice) => {
    if (id !== orderId) return;
    console.log(`   orderStatus  status=${status}  filled=${filled}  remaining=${remaining}  avgFill=${avgFillPrice ?? '-'}`);

    if (
      BRACKET_ENABLED &&
      !bracketArmed &&
      status === 'Filled' &&
      Number(filled) > 0 &&
      Number(remaining) === 0 &&
      Number.isFinite(t1Price) &&
      Number.isFinite(stopPrice)
    ) {
      bracketArmed = true;
      const actualQty = Number(filled);
      if (actualQty < qty) {
        console.log(`   ℹ partial fill detected: sizing bracket to actual ${actualQty} (planned ${qty})`);
      }
      const right = sigDir === 'CALLS' ? 'C' : 'P';
      const fillPrice = Number(avgFillPrice ?? pick.mid);
      const tierQtys = allocateTierQtys(actualQty);
      const TRANSMITTED = new Set(['PreSubmitted', 'Submitted', 'Filled', 'Cancelled']);

      // Verify a set of orderIds all reached a transmitted state within
      // a short window. Returns { ok: boolean, statuses: { id: status } }.
      const verifyTransmitted = async (orderIds) => {
        const idSet = new Set(orderIds);
        return await new Promise((resolve) => {
          const seen = new Map();
          const handler = (id, status) => {
            if (!idSet.has(id)) return;
            seen.set(id, status);
            if (orderIds.every((oid) => TRANSMITTED.has(seen.get(oid)))) {
              ib.off(EventName.orderStatus, handler);
              clearTimeout(timer);
              resolve({ ok: true, statuses: Object.fromEntries(seen) });
            }
          };
          ib.on(EventName.orderStatus, handler);
          const timer = setTimeout(() => {
            ib.off(EventName.orderStatus, handler);
            const ok = orderIds.every((oid) => TRANSMITTED.has(seen.get(oid)));
            resolve({ ok, statuses: Object.fromEntries(seen) });
          }, 5000);
        });
      };

      const optContractForExits = {
        symbol: ticker, secType: 'OPT', exchange: 'SMART', currency: 'USD',
        lastTradeDateOrContractMonth: expiry, strike: pick.strike, right, multiplier: '100',
      };

      if (trailingRunner) {
        // ─── FIXED STOP PATH (2026-06-03) ───────────────────────────────────
        // Single STP SELL on the option at a FIXED level: fillPrice ×(1−STOP_PCT).
        // Replaced the trailing stop, which failed to ratchet on cheap/fast 0DTE
        // premium (SPY 753P spiked 0.48→1.22→0.47 and the trail stayed pinned at
        // entry — see placeFixedStop note in ibkr_orders.mjs). A fixed stop has no
        // high-water mark, so that failure mode is gone. No T1/T2 — "tight primary":
        // this STP is the hard downside floor; the user manages upside manually.
        const stopOrderId = nextOrderId++;
        const stopPrice = roundStopToTick(Math.max(0.01, fillPrice - STOP_DISTANCE_USD));
        let stopResult = null;
        let stopError = null;
        try {
          stopResult = placeFixedStop({
            ib, ticker, expiry, strike: pick.strike, right,
            qty: actualQty, stopPrice,
            orderId: stopOrderId,
          });
          printFixedStopSpec({
            ticker, direction: sigDir, strike: pick.strike, right,
            qty: actualQty, stopPrice, fillPrice,
            orderId: stopResult.orderId,
          });
        } catch (e) {
          stopError = e;
          console.log(`   ⚠ fixed-stop placement failed: ${e.message}`);
          console.log(`   You will need to set your exit manually in TWS.`);
        }

        let verifyResult = { ok: false, statuses: {} };
        if (stopResult) {
          verifyResult = await verifyTransmitted([stopResult.orderId]);
        }

        if (stopResult && verifyResult.ok) {
          const maxLoss = Math.max(0, fillPrice - stopPrice) * actualQty * 100;
          discordNotify(
            `🚀 **${ticker} ${pick.strike}${right} ${expiry}** ×${actualQty} FILLED @ $${fillPrice.toFixed(2)} (${triggerLabel})\n` +
            `Fixed stop armed: $${stopPrice.toFixed(2)} (−$${(fillPrice - stopPrice).toFixed(2)} below) · max loss $${maxLoss.toFixed(2)} · MARKET exit, does NOT move\n` +
            `Upside is yours — manage T1/T2 manually; no take-profit orders placed.`,
          );
        } else if (stopResult && !verifyResult.ok) {
          console.log(`\n🚨 STOP VERIFICATION FAILED — order did not transmit.`);
          console.log(`   orderId=${stopResult.orderId}: ${verifyResult.statuses[stopResult.orderId] ?? 'NEVER REPORTED'}`);
          console.log(`   Open TWS Orders panel NOW.`);
          discordNotify(
            `🚨 **${ticker} ${pick.strike}${right}** ×${actualQty} FILLED @ $${fillPrice.toFixed(2)} BUT stop verification FAILED.\n` +
            `Open TWS NOW — stop may be staged, not transmitted.`,
          );
        } else {
          discordNotify(
            `⚠️ **${ticker} ${pick.strike}${right}** ×${actualQty} FILLED @ $${fillPrice.toFixed(2)} (${triggerLabel}) ` +
            `BUT STOP PLACEMENT FAILED: ${stopError?.message || 'unknown'} — set exit manually in TWS!`,
          );
        }
      } else if (tierQtys && BRACKET_ENABLED) {
        // ─── 3-TIER LADDER PATH (auto-trim) ─────────────────────────────────
        // Tiers (T1/T2/T3) stay on underlying-trigger MKTs (structural
        // take-profits). Stop becomes an OPTION-premium STP at
        // (fillPrice - OPTION_STOP_OFFSET_USD) — same simple rule as the
        // binary path, uniform across qty.
        const { tier1, tier2, tier3 } = computeTierPrices({
          entry: sigEntry, stop: stopPrice, T1: t1Price, T2: sigT2, direction: sigDir,
        });
        const ladderOptionStop = Math.max(0.01, fillPrice - OPTION_STOP_OFFSET_USD);
        const ladderOptionStopRounded = Math.round(ladderOptionStop * 100) / 100;
        const tierOrderIds = [nextOrderId++, nextOrderId++, nextOrderId++];
        const stopOrderId = nextOrderId++;
        let ladderResult = null;
        let ladderError = null;
        try {
          ladderResult = placeOCALadderExits({
            ib, ticker, expiry, strike: pick.strike, right,
            totalQty: actualQty, direction: sigDir,
            underlyingConId,
            tiers: [
              { price: tier1, qty: tierQtys[0] },
              { price: tier2, qty: tierQtys[1] },
              { price: tier3, qty: tierQtys[2] },
            ],
            stopPrice: ladderOptionStopRounded,        // option price (not underlying)
            useOptionPriceStop: true,                  // STP on option premium
            tierOrderIds, stopOrderId,
          });
          printLadderSpec({
            ticker, direction: sigDir, strike: pick.strike, right, totalQty: actualQty,
            tier1, tier2, tier3, tierQtys,
            stopPrice: ladderOptionStopRounded,        // print option-stop value
            stopIsOptionPrice: true,
            entryUnderlying: sigEntry,
            fillPrice,
            tierOrderIds: ladderResult.tierOrderIds, stopOrderId: ladderResult.stopOrderId,
            ocaGroup: ladderResult.ocaGroup,
          });
        } catch (e) {
          ladderError = e;
          console.log(`   ⚠ ladder placement failed: ${e.message}`);
          console.log(`   You will need to set your exits manually in TWS.`);
        }

        // Verify ALL N+1 ladder legs transmitted
        let verifyResult = { ok: false, statuses: {} };
        if (ladderResult) {
          const allIds = [...ladderResult.tierOrderIds, ladderResult.stopOrderId];
          verifyResult = await verifyTransmitted(allIds);
        }

        // Tier-1-fill listener: when first tier fills, slide stop to BE
        // for the remaining qty. ocaType=2 already handles the qty cascade
        // on the OTHER tiers; this handles the price slide on the stop.
        if (ladderResult) {
          const t1Id = ladderResult.tierOrderIds[0];
          const stopIdLive = ladderResult.stopOrderId;
          let beApplied = false;
          const tier1Listener = (id, status, filledLeg /* , remaining */) => {
            if (id !== t1Id) return;
            if (beApplied) return;
            if (status !== 'Filled' && status !== 'PartiallyFilled') return;
            const tier1Filled = Number(filledLeg) || 0;
            if (tier1Filled <= 0) return;
            beApplied = true;
            const remainingAfterTier1 = actualQty - tier1Filled;
            try {
              const result = modifyStopToBreakeven({
                ib,
                stopOrderId: stopIdLive,
                contract: optContractForExits,
                newStopPrice: sigEntry,                  // BE = entry premium (underlying)
                newQty: remainingAfterTier1,
                underlyingConId,
                direction: sigDir,
                ocaGroup: ladderResult.ocaGroup,
                freshOrderIdIfNeeded: nextOrderId++,
              });
              console.log(`   🎯 Tier 1 filled (${tier1Filled} contract(s)) — stop slid to BE @ ${sigEntry.toFixed(2)} for remaining ${remainingAfterTier1} (${result.modifiedInPlace ? 'modified-in-place' : 'cancel-replaced'})`);
              discordNotify(
                `🎯 **${ticker} ${pick.strike}${right}** Tier 1 hit (×${tier1Filled}) — stop slid to BE @ ${sigEntry.toFixed(2)}, ${remainingAfterTier1} contract(s) running.`,
              );
            } catch (e) {
              console.log(`   ⚠ stop-to-BE slide failed: ${e.message}`);
              console.log(`   Position remains protected at original stop ${stopPrice.toFixed(2)} — manual intervention optional.`);
              discordNotify(
                `⚠️ **${ticker} ${pick.strike}${right}** Tier 1 filled but stop-to-BE slide FAILED (${e.message}). Original stop ${stopPrice.toFixed(2)} still active.`,
              );
            }
          };
          ib.on(EventName.orderStatus, tier1Listener);
        }

        if (ladderResult && verifyResult.ok) {
          discordNotify(
            `🚀 **${ticker} ${pick.strike}${right} ${expiry}** ×${actualQty} FILLED @ $${fillPrice.toFixed(2)} (${triggerLabel})\n` +
            `3-tier OCA ladder armed (entry ${sigEntry.toFixed(2)}):\n` +
            `  Tier 1 (${tierQtys[0]}c): ${tier1.toFixed(2)}\n` +
            `  Tier 2 (${tierQtys[1]}c): ${tier2.toFixed(2)}\n` +
            `  Tier 3 (${tierQtys[2]}c): ${tier3.toFixed(2)}\n` +
            `  Stop (${actualQty}c → reduces): option STP @ $${ladderOptionStopRounded.toFixed(2)}  (fill $${fillPrice.toFixed(2)} − $${OPTION_STOP_OFFSET_USD})`,
          );
        } else if (ladderResult && !verifyResult.ok) {
          console.log(`\n🚨 LADDER VERIFICATION FAILED — at least one OCA leg did not transmit.`);
          for (const id of [...ladderResult.tierOrderIds, ladderResult.stopOrderId]) {
            console.log(`   orderId=${id}: ${verifyResult.statuses[id] ?? 'NEVER REPORTED'}`);
          }
          console.log(`   Open TWS Orders panel NOW.`);
          discordNotify(
            `🚨 **${ticker} ${pick.strike}${right}** ×${actualQty} FILLED @ $${fillPrice.toFixed(2)} BUT ladder verification FAILED.\n` +
            `Open TWS NOW — at least one ladder leg may be staged, not transmitted.`,
          );
        } else {
          discordNotify(
            `⚠️ **${ticker} ${pick.strike}${right}** ×${actualQty} FILLED @ $${fillPrice.toFixed(2)} (${triggerLabel}) ` +
            `BUT LADDER PLACEMENT FAILED: ${ladderError?.message || 'unknown'} — set exits manually in TWS!`,
          );
        }
      } else {
        // ─── BINARY OCA PATH (qty < 3) — USING OPTION-PREMIUM STOP ──────────
        // T1 stays on the structural underlying-trigger MKT. Stop is a true
        // STP on the OPTION at (fillPrice - OPTION_STOP_OFFSET_USD = $0.10).
        // Per-trade $ loss = $0.10 × 100 × qty = $10 × qty (scales with qty).
        const optionStopPrice = Math.max(0.01, fillPrice - OPTION_STOP_OFFSET_USD);
        const optionStopRounded = Math.round(optionStopPrice * 100) / 100;
        let bracketResult = null;
        let bracketError = null;
        try {
          const t1OrderId = nextOrderId++;
          const stopOrderId = nextOrderId++;
          bracketResult = placeOCABracketExits({
            ib, ticker, expiry, strike: pick.strike, right, qty: actualQty, direction: sigDir,
            underlyingConId,
            t1Price,
            stopPrice: optionStopRounded,        // option price (not underlying)
            useOptionPriceStop: true,            // stop becomes STP on option
            t1OrderId, stopOrderId,
          });
          console.log(`\n  ── OCA bracket placed ──`);
          console.log(`  Filled @ option $${fillPrice.toFixed(2)}, structural underlying entry ${sigEntry.toFixed(2)}`);
          console.log(`  T1 limit (underlying-trigger MKT):  fires when ${ticker} ${sigDir === 'CALLS' ? '≥' : '≤'} ${t1Price.toFixed(2)}   (orderId=${bracketResult.t1OrderId})`);
          console.log(`  STOP (option-price STP):            fires when option ≤ $${optionStopRounded.toFixed(2)} → market sell   (orderId=${bracketResult.stopOrderId})`);
          console.log(`  Max realized loss: $${(actualQty * (fillPrice - optionStopRounded) * 100).toFixed(2)} (= $${OPTION_STOP_OFFSET_USD} offset × 100 × ${actualQty} contract${actualQty === 1 ? '' : 's'})`);
        } catch (e) {
          bracketError = e;
          console.log(`   ⚠ bracket placement failed: ${e.message}`);
          console.log(`   You will need to set your exits manually in TWS.`);
        }

        let verifyResult = { ok: false, statuses: {} };
        if (bracketResult) {
          verifyResult = await verifyTransmitted([bracketResult.t1OrderId, bracketResult.stopOrderId]);
        }

        if (bracketResult && verifyResult.ok) {
          // For sniper fires (triggerType=A_SNIPER): track active position
          // so Rule 3 can run on the NEXT 5m boundary after fire. Cleared
          // after Rule 3 check completes (alignment held → clear; alignment
          // broke → market-sell submitted, position closing → clear).
          if (triggerType === 'A_SNIPER' && signal.sniperFireTimeSec) {
            _activeSniperPosition = {
              ticker, expiry, strike: pick.strike, right, qty: actualQty,
              direction: sigDir,
              entry: sigEntry,
              fillPrice,
              sniperFireTimeSec: signal.sniperFireTimeSec,
              fireBarHHMM: (() => {
                const parts = new Intl.DateTimeFormat('en-US', {
                  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
                }).formatToParts(new Date(signal.sniperFireTimeSec * 1000));
                return `${parts.find(p=>p.type==='hour').value}:${parts.find(p=>p.type==='minute').value}`;
              })(),
              sniperBarClose: signal.sniperBarClose,
              // Rule 3 fires on the NEXT 5m bar's close, so we need the
              // next-bar close time (sniperFireTimeSec + 5min) plus a small
              // grace (already built into the next 5m boundary wake).
              rule3DueAfterSec: signal.sniperFireTimeSec + 5 * 60,
              entryOrderId: orderId,
              t1OrderId: bracketResult.t1OrderId,
              stopOrderId: bracketResult.stopOrderId,
            };
            console.log(`   🎯 active sniper position tracked for Rule 3 abort check at next 5m boundary`);
          }
          discordNotify(
            `🚀 **${ticker} ${pick.strike}${right} ${expiry}** ×${actualQty} FILLED @ $${fillPrice.toFixed(2)} (${triggerLabel})\n` +
            `OCA bracket armed:\n` +
            `  T1 (underlying-trigger): ${ticker} ${sigDir === 'CALLS' ? '≥' : '≤'} ${t1Price.toFixed(2)}\n` +
            `  STOP (option-price): $${optionStopRounded.toFixed(2)} (max loss $${(actualQty * (fillPrice - optionStopRounded) * 100).toFixed(0)})\n` +
            (triggerType === 'A_SNIPER' ? `🎯 SNIPER fire — Rule 3 will check fakeout abort at next 5m boundary\n` : '') +
            `Order #${orderId} · bracket #${bracketResult.t1OrderId}/${bracketResult.stopOrderId}`,
          );
        } else if (bracketResult && !verifyResult.ok) {
          const t1Status = verifyResult.statuses[bracketResult.t1OrderId] ?? 'NEVER REPORTED';
          const stopStatus = verifyResult.statuses[bracketResult.stopOrderId] ?? 'NEVER REPORTED';
          console.log(`\n🚨 BRACKET VERIFICATION FAILED — at least one OCA leg did not transmit to IBKR.`);
          console.log(`   T1 (orderId=${bracketResult.t1OrderId}):   ${t1Status}`);
          console.log(`   Stop (orderId=${bracketResult.stopOrderId}): ${stopStatus}`);
          console.log(`   Open TWS Orders panel NOW. Any leg showing a "Transmit" button is staged and not protecting you.`);
          discordNotify(
            `🚨 **${ticker} ${pick.strike}${right}** ×${actualQty} FILLED @ $${fillPrice.toFixed(2)} BUT bracket verification FAILED.\n` +
            `T1 status: ${t1Status}\nStop status: ${stopStatus}\n` +
            `Open TWS NOW — at least one exit leg is staged, not transmitted. Position is partially unprotected.`,
          );
        } else {
          discordNotify(
            `⚠️ **${ticker} ${pick.strike}${right}** ×${actualQty} FILLED @ $${fillPrice.toFixed(2)} (${triggerLabel}) ` +
            `BUT BRACKET PLACEMENT FAILED: ${bracketError?.message || 'unknown'} — set exits manually in TWS!`,
          );
        }
      }
    }
  });

  // Record the trade — count-based per ticker, persists across invocations.
  // triggerType embedded so the per-day breakdown can show A vs B mix.
  recordTrade(ticker, {
    triggerType, subType,
    orderId, strike: pick.strike, right: sigDir === 'CALLS' ? 'C' : 'P',
    qty, premiumEst: pick.mid, direction: sigDir, expiry, entryTrigger: sigEntry,
    bracket: BRACKET_ENABLED ? { t1: t1Price, stop: stopPrice } : null,
  });

  // Wait for fill + bracket to land before yielding back to the loop.
  await new Promise(r => setTimeout(r, 15000));
  return true;
}

// ─── Option chain pre-warm ───────────────────────────────────────────────────
//
// Without pre-warm, when a trigger fires the watcher does:
//   resolveStockConId (~50-200ms)
// + getOptionChainParams (~500-2000ms)
// + queryOptionPremium × 20 strikes (~5-15s, 200ms pacing each)
// = total 5-15s of latency between trigger fire and the YES popup.
//
// Pre-warm runs in the background after every check (and at startup), so by
// the time a trigger fires the option chain + premium grid is already cached.
// Trigger A's entry is constant for the day, so the pre-warm target is
// stable. Trigger B fires at slightly different prices (VWAP / EMA21) but
// those are within the same strike window, so the cached premium grid still
// covers them.
const PREFETCH_TTL_MS = 30 * 60 * 1000;  // 30 min — premium freshness ceiling
const _optionCache = {
  conId: null,                  // resolved once per session
  chainParams: null,            // { strikes: Set, expirations: Set } — once per session
  expiry: null,                 // 0DTE string, once per session
  premiums: null,               // { fetchedAt, direction, centerPrice, premiums: Map<strike, mid> }
  inFlight: null,               // Promise of an in-progress prewarm (debounce)
};

async function ensureChainStaticsCached() {
  if (_optionCache.conId == null) {
    _optionCache.conId = await resolveStockConId(ib, ticker);
  }
  if (_optionCache.chainParams == null) {
    _optionCache.chainParams = await getOptionChainParams(ib, ticker, _optionCache.conId);
  }
  if (_optionCache.expiry == null) {
    _optionCache.expiry = pickExpiryForTicker(ticker, _optionCache.chainParams.expirations);
  }
}

/**
 * Pre-warm the option premium cache for the given direction, around `centerPrice`.
 * Idempotent — if a prewarm is already in flight, returns the same Promise.
 * Quietly swallows errors (best-effort; trigger fire will fall through to
 * a live fetch if the cache is empty).
 */
async function prewarmOptionData(prewarmDir, centerPrice) {
  if (_optionCache.inFlight) return _optionCache.inFlight;
  _optionCache.inFlight = (async () => {
    const t0 = Date.now();
    try {
      await ensureChainStaticsCached();
      if (!_optionCache.expiry) return;
      const right = prewarmDir === 'CALLS' ? 'C' : 'P';
      const nearby = nearestStrikes(_optionCache.chainParams.strikes, centerPrice, STRIKES_TO_QUERY * 2);
      const candidates = prewarmDir === 'CALLS'
        ? nearby.filter(s => s >= centerPrice - 2).slice(0, STRIKES_TO_QUERY)
        : nearby.filter(s => s <= centerPrice + 2).slice(-STRIKES_TO_QUERY);
      if (candidates.length === 0) return;
      const premiums = new Map();
      for (const strike of candidates) {
        const mid = await queryOptionPremium(ib, ticker, _optionCache.expiry, strike, right);
        if (mid != null) premiums.set(strike, mid);
        await new Promise(r => setTimeout(r, 200));
      }
      _optionCache.premiums = {
        fetchedAt: Date.now(),
        direction: prewarmDir,
        centerPrice,
        premiums,
      };
      const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`   🔥 prewarmed ${premiums.size} ${right} strikes around ${centerPrice.toFixed(2)} in ${elapsedSec}s`);
    } catch (e) {
      console.log(`   ⚠ option prewarm failed: ${e.message} (will fetch live on trigger)`);
    } finally {
      _optionCache.inFlight = null;
    }
  })();
  return _optionCache.inFlight;
}

/**
 * Try to pick a strike from the prewarm cache. Returns the same shape as
 * pickStrikeInRange ({ strike, mid }) on hit, or null on miss/stale/wrong-dir.
 */
function pickFromCache(pickDir, entryPrice) {
  const c = _optionCache.premiums;
  if (!c) return null;
  if (c.direction !== pickDir) return null;
  if (Date.now() - c.fetchedAt > PREFETCH_TTL_MS) return null;
  // Use cached premiums; recenter the candidates around the actual trigger entry
  // (might be Trigger A's configured entry vs Trigger B's VWAP/EMA21 — the
  // difference is small and within the cached strike window).
  const candidates = [...c.premiums.keys()].filter(strike =>
    pickDir === 'CALLS' ? strike >= entryPrice - 2 : strike <= entryPrice + 2,
  );
  const inRange = candidates
    .map(strike => ({ strike, mid: c.premiums.get(strike) }))
    .filter(p => p.mid >= PREMIUM_MIN && p.mid <= PREMIUM_MAX);
  if (inRange.length === 0) return null;
  inRange.sort((a, b) => Math.abs(a.strike - entryPrice) - Math.abs(b.strike - entryPrice));
  return inRange[0];
}

// ─── Main loop ───────────────────────────────────────────────────────────────
/**
 * Process one check cycle:
 *   1. Validate Trigger A. If fires AND quota available → handle (A only this cycle).
 *   2. Else validate Trigger B. If fires AND quota available → handle.
 * Returns true if a trade was placed (caller decides whether to continue).
 *
 * Single-fire-per-cycle: prevents A and B firing on the SAME bar (rare but
 * possible). Across DAYS, A and B can each fire multiple times up to
 * MAX_TRADES_PER_DAY per ticker. A is checked first when both could match
 * the same bar (more conservative breakout signal).
 */
async function runOneCheck(checkLabel) {
  // Hot-reload entry_notes BEFORE any validation — picks up mid-session
  // premarket re-runs (anchor 2026-04-30 SPY direction-flip).
  reloadEntryNotesIfChanged();

  // Determine boundary type from current ET time. 15m boundaries =
  // HH:00/15/30/45 → run Trigger A/B validators. Other 5m boundaries =
  // HH:05/10/20/25/35/40/50/55 → run sniper validator only (sniper-eligible
  // mid-window 5m closes per Rule 1).
  const nowEtMins = (() => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    return Number(parts.find(p=>p.type==='hour').value) * 60 + Number(parts.find(p=>p.type==='minute').value);
  })();
  const isFifteenMinBoundary = (nowEtMins % 15 === 0);

  // Always run Rule 3 fakeout-abort check first if we have an active sniper
  // position. Catches alignment breaks before they become full stop-outs.
  if (_activeSniperPosition) {
    try {
      await checkSniperFakeoutAbort();
    } catch (e) {
      console.log(`   ⚠ Rule 3 abort check error: ${e.message}`);
    }
  }

  const tradeCount = getTradeCount(ticker);
  if (tradeCount >= MAX_TRADES_PER_DAY) {
    console.log(`   ⏸  ${ticker} at trade cap (${tradeCount}/${MAX_TRADES_PER_DAY}) — skipping check (watcher staying alive for in-flight bracket fills)`);
    return false;
  }

  // 5m boundaries (mid-window): SNIPER ONLY. Don't run 15m validators on
  // partial 15m bars — they'd misfire on incomplete data.
  if (!isFifteenMinBoundary) {
    if (!SNIPER_ENABLED) {
      // Non-sniper non-15m boundary — nothing to do. (Shouldn't happen with
      // SNIPER_ENABLED=false because nextCandleBoundary returns 15m only.)
      return false;
    }
    let resultSniper = null;
    try {
      resultSniper = await validateSniperTrigger();
      console.log(`   SNIPER: ${resultSniper.triggered ? '🎯 FIRED' : 'not yet'}: ${resultSniper.reason}`);
    } catch (e) {
      console.log(`   sniper validation error: ${e.message}`);
    }
    if (resultSniper?.triggered && !testMode) {
      return await handleTriggered(resultSniper.signal);
    } else if (resultSniper?.triggered && testMode) {
      console.log(`   (test mode — skipping SNIPER order placement)`);
    }
    return false;
  }

  // 15m boundary: standard Trigger A + B validators.
  let resultA = null;
  try {
    resultA = await validateTriggerA();
    console.log(`   A: ${resultA.triggered ? '🔔 TRIGGERED' : 'not yet'}: ${resultA.reason}`);
  } catch (e) {
    console.log(`   A validation error: ${e.message}`);
  }
  if (resultA?.triggered && !testMode) {
    return await handleTriggered(resultA.signal);
  } else if (resultA?.triggered && testMode) {
    console.log(`   (test mode — skipping A order placement)`);
  }

  let resultB = null;
  try {
    resultB = await validateTriggerB();
    console.log(`   B: ${resultB.triggered ? '🔔 TRIGGERED' : 'not yet'}: ${resultB.reason}`);
  } catch (e) {
    console.log(`   B validation error: ${e.message}`);
  }
  if (resultB?.triggered && !testMode) {
    return await handleTriggered(resultB.signal);
  } else if (resultB?.triggered && testMode) {
    console.log(`   (test mode — skipping B order placement)`);
  }

  return false;
}

// Module-scoped so SIGINT handler can clear it on shutdown.
let prewarmTimer = null;

async function runLoop() {
  let checkNum = 0;

  // --test-fire: skip validator, immediately fire handleTriggered with the
  // CURRENT entry_notes Trigger A signal. Useful to verify the end-to-end
  // chain (YES prompt ↔ dashboard ↔ stdin ↔ order placement ↔ OCA bracket)
  // without waiting for a real candle trigger. Exits after one attempt.
  if (testFire) {
    console.log(`\n🧪 TEST-FIRE mode — skipping validator, firing Trigger A handleTriggered() immediately.`);
    console.log(`   This IS a real order path — uses the active IBKR_PORT for real interaction.`);
    try {
      await handleTriggered({
        triggerType: 'A',
        direction,
        entry: entryPrice,
        stop: triggerA.stop,
        T1: triggerA.T1,
        T2: triggerA.T2 ?? null,
      });
    } catch (e) {
      console.log(`   test-fire error: ${e.message}`);
    }
    console.log(`\n   test-fire complete. Exiting.`);
    return;
  }

  // Emit loaded-levels marker so the dashboard can render what the watcher
  // actually has in memory (instead of inferring from the file). Carries the
  // generatedAt timestamp so consumers can detect drift vs the live file.
  emitLoadedLevelsMarker();

  // Kick off option-chain prewarm in the background. Doesn't block the
  // initial check — if it finishes before a trigger fires, the YES popup is
  // instant; if not, the trigger handler falls through to a live fetch.
  prewarmOptionData(direction, entryPrice).catch(() => {});

  // Periodic refresh on top of the per-15m-check refresh below — keeps the
  // cache at most ~5 min stale at fire time. Anchor 2026-05-01: cached
  // QQQ 675C @ $0.62 (built at 09:46) was 14 min stale at 10:00:44 fire,
  // by which point fresh was $1.41 (+127% drift). With this interval the
  // worst-case staleness shrinks from 14 min to ~5 min. inFlight guard in
  // prewarmOptionData prevents double-fetch if a post-check refresh is
  // already running. Cleared on SIGINT below.
  prewarmTimer = setInterval(() => {
    prewarmOptionData(direction, entryPrice).catch(() => {});
  }, PREWARM_REFRESH_INTERVAL_MS);

  console.log(`[${nowETStr()}] Initial check...`);
  try {
    const placed = await runOneCheck('initial');
    if (placed) {
      // Continue loop after a placed trade to allow further fires up to cap
      console.log(`   trade placed; continuing loop for additional triggers within cap`);
    }
  } catch (e) {
    console.log(`   initial check error: ${e.message}`);
  }

  let capMarkerEmitted = false;
  while (true) {
    if (Date.now() >= until.getTime()) {
      console.log(`\n⏰ ${untilStr} SGT reached. Closing cleanly.`);
      if (capMarkerEmitted) console.log('__EXIT_REASON__ trade_cap');
      break;
    }
    if (getTradeCount(ticker) >= MAX_TRADES_PER_DAY) {
      // P1 fix (anchor 2026-04-29 IWM 271P): the bracket SELL leg was
      // missing from executions-raw JSONL because the watcher exited
      // immediately at trade_cap, killing the execDetails handler before
      // the bracket fired. Stay alive until --until so any in-flight
      // bracket fills get appended to JSONL by the existing handler.
      if (!capMarkerEmitted) {
        console.log(`\n✅ ${ticker} at trade cap (${getTradeCount(ticker)}/${MAX_TRADES_PER_DAY}). Staying alive for in-flight bracket fills until ${untilStr} SGT.`);
        // Emit marker immediately so the dashboard can render the cap-reached
        // pill right away. The actual process-exit will fire when --until hits.
        console.log('__EXIT_REASON__ trade_cap');
        capMarkerEmitted = true;
      }
      // Sleep in chunks of 60s so we periodically wake up to check until-time
      // (instead of one giant timeout that delays clean exit).
      const remainMs = until.getTime() - Date.now();
      const sleepMs = Math.min(remainMs, 60_000);
      await new Promise(r => setTimeout(r, sleepMs));
      continue;
    }

    const nextBoundary = nextCandleBoundary();
    if (nextBoundary.getTime() > until.getTime()) {
      const remainMs = until.getTime() - Date.now();
      console.log(`\n⏰ Next boundary is past --until ${untilStr}. Sleeping ${Math.round(remainMs/60000)}m more then exiting.`);
      await new Promise(r => setTimeout(r, remainMs));
      break;
    }

    const waitMs = nextBoundary.getTime() - Date.now();
    const nbTimeStr = nextBoundary.toLocaleTimeString('en-US', { hour12: false });
    console.log(`\nSleeping ${Math.round(waitMs/1000)}s until ${nbTimeStr} SGT...`);
    await new Promise(r => setTimeout(r, waitMs));

    checkNum++;
    console.log(`\n[${nowETStr()}] Check #${checkNum}...`);
    await runOneCheck(`#${checkNum}`);

    // Refresh prewarm cache so the next check's trigger fires get an instant
    // strike pick. Background — does not block the next sleep cycle.
    prewarmOptionData(direction, entryPrice).catch(() => {});
  }
}

// ─── Ctrl+C handler ──────────────────────────────────────────────────────────
let shuttingDown = false;
process.on('SIGINT', () => {
  if (shuttingDown) process.exit(0);
  shuttingDown = true;
  console.log('\n\n⏹  Ctrl+C — shutting down cleanly...');
  if (prewarmTimer) { clearInterval(prewarmTimer); prewarmTimer = null; }
  if (_activeSniperPosition) {
    console.log(`   ⚠ Active sniper position for ${_activeSniperPosition.ticker} ${_activeSniperPosition.strike}${_activeSniperPosition.right} — Rule 3 abort will NOT run after shutdown. OCA bracket (T1+stop) is still armed in TWS.`);
    _activeSniperPosition = null;
  }
  ib.disconnect();
  notifyExit('stopped (Ctrl+C / SIGINT)', 0);
});

// ─── Banner + main ───────────────────────────────────────────────────────────
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  trade_window.mjs — ${ticker} Trigger A + B watcher (multi-trade)`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  Loaded entry_notes (${ageHrs.toFixed(1)}h old): ${ticker} ${direction}`);
console.log(`  Trigger A: ${entryPrice != null
  ? `15m close ${direction === 'CALLS' ? '>' : '<'} ${entryPrice.toFixed(2)} with rVol ≥ ${RVOL_THRESHOLD}`
  : '— inactive (no ORB breakout entry; pullback-only setup, Trigger B carries it)'}`);
const tbVwap = entryNotes.trigger_b?.entry_vwap;
const tbEma = entryNotes.trigger_b?.entry_ema21_1H;
console.log(`  Trigger B: ${direction === 'CALLS' ? 'reclaim' : 'reject'} of session VWAP (~${tbVwap?.toFixed(2) ?? '—'}) or 1H EMA21 (~${tbEma?.toFixed(2) ?? '—'}) with rVol ≥ ${RVOL_THRESHOLD}`);
if (sessionLevels) {
  console.log(`  Session lvls: PDH=${sessionLevels.pdh ?? '—'}/PDL=${sessionLevels.pdl ?? '—'} (${sessionLevels.pd_session_date || 'n/a'}) · PMH=${sessionLevels.pmh ?? '—'}/PML=${sessionLevels.pml ?? '—'}  (gate: suppress fire within ${SESSION_LEVEL_K}×ATR of opposing level)`);
} else {
  console.log(`  Session lvls: none loaded — session_level_proximity gate inactive`);
}
console.log(`  Cap:       ${MAX_TRADES_PER_DAY} trades per day per ticker (currently ${getTradeCount(ticker)} used today)`);
console.log(`  Stop loss: option-premium STP at fill − $${OPTION_STOP_OFFSET_USD.toFixed(2)} (max $${(OPTION_STOP_OFFSET_USD * 100).toFixed(0)}/contract loss; uniform across qty)`);
console.log(`  Chase guard: ON — Layer A (5m bar) + Layer B (live tick via reqMktData, 800ms timeout, fail-open)`);
console.log(`  Correlation gate: ON — suppress if SPY/QQQ/IWM same-direction fire within ${CORRELATION_WINDOW_SEC}s on a different ticker`);
console.log(`  Sniper window: 10:00 – 10:45 ET (sniper Trigger A only; Trigger B unrestricted within 10:00–14:00)`);
console.log(`  Premium:   $${PREMIUM_MIN.toFixed(2)}–$${PREMIUM_MAX.toFixed(2)} (${PREMIUM_RANGE[ticker] ? 'per-ticker' : 'default'})`);
console.log(`  Window:    now (${nowETStr()}) → ${untilStr} SGT`);
console.log(`  Mode:      ${testFire ? '🧪 TEST-FIRE (skips validator, fires once on YES)' : testMode ? 'TEST (no order placement)' : STAGED_MODE ? 'STAGED (YES → stage in TWS → click Transmit)' : autoFire ? '⚡ AUTO-FIRE (no YES gate, place immediately, manage in TWS)' : 'AUTO-TRANSMIT (YES fires immediately)'}`);
console.log(`  YES gate:  ${autoFire ? '⚡ DISABLED (auto-fire mode)' : 'ENABLED (portal/terminal YES required before order placement)'}`);
console.log(`  1m confirm: ${confirmFire ? '⏳ ENABLED (60s wait + 1m bar confirmation on Trigger A and A_SNIPER)' : 'disabled'}`);
console.log(`  Exits:     ${trailingRunner ? `🛑 FIXED STOP (single STP SELL @ −$${STOP_DISTANCE_USD.toFixed(2)} below fill, MARKET exit; manage T1/T2 manually)` : 'OCA bracket (T1 + option-premium STP @ -$0.10)'}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

(async () => {
  console.log('Connecting to TWS...');
  try { await connectIB(); } catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
  console.log(`✅ connected (clientId=${watcherClientId})`);
  console.log(
    DISCORD_ENABLED
      ? `🔔 Discord notifications: ENABLED`
      : `🔕 Discord notifications: DISABLED (set DISCORD_WEBHOOK env to enable)`,
  );

  await runLoop();

  ib.disconnect();
  notifyExit('session ended (--until reached or loop exited)', 0);
})().catch(e => { console.error('FATAL:', e); notifyExit(`FATAL — ${e?.message ?? e}`, 1); });
