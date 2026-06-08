/**
 * Live gate evaluation for the dashboard.
 *
 * Mirrors the watcher's asia/lib/gates_eval.mjs semantics — reads the same
 * state files and produces statuses in the format gate-panel.tsx's
 * classifyStatus() understands ("pass (...)", "fail (...)", "deferred (...)",
 * "evaluated_at_*", "unknown_*").
 *
 * Returns a merged list: live statuses for session-wide gates that CAN be
 * evaluated server-side now (Y/N, session_window, blackout, cap, A50),
 * falls back to the journal-parsed snapshot for gates that can't (vhsi_regime
 * is from premarket fetch; chase is per-trigger only).
 */

import { promises as fs } from "node:fs";
import path from "node:path";

type GateOut = { name: string; status: string };

type ManualYn = { yn?: "Y" | "N" | null; set_at?: string | null; set_by?: string | null };
type A50State = { today_sgt_date?: string; status?: string; detail?: string };
type PolicyState = { fetched_at?: string; events?: Array<{ time_utc: string; event: string }> };
type GatesConfig = {
  session_window?: { allowed_windows_sgt?: string[] };
  daily_trade_cap?: { max_trades?: number };
  china_policy_blackout?: { blackout_minutes?: number };
};
type TradedToday = { date?: string; tradeCount?: Record<string, number> };

function nowInSGT(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    h: Number(get("hour")),
    m: Number(get("minute")),
  };
}

function todayHK() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function formatSetAtShort(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(iso)) + " SGT";
  } catch {
    return iso;
  }
}

function evalSessionWindow(allowed: string[], sgt: ReturnType<typeof nowInSGT>): string {
  const mins = sgt.h * 60 + sgt.m;
  for (const w of allowed) {
    const m = String(w).match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const start = Number(m[1]) * 60 + Number(m[2]);
    const end = Number(m[3]) * 60 + Number(m[4]);
    if (mins >= start && mins < end) {
      return `pass (in ${w})`;
    }
  }
  // Find the next upcoming window today
  let nextWindow: string | null = null;
  let minDelta = Infinity;
  for (const w of allowed) {
    const m = String(w).match(/^(\d{1,2}):(\d{2})/);
    if (!m) continue;
    const start = Number(m[1]) * 60 + Number(m[2]);
    const delta = start - mins;
    if (delta > 0 && delta < minDelta) { minDelta = delta; nextWindow = w; }
  }
  if (nextWindow) {
    const h = Math.floor(minDelta / 60);
    const m = minDelta % 60;
    return `deferred (next ${nextWindow} in ${h > 0 ? `${h}h` : ""}${m}m)`;
  }
  return `fail (no more windows today, now ${String(sgt.h).padStart(2, "0")}:${String(sgt.m).padStart(2, "0")} SGT)`;
}

function evalManualYn(state: ManualYn | null): string {
  if (!state || state.yn !== "Y") {
    return `fail (toggle off — enable trading to send orders)`;
  }
  if (!state.set_at) return `fail (yn='Y' but no set_at — malformed)`;
  const setAt = new Date(state.set_at);
  if (Number.isNaN(setAt.getTime())) return `fail (set_at unparseable)`;
  const setSgtDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(setAt);
  const today = todayHK();
  if (setSgtDate !== today) {
    return `fail (stale — last enabled ${setSgtDate}, today is ${today})`;
  }
  const setBy = state.set_by ? ` by ${state.set_by}` : "";
  return `pass (${formatSetAtShort(state.set_at)}${setBy})`;
}

function evalA50(state: A50State | null): string {
  if (!state) return `deferred (waiting — A50 check runs ~09:45 SGT)`;
  const today = todayHK();
  if (state.today_sgt_date && state.today_sgt_date !== today) {
    return `deferred (stale from ${state.today_sgt_date} — A50 check pending today)`;
  }
  if (state.status === "pass") {
    return `pass (${state.detail ?? "hsi+a50 agree"})`;
  }
  return `fail (${state.detail ?? state.status ?? "no agreement"})`;
}

function evalBlackout(state: PolicyState | null, windowMin: number): string {
  if (!state) return `unknown_no_calendar`;
  const fetchedHrsAgo = state.fetched_at
    ? (Date.now() - new Date(state.fetched_at).getTime()) / (1000 * 60 * 60)
    : Infinity;
  if (fetchedHrsAgo > 30) return `unknown_calendar_stale`;
  const nowMs = Date.now();
  const winMs = windowMin * 60 * 1000;
  const events = Array.isArray(state.events) ? state.events : [];
  const active = events.find((e) => {
    const t = new Date(e.time_utc).getTime();
    return Number.isFinite(t) && Math.abs(t - nowMs) <= winMs;
  });
  if (active) {
    const delta = Math.round((new Date(active.time_utc).getTime() - nowMs) / 60000);
    return `fail (blackout: ${active.event} ${delta >= 0 ? "+" : ""}${delta}m)`;
  }
  const upcoming = events
    .map((e) => ({ e, t: new Date(e.time_utc).getTime() }))
    .filter((x) => Number.isFinite(x.t) && x.t > nowMs)
    .sort((a, b) => a.t - b.t)[0];
  if (!upcoming) return `pass (no events ±${windowMin}m)`;
  const minsUntil = Math.round((upcoming.t - nowMs) / 60000);
  return minsUntil < 240
    ? `pass (next: ${upcoming.e.event} in ${minsUntil}m)`
    : `pass (next: ${upcoming.e.event} in ${Math.round(minsUntil / 60)}h)`;
}

function evalDailyCap(state: TradedToday | null, cap: number, instrumentKeys: string[]): string {
  const today = todayHK();
  if (!state || state.date !== today) {
    return `pass (0/${cap} per instrument — fresh day)`;
  }
  const counts = state.tradeCount ?? {};
  const totals = instrumentKeys.map((k) => `${k.slice(0, 3)}:${counts[k] ?? 0}`);
  const capped = instrumentKeys.find((k) => (counts[k] ?? 0) >= cap);
  if (capped) {
    return `fail (${capped} at ${counts[capped]}/${cap})`;
  }
  const totalUsed = instrumentKeys.reduce((s, k) => s + (counts[k] ?? 0), 0);
  if (totalUsed === 0) {
    return `pass (0/${cap} per instrument)`;
  }
  return `pass (${totals.join(" ")} of ${cap} each)`;
}

/**
 * Build the live gate list for the dashboard. Pass the journal-parsed gate
 * snapshot for fields that can't be evaluated server-side (vhsi_regime,
 * correlation_chase_filter), the rest are computed live from state files.
 */
export async function buildLiveGates(asiaRoot: string, journalGates: GateOut[], instrumentKeys: string[]): Promise<GateOut[]> {
  const [gatesCfg, manualYn, a50, policy, traded] = await Promise.all([
    readJsonSafe<GatesConfig>(path.join(asiaRoot, "config", "gates.json")),
    readJsonSafe<ManualYn>(path.join(asiaRoot, "state", "manual_yn.json")),
    readJsonSafe<A50State>(path.join(asiaRoot, "state", "a50_correlation.json")),
    readJsonSafe<PolicyState>(path.join(asiaRoot, "state", "policy_events.json")),
    readJsonSafe<TradedToday>(path.join(asiaRoot, "state", "traded_today_hk.json")),
  ]);

  const sgt = nowInSGT();
  const blackoutMin = gatesCfg?.china_policy_blackout?.blackout_minutes ?? 30;
  const cap = gatesCfg?.daily_trade_cap?.max_trades ?? 3;
  const allowedWindows = gatesCfg?.session_window?.allowed_windows_sgt ?? [];

  const live: Record<string, string> = {
    manual_dashboard_yn: evalManualYn(manualYn),
    session_window: evalSessionWindow(allowedWindows, sgt),
    china_policy_blackout: evalBlackout(policy, blackoutMin),
    daily_trade_cap: evalDailyCap(traded, cap, instrumentKeys),
    a50_correlation: evalA50(a50),
    // correlation_chase_filter: per-trigger only — fall through to journal
    // vhsi_regime: from premarket fetch — fall through to journal
  };

  // Build the output in the original gates.json order (preserved by the
  // journal parser). If journalGates is empty we fabricate from the live
  // set so the panel still renders.
  if (journalGates.length === 0) {
    return [
      "vhsi_regime",
      "a50_correlation",
      "china_policy_blackout",
      "session_window",
      "daily_trade_cap",
      "manual_dashboard_yn",
      "correlation_chase_filter",
    ].map((name) => ({
      name,
      status: live[name] ?? (name === "correlation_chase_filter" ? "evaluated_at_entry" : "unknown_no_premarket"),
    }));
  }
  return journalGates.map((g) => ({ name: g.name, status: live[g.name] ?? g.status }));
}
