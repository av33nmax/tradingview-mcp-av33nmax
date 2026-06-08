#!/usr/bin/env node
/**
 * persist_session.mjs — end-of-day persistence for the May 12 sniper agent.
 *
 * The remote analysis agent (routine trig_0151kJmFNu3DH5NRTugxV8fz scheduled
 * for 2026-05-12T01:00:00Z) clones the GitHub repo and reads journal/ files.
 * It cannot access local TWS or in-memory dashboard state — so each session's
 * data must be written to disk and committed.
 *
 * Files produced (in journal/, at repo root):
 *
 *   executions-YYYY-MM-DD.json      Day's IBKR fills (from dashboard endpoint)
 *   watcher-checks-YYYY-MM-DD.json  Per-ticker check markers (consolidated
 *                                   from journal/watcher-checks-raw/*.jsonl
 *                                   that trade_window.mjs writes as it runs)
 *   bars-YYYY-MM-DD.json            15m + 5m OHLCV for SPY/QQQ/IWM, RTH
 *   traded_history/YYYY-MM-DD.json  Snapshot of traded_today.json
 *
 * Usage:
 *   node scripts/persist_session.mjs                  # today (ET date)
 *   node scripts/persist_session.mjs 2026-04-28       # specific date
 *
 * After running, the script prints the git commands to commit + push.
 *
 * Safe to re-run for the same date (overwrites consolidated outputs).
 * Idempotent — calling twice in a row produces the same files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IBApi, EventName, SecType } from '@stoqey/ib';
import { IBKR_CONFIG, CLIENT_IDS, isInfoCode } from '../ibkr_config.mjs';

// ─── Paths ───────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const JOURNAL_DIR = path.join(REPO_ROOT, 'journal');
const CHECKS_RAW_DIR = path.join(JOURNAL_DIR, 'watcher-checks-raw');
const EXECS_RAW_DIR = path.join(JOURNAL_DIR, 'executions-raw');
const TRADED_HISTORY_DIR = path.join(JOURNAL_DIR, 'traded_history');
const TRADED_TODAY_FILE = path.join(REPO_ROOT, 'traded_today.json');

const TICKERS = ['SPY', 'QQQ', 'IWM', 'AAPL', 'NVDA', 'AMZN'];

// Reserve a unique clientId for this script. Watchers use 50/51/52,
// dashboard uses 48, so 53 is free.
const CLIENT_ID = 53;
const DASHBOARD_BASE = process.env.DASHBOARD_BASE || 'http://localhost:3000';

// ─── Date helpers ────────────────────────────────────────────────────────────
function todayET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function isValidISODate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// ─── Step 1: executions ──────────────────────────────────────────────────────
//
// Two sources, merged by execId:
//   (a) JSONL written by the watcher's execDetails listener as fills happened
//       — this is the authoritative source, captures every fill in real time,
//       and survives TWS being down / IBKR's 18:00 ET trading-day rollover.
//   (b) Live IBKR via the dashboard's /api/ibkr/executions endpoint — used
//       to backfill anything the watcher missed (e.g., manual TWS UI orders
//       placed by the user that the watcher's client doesn't see). Best
//       effort only: failure here is fine if the JSONL is populated.
async function persistExecutions(date) {
  console.log(`\n[1/5] Consolidating executions for ${date}...`);
  const byId = new Map();

  // (a) JSONL files (watcher-emitted, rollover-proof)
  let jsonlCount = 0;
  for (const ticker of TICKERS) {
    const p = path.join(EXECS_RAW_DIR, `${date}-${ticker}.jsonl`);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        if (r.execId) { byId.set(r.execId, r); jsonlCount++; }
      } catch { /* skip malformed line */ }
    }
  }
  console.log(`      JSONL: ${jsonlCount} fills across ${TICKERS.length} tickers`);

  // (b) Live IBKR via dashboard (best effort, supplemental)
  let liveCount = 0;
  let liveErr = null;
  try {
    const url = `${DASHBOARD_BASE}/api/ibkr/executions`;
    const res = await fetch(url, { cache: 'no-store' });
    const json = await res.json();
    if (json.ok) {
      for (const e of json.executions ?? []) {
        const m = e.time?.match(/^(\d{4})(\d{2})(\d{2})/);
        if (!m) continue;
        if (`${m[1]}-${m[2]}-${m[3]}` !== date) continue;
        // Don't overwrite JSONL records — they have capturedAt and are
        // authoritative. Only add live entries we haven't seen.
        if (!byId.has(e.execId)) byId.set(e.execId, e);
        liveCount++;
      }
      console.log(`      Live IBKR: ${liveCount} fills on ${date}`);
    } else {
      liveErr = json.error;
      console.log(`      Live IBKR unavailable: ${liveErr}`);
    }
  } catch (e) {
    liveErr = e.message;
    console.log(`      Live IBKR unreachable: ${liveErr} (dashboard down? — JSONL is enough if it's populated)`);
  }

  const executions = [...byId.values()];
  if (executions.length === 0) {
    throw new Error(
      `no executions found for ${date}. JSONL was empty (watcher didn't run, or no fills happened) ` +
      `and live IBKR returned ${liveErr ? 'an error' : '0 results'}. Skipping the daily JSON.`,
    );
  }

  const out = {
    date,
    fetchedAt: new Date().toISOString(),
    count: executions.length,
    sources: { jsonl: jsonlCount, live: liveCount, liveError: liveErr },
    executions,
  };
  const outPath = path.join(JOURNAL_DIR, `executions-${date}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`      → ${path.relative(REPO_ROOT, outPath)} (${executions.length} fills total)`);
  return out;
}

// ─── Step 2: watcher checks (consolidate per-ticker JSONL) ───────────────────
function persistWatcherChecks(date) {
  console.log(`\n[2/5] Consolidating watcher check JSONL for ${date}...`);
  const checks = {};
  let totalLines = 0;

  for (const ticker of TICKERS) {
    const jsonlPath = path.join(CHECKS_RAW_DIR, `${date}-${ticker}.jsonl`);
    if (!fs.existsSync(jsonlPath)) {
      checks[ticker] = [];
      continue;
    }
    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
    const parsed = [];
    for (const line of lines) {
      try { parsed.push(JSON.parse(line)); }
      catch { /* skip malformed line */ }
    }
    checks[ticker] = parsed;
    totalLines += parsed.length;
  }

  const out = {
    date,
    fetchedAt: new Date().toISOString(),
    perTickerCount: Object.fromEntries(TICKERS.map((t) => [t, checks[t].length])),
    checks,
  };
  const outPath = path.join(JOURNAL_DIR, `watcher-checks-${date}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`      → ${path.relative(REPO_ROOT, outPath)} (${totalLines} total checks across ${TICKERS.length} tickers)`);
  return out;
}

// ─── Step 3: bars (15m + 5m for each ticker) ─────────────────────────────────
async function persistBars(date) {
  console.log(`\n[3/5] Fetching 15m + 5m bars from IBKR for ${TICKERS.join('/')}...`);
  const ib = new IBApi({ host: IBKR_CONFIG.host, port: IBKR_CONFIG.port, clientId: CLIENT_ID });

  // Suppress noisy informational error codes during this short-lived script
  ib.on(EventName.error, (err, code, reqId) => {
    const c = code;
    if (isInfoCode?.(c)) return;
    if (c === 200 || c === 354) return;
    console.log(`   ⚠ IBKR error code=${c} reqId=${reqId} ${err?.message || err}`);
  });

  await new Promise((resolve, reject) => {
    const onConn = () => { ib.off(EventName.connected, onConn); resolve(); };
    ib.on(EventName.connected, onConn);
    ib.connect();
    setTimeout(() => reject(new Error('IBKR connection timeout (10s)')), 10000);
  });

  let nextReqId = 9100;
  const reqHist = (contract, duration, barSize) =>
    new Promise((resolve, reject) => {
      const reqId = nextReqId++;
      const bars = [];
      const onData = (id, time, open, high, low, close, volume) => {
        if (id !== reqId) return;
        // String "finished-..." marks end of stream in @stoqey/ib
        if (typeof time === 'string' && time.startsWith('finished')) {
          ib.off(EventName.historicalData, onData);
          resolve(bars);
          return;
        }
        bars.push({ time: Number(time), open, high, low, close, volume });
      };
      ib.on(EventName.historicalData, onData);
      // endDateTime '' = now; durationStr like "1 D"; barSizeSetting like "15 mins"
      // formatDate=2 returns time as Unix epoch seconds (Number-able); formatDate=1
      // returns "yyyyMMdd HH:mm:ss" strings which Number(...) turns into NaN→null,
      // breaking the near-miss simulator (real bug surfaced 2026-04-30).
      ib.reqHistoricalData(reqId, contract, '', duration, barSize, 'TRADES', 1, 2, false);
      setTimeout(() => {
        ib.off(EventName.historicalData, onData);
        reject(new Error(`historical bars timeout for ${contract.symbol} ${barSize}`));
      }, 30000);
    });

  const result = {};
  for (const ticker of TICKERS) {
    const contract = { symbol: ticker, secType: SecType.STK, exchange: 'SMART', currency: 'USD' };
    try {
      const [bars15m, bars5m] = await Promise.all([
        reqHist(contract, '1 D', '15 mins'),
        reqHist(contract, '1 D', '5 mins'),
      ]);
      result[ticker] = { bars15m, bars5m };
      console.log(`      ${ticker}: ${bars15m.length} × 15m, ${bars5m.length} × 5m`);
    } catch (e) {
      console.log(`      ⚠ ${ticker} bars failed: ${e.message}`);
      result[ticker] = { bars15m: [], bars5m: [], error: e.message };
    }
  }

  ib.disconnect();

  const out = {
    date,
    fetchedAt: new Date().toISOString(),
    tickers: result,
  };
  const outPath = path.join(JOURNAL_DIR, `bars-${date}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`      → ${path.relative(REPO_ROOT, outPath)}`);
  return out;
}

// ─── Step 4: near-miss outcomes (simulate would-be trades) ──────────────────
// For each `nearMiss` entry the watcher emitted in step 2's consolidated
// checks, look up the subsequent 5m bars from step 3's output and simulate
// the would-be trade outcome using the system's actual entry/stop/T1 math.
//
// Output is the dataset for empirically retuning numeric gates (rVol
// threshold, time window, future per-ticker calibration). After ~10-20
// sessions, this file answers: "if we'd lowered IWM rVol to 0.7, would
// the extra fires have been profitable?"
//
// Simulation rules:
// - Entry = wouldHaveFired.entry (the system's exact entry price)
// - Walk subsequent 5m bars (from step 3's `bars5m` for this ticker)
// - LONG:  T1 hit when bar.high >= T1; stop hit when bar.low <= stop
// - SHORT: T1 hit when bar.low  <= T1; stop hit when bar.high >= stop
// - Same-bar ambiguity: if both hit in one bar, assume STOP first
//   (worst-case — matches typical pessimistic backtest convention)
// - Cap at 14:00 ET (system's TIME_STOP_ET_HOUR) — open at end-of-window
//   counts as "open" outcome, not win or loss
function simulateNearMissOutcomes(date, checks, bars) {
  console.log(`\n[4/5] Simulating near-miss outcomes...`);
  if (!checks || !checks.checks) {
    console.log(`      (no consolidated checks — skipping)`);
    return null;
  }

  // 14:00 ET cap = end of system's trading window. Stored as bar.time
  // seconds-since-epoch, comparable to bars5m[i].time directly.
  const cap14ET = (() => {
    const [y, m, d] = date.split('-').map(Number);
    // 14:00 ET = 18:00 UTC during DST (EDT, UTC-4); 19:00 UTC otherwise (EST).
    // For Apr-Oct US is in DST. For simplicity, compute as the user's NY-tz
    // 14:00 wall-clock and trust IBKR bar times to be in seconds-since-epoch.
    const utcMs = Date.UTC(y, m - 1, d, 14, 0, 0);  // 14:00 UTC anchor
    // Find ET offset by comparing what 14:00 UTC formats as in NY tz.
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false, hour: '2-digit',
    });
    const etHourAt14UTC = parseInt(fmt.format(new Date(utcMs)), 10);
    const offsetHours = etHourAt14UTC - 14;             // -4 in DST, -5 in EST
    return Math.floor(utcMs / 1000) - offsetHours * 3600;
  })();

  const outcomes = [];
  let totalNearMiss = 0;
  for (const [ticker, tickerChecks] of Object.entries(checks.checks)) {
    const tickerBars = bars?.tickers?.[ticker]?.bars5m ?? [];
    for (const c of tickerChecks) {
      if (!c.nearMiss) continue;
      totalNearMiss++;
      const wf = c.nearMiss.wouldHaveFired;
      if (!wf || wf.entry == null || wf.stop == null || wf.T1 == null) {
        outcomes.push({ ticker, barTime: c.barTime, triggerType: c.triggerType, blockedBy: c.nearMiss.blockedBy, result: 'skipped', reason: 'incomplete wouldHaveFired levels' });
        continue;
      }
      const isLong = wf.direction === 'CALLS';
      // Find first 5m bar AFTER the near-miss bar's close. Watcher's barTime
      // is the bar's CLOSE time in ET (e.g. "11:00" = 10:45-11:00 bar).
      // Convert ET HH:MM to seconds-since-epoch by reusing the cap14ET
      // offset trick (same offset applies to all wall-clock times today).
      const nmCloseTimeSec = (() => {
        const [hh, mm] = c.barTime.split(':').map(Number);
        const [y, m, d] = date.split('-').map(Number);
        const utcMs = Date.UTC(y, m - 1, d, hh, mm, 0);
        const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit' });
        const etHour = parseInt(fmt.format(new Date(utcMs)), 10);
        const offsetHours = etHour - hh;
        return Math.floor(utcMs / 1000) - offsetHours * 3600;
      })();
      const subsequent = tickerBars.filter((b) => b.time >= nmCloseTimeSec && b.time < cap14ET);
      let result = 'open';
      let exitBar = null;
      let exitPrice = null;
      for (const b of subsequent) {
        const stopHit = isLong ? b.low <= wf.stop : b.high >= wf.stop;
        const t1Hit   = isLong ? b.high >= wf.T1  : b.low  <= wf.T1;
        if (stopHit && t1Hit)      { result = 'loss'; exitBar = b.time; exitPrice = wf.stop; break; }   // worst-case
        if (stopHit)               { result = 'loss'; exitBar = b.time; exitPrice = wf.stop; break; }
        if (t1Hit)                 { result = 'win';  exitBar = b.time; exitPrice = wf.T1;   break; }
      }
      const rDistance = Math.abs(wf.entry - wf.stop);
      const rMultiple = result === 'win'  ? Math.abs(wf.T1 - wf.entry) / rDistance
                       : result === 'loss' ? -1
                       : null;
      const holdMinutes = exitBar != null ? Math.round((exitBar - nmCloseTimeSec) / 60) : null;
      outcomes.push({
        ticker, barTime: c.barTime, triggerType: c.triggerType,
        blockedBy: c.nearMiss.blockedBy,
        actualValue: c.nearMiss.actualValue,
        thresholdValue: c.nearMiss.thresholdValue,
        wouldHaveFired: wf,
        result,                 // 'win' | 'loss' | 'open' | 'skipped'
        exitPrice,
        holdMinutes,
        rMultiple,              // +R for win, -1 for loss, null otherwise
      });
    }
  }

  // Tally summary
  const tally = (arr) => ({
    total: arr.length,
    win: arr.filter((o) => o.result === 'win').length,
    loss: arr.filter((o) => o.result === 'loss').length,
    open: arr.filter((o) => o.result === 'open').length,
    netR: arr.reduce((s, o) => s + (o.rMultiple ?? 0), 0),
  });
  const byBlockedBy = {};
  for (const blocker of new Set(outcomes.map((o) => o.blockedBy))) {
    byBlockedBy[blocker] = tally(outcomes.filter((o) => o.blockedBy === blocker));
  }

  const out = {
    date,
    fetchedAt: new Date().toISOString(),
    summary: { total: totalNearMiss, ...tally(outcomes), byBlockedBy },
    outcomes,
  };
  const outPath = path.join(JOURNAL_DIR, `near-miss-outcomes-${date}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`      → ${path.relative(REPO_ROOT, outPath)}`);
  console.log(`      ${totalNearMiss} near-miss(es): ${out.summary.win} would-win, ${out.summary.loss} would-lose, ${out.summary.open} open at 14:00 ET, netR=${out.summary.netR.toFixed(2)}`);
  return out;
}

// ─── Step 5: traded_today snapshot ───────────────────────────────────────────
function persistTradedHistory(date) {
  console.log(`\n[5/5] Snapshotting traded_today.json...`);
  if (!fs.existsSync(TRADED_TODAY_FILE)) {
    console.log(`      (no traded_today.json — skipping)`);
    return null;
  }
  if (!fs.existsSync(TRADED_HISTORY_DIR)) {
    fs.mkdirSync(TRADED_HISTORY_DIR, { recursive: true });
  }
  const raw = JSON.parse(fs.readFileSync(TRADED_TODAY_FILE, 'utf8'));
  // Only snapshot if the date matches — otherwise the user is persisting a
  // stale traded_today from a different day.
  if (raw.date !== date) {
    console.log(`      (traded_today.json is for ${raw.date}, not ${date} — skipping)`);
    return null;
  }
  const outPath = path.join(TRADED_HISTORY_DIR, `${date}.json`);
  fs.writeFileSync(outPath, JSON.stringify(raw, null, 2));
  console.log(`      → ${path.relative(REPO_ROOT, outPath)} (${(raw.trades ?? []).length} trades)`);
  return raw;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const argDate = process.argv[2];
  const date = argDate ?? todayET();
  if (!isValidISODate(date)) {
    console.error(`❌ invalid date: ${date} (expected YYYY-MM-DD)`);
    process.exit(1);
  }

  if (!fs.existsSync(JOURNAL_DIR)) fs.mkdirSync(JOURNAL_DIR, { recursive: true });

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Persist session — ${date} (ET)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Each step runs independently — partial success is fine (e.g. TWS down
  // skips bars/executions but local consolidation + traded_history snapshot
  // still produce useful files).
  const results = { executions: 'skip', checks: 'skip', bars: 'skip', nearMiss: 'skip', traded: 'skip' };
  const errors = [];

  // Capture step 2 + 3 outputs so step 4 (near-miss simulation) can join them.
  let checksOut = null;
  let barsOut = null;

  try { await persistExecutions(date); results.executions = 'ok'; }
  catch (e) { results.executions = 'fail'; errors.push(`executions: ${e.message}`); console.log(`      ⚠ ${e.message}`); }

  try { checksOut = persistWatcherChecks(date); results.checks = 'ok'; }
  catch (e) { results.checks = 'fail'; errors.push(`checks: ${e.message}`); console.log(`      ⚠ ${e.message}`); }

  try { barsOut = await persistBars(date); results.bars = 'ok'; }
  catch (e) { results.bars = 'fail'; errors.push(`bars: ${e.message}`); console.log(`      ⚠ ${e.message}`); }

  try { simulateNearMissOutcomes(date, checksOut, barsOut); results.nearMiss = 'ok'; }
  catch (e) { results.nearMiss = 'fail'; errors.push(`near-miss sim: ${e.message}`); console.log(`      ⚠ ${e.message}`); }

  try { persistTradedHistory(date); results.traded = 'ok'; }
  catch (e) { results.traded = 'fail'; errors.push(`traded: ${e.message}`); console.log(`      ⚠ ${e.message}`); }

  const okCount = Object.values(results).filter((s) => s === 'ok').length;
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Persistence summary: ${okCount}/5 steps succeeded`);
  for (const [step, status] of Object.entries(results)) {
    const icon = status === 'ok' ? '✅' : status === 'fail' ? '❌' : '⏸ ';
    console.log(`  ${icon} ${step}`);
  }
  if (okCount === 0) {
    console.log('\nNo files written. Check that TWS is up and dashboard is running.');
    process.exit(1);
  }
  console.log('');
  console.log('Commit + push to make this visible to the May 12 sniper-analysis');
  console.log('remote agent:');
  console.log('');
  console.log(`     git add journal/`);
  console.log(`     git commit -m "Persist session ${date}"`);
  console.log(`     git push   # only after merging worktree branch to main`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (errors.length) process.exit(2);
}

main().catch((e) => {
  console.error(`\n❌ persist_session crashed: ${e.message}`);
  process.exit(1);
});
