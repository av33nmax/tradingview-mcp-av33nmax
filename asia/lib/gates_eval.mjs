/**
 * asia/lib/gates_eval.mjs — runtime gate evaluator for the HK watcher.
 *
 * Reads asia/config/gates.json + state files + (optionally) the live
 * trigger signal context, returns a structured verdict:
 *
 *   {
 *     passed:   boolean,                    // true iff ZERO blocking gates failed
 *     blocking: string[],                   // names of gates whose failure blocks this fire
 *     gates: {
 *       [name]: {
 *         pass:    boolean,
 *         reason:  string,                  // human-readable detail
 *         action:  'skip_session' | 'block_entry' | 'pass',
 *         blocking: boolean,                // true if fail blocks the fire
 *         skipped?: boolean,                // gate was disabled or deferred
 *       }
 *     },
 *     evaluatedAt: string,                  // ISO ts
 *   }
 *
 * NOT every gate is re-evaluated at watcher time. The vhsi_regime gate is
 * marked "deferred_to_premarket" — premarket_hsi.mjs evaluates it once at
 * 08:30 SGT against the day's regime. If you want the watcher to re-fetch
 * VHSI live, add it here later. For now we assume the premarket gate cascade
 * blocked the day if VHSI was out of band.
 *
 * Caller responsibilities:
 *   - Pass instrumentKey (for daily_trade_cap and per-instrument counts)
 *   - Pass signal context for the chase filter:
 *       { entry: number, direction: 'long'|'short', currentPrice: number }
 *     If signal is null, chase filter is skipped (e.g. when called from a
 *     pre-flight startup check, not at a real fire).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluatePolicyGate } from './calendar.mjs';
import { getTradeCount, maxTradesPerDay } from './trades_today_hk.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASIA_ROOT = path.resolve(__dirname, '..');

const GATES_PATH = path.join(ASIA_ROOT, 'config', 'gates.json');
const POLICY_EVENTS_PATH = path.join(ASIA_ROOT, 'state', 'policy_events.json');
const A50_STATE_PATH = path.join(ASIA_ROOT, 'state', 'a50_correlation.json');
const MANUAL_YN_PATH = path.join(ASIA_ROOT, 'state', 'manual_yn.json');

let _gatesCache = null;
async function loadGates() {
  if (_gatesCache) return _gatesCache;
  _gatesCache = JSON.parse(await fs.readFile(GATES_PATH, 'utf8'));
  return _gatesCache;
}

function nowInSGT(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find(p => p.type === t)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    h: Number(get('hour')),
    m: Number(get('minute')),
  };
}

function evaluateSessionWindow(gateConfig, sgt) {
  const allowed = gateConfig?.allowed_windows_sgt || [];
  const mins = sgt.h * 60 + sgt.m;
  for (const window of allowed) {
    const m = String(window).match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const start = Number(m[1]) * 60 + Number(m[2]);
    const end = Number(m[3]) * 60 + Number(m[4]);
    if (mins >= start && mins < end) {
      return { in: true, window };
    }
  }
  return { in: false, window: null };
}

async function evaluateA50Correlation() {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(A50_STATE_PATH, 'utf8'));
  } catch {
    return { pass: false, deferred: true, reason: 'no a50_correlation.json — check_a50_correlation.mjs has not run yet (expected after 09:45 SGT)' };
  }
  const todaySgt = nowInSGT().date;
  if (raw.today_sgt_date && raw.today_sgt_date !== todaySgt) {
    return { pass: false, deferred: true, reason: `stale verdict from ${raw.today_sgt_date}, today is ${todaySgt}` };
  }
  if (raw.status === 'pass') {
    return { pass: true, reason: raw.detail || 'a50 + mhi agree on direction' };
  }
  return { pass: false, reason: raw.detail || `a50 correlation status=${raw.status}` };
}

async function evaluateManualYN() {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(MANUAL_YN_PATH, 'utf8'));
  } catch {
    return { pass: false, reason: "manual_yn.json missing — dashboard Y/N toggle not yet wired" };
  }
  if (raw.yn !== 'Y') {
    return { pass: false, reason: `dashboard toggle is '${raw.yn ?? 'unset'}' — set to 'Y' from the dashboard to arm the watcher` };
  }
  if (!raw.set_at) {
    return { pass: false, reason: "yn='Y' but no set_at timestamp — refusing as malformed" };
  }
  const setAt = new Date(raw.set_at);
  if (Number.isNaN(setAt.getTime())) {
    return { pass: false, reason: `yn='Y' but set_at is unparseable (${raw.set_at})` };
  }
  // Same SGT calendar day required — yesterday's Y must not auto-arm today.
  const setSgtDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(setAt);
  const todaySgtDate = nowInSGT().date;
  if (setSgtDate !== todaySgtDate) {
    return { pass: false, reason: `yn='Y' but set_at is ${setSgtDate} (today HK: ${todaySgtDate}) — toggle must be re-armed each SGT day` };
  }
  return { pass: true, reason: `armed at ${raw.set_at}${raw.set_by ? ` by ${raw.set_by}` : ''}` };
}

function evaluateChaseFilter(gateConfig, signal) {
  if (!signal || !Number.isFinite(signal.entry) || !Number.isFinite(signal.currentPrice)) {
    return { pass: true, skipped: true, reason: 'no signal context — gate not applicable to this call' };
  }
  const maxPct = Number(gateConfig?.max_distance_from_signal_pct ?? 0.3);
  // For LONG: chase if currentPrice > entry * (1 + maxPct/100)
  // For SHORT: chase if currentPrice < entry * (1 - maxPct/100)
  const isLong = signal.direction === 'long' || signal.direction === 'CALLS';
  const distancePct = isLong
    ? ((signal.currentPrice - signal.entry) / signal.entry) * 100
    : ((signal.entry - signal.currentPrice) / signal.entry) * 100;
  if (distancePct > maxPct) {
    return {
      pass: false,
      reason: `current ${signal.currentPrice.toFixed(2)} is ${distancePct.toFixed(2)}% beyond entry ${signal.entry.toFixed(2)} — exceeds chase cap ${maxPct}%`,
    };
  }
  return {
    pass: true,
    reason: `${distancePct >= 0 ? '+' : ''}${distancePct.toFixed(2)}% from entry (cap ${maxPct}%)`,
  };
}

/**
 * Main entry point. Evaluates every gate that's enabled in gates.json.
 *
 * @param {object} ctx
 * @param {string} ctx.instrumentKey       — e.g. 'MHI', 'TENCENT'
 * @param {object} [ctx.signal]            — { entry, direction, currentPrice }
 * @param {Date}   [ctx.now]               — for testing
 *
 * @returns {Promise<object>} verdict (see file header for shape)
 */
export async function evaluateAllGates(ctx) {
  const { instrumentKey, signal = null, now = new Date() } = ctx;
  const gates = await loadGates();
  const sgt = nowInSGT(now);
  const result = { passed: true, blocking: [], gates: {}, evaluatedAt: now.toISOString(), sgt };

  // 1. vhsi_regime — deferred to premarket. We trust premarket_hsi.mjs
  //    blocked the day if VHSI was out of band. Watcher does not refetch.
  if (gates.vhsi_regime?.enabled) {
    result.gates.vhsi_regime = {
      pass: true,
      skipped: true,
      reason: 'deferred to premarket_hsi.mjs (08:30 SGT) — watcher does not refetch VHSI',
      action: gates.vhsi_regime.action_on_fail || 'skip_session',
      blocking: false,
    };
  }

  // 2. a50_correlation — read state file (written by check_a50_correlation.mjs at 09:45)
  if (gates.a50_correlation?.enabled) {
    const r = await evaluateA50Correlation();
    result.gates.a50_correlation = {
      pass: r.pass,
      reason: r.reason,
      action: gates.a50_correlation.action_on_fail || 'skip_session',
      blocking: !r.pass && !r.deferred,
      ...(r.deferred ? { deferred: true } : {}),
    };
    if (result.gates.a50_correlation.blocking) {
      result.passed = false;
      result.blocking.push('a50_correlation');
    }
  }

  // 3. china_policy_blackout — live calendar check against now
  if (gates.china_policy_blackout?.enabled) {
    const windowMin = gates.china_policy_blackout.blackout_minutes ?? 30;
    const verdict = await evaluatePolicyGate(POLICY_EVENTS_PATH, now, windowMin);
    const pass = verdict.status === 'pass';
    result.gates.china_policy_blackout = {
      pass,
      reason: verdict.detail,
      action: gates.china_policy_blackout.action_on_fail || 'block_entry',
      blocking: !pass && verdict.status === 'fail',
      ...(verdict.status.startsWith('unknown_') ? { unknown: true } : {}),
    };
    if (result.gates.china_policy_blackout.blocking) {
      result.passed = false;
      result.blocking.push('china_policy_blackout');
    }
  }

  // 4. session_window — pure SGT time math
  if (gates.session_window?.enabled) {
    const r = evaluateSessionWindow(gates.session_window, sgt);
    result.gates.session_window = {
      pass: r.in,
      reason: r.in
        ? `inside ${r.window} (now ${String(sgt.h).padStart(2, '0')}:${String(sgt.m).padStart(2, '0')} SGT)`
        : `outside allowed windows (now ${String(sgt.h).padStart(2, '0')}:${String(sgt.m).padStart(2, '0')} SGT)`,
      action: 'block_entry',
      blocking: !r.in,
    };
    if (!r.in) {
      result.passed = false;
      result.blocking.push('session_window');
    }
  }

  // 5. daily_trade_cap — count from traded_today_hk.json
  if (gates.daily_trade_cap?.enabled) {
    const count = getTradeCount(instrumentKey);
    const cap = maxTradesPerDay();
    const pass = count < cap;
    result.gates.daily_trade_cap = {
      pass,
      reason: pass
        ? `${count}/${cap} trades for ${instrumentKey} today`
        : `cap reached: ${count}/${cap} trades for ${instrumentKey} today`,
      action: 'block_entry',
      blocking: !pass,
    };
    if (!pass) {
      result.passed = false;
      result.blocking.push('daily_trade_cap');
    }
  }

  // 6. manual_dashboard_yn — binding gate (hard block until UI ships)
  if (gates.manual_dashboard_yn?.enabled) {
    const r = await evaluateManualYN();
    result.gates.manual_dashboard_yn = {
      pass: r.pass,
      reason: r.reason,
      action: 'block_entry',
      blocking: !r.pass,
    };
    if (!r.pass) {
      result.passed = false;
      result.blocking.push('manual_dashboard_yn');
    }
  }

  // 7. correlation_chase_filter — only evaluated if signal context provided
  if (gates.correlation_chase_filter?.enabled) {
    const r = evaluateChaseFilter(gates.correlation_chase_filter, signal);
    result.gates.correlation_chase_filter = {
      pass: r.pass,
      reason: r.reason,
      action: 'block_entry',
      blocking: !r.pass && !r.skipped,
      ...(r.skipped ? { skipped: true } : {}),
    };
    if (result.gates.correlation_chase_filter.blocking) {
      result.passed = false;
      result.blocking.push('correlation_chase_filter');
    }
  }

  return result;
}

/** Pretty multi-line summary for console output. */
export function formatVerdict(verdict) {
  const lines = [];
  lines.push(`Gate verdict: ${verdict.passed ? '✅ PASS' : `❌ BLOCKED by [${verdict.blocking.join(', ')}]`}`);
  for (const [name, g] of Object.entries(verdict.gates)) {
    const icon = g.pass ? '✓' : (g.skipped || g.deferred || g.unknown ? '·' : '✗');
    lines.push(`   ${icon} ${name.padEnd(28)} ${g.reason}`);
  }
  return lines.join('\n');
}
