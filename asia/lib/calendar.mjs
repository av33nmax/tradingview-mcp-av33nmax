/**
 * asia/lib/calendar.mjs
 *
 * Economic calendar event loading + blackout evaluation.
 *
 * Reads events from `asia/state/policy_events.json` (refreshed by
 * `refresh_calendar.mjs`) and answers: "is NOW within ±N minutes of a
 * scheduled high-impact China/HK policy or data event?"
 *
 * Event format (one entry):
 *   {
 *     "time_utc": "2026-05-20T01:15:00Z",   // ISO UTC timestamp
 *     "country": "China",
 *     "event": "PBoC 1-Year Loan Prime Rate",
 *     "source": "tradingeconomics" | "manual",
 *     "importance": 3,                       // 1=low, 2=med, 3=high
 *     "category": "Interest Rate"
 *   }
 *
 * Pure logic — no TV/CDP calls.
 */

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_BLACKOUT_MIN = 30;
const STALE_AFTER_HOURS = 30; // refresh recommended after 30h

/**
 * Read the events file. Returns { fetched_at, events: [...] } or null if missing.
 */
export async function loadEvents(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw);
    return {
      fetched_at: data.fetched_at,
      events: Array.isArray(data.events) ? data.events : [],
    };
  } catch {
    return null;
  }
}

/**
 * Is the file stale (fetched more than `maxHours` ago)?
 */
export function isStale(loaded, maxHours = STALE_AFTER_HOURS) {
  if (!loaded || !loaded.fetched_at) return true;
  const fetched = new Date(loaded.fetched_at).getTime();
  if (Number.isNaN(fetched)) return true;
  const ageHours = (Date.now() - fetched) / (1000 * 60 * 60);
  return ageHours > maxHours;
}

/**
 * Return events that fall within [now - windowMin, now + windowMin].
 * These are the ones currently triggering a blackout.
 */
export function getActiveBlackouts(events, now = new Date(), windowMin = DEFAULT_BLACKOUT_MIN) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const nowMs = now.getTime();
  const windowMs = windowMin * 60 * 1000;
  return events.filter((e) => {
    const evt = new Date(e.time_utc).getTime();
    if (Number.isNaN(evt)) return false;
    return Math.abs(evt - nowMs) <= windowMs;
  });
}

/**
 * Get the next upcoming event (>= now).
 * Returns { event, minutes_until } or null if no future events.
 */
export function getNextEvent(events, now = new Date()) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const nowMs = now.getTime();
  const upcoming = events
    .map((e) => ({ event: e, ts: new Date(e.time_utc).getTime() }))
    .filter((x) => !Number.isNaN(x.ts) && x.ts >= nowMs)
    .sort((a, b) => a.ts - b.ts);
  if (upcoming.length === 0) return null;
  return {
    event: upcoming[0].event,
    minutes_until: Math.round((upcoming[0].ts - nowMs) / 60000),
  };
}

/**
 * Top-level: evaluate the china_policy_blackout gate.
 *
 * Returns one of:
 *   { status: "pass", detail: "no events in window" | "next: X @ Y in Zmin" }
 *   { status: "fail", detail: "blackout: <event> ±Xmin" }
 *   { status: "unknown_no_calendar" | "unknown_calendar_stale", detail: "..." }
 */
export async function evaluatePolicyGate(filePath, now = new Date(), windowMin = DEFAULT_BLACKOUT_MIN) {
  const loaded = await loadEvents(filePath);
  if (!loaded) {
    return {
      status: "unknown_no_calendar",
      detail: "no events file — run `npm run refresh:calendar`",
    };
  }
  if (isStale(loaded)) {
    return {
      status: "unknown_calendar_stale",
      detail: `last refresh ${new Date(loaded.fetched_at).toISOString()} — run refresh`,
    };
  }

  const blackouts = getActiveBlackouts(loaded.events, now, windowMin);
  if (blackouts.length > 0) {
    const e = blackouts[0];
    const minutes = Math.round((new Date(e.time_utc).getTime() - now.getTime()) / 60000);
    const direction = minutes >= 0 ? `+${minutes}m` : `${minutes}m`;
    return {
      status: "fail",
      detail: `blackout: ${e.event} (${direction})`,
    };
  }

  const next = getNextEvent(loaded.events, now);
  if (!next) {
    return { status: "pass", detail: "no upcoming events in feed" };
  }

  const hoursUntil = next.minutes_until / 60;
  if (hoursUntil < 4) {
    return {
      status: "pass",
      detail: `next: ${next.event.event} in ${next.minutes_until}m`,
    };
  }
  return {
    status: "pass",
    detail: `next: ${next.event.event} in ${Math.round(hoursUntil)}h`,
  };
}
