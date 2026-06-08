#!/usr/bin/env node
/**
 * refresh_calendar.mjs — pull this week's economic events from ForexFactory
 * (via the public Faireconomy mirror) and write to
 * `asia/state/policy_events.json`.
 *
 * Filters for China (CNY) + Hong Kong (HKD), Medium+ impact only. Skips Low.
 *
 * Run this once a day (or before pre-market routine). The data covers a
 * rolling week, so daily refresh keeps it fresh.
 *
 * Usage:
 *   npm run refresh:calendar
 *   node asia/scripts/refresh_calendar.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASIA_ROOT = path.resolve(__dirname, "..");
const STATE_FILE = path.join(ASIA_ROOT, "state", "policy_events.json");

const SOURCE_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

// FF country code → readable label (for our event format)
const COUNTRY_MAP = {
  CNY: "China",
  HKD: "Hong Kong",
};

// FF impact label → our numeric importance (1=low, 2=med, 3=high)
const IMPACT_MAP = {
  Low: 1,
  Medium: 2,
  High: 3,
};

async function fetchCalendar() {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`Calendar fetch failed: HTTP ${res.status}`);
  return res.json();
}

function isPolicyRelevant(ffEvent) {
  const country = ffEvent.country;
  if (!country || !COUNTRY_MAP[country]) return false;

  const impact = ffEvent.impact;
  if (!impact || IMPACT_MAP[impact] < 2) return false; // skip Low

  return true;
}

function toOurFormat(ffEvent) {
  return {
    // ForexFactory dates are ISO with offset (ET). new Date() parses
    // correctly, then toISOString() gives us UTC.
    time_utc: new Date(ffEvent.date).toISOString(),
    country: COUNTRY_MAP[ffEvent.country] ?? ffEvent.country,
    event: ffEvent.title,
    source: "forexfactory",
    importance: IMPACT_MAP[ffEvent.impact] ?? 1,
    category: ffEvent.title, // FF doesn't have a separate category — use title
    forecast: ffEvent.forecast ?? null,
    previous: ffEvent.previous ?? null,
  };
}

async function main() {
  console.log("[refresh-calendar] Fetching ForexFactory weekly calendar…");
  const all = await fetchCalendar();
  console.log(`[refresh-calendar] Got ${all.length} total events`);

  const relevant = all.filter(isPolicyRelevant).map(toOurFormat);
  // Sort by time
  relevant.sort((a, b) => new Date(a.time_utc) - new Date(b.time_utc));

  const payload = {
    fetched_at: new Date().toISOString(),
    source: "forexfactory (faireconomy mirror)",
    countries: ["China", "Hong Kong"],
    min_importance: 2,
    events: relevant,
  };

  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");

  console.log(`[refresh-calendar] Wrote ${relevant.length} China/HK events to:`);
  console.log(`  ${STATE_FILE}`);
  if (relevant.length > 0) {
    console.log("[refresh-calendar] First 3:");
    for (const e of relevant.slice(0, 3)) {
      console.log(`  - ${e.time_utc}  ${e.country}  ${e.event}  (importance=${e.importance})`);
    }
  } else {
    console.log("[refresh-calendar] No China/HK Medium+ events this week.");
  }
}

main().catch((err) => {
  console.error("[refresh-calendar] Fatal:", err);
  process.exit(1);
});
