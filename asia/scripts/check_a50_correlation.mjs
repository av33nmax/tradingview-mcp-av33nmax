#!/usr/bin/env node
/**
 * check_a50_correlation.mjs — A50 vs HSI directional agreement check.
 *
 * Runs at ~09:45 SGT (15 min after HK cash open). Compares the first M15
 * bar after 09:30 SGT for HSI and A50.
 *
 * Logic:
 *   - Find each M15 bar's first 15-min candle starting at 09:30 SGT
 *   - Compute direction = sign(close - open) for each
 *   - Pass: both up or both down (agreement)
 *   - Fail: opposite directions (divergence — likely false break, skip session)
 *
 * Writes verdict to `asia/state/a50_correlation.json` keyed by today's
 * date (so stale data is detectable). Stage 5 of `premarket_hsi.mjs` reads
 * this file and surfaces the verdict in the A50 chip on the dashboard.
 *
 * Usage:
 *   npm run check:correlation
 *   node asia/scripts/check_a50_correlation.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findTabBySymbol,
  readBarsAtResolutionFromTab,
} from "../lib/multi_tab.mjs";

process.stdout.on("error", (e) => { if (e.code !== "EPIPE") throw e; });
process.stderr.on("error", (e) => { if (e.code !== "EPIPE") throw e; });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASIA_ROOT = path.resolve(__dirname, "..");
const STATE_FILE = path.join(ASIA_ROOT, "state", "a50_correlation.json");

const SGT_OFFSET_HOURS = 8;
const HK_OPEN_HOUR_SGT = 9;
const HK_OPEN_MIN_SGT = 30;

/**
 * Compute today's 09:30 SGT as a unix timestamp (seconds).
 */
function todayHKOpenTs() {
  const now = new Date();
  const utcOpen = new Date(now);
  utcOpen.setUTCHours(HK_OPEN_HOUR_SGT - SGT_OFFSET_HOURS, HK_OPEN_MIN_SGT, 0, 0);
  return Math.floor(utcOpen.getTime() / 1000);
}

/**
 * Today's date in SGT as YYYY-MM-DD.
 */
function todaySGTDate() {
  const now = new Date();
  const sgt = new Date(now.getTime() + SGT_OFFSET_HOURS * 60 * 60 * 1000);
  return sgt.toISOString().slice(0, 10);
}

/**
 * Find the first M15 bar at or after the target timestamp.
 */
function findOpeningBar(bars, targetTs) {
  return bars.find((b) => b.time >= targetTs) ?? null;
}

/**
 * Pull the opening bar's direction for a given symbol.
 * Returns { ok: true, bar, direction } or { ok: false, reason }.
 */
async function pullOpeningBar(symbolPattern) {
  const found = await findTabBySymbol(symbolPattern);
  if (!found) {
    return { ok: false, reason: `no tab for ${symbolPattern}` };
  }
  const { bars } = await readBarsAtResolutionFromTab(found.tab.id, "15", 30, {
    chartIndex: found.chartIndex,
  });
  if (!Array.isArray(bars) || bars.length === 0) {
    return { ok: false, reason: `no bars for ${symbolPattern}`, symbol: found.actualSymbol };
  }
  const openTs = todayHKOpenTs();
  const bar = findOpeningBar(bars, openTs);
  if (!bar) {
    return {
      ok: false,
      reason: `no M15 bar at or after 09:30 SGT yet (last bar: ${new Date(
        bars[bars.length - 1].time * 1000
      ).toISOString()})`,
      symbol: found.actualSymbol,
    };
  }
  const delta = bar.close - bar.open;
  const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  return {
    ok: true,
    symbol: found.actualSymbol,
    bar,
    direction,
    delta: Number(delta.toFixed(4)),
  };
}

async function main() {
  console.log("[a50-check] Comparing first M15 bar after 09:30 SGT for HSI + A50…");

  // Sanity: not before 09:45 SGT (first M15 bar isn't complete)
  const now = new Date();
  const sgt = new Date(now.getTime() + SGT_OFFSET_HOURS * 60 * 60 * 1000);
  const sgtMin = sgt.getUTCHours() * 60 + sgt.getUTCMinutes();
  if (sgtMin < 9 * 60 + 45) {
    console.log(
      `[a50-check] ⚠ Current SGT time is ${sgt.getUTCHours()}:${String(sgt.getUTCMinutes()).padStart(2, "0")} — running before 09:45 means the first M15 bar may not be complete yet.`
    );
  }

  const [hsi, a50] = await Promise.all([
    pullOpeningBar("HSI"),
    pullOpeningBar("CN1!"), // A50 = SGX:CN1!
  ]);

  let status = "fail";
  let detail;

  if (!hsi.ok || !a50.ok) {
    status = "unknown";
    detail = `missing data — HSI: ${hsi.ok ? "ok" : hsi.reason}; A50: ${a50.ok ? "ok" : a50.reason}`;
    console.log(`[a50-check] ${detail}`);
  } else {
    const agreed = hsi.direction === a50.direction && hsi.direction !== "flat";
    status = agreed ? "pass" : "fail";
    detail = agreed
      ? `agreed: both ${hsi.direction}`
      : `diverged: HSI ${hsi.direction}, A50 ${a50.direction}`;
    console.log(`[a50-check] HSI:  ${hsi.symbol}  open=${hsi.bar.open}  close=${hsi.bar.close}  ${hsi.direction}`);
    console.log(`[a50-check] A50:  ${a50.symbol}  open=${a50.bar.open}  close=${a50.bar.close}  ${a50.direction}`);
    console.log(`[a50-check] Verdict: ${status} — ${detail}`);
  }

  const payload = {
    evaluated_at: new Date().toISOString(),
    today_sgt_date: todaySGTDate(),
    hsi: hsi.ok ? { symbol: hsi.symbol, open: hsi.bar.open, close: hsi.bar.close, direction: hsi.direction, delta: hsi.delta, bar_time: hsi.bar.time } : { error: hsi.reason },
    a50: a50.ok ? { symbol: a50.symbol, open: a50.bar.open, close: a50.bar.close, direction: a50.direction, delta: a50.delta, bar_time: a50.bar.time } : { error: a50.reason },
    status,
    detail,
  };

  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
  console.log(`[a50-check] State: ${STATE_FILE}`);
}

main().catch((err) => {
  console.error("[a50-check] Fatal:", err);
  process.exit(1);
});
