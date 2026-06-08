#!/usr/bin/env node
/**
 * sniper_backtest.mjs — answer the question:
 *
 *   On historical 0DTE setups for SPY/QQQ/IWM, does firing on a mid-window
 *   5m close ("sniper" tier) produce better underlying-R outcomes than
 *   waiting for the 15m close ("baseline")?
 *
 * What this answers:
 *   - For each historical day, does the SNIPER fire earlier than the 15m?
 *   - When sniper fires, does the underlying reach T1 before stop more or
 *     less often than the 15m fire on the same day?
 *   - What's the false-positive rate (sniper fires, then 15m close doesn't
 *     confirm the breakout)?
 *
 * What this does NOT answer:
 *   - Option premium P&L. We measure underlying-R, not option-R. That's
 *     the same caveat already on the roadmap as "Simulator upgrade:
 *     historical option premiums." If sniper underlying-R is materially
 *     better, the timing edge is real; option-fidelity adjustment can
 *     come later.
 *
 * Assumptions for fairness:
 *   - Both 15m and sniper use the SAME entry threshold (ORB high/low)
 *   - Both use the SAME stop (entry ∓ 1×ATR15) and T1 (entry ± 0.5×ATR15)
 *   - The only difference is WHEN they fire
 *   - Fill modeled as next 5m bar's OPEN after the signal close
 *   - Same-bar T1+stop ambiguity: treat as stop-first (per existing simulator)
 *   - Cap at 14:00 ET (matches live system's time stop)
 *
 * Sniper conditions (mirrors data-gated roadmap spec):
 *   - 5m close inside an unfilled 15m window (i.e., NOT at the 15m boundary
 *     since that's just the 15m fire by another name)
 *   - 5m close has crossed the ORB entry threshold in the candidate direction
 *   - Parent 15m bar's RUNNING close (synthesized from 5m bars so far in
 *     the window) also past the entry threshold — structural-alignment gate
 *   - rVol filter SKIPPED in this first-cut backtest (would shrink sample
 *     size; can layer in once timing answer is clear)
 *
 * Usage:
 *   node scripts/sniper_backtest.mjs                # default 30 days
 *   node scripts/sniper_backtest.mjs --days 60     # custom window
 *   node scripts/sniper_backtest.mjs --tickers SPY # single ticker
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IBApi, EventName, SecType } from '@stoqey/ib';
import { IBKR_CONFIG, isInfoCode } from '../ibkr_config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const JOURNAL_DIR = path.join(REPO_ROOT, 'journal');

const CLIENT_ID = 55; // outside watcher (50-52), persist (53), dashboard (48) ranges

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return args[i + 1];
}
const DAYS = Number(getArg('days', '30'));
const TICKERS = (getArg('tickers', 'SPY,QQQ,IWM')).split(',').map(s => s.trim());

if (Number.isNaN(DAYS) || DAYS < 5 || DAYS > 90) {
  console.error('--days must be 5..90');
  process.exit(1);
}

// ─── Time helpers (ET-aware) ─────────────────────────────────────────────────
function etParts(epochSec) {
  // Returns { date: 'YYYY-MM-DD', hhmm: 'HH:MM', minutesFromOpen: number }
  const d = new Date(epochSec * 1000);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
  // Intl can return hour='24' for midnight in some envs — normalize
  const hh = parts.hour === '24' ? '00' : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${hh}:${parts.minute}`,
    h: Number(hh),
    m: Number(parts.minute),
    minutesFromMidnight: Number(hh) * 60 + Number(parts.minute),
  };
}

function isRTH(epochSec) {
  // RTH = 09:30 ET → 16:00 ET, weekdays only
  const ep = etParts(epochSec);
  const mins = ep.minutesFromMidnight;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

function isWithinTradeWindow(epochSec) {
  // 09:45 ET (after ORB completes) → 14:00 ET (time stop) — when fires can occur
  const mins = etParts(epochSec).minutesFromMidnight;
  return mins >= 9 * 60 + 45 && mins < 14 * 60;
}

function trueRange(prev, cur) {
  return Math.max(
    cur.high - cur.low,
    Math.abs(cur.high - prev.close),
    Math.abs(cur.low - prev.close),
  );
}

function computeATR(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const sub = bars.slice(-period - 1);
  const trs = [];
  for (let i = 1; i < sub.length; i++) trs.push(trueRange(sub[i - 1], sub[i]));
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// ─── IBKR fetch ──────────────────────────────────────────────────────────────
async function fetchBars(ib, ticker, durationStr, barSize) {
  const contract = { symbol: ticker, secType: SecType.STK, exchange: 'SMART', currency: 'USD' };
  return new Promise((resolve, reject) => {
    const reqId = Math.floor(Math.random() * 1e6) + 9000;
    const bars = [];
    const onData = (id, time, open, high, low, close, volume) => {
      if (id !== reqId) return;
      if (typeof time === 'string' && time.startsWith('finished')) {
        ib.off(EventName.historicalData, onData);
        resolve(bars);
        return;
      }
      bars.push({ time: Number(time), open, high, low, close, volume });
    };
    ib.on(EventName.historicalData, onData);
    // formatDate=2 → epoch seconds (Number)
    ib.reqHistoricalData(reqId, contract, '', durationStr, barSize, 'TRADES', 1, 2, false);
    setTimeout(() => {
      ib.off(EventName.historicalData, onData);
      reject(new Error(`historical bars timeout for ${ticker} ${barSize} (${durationStr})`));
    }, 60_000);
  });
}

// ─── Day grouping ────────────────────────────────────────────────────────────
function groupByDay(bars) {
  // Returns Map<'YYYY-MM-DD', bars[]> sorted within each day
  const out = new Map();
  for (const b of bars) {
    const ep = etParts(b.time);
    const key = ep.date;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(b);
  }
  for (const arr of out.values()) arr.sort((a, b) => a.time - b.time);
  return out;
}

// ─── Backtest core: per (ticker, day, direction) ────────────────────────────
function findORB(day15m) {
  // ORB = the 15m bar that opens at 09:30 ET. Returns {high, low, time, idx} or null.
  for (let i = 0; i < day15m.length; i++) {
    const ep = etParts(day15m[i].time);
    if (ep.hhmm === '09:30') return { high: day15m[i].high, low: day15m[i].low, time: day15m[i].time, idx: i };
  }
  return null;
}

function find15mFire(day15m, orb, direction, atr15) {
  // Walk 15m bars starting from the bar opening at 09:45 (the FIRST bar that
  // can confirm a breakout — the 09:30 bar IS the ORB).
  // Returns { fireBar, fireTime, entry, stop, T1 } or null if no fire in window.
  const isCalls = direction === 'CALLS';
  const entry = isCalls ? orb.high : orb.low;
  const stop = isCalls ? entry - 1.0 * atr15 : entry + 1.0 * atr15;
  const T1 = isCalls ? entry + 0.5 * atr15 : entry - 0.5 * atr15;

  for (let i = orb.idx + 1; i < day15m.length; i++) {
    const bar = day15m[i];
    if (!isWithinTradeWindow(bar.time)) continue;
    const ep = etParts(bar.time);
    // Bar at HH:45 closes at HH:00. We fire on the CLOSE, so we need bar's
    // open time + 15min to be ≤ 14:00 ET (within window when it closes).
    if (ep.minutesFromMidnight + 15 > 14 * 60) break;
    const crossed = isCalls ? bar.close > entry : bar.close < entry;
    if (crossed) {
      return {
        fireBar: bar,
        fireTime: bar.time + 15 * 60, // close time
        fireET: etParts(bar.time + 15 * 60).hhmm,
        entry, stop, T1,
      };
    }
  }
  return null;
}

function findSniperFire(day5m, orb, direction, atr15) {
  // Walk 5m bars starting from the first 5m bar AFTER the ORB completes
  // (i.e., bar opening at 09:45). Sniper fires on a 5m close that:
  //   1. Is NOT at a 15m boundary (would equal a 15m fire)
  //   2. Has crossed the ORB entry threshold in the candidate direction
  //   3. The parent 15m bar's RUNNING close (last 5m close in the window
  //      that started at the most recent 15m boundary ≤ this bar) is also
  //      past the entry threshold — structural alignment gate
  //
  // The 15m boundary check: a 5m bar opens at HH:MM where MM ∈ {00, 15, 30, 45}
  // marks the START of a new 15m window. The bar that CLOSES at a 15m boundary
  // opens at HH:(00-5)=HH:55 / HH:10 / HH:25 / HH:40 — i.e., bar.open_minutes %
  // 15 == 10. We exclude these (their close = the 15m close already).
  const isCalls = direction === 'CALLS';
  const entry = isCalls ? orb.high : orb.low;
  const stop = isCalls ? entry - 1.0 * atr15 : entry + 1.0 * atr15;
  const T1 = isCalls ? entry + 0.5 * atr15 : entry - 0.5 * atr15;

  for (let i = 0; i < day5m.length; i++) {
    const bar = day5m[i];
    if (!isWithinTradeWindow(bar.time)) continue;
    const ep = etParts(bar.time);
    // Cap: bar must close ≤ 14:00 ET (open + 5min)
    if (ep.minutesFromMidnight + 5 > 14 * 60) break;
    // Skip ORB itself and bars before 09:45
    if (ep.minutesFromMidnight < 9 * 60 + 45) continue;
    // Skip bars that close ON a 15m boundary (those = 15m close events)
    const closeMinutes = ep.minutesFromMidnight + 5;
    if (closeMinutes % 15 === 0) continue;

    const crossed = isCalls ? bar.close > entry : bar.close < entry;
    if (!crossed) continue;

    // Structural-alignment gate: parent 15m bar's running close must also
    // be past entry. The parent window starts at the most recent 15m
    // boundary ≤ this bar's open. Synthesize the running close = this 5m
    // bar's close (the most recent 5m close in the window).
    // Simplified: the SAME bar's close is the parent's running close at
    // this moment. So this gate is implicitly satisfied by the `crossed`
    // check above. Add a STRICTER gate: the bar's CLOSE (not just touch)
    // must clear entry by at least 1 tick — avoid boundary kissing.
    // For simplicity, leave as-is. This is the bar-close-pierce condition,
    // mirroring how validateTriggerA works on 15m closes.

    return {
      fireBar: bar,
      fireTime: bar.time + 5 * 60, // close time
      fireET: etParts(bar.time + 5 * 60).hhmm,
      entry, stop, T1,
    };
  }
  return null;
}

function simulateOutcome(day5m, fire, direction) {
  // From the fire's CLOSE time, model fill at the OPEN of the next 5m bar.
  // Then walk subsequent 5m bars: check if T1 or stop hits first.
  // Cap at 14:00 ET → OPEN if neither hits.
  const isCalls = direction === 'CALLS';
  const fillIdx = day5m.findIndex(b => b.time >= fire.fireTime);
  if (fillIdx === -1) return { outcome: 'no-fill', rUnderlying: null };

  const fillBar = day5m[fillIdx];
  const fillPrice = fillBar.open;

  for (let i = fillIdx; i < day5m.length; i++) {
    const bar = day5m[i];
    const ep = etParts(bar.time);
    if (ep.minutesFromMidnight + 5 > 14 * 60) {
      return { outcome: 'open', rUnderlying: 0, fillPrice, lastPrice: bar.close };
    }
    const t1Hit = isCalls ? bar.high >= fire.T1 : bar.low <= fire.T1;
    const stopHit = isCalls ? bar.low <= fire.stop : bar.high >= fire.stop;
    if (stopHit && t1Hit) {
      // Same-bar ambiguity: treat as stop-first (conservative, per existing simulator)
      return { outcome: 'stop', rUnderlying: -1, fillPrice, exitPrice: fire.stop, exitBarET: ep.hhmm };
    }
    if (t1Hit) {
      return { outcome: 't1', rUnderlying: 0.5, fillPrice, exitPrice: fire.T1, exitBarET: ep.hhmm };
    }
    if (stopHit) {
      return { outcome: 'stop', rUnderlying: -1, fillPrice, exitPrice: fire.stop, exitBarET: ep.hhmm };
    }
  }
  // Ran out of bars without hitting either
  const lastBar = day5m[day5m.length - 1];
  return { outcome: 'open', rUnderlying: 0, fillPrice, lastPrice: lastBar?.close ?? null };
}

// ─── Per-day analysis ────────────────────────────────────────────────────────
function analyzeDay({ ticker, date, day15m, day5m, prior15m }) {
  if (day15m.length < 5 || day5m.length < 30) return { skipped: 'insufficient bars' };

  const orb = findORB(day15m);
  if (!orb) return { skipped: 'no ORB bar (no 09:30 15m bar)' };

  // ATR15 from PRIOR day's 15m bars (no look-ahead)
  const atr15 = computeATR(prior15m, 14);
  if (atr15 == null || atr15 <= 0) return { skipped: 'no ATR15 (prior day insufficient)' };

  const results = { ticker, date, orb: { high: orb.high, low: orb.low }, atr15: round(atr15) };

  for (const direction of ['CALLS', 'PUTS']) {
    const fire15m = find15mFire(day15m, orb, direction, atr15);
    const fireSniper = findSniperFire(day5m, orb, direction, atr15);

    const out15m = fire15m ? simulateOutcome(day5m, fire15m, direction) : null;
    const outSniper = fireSniper ? simulateOutcome(day5m, fireSniper, direction) : null;

    // Time delta = how many minutes earlier did sniper fire?
    const minutesEarlier =
      fire15m && fireSniper ? Math.round((fire15m.fireTime - fireSniper.fireTime) / 60) : null;

    results[direction] = {
      fire15m: fire15m ? { fireET: fire15m.fireET, entry: round(fire15m.entry), stop: round(fire15m.stop), T1: round(fire15m.T1) } : null,
      fireSniper: fireSniper ? { fireET: fireSniper.fireET, entry: round(fireSniper.entry), stop: round(fireSniper.stop), T1: round(fireSniper.T1) } : null,
      out15m: out15m ? { outcome: out15m.outcome, r: out15m.rUnderlying, fillPrice: round(out15m.fillPrice), exitET: out15m.exitBarET ?? null } : null,
      outSniper: outSniper ? { outcome: outSniper.outcome, r: outSniper.rUnderlying, fillPrice: round(outSniper.fillPrice), exitET: outSniper.exitBarET ?? null } : null,
      minutesEarlier,
      sniperFalsePositive: fireSniper && !fire15m,        // sniper fired, 15m never confirmed
      sniperCaughtEarly: fireSniper && fire15m && minutesEarlier > 0,
    };
  }

  return results;
}

function round(x, decimals = 2) {
  if (x == null) return null;
  return Math.round(x * 10 ** decimals) / 10 ** decimals;
}

// ─── Aggregation ─────────────────────────────────────────────────────────────
function aggregate(allResults) {
  const summary = {};
  for (const ticker of TICKERS) {
    const tickerResults = allResults.filter(r => r.ticker === ticker && !r.skipped);
    summary[ticker] = computeStats(tickerResults);
  }
  summary.OVERALL = computeStats(allResults.filter(r => !r.skipped));
  return summary;
}

function computeStats(results) {
  const stats = {
    days: results.length,
    CALLS: { fire15m_count: 0, fireSniper_count: 0, sumR_15m: 0, sumR_sniper: 0, wins_15m: 0, wins_sniper: 0, losses_15m: 0, losses_sniper: 0, opens_15m: 0, opens_sniper: 0, sniperFP: 0, sniperEarly: 0, avgMinutesEarlier: 0 },
    PUTS:  { fire15m_count: 0, fireSniper_count: 0, sumR_15m: 0, sumR_sniper: 0, wins_15m: 0, wins_sniper: 0, losses_15m: 0, losses_sniper: 0, opens_15m: 0, opens_sniper: 0, sniperFP: 0, sniperEarly: 0, avgMinutesEarlier: 0 },
  };

  const totalEarlierMins = { CALLS: [], PUTS: [] };

  for (const r of results) {
    for (const dir of ['CALLS', 'PUTS']) {
      const d = r[dir];
      if (!d) continue;
      const s = stats[dir];
      if (d.fire15m) {
        s.fire15m_count++;
        if (d.out15m) {
          s.sumR_15m += d.out15m.r;
          if (d.out15m.outcome === 't1') s.wins_15m++;
          else if (d.out15m.outcome === 'stop') s.losses_15m++;
          else s.opens_15m++;
        }
      }
      if (d.fireSniper) {
        s.fireSniper_count++;
        if (d.outSniper) {
          s.sumR_sniper += d.outSniper.r;
          if (d.outSniper.outcome === 't1') s.wins_sniper++;
          else if (d.outSniper.outcome === 'stop') s.losses_sniper++;
          else s.opens_sniper++;
        }
      }
      if (d.sniperFalsePositive) s.sniperFP++;
      if (d.sniperCaughtEarly) s.sniperEarly++;
      if (d.minutesEarlier != null && d.minutesEarlier > 0) totalEarlierMins[dir].push(d.minutesEarlier);
    }
  }

  for (const dir of ['CALLS', 'PUTS']) {
    const arr = totalEarlierMins[dir];
    stats[dir].avgMinutesEarlier = arr.length ? round(arr.reduce((a, b) => a + b, 0) / arr.length, 1) : null;
    stats[dir].sumR_15m = round(stats[dir].sumR_15m, 2);
    stats[dir].sumR_sniper = round(stats[dir].sumR_sniper, 2);
    stats[dir].avgR_15m = stats[dir].fire15m_count ? round(stats[dir].sumR_15m / stats[dir].fire15m_count, 3) : null;
    stats[dir].avgR_sniper = stats[dir].fireSniper_count ? round(stats[dir].sumR_sniper / stats[dir].fireSniper_count, 3) : null;
  }

  return stats;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n━━━ sniper_backtest — ${DAYS} days, tickers ${TICKERS.join('/')} ━━━\n`);

  const ib = new IBApi({ host: IBKR_CONFIG.host, port: IBKR_CONFIG.port, clientId: CLIENT_ID });
  ib.on(EventName.error, (err, code, reqId) => {
    if (isInfoCode?.(code)) return;
    if (code === 200 || code === 354) return;
    console.log(`   ⚠ IBKR err code=${code} reqId=${reqId} ${err?.message || err}`);
  });

  await new Promise((resolve, reject) => {
    const onConn = () => { ib.off(EventName.connected, onConn); resolve(); };
    ib.on(EventName.connected, onConn);
    ib.connect();
    setTimeout(() => reject(new Error('IBKR connect timeout (10s)')), 10000);
  });
  console.log(`✓ connected (clientId=${CLIENT_ID})\n`);

  // Fetch +5 calendar days for ATR warmup
  const fetchDays = DAYS + 5;
  const allBars = {};
  for (const ticker of TICKERS) {
    console.log(`Fetching ${ticker}: ${fetchDays}D × 15m and 5m...`);
    const t0 = Date.now();
    try {
      const [b15, b5] = await Promise.all([
        fetchBars(ib, ticker, `${fetchDays} D`, '15 mins'),
        fetchBars(ib, ticker, `${fetchDays} D`, '5 mins'),
      ]);
      allBars[ticker] = { b15, b5 };
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ✓ ${b15.length} × 15m, ${b5.length} × 5m (${dt}s)`);
    } catch (e) {
      console.log(`  ✗ ${ticker}: ${e.message}`);
      allBars[ticker] = null;
    }
  }
  ib.disconnect();
  console.log();

  // Per-ticker per-day analysis
  const allResults = [];
  for (const ticker of TICKERS) {
    if (!allBars[ticker]) continue;
    const { b15, b5 } = allBars[ticker];
    // RTH-only filter (drops pre/post)
    const rth15 = b15.filter(b => isRTH(b.time));
    const rth5  = b5.filter(b => isRTH(b.time));
    const days15 = groupByDay(rth15);
    const days5  = groupByDay(rth5);
    const allRTH15 = rth15.slice().sort((a, b) => a.time - b.time);

    const sortedDates = [...days15.keys()].sort();
    // Skip the first (no prior day for ATR warmup) and any day with missing pieces
    for (let i = 1; i < sortedDates.length; i++) {
      const date = sortedDates[i];
      const prevDate = sortedDates[i - 1];
      const day15m = days15.get(date) ?? [];
      const day5m  = days5.get(date) ?? [];
      // For ATR15 warmup, use ALL 15m bars in the prior day
      const prior15m = days15.get(prevDate) ?? [];
      const result = analyzeDay({ ticker, date, day15m, day5m, prior15m });
      allResults.push(result);
    }
  }

  const summary = aggregate(allResults);

  // Output
  const today = new Date().toISOString().slice(0, 10);
  const outPath = path.join(JOURNAL_DIR, `sniper-backtest-${today}.json`);
  if (!fs.existsSync(JOURNAL_DIR)) fs.mkdirSync(JOURNAL_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    runAt: new Date().toISOString(),
    days: DAYS,
    tickers: TICKERS,
    summary,
    perDay: allResults,
  }, null, 2));
  console.log(`Wrote: ${path.relative(REPO_ROOT, outPath)}\n`);

  // Console summary
  printSummary(summary);
}

function printSummary(summary) {
  console.log('━━━ Summary ━━━\n');
  for (const ticker of [...TICKERS, 'OVERALL']) {
    const s = summary[ticker];
    if (!s) continue;
    console.log(`▸ ${ticker} — ${s.days} days analyzed`);
    for (const dir of ['CALLS', 'PUTS']) {
      const d = s[dir];
      const wr15m = d.fire15m_count ? (d.wins_15m / d.fire15m_count * 100).toFixed(0) : '—';
      const wrSniper = d.fireSniper_count ? (d.wins_sniper / d.fireSniper_count * 100).toFixed(0) : '—';
      console.log(`  ${dir.padEnd(5)} | 15m: ${String(d.fire15m_count).padStart(3)} fires, ${String(d.wins_15m).padStart(2)}W/${String(d.losses_15m).padStart(2)}L/${String(d.opens_15m).padStart(2)}O = ${String(d.sumR_15m).padStart(6)}R (avg ${d.avgR_15m ?? '—'}, win% ${wr15m})`);
      console.log(`        | snp: ${String(d.fireSniper_count).padStart(3)} fires, ${String(d.wins_sniper).padStart(2)}W/${String(d.losses_sniper).padStart(2)}L/${String(d.opens_sniper).padStart(2)}O = ${String(d.sumR_sniper).padStart(6)}R (avg ${d.avgR_sniper ?? '—'}, win% ${wrSniper})`);
      console.log(`        | sniper FP (no 15m confirm): ${d.sniperFP},  caught earlier: ${d.sniperEarly},  avg min earlier: ${d.avgMinutesEarlier ?? '—'}`);
    }
    console.log();
  }
  console.log('R-multiple convention: T1 hit = +0.5R, stop hit = -1.0R, open at 14:00 = 0R');
  console.log('Caveat: measures UNDERLYING outcome only. Option-premium P&L will differ.');
}

main().catch(e => {
  console.error(`\n✗ backtest failed: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
