/**
 * multi_timeframe_analysis.js
 * One-shot analysis: ES/NQ futures → SPY/QQQ options setup.
 *
 * For each symbol and each of 15m / 1H / 4H:
 *   a) Supply/Demand zones (impulse moves)
 *   b) Support/Resistance (swing pivots)
 *   c) EMA 9/21/50 + price position
 *   d) VWAP (session anchored) + price position
 *   e) Volume (relative to 20-bar avg)
 *   f) Fib retracement (last major swing)
 *   g) MACD (12/26/9)
 *   h) FVG (3-bar gap) — unfilled gaps nearest to price
 *
 * Then correlates ES→SPY and NQ→QQQ, scores confluence, prints setup.
 *
 * Usage: node multi_timeframe_analysis.js
 */

// EPIPE tolerance — see premarket_setup.mjs header comment. When this script
// is spawned as a child of premarket_setup.mjs (which is itself spawned by
// the dashboard), a chain of pipes carries our stdout. Any link closing
// would propagate as EPIPE on console.* writes here. Swallow it.
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

import { evaluate, evaluateAsync } from './src/connection.js';
import { pickTarget, buildTargetCandidates, computeEntryConfluence } from './src/target_selector.js';

const SYMBOLS = ['CME_MINI:ES1!', 'CME_MINI:NQ1!', 'CME_MINI:RTY1!', 'BATS:SPY', 'NASDAQ:QQQ', 'BATS:IWM', 'NASDAQ:AAPL', 'NASDAQ:NVDA', 'NASDAQ:AMZN', 'NASDAQ:TSLA', 'NASDAQ:MU', 'NASDAQ:INTC'];
const LABELS = { 'CME_MINI:ES1!': 'ES', 'CME_MINI:NQ1!': 'NQ', 'CME_MINI:RTY1!': 'RTY', 'BATS:SPY': 'SPY', 'NASDAQ:QQQ': 'QQQ', 'BATS:IWM': 'IWM', 'NASDAQ:AAPL': 'AAPL', 'NASDAQ:NVDA': 'NVDA', 'NASDAQ:AMZN': 'AMZN', 'NASDAQ:TSLA': 'TSLA', 'NASDAQ:MU': 'MU', 'NASDAQ:INTC': 'INTC' };
const TIMEFRAMES = [
  { res: '15', label: '15m', barsNeeded: 300 },
  { res: '60', label: '1H',  barsNeeded: 300 },
  { res: '240', label: '4H', barsNeeded: 200 },
];

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

// ─── TV control ───────────────────────────────────────────────────────────────

async function setSymbol(symbol) {
  await evaluateAsync(`
    (function() {
      var chart = ${CHART_API};
      return new Promise(function(resolve) {
        chart.setSymbol('${symbol.replace(/'/g, "\\'")}', {});
        setTimeout(resolve, 600);
      });
    })()
  `);
}

async function setTimeframe(res) {
  await evaluate(`${CHART_API}.setResolution('${res}', {})`);
  await new Promise(r => setTimeout(r, 250));
}

// Poll until the ACTIVE main series matches the requested symbol + resolution
// AND has loaded >= minBars. Replaces blind setTimeout sleeps so we never read
// stale bars (wrong symbol/TF still loading) or a half-loaded series. At the
// open the data feed lags; a fixed 1.5s sleep was reading 0–stale bars, which
// scored everything NEUTRAL and nulled out entry_notes. Returns { ok, n }.
// Snapshot the active series' bar "signature": firstTime:lastTime:lastClose:count.
// Two different symbols (or the same symbol at a different resolution) can't
// share this fingerprint, so it's the ground-truth freshness signal.
async function readSig() {
  const sig = await evaluate(`
    (function() {
      try {
        var bars = ${CHART_API}._chartWidget.model().mainSeries().bars();
        if (!bars || typeof bars.lastIndex !== 'function') return '';
        var li = bars.lastIndex(), fi = bars.firstIndex();
        if (typeof li !== 'number' || typeof fi !== 'number') return '';
        var n = li - fi + 1, lv = bars.valueAt(li), fv = bars.valueAt(fi);
        return (fv ? fv[0] : '') + ':' + (lv ? lv[0] : '') + ':' + (lv ? lv[4] : '') + ':' + n;
      } catch (e) { return ''; }
    })()
  `);
  return sig || '';
}

// Poll until the ACTIVE series is genuinely the requested symbol+resolution with
// >= minBars loaded. chart.symbol() AND symbolInfo() both flip BEFORE bars()
// reloads, so neither alone prevents stale-bar bleed. The decisive gate is the
// bar signature changing from prevSig — bars can't be stale if their fingerprint
// moved. Returns { ok, n, sig }.
async function waitForSeries(symbol, res, minBars = 30, prevSig = null, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  const wantTick = symbol.split(':').pop().toUpperCase();
  let last = { n: 0, sig: '' };
  while (Date.now() < deadline) {
    const st = await evaluate(`
      (function() {
        try {
          var chart = ${CHART_API};
          var ser = chart._chartWidget.model().mainSeries();
          var bars = ser.bars();
          var n = 0, sig = '';
          if (bars && typeof bars.lastIndex === 'function') {
            var li = bars.lastIndex(), fi = bars.firstIndex();
            if (typeof li === 'number' && typeof fi === 'number') {
              n = li - fi + 1;
              var lv = bars.valueAt(li), fv = bars.valueAt(fi);
              sig = (fv ? fv[0] : '') + ':' + (lv ? lv[0] : '') + ':' + (lv ? lv[4] : '') + ':' + n;
            }
          }
          var info = (typeof ser.symbolInfo === 'function') ? ser.symbolInfo() : null;
          var nm = info ? (info.pro_name || info.full_name || info.ticker || info.name || '') : '';
          return { sym: String(nm), res: String(chart.resolution()), n: n, sig: sig };
        } catch (e) { return { err: String(e), n: 0, sig: '' }; }
      })()
    `);
    if (st && !st.err) {
      last = st;
      const resOk = st.res === String(res);
      // Signature-change is the decisive gate: bars can't be stale if their
      // fingerprint moved. symbolInfo/chart.symbol() both lag the bar reload,
      // so they're not required — relying on them caused false timeouts.
      const changed = !prevSig || st.sig !== prevSig;
      if (resOk && changed && st.n >= minBars) return { ok: true, n: st.n, sig: st.sig };
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return { ok: false, n: last.n || 0, sig: last.sig || '' };
}

async function getOhlcv(count) {
  const data = await evaluate(`
    (function() {
      var bars = ${CHART_API}._chartWidget.model().mainSeries().bars();
      if (!bars || typeof bars.lastIndex !== 'function') return null;
      var result = [];
      var end = bars.lastIndex();
      var start = Math.max(bars.firstIndex(), end - ${count} + 1);
      for (var i = start; i <= end; i++) {
        var v = bars.valueAt(i);
        if (v) result.push([v[0], v[1], v[2], v[3], v[4], v[5] || 0]);
      }
      return result;
    })()
  `);
  return (data || []).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
}

async function ensureIndicators(neededNames) {
  // neededNames: array of study display names to add if not present
  const existing = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.name || s.title || ''; })`);
  const added = [];
  for (const name of neededNames) {
    const has = existing.some(e => e.includes(name) || name.includes(e));
    if (!has) {
      try {
        await evaluate(`${CHART_API}.createStudy('${name}', false, false, [])`);
        await new Promise(r => setTimeout(r, 800));
        added.push(name);
      } catch (e) {
        // non-fatal
      }
    }
  }
  return added;
}

// ─── Indicator computations (from OHLCV) ─────────────────────────────────────

function ema(values, period) {
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

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = ema(macdLine, signal);
  const hist = macdLine.map((v, i) => v - signalLine[i]);
  return { macd: macdLine, signal: signalLine, hist };
}

function openingRange(bars, minutes = 15) {
  // Opening Range: high/low of first N minutes of RTH (9:30 ET = 13:30 UTC).
  // For 15m bars, minutes=15 → 1 bar. minutes=30 → 2 bars.
  if (bars.length === 0) return null;
  const last = bars[bars.length - 1];
  const lastDate = new Date(last.t * 1000);
  const y = lastDate.getUTCFullYear(), m = lastDate.getUTCMonth(), d = lastDate.getUTCDate();
  const anchor930 = Date.UTC(y, m, d, 13, 30, 0) / 1000;
  let anchor = anchor930;
  if (last.t < anchor930) anchor = anchor930 - 86400;
  const orEnd = anchor + minutes * 60;
  const orBars = bars.filter(b => b.t >= anchor && b.t < orEnd);
  if (orBars.length === 0) return null;
  const high = Math.max(...orBars.map(b => b.h));
  const low = Math.min(...orBars.map(b => b.l));
  const vol = orBars.reduce((a, b) => a + b.v, 0);
  const price = last.c;
  const mid = (high + low) / 2;
  const range = high - low;
  let state = 'inside';
  if (price > high) state = 'above';
  else if (price < low) state = 'below';
  // Check if broken cleanly (closed above/below)
  const postOR = bars.filter(b => b.t >= orEnd);
  const brokeHigh = postOR.some(b => b.c > high);
  const brokeLow = postOR.some(b => b.c < low);
  return {
    minutes,
    anchor,
    high: round(high),
    low: round(low),
    mid: round(mid),
    range: round(range),
    volume: vol,
    state,
    brokeHigh,
    brokeLow,
    breakoutTarget_up: round(high + range),   // 1x range extension
    breakoutTarget_dn: round(low - range),
    measured_2x_up: round(high + 2 * range),
    measured_2x_dn: round(low - 2 * range),
  };
}

function sessionLevels(bars) {
  // PDH / PDL = previous RTH-session high/low (walks back day-by-day so
  // weekends/holidays don't break us). PMH / PML = today's pre-market window
  // (4:00 → 9:30 ET == 8:00 → 13:30 UTC during EDT). Best computed from 15m
  // bars; coarser timeframes will undercount the pre-market window.
  // Note: same EDT-anchor assumption as openingRange/sessionVWAPAnchored —
  // off by 1h across DST transitions but consistent with the rest of the file.
  if (!bars || bars.length === 0) return null;
  const last = bars[bars.length - 1];
  const lastDate = new Date(last.t * 1000);
  const ly = lastDate.getUTCFullYear(), lm = lastDate.getUTCMonth(), ld = lastDate.getUTCDate();
  const todayRTHStart = Date.UTC(ly, lm, ld, 13, 30, 0) / 1000;     // 9:30 ET
  const todayPMStart  = todayRTHStart - 5.5 * 3600;                  // 4:00 ET
  const RTH_HOURS     = 6.5;                                         // 9:30 → 16:00

  // Today's pre-market window
  const pmBars = bars.filter(b => b.t >= todayPMStart && b.t < todayRTHStart);
  let pmh = null, pml = null;
  if (pmBars.length > 0) {
    pmh = round(Math.max(...pmBars.map(b => b.h)));
    pml = round(Math.min(...pmBars.map(b => b.l)));
  }

  // Previous RTH session: walk back day-by-day until bars are found, cap at 7
  let pdh = null, pdl = null, pdSessionDate = null;
  for (let daysBack = 1; daysBack <= 7; daysBack++) {
    const sessStart = todayRTHStart - daysBack * 86400;
    const sessEnd   = sessStart + RTH_HOURS * 3600;
    const sessBars  = bars.filter(b => b.t >= sessStart && b.t < sessEnd);
    if (sessBars.length > 0) {
      pdh = round(Math.max(...sessBars.map(b => b.h)));
      pdl = round(Math.min(...sessBars.map(b => b.l)));
      pdSessionDate = new Date(sessStart * 1000).toISOString().slice(0, 10);
      break;
    }
  }

  return {
    pdh, pdl, pmh, pml,
    pd_session_date: pdSessionDate,
    pm_bars: pmBars.length,
  };
}

function sessionVWAPAnchored(bars) {
  // Anchor VWAP at the start of the most recent RTH session (9:30 ET = 13:30 UTC).
  // Bar timestamps are in seconds UTC.
  if (bars.length === 0) return { vwap: null, anchor: null };
  // Find last bar's date (ET)
  const last = bars[bars.length - 1];
  const lastDate = new Date(last.t * 1000);
  // Compute today 9:30 ET in UTC seconds
  const y = lastDate.getUTCFullYear(), m = lastDate.getUTCMonth(), d = lastDate.getUTCDate();
  // 9:30 ET = 13:30 UTC (EDT is UTC-4 in summer)
  // April 21, 2026 is EDT (DST). Use 13:30 UTC.
  const anchor930 = Date.UTC(y, m, d, 13, 30, 0) / 1000;
  // If last bar is before 9:30 today, anchor to previous day's 9:30
  let anchor = anchor930;
  if (last.t < anchor930) anchor = anchor930 - 86400;
  // Otherwise look back to find earliest bar >= anchor
  let cumPV = 0, cumV = 0;
  let vwap = null;
  for (const b of bars) {
    if (b.t < anchor) continue;
    const typical = (b.h + b.l + b.c) / 3;
    cumPV += typical * b.v;
    cumV += b.v;
    if (cumV > 0) vwap = cumPV / cumV;
  }
  return { vwap, anchor };
}

function findSwings(bars, left = 3, right = 3) {
  // Fractal pivots: high is pivot if higher than `left` bars before and `right` bars after
  const pivotHighs = [], pivotLows = [];
  for (let i = left; i < bars.length - right; i++) {
    const h = bars[i].h, l = bars[i].l;
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j].h >= h) isHigh = false;
      if (bars[j].l <= l) isLow = false;
    }
    if (isHigh) pivotHighs.push({ i, t: bars[i].t, price: h });
    if (isLow) pivotLows.push({ i, t: bars[i].t, price: l });
  }
  return { pivotHighs, pivotLows };
}

function lastImpulseFib(bars, swings) {
  // Take the two most recent significant pivots of opposite type
  const last = [...swings.pivotHighs, ...swings.pivotLows].sort((a, b) => b.i - a.i);
  if (last.length < 2) return null;
  const p1 = last[0];
  const p2 = last.find(p => (p.i < p1.i) && ((swings.pivotHighs.includes(p1) && swings.pivotLows.includes(p)) || (swings.pivotLows.includes(p1) && swings.pivotHighs.includes(p))));
  if (!p2) return null;
  const hi = Math.max(p1.price, p2.price);
  const lo = Math.min(p1.price, p2.price);
  const range = hi - lo;
  const direction = p1.price > p2.price ? 'up' : 'down';
  return {
    direction,
    hi: round(hi), lo: round(lo),
    fib_382: round(direction === 'up' ? hi - 0.382 * range : lo + 0.382 * range),
    fib_500: round(direction === 'up' ? hi - 0.5   * range : lo + 0.5   * range),
    fib_618: round(direction === 'up' ? hi - 0.618 * range : lo + 0.618 * range),
    fib_786: round(direction === 'up' ? hi - 0.786 * range : lo + 0.786 * range),
  };
}

function findFVGs(bars) {
  // 3-bar FVG: if bars[i-2].high < bars[i].low (bullish gap) or bars[i-2].low > bars[i].high (bearish gap)
  const gaps = [];
  for (let i = 2; i < bars.length; i++) {
    const a = bars[i - 2], c = bars[i];
    if (a.h < c.l) {
      // Bullish FVG: zone between a.high and c.low
      gaps.push({ type: 'bull', low: round(a.h), high: round(c.l), createdAt: c.t, i });
    } else if (a.l > c.h) {
      gaps.push({ type: 'bear', low: round(c.h), high: round(a.l), createdAt: c.t, i });
    }
  }
  // Check which are still unfilled (price hasn't revisited the zone)
  const unfilled = [];
  for (const g of gaps) {
    let filled = false;
    for (let j = g.i + 1; j < bars.length; j++) {
      const b = bars[j];
      if (g.type === 'bull' && b.l <= g.low) { filled = true; break; }
      if (g.type === 'bear' && b.h >= g.high) { filled = true; break; }
    }
    if (!filled) unfilled.push(g);
  }
  return unfilled;
}

function findSupplyDemand(bars, atrLookback = 14) {
  // Simple heuristic: identify 3-bar impulsive moves (strong body, high volume)
  // with a base of tight consolidation just before.
  if (bars.length < atrLookback + 5) return [];
  const atrArr = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    atrArr.push(tr);
  }
  const atr = [];
  for (let i = atrLookback - 1; i < atrArr.length; i++) {
    const slice = atrArr.slice(i - atrLookback + 1, i + 1);
    atr.push(slice.reduce((a, b) => a + b, 0) / atrLookback);
  }
  // Align ATR index to bar index: atr[k] corresponds to bars[k + atrLookback]
  const zones = [];
  for (let i = atrLookback + 2; i < bars.length - 1; i++) {
    const curATR = atr[i - atrLookback];
    if (!curATR) continue;
    const bar = bars[i];
    const body = Math.abs(bar.c - bar.o);
    const range = bar.h - bar.l;
    if (body > 1.5 * curATR && body / range > 0.6) {
      // Impulsive bar. Base = 3 bars before
      const base = bars.slice(i - 3, i);
      const baseHigh = Math.max(...base.map(b => b.h));
      const baseLow = Math.min(...base.map(b => b.l));
      if (bar.c > bar.o) {
        zones.push({ type: 'demand', high: round(baseHigh), low: round(baseLow), createdAt: bar.t });
      } else {
        zones.push({ type: 'supply', high: round(baseHigh), low: round(baseLow), createdAt: bar.t });
      }
    }
  }
  // Keep unmitigated: price since zone creation hasn't closed through the opposite boundary
  const unmitigated = [];
  for (const z of zones) {
    const idx = bars.findIndex(b => b.t === z.createdAt);
    if (idx < 0) continue;
    let mitigated = false;
    for (let j = idx + 1; j < bars.length; j++) {
      const b = bars[j];
      if (z.type === 'demand' && b.c < z.low) { mitigated = true; break; }
      if (z.type === 'supply' && b.c > z.high) { mitigated = true; break; }
    }
    if (!mitigated) unmitigated.push(z);
  }
  return unmitigated;
}

const round = n => Math.round(n * 100) / 100;
// Null-safe variant for target fields that are legitimately absent (e.g. ORB
// extension targets when there is no opening-range breakout). round(null) === 0
// (Math.round(null*100)/100), which silently injected a 0 price into trigger_a
// .T1/.T2 and tripped premarket_setup's price-band validation. Preserve null.
const roundOrNull = n => (n == null || !Number.isFinite(n)) ? null : round(n);

// ─── Analysis per (symbol, timeframe) ─────────────────────────────────────────

function analyzeBars(bars) {
  if (bars.length < 30) return { error: 'Not enough bars' };
  const closes = bars.map(b => b.c);
  const lastBar = bars[bars.length - 1];
  const price = lastBar.c;

  // (c) EMAs
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const emaNow = {
    ema9: round(ema9[ema9.length - 1]),
    ema21: round(ema21[ema21.length - 1]),
    ema50: round(ema50[ema50.length - 1]),
  };
  const emaStack = emaNow.ema9 > emaNow.ema21 && emaNow.ema21 > emaNow.ema50 ? 'bull'
                 : emaNow.ema9 < emaNow.ema21 && emaNow.ema21 < emaNow.ema50 ? 'bear' : 'mixed';
  const priceVsEMA = price > emaNow.ema9 ? 'above9' : price < emaNow.ema21 ? 'below21' : 'mixed';

  // (d) VWAP session anchored
  const { vwap, anchor } = sessionVWAPAnchored(bars);
  const vwapSide = vwap ? (price > vwap ? 'above' : 'below') : 'n/a';
  const vwapDist = vwap ? round(((price - vwap) / vwap) * 100) : null;

  // (e) Volume — last bar vs 20-bar avg
  const recentVol = bars.slice(-20).map(b => b.v);
  const avgVol = recentVol.reduce((a, b) => a + b, 0) / recentVol.length;
  const relVol = avgVol > 0 ? round(lastBar.v / avgVol) : 0;

  // (g) MACD
  const m = macd(closes);
  const macdNow = {
    macd: round(m.macd[m.macd.length - 1]),
    signal: round(m.signal[m.signal.length - 1]),
    hist: round(m.hist[m.hist.length - 1]),
    trend: m.macd[m.macd.length - 1] > m.signal[m.signal.length - 1] ? 'bull' : 'bear',
    histDirection: m.hist[m.hist.length - 1] > m.hist[m.hist.length - 2] ? 'rising' : 'falling',
  };

  // (b) Swing S/R
  const swings = findSwings(bars, 3, 3);
  const recentHighs = swings.pivotHighs.slice(-5).map(p => round(p.price));
  const recentLows = swings.pivotLows.slice(-5).map(p => round(p.price));

  // (f) Fib
  const fib = lastImpulseFib(bars, swings);

  // (a) Supply/Demand
  const sdZones = findSupplyDemand(bars).slice(-5);

  // (h) FVG
  const fvgs = findFVGs(bars).slice(-5);

  // (i) ORB — only meaningful on 15m (1 bar) and relevant on 1H (approx first hour)
  const orb15 = openingRange(bars, 15);
  const orb30 = openingRange(bars, 30);

  // ATR (14) for sizing stops
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    trs.push(Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c),
    ));
  }
  const atr14 = trs.slice(-14).reduce((a, b) => a + b, 0) / 14;

  return {
    price: round(price),
    lastBarTime: lastBar.t,
    bars: bars.length,
    atr14: round(atr14),
    ema: emaNow, emaStack, priceVsEMA,
    vwap: vwap ? round(vwap) : null,
    vwapSide, vwapDistPct: vwapDist,
    relVol,
    macd: macdNow,
    recentHighs, recentLows,
    fib,
    sdZones,
    fvgs,
    orb15, orb30,
    sessionLevels: sessionLevels(bars),
  };
}

// ─── Confluence scoring ───────────────────────────────────────────────────────

function scoreSymbol(tfs) {
  // Across 15m/1H/4H, count bullish vs bearish signals
  const signals = { bull: 0, bear: 0 };
  for (const tf of Object.values(tfs)) {
    if (tf.error) continue;
    if (tf.emaStack === 'bull') signals.bull++;
    else if (tf.emaStack === 'bear') signals.bear++;
    if (tf.vwapSide === 'above') signals.bull++;
    else if (tf.vwapSide === 'below') signals.bear++;
    if (tf.macd?.trend === 'bull') signals.bull++;
    else if (tf.macd?.trend === 'bear') signals.bear++;
    if (tf.macd?.histDirection === 'rising') signals.bull++;
    else signals.bear++;
  }
  const total = signals.bull + signals.bear;
  const bias = signals.bull > signals.bear ? 'BULL' : signals.bear > signals.bull ? 'BEAR' : 'NEUTRAL';
  return { ...signals, total, bias, pct: total ? Math.round((Math.max(signals.bull, signals.bear) / total) * 100) : 0 };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const results = {};
  const indicatorsToEnsure = ['Moving Average Exponential', 'Volume Weighted Average Price', 'Moving Average Convergence Divergence', 'Volume'];

  // Capture the user's original symbol + resolution so we can restore the chart afterward.
  let userOriginalSymbol = null, userOriginalRes = null;
  try {
    userOriginalSymbol = await evaluate(`${CHART_API}.symbol()`);
    userOriginalRes = await evaluate(`${CHART_API}.resolution()`);
    console.log(`(chart will be restored to ${userOriginalSymbol} @ ${userOriginalRes}m when script finishes)`);
  } catch {}

  const restore = async () => {
    if (!userOriginalSymbol) return;
    try {
      await evaluateAsync(`
        (function() {
          var chart = ${CHART_API};
          return new Promise(function(resolve) {
            chart.setSymbol('${userOriginalSymbol}', {});
            setTimeout(function() {
              try { chart.setResolution('${userOriginalRes}', {}); } catch(e) {}
              resolve();
            }, 800);
          });
        })()
      `);
      console.log(`(chart restored to ${userOriginalSymbol} @ ${userOriginalRes}m)`);
    } catch {}
  };
  process.on('SIGINT', async () => { await restore(); process.exit(130); });

  // Session clock — use 24-hour format to avoid AM/PM parsing bugs
  const fmtHM = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  const parts = fmtHM.formatToParts(new Date());
  const hr = +parts.find(p => p.type === 'hour').value % 24;
  const mn = +parts.find(p => p.type === 'minute').value;
  const nowET = new Date();
  const minsFromOpen = (hr - 9) * 60 + (mn - 30);
  const minsToClose = (16 - hr) * 60 - mn;
  const sessionPhase =
    minsFromOpen < 0 ? 'PRE-MARKET' :
    minsFromOpen < 15 ? 'OPENING (ORB forming)' :
    minsFromOpen < 60 ? 'POST-ORB (first hour)' :
    minsFromOpen < 180 ? 'MORNING TREND' :
    minsFromOpen < 330 ? 'LUNCH / MIDDAY CHOP' :
    minsFromOpen < 360 ? 'POWER HOUR APPROACH' :
    minsFromOpen < 390 ? 'POWER HOUR / CLOSE' : 'AFTER-HOURS';
  console.log(`\nSession clock: ${nowET.toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET · ${sessionPhase} · ${minsToClose}m to close`);

  // Track the previous read's bar signature so each new read must differ from it
  // (no stale bleed). Seed with the chart's current series before any switch.
  let prevSig = await readSig();

  for (const sym of SYMBOLS) {
    const label = LABELS[sym];
    console.log(`\n━━━ ${label} (${sym}) ━━━`);
    results[label] = { symbol: sym, tfs: {} };

    try {
      await setSymbol(sym);

      // Only add indicators to ETFs (primary trade vehicles)
      if (sym === 'BATS:SPY' || sym === 'NASDAQ:QQQ') {
        const added = await ensureIndicators(indicatorsToEnsure);
        if (added.length) console.log(`  added indicators: ${added.join(', ')}`);
      }

      for (const tf of TIMEFRAMES) {
        await setTimeframe(tf.res);
        const loaded = await waitForSeries(sym, tf.res, 30, prevSig);
        if (!loaded.ok) {
          // Feed didn't deliver fresh bars in time. Do NOT read — the series
          // still holds the PREVIOUS symbol/TF's bars, and ingesting them would
          // produce a wrong bias. Error out → scores NEUTRAL → safe skip.
          console.log(`  ${tf.label}: ERROR — feed not loaded in time (skipped to avoid stale read)`);
          results[label].tfs[tf.label] = { error: 'feed not loaded' };
          continue;
        }
        prevSig = loaded.sig;
        const bars = await getOhlcv(tf.barsNeeded);
        const a = analyzeBars(bars);
        results[label].tfs[tf.label] = a;
        if (a.error) {
          console.log(`  ${tf.label}: ERROR — ${a.error}`);
        } else {
          const orbStr = a.orb15 ? `ORB=${a.orb15.low}/${a.orb15.high} (${a.orb15.state}${a.orb15.brokeHigh ? ',brokeHi' : ''}${a.orb15.brokeLow ? ',brokeLo' : ''})` : '';
          console.log(`  ${tf.label}: px=${a.price} ATR=${a.atr14} ema9/21/50=${a.ema.ema9}/${a.ema.ema21}/${a.ema.ema50} (${a.emaStack}) vwap=${a.vwap} (${a.vwapSide}) macd=${a.macd.trend}/${a.macd.histDirection} rVol=${a.relVol}x FVGs=${a.fvgs.length} SD=${a.sdZones.length} ${orbStr}`);
        }
      }
      results[label].score = scoreSymbol(results[label].tfs);
      console.log(`  → BIAS: ${results[label].score.bias} (${results[label].score.bull}B/${results[label].score.bear}S = ${results[label].score.pct}%)`);
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
      results[label].error = e.message;
    }
  }

  // ─── Correlation & setup suggestion ─────────────────────────────────────────

  console.log(`\n\n════════════════════════════════════════════════════════════════`);
  console.log(`  CORRELATION & OPTIONS SETUP`);
  console.log(`════════════════════════════════════════════════════════════════`);

  // Futures→ETF pairs (broad-market correlation gate) + standalone stocks
  // (no futures correlate; aligned reduces to "bias is non-NEUTRAL").
  const futuresPairs = [['ES', 'SPY'], ['NQ', 'QQQ'], ['RTY', 'IWM']];
  const standaloneStocks = ['AAPL', 'NVDA', 'AMZN', 'TSLA', 'MU', 'INTC'];
  const entries = [
    ...futuresPairs.map(([fut, etf]) => ({ fut, etf })),
    ...standaloneStocks.map((s) => ({ fut: null, etf: s })),
  ];
  const final = {};
  for (const { fut, etf } of entries) {
    const fs = fut ? results[fut]?.score?.bias : null;
    const es = results[etf]?.score?.bias;
    const aligned = fut
      ? (fs === es && fs !== 'NEUTRAL')
      : (es != null && es !== 'NEUTRAL');
    if (fut) {
      console.log(`\n${fut}→${etf}: ${fut}=${fs} ${etf}=${es} ${aligned ? '✓ ALIGNED' : '✗ divergent'}`);
    } else {
      console.log(`\n${etf}: ${es ?? 'NEUTRAL'} ${aligned ? '✓ aligned' : '✗ no setup (NEUTRAL)'}`);
    }
    final[etf] = { fut, etf, aligned, bias: fut ? (fs === es ? fs : 'NO_TRADE') : (es ?? 'NO_TRADE') };
    // Surface the ETF's bias percentage (e.g. 91 for 91% bearish across TFs)
    // so the bias-label drawer in premarket_setup.mjs can show "BEAR 91%" at
    // the top-right of each chart. Read from the ETF's score (not the future)
    // because the chart we draw on IS the ETF chart.
    final[etf].bias_pct = results[etf]?.score?.pct ?? null;

    // Surface session levels (PDH/PDL/PMH/PML) regardless of bias alignment —
    // informational, useful as a confluence input for future gates and as a
    // visual reference on the chart.
    const _sl = results[etf]?.tfs?.['15m']?.sessionLevels;
    if (_sl) {
      final[etf].session_levels = { ..._sl };
      const _atr = results[etf]?.tfs?.['15m']?.atr14;
      const _px  = results[etf]?.tfs?.['15m']?.price;
      if (_atr > 0 && _px != null) {
        const dist = v => v == null ? null : round((v - _px) / _atr);
        final[etf].session_levels.atr_dist = {
          pdh: dist(_sl.pdh),
          pdl: dist(_sl.pdl),
          pmh: dist(_sl.pmh),
          pml: dist(_sl.pml),
        };
      }
    }

    if (aligned) {
      const etfData = results[etf];
      const tf15 = etfData.tfs['15m'] || {};
      const tf1H = etfData.tfs['1H'] || {};
      const tf4H = etfData.tfs['4H'] || {};
      const px = tf15.price;
      const atr15 = tf15.atr14;
      const ema9_15 = tf15.ema?.ema9;
      const ema21_15 = tf15.ema?.ema21;
      const ema21_1H = tf1H.ema?.ema21;
      const ema50_4H = tf4H.ema?.ema50;
      const vwap15 = tf15.vwap;
      const fvgs15 = tf15.fvgs || [];
      const nearestFVG = fvgs15.length ? fvgs15[fvgs15.length - 1] : null;
      const fib1H = tf1H.fib;
      const orb = tf15.orb30; // 30-min ORB (09:30–10:00). Switched from orb15 (15-min) 2026-06-08.
      const orb30 = tf15.orb30;
      // Inside `if (aligned)`: for ETF pairs fs === es; for stocks fs is null
      // and bias comes from es. Use es uniformly.
      const dir = es === 'BULL' ? 'CALLS' : 'PUTS';
      const bullish = es === 'BULL';

      // Trigger levels
      const orbTriggerLong = orb ? orb.high : null;
      const orbTriggerShort = orb ? orb.low : null;
      const fvgBreakTrigger = nearestFVG ? (nearestFVG.type === 'bear' ? nearestFVG.high : nearestFVG.low) : null;

      // Stops: 1 ATR beyond the 1H EMA21 invalidation level, BUT clamped so a
      // long stop always sits at least 1 ATR below the ORB-high entry trigger
      // (and a short stop always sits at least 1 ATR above ORB-low). Without
      // the clamp, the formula returns stop > entry whenever the ORB sits on
      // the wrong side of the 1H EMA21 — which produces a structurally invalid
      // OCA bracket order. See structureSupportsBias check below.
      const stopLong = (ema21_1H != null && orbTriggerLong != null)
        ? Math.min(round(ema21_1H - atr15), round(orbTriggerLong - atr15))
        : (ema21_1H != null ? round(ema21_1H - atr15) : null);
      const stopShort = (ema21_1H != null && orbTriggerShort != null)
        ? Math.max(round(ema21_1H + atr15), round(orbTriggerShort + atr15))
        : (ema21_1H != null ? round(ema21_1H + atr15) : null);

      // Structure sanity check: the bias direction must match where the ORB
      // sits relative to the 1H EMA21 trend reference. A bullish ORB-breakout
      // long only makes sense if ORB high is at-or-above the 1H EMA21 (price
      // is taking out resistance from a position near/above trend). When the
      // ORB sits on the wrong side of trend, the setup is structurally a
      // counter-trend bet — suppress it.
      //
      // STRUCTURE_CHECK_K = ATR-units of "loosening" buffer applied to the
      // strict comparison. K=0 = strict (orb.high >= ema21_1H exactly). K>0
      // allows the ORB to sit slightly below trend by K*ATR before failing.
      // Calibrated to 0.25 from the Phase 1 backtest (journal/2026-04-28-phase1-structure-sweep.md):
      // strict (K=0) was killing 3 wins per 10 days; K=0.25 recovers 2 of
      // them while still rejecting clear counter-structure setups (>0.25 ATR off).
      // PENDING: re-validate with 60-day backtest before treating as permanent.
      const STRUCTURE_CHECK_K = 0.25;
      const structureSupportsBias = (orb && ema21_1H != null && atr15 != null)
        ? (bullish
            ? orb.high >= ema21_1H - STRUCTURE_CHECK_K * atr15
            : orb.low  <= ema21_1H + STRUCTURE_CHECK_K * atr15)
        : true; // pre-ORB or missing data — don't disqualify on absence
      const noTradeReason = !structureSupportsBias
        ? (bullish
            ? `BULL bias but ORB high ${orbTriggerLong} < 1H EMA21 ${ema21_1H} − ${STRUCTURE_CHECK_K}×ATR (${(ema21_1H - STRUCTURE_CHECK_K * atr15).toFixed(2)}) — structure is below trend by more than the calibrated buffer, not a clean breakout long`
            : `BEAR bias but ORB low ${orbTriggerShort} > 1H EMA21 ${ema21_1H} + ${STRUCTURE_CHECK_K}×ATR (${(ema21_1H + STRUCTURE_CHECK_K * atr15).toFixed(2)}) — structure is above trend by more than the calibrated buffer, not a clean breakdown short`)
        : null;

      // ─── Targets — Layer 2 confluence selector ────────────────────────────
      // Replaces the simple "ORB extension" formula with a "nearest wall"
      // pick from { ORB extension, PDH/PDL, PMH/PML, recent 15m swing }.
      // Aurora zones are NOT yet available here — they get added in
      // premarket_setup.mjs STEP 3 via a re-pass of the same selector.
      // `*_raw` retains the original formula for fallback + diagnostics.
      const tgt1_up_raw = orb ? orb.breakoutTarget_up : null;
      const tgt2_up_raw = orb ? orb.measured_2x_up : null;
      const tgt1_dn_raw = orb ? orb.breakoutTarget_dn : null;
      const tgt2_dn_raw = orb ? orb.measured_2x_dn : null;

      const sl = final[etf]?.session_levels ?? null;
      const recentHighsArr = tf15.recentHighs || [];
      const recentLowsArr  = tf15.recentLows  || [];
      const swingHigh = recentHighsArr.length ? Math.max(...recentHighsArr) : null;
      const swingLow  = recentLowsArr.length  ? Math.min(...recentLowsArr)  : null;

      // T-A T1 / T2 (selector input: post-Entry, in trade direction)
      const tA_T1_pick = bullish
        ? pickTarget({
            candidates: buildTargetCandidates({
              orbExtension: tgt1_up_raw, orbExtName: 'ORB+range',
              sessionLevels: sl, auroraZones: [],
              recentSwing: swingHigh, isCalls: true,
            }),
            entry: orbTriggerLong, isCalls: true, atr: atr15,
          })
        : pickTarget({
            candidates: buildTargetCandidates({
              orbExtension: tgt1_dn_raw, orbExtName: 'ORB-range',
              sessionLevels: sl, auroraZones: [],
              recentSwing: swingLow, isCalls: false,
            }),
            entry: orbTriggerShort, isCalls: false, atr: atr15,
          });
      const tA_T2_pick = bullish
        ? pickTarget({
            candidates: buildTargetCandidates({
              orbExtension: tgt2_up_raw, orbExtName: 'ORB+2x',
              sessionLevels: sl, auroraZones: [],
              recentSwing: swingHigh, isCalls: true,
            }),
            entry: orbTriggerLong, isCalls: true,
            beyondPrice: tA_T1_pick?.value ?? orbTriggerLong, atr: atr15,
          })
        : pickTarget({
            candidates: buildTargetCandidates({
              orbExtension: tgt2_dn_raw, orbExtName: 'ORB-2x',
              sessionLevels: sl, auroraZones: [],
              recentSwing: swingLow, isCalls: false,
            }),
            entry: orbTriggerShort, isCalls: false,
            beyondPrice: tA_T1_pick?.value ?? orbTriggerShort, atr: atr15,
          });

      // T-B T1 / T2 — per candidate (VWAP, EMA21_1H). Each candidate gets its
      // own T1 because the trade enters at a different price level.
      function tBTargetsForCandidate(candidateEntry) {
        if (candidateEntry == null) return null;
        const t1 = bullish
          ? pickTarget({
              candidates: buildTargetCandidates({
                orbExtension: tgt1_up_raw, orbExtName: 'ORB+range',
                sessionLevels: sl, auroraZones: [],
                recentSwing: swingHigh, isCalls: true,
              }),
              entry: candidateEntry, isCalls: true, atr: atr15,
            })
          : pickTarget({
              candidates: buildTargetCandidates({
                orbExtension: tgt1_dn_raw, orbExtName: 'ORB-range',
                sessionLevels: sl, auroraZones: [],
                recentSwing: swingLow, isCalls: false,
              }),
              entry: candidateEntry, isCalls: false, atr: atr15,
            });
        const t2 = bullish
          ? pickTarget({
              candidates: buildTargetCandidates({
                orbExtension: tgt2_up_raw, orbExtName: 'ORB+2x',
                sessionLevels: sl, auroraZones: [],
                recentSwing: swingHigh, isCalls: true,
              }),
              entry: candidateEntry, isCalls: true,
              beyondPrice: t1?.value ?? candidateEntry, atr: atr15,
            })
          : pickTarget({
              candidates: buildTargetCandidates({
                orbExtension: tgt2_dn_raw, orbExtName: 'ORB-2x',
                sessionLevels: sl, auroraZones: [],
                recentSwing: swingLow, isCalls: false,
              }),
              entry: candidateEntry, isCalls: false,
              beyondPrice: t1?.value ?? candidateEntry, atr: atr15,
            });
        return { t1, t2 };
      }
      const tB_vwap_targets = tBTargetsForCandidate(vwap15);
      const tB_ema21_targets = tBTargetsForCandidate(ema21_1H);

      // Entry-line confluence styling signal (Layer 1 visualization).
      // Computed for both Trigger A and Trigger B candidates.
      const tA_confluence = bullish
        ? computeEntryConfluence({ entry: orbTriggerLong, isCalls: true, sessionLevels: sl, vwap: vwap15, ema21_1H, auroraZones: [], atr: atr15 })
        : computeEntryConfluence({ entry: orbTriggerShort, isCalls: false, sessionLevels: sl, vwap: vwap15, ema21_1H, auroraZones: [], atr: atr15 });
      const tB_vwap_confluence = vwap15 != null ? computeEntryConfluence({
        entry: vwap15, isCalls: bullish, sessionLevels: sl, vwap: null /* avoid self */, ema21_1H, auroraZones: [], atr: atr15,
      }) : null;
      const tB_ema21_confluence = ema21_1H != null ? computeEntryConfluence({
        entry: ema21_1H, isCalls: bullish, sessionLevels: sl, vwap: vwap15, ema21_1H: null /* avoid self */, auroraZones: [], atr: atr15,
      }) : null;

      // Final number values for entry_notes (backward-compat: must be numbers).
      const tgt1_up = tA_T1_pick?.value ?? tgt1_up_raw;
      const tgt2_up = tA_T2_pick?.value ?? tgt2_up_raw;
      const tgt1_dn = tA_T1_pick?.value ?? tgt1_dn_raw;
      const tgt2_dn = tA_T2_pick?.value ?? tgt2_dn_raw;

      console.log(`\n  ── ${etf} ${dir} PLAN ──`);
      console.log(`  Current: ${px}   ATR(15m)=${atr15}   VWAP=${vwap15}`);
      if (orb) console.log(`  ORB-15: ${orb.low}-${orb.high} (range ${orb.range}) · state=${orb.state}${orb.brokeHigh ? ' · BROKE HIGH' : ''}${orb.brokeLow ? ' · BROKE LOW' : ''}`);
      if (orb30) console.log(`  ORB-30: ${orb30.low}-${orb30.high} (range ${orb30.range})`);
      const _slPrint = etfData.tfs['15m']?.sessionLevels;
      if (_slPrint && (_slPrint.pdh != null || _slPrint.pmh != null)) {
        console.log(`  Session levels: PDH=${_slPrint.pdh ?? '—'}/PDL=${_slPrint.pdl ?? '—'} (${_slPrint.pd_session_date || 'n/a'}) · PMH=${_slPrint.pmh ?? '—'}/PML=${_slPrint.pml ?? '—'}`);
      }
      console.log(`  Trend ladder: 15m EMA21=${ema21_15} · 1H EMA21=${ema21_1H} · 4H EMA50=${ema50_4H}`);
      if (nearestFVG) console.log(`  Nearest 15m FVG: ${nearestFVG.type} ${nearestFVG.low}-${nearestFVG.high}`);
      if (fib1H) console.log(`  1H Fib (${fib1H.direction}): 38.2=${fib1H.fib_382} · 50=${fib1H.fib_500} · 61.8=${fib1H.fib_618}`);
      console.log(``);
      if (bullish) {
        const tA_T1_label = tA_T1_pick ? `${tA_T1_pick.source}` : 'ORB+range';
        const tA_T2_label = tA_T2_pick ? `${tA_T2_pick.source}` : 'ORB+2x';
        const tA_T1_clust = tA_T1_pick?.cluster?.count > 1 ? ` [CLUSTER ${tA_T1_pick.cluster.count}: ${tA_T1_pick.cluster.members.join(',')}]` : '';
        const tA_T2_clust = tA_T2_pick?.cluster?.count > 1 ? ` [CLUSTER ${tA_T2_pick.cluster.count}]` : '';
        console.log(`  🟢 TRIGGER A — ORB breakout long`);
        console.log(`     Entry: 15m close > ${orbTriggerLong} with rVol ≥ 1.2x  (confluence: +${tA_confluence.confirming.count} confirming, -${tA_confluence.warning.count} warnings)`);
        console.log(`     Stop:  ${stopLong} (below 1H EMA21 − 1 ATR)`);
        console.log(`     T1:    ${tgt1_up} (${tA_T1_label})${tA_T1_clust}    T2: ${tgt2_up} (${tA_T2_label})${tA_T2_clust}`);
        console.log(``);
        console.log(`  🟢 TRIGGER B — VWAP/EMA21 pullback long`);
        console.log(`     Entry: price tags VWAP (${vwap15}) or 1H EMA21 (${ema21_1H}) and prints bullish reclaim candle on 5m`);
        console.log(`     Stop:  1 ATR below entry (~${round((vwap15 || px) - atr15)})`);
        console.log(`     T1:    back to prior swing (${Math.max(...(tf15.recentHighs || [px]))})   T2: ${tgt1_up}`);
        if (fvgBreakTrigger && nearestFVG?.type === 'bear') {
          console.log(``);
          console.log(`  ⚠️ Overhead bear FVG at ${nearestFVG.low}-${nearestFVG.high} — expect rejection on first touch; size small until reclaimed.`);
        }
      } else {
        console.log(`  🔴 TRIGGER A — ORB breakdown short`);
        console.log(`     Entry: 15m close < ${orbTriggerShort} with rVol ≥ 1.2x`);
        console.log(`     Stop:  ${stopShort}   T1: ${tgt1_dn}   T2: ${tgt2_dn}`);
      }
      console.log(``);
      console.log(`  INVALIDATION: 15m close below 1H EMA21 (${ema21_1H}) with bearish MACD cross → exit or flip.`);

      // Time-of-day guidance
      const timingNote =
        minsFromOpen < 15 ? `ORB still forming — do NOT enter before 9:45 ET.` :
        minsFromOpen < 60 ? `First-hour window. Most reliable ORB breakouts fire between 9:45-10:30 ET.` :
        minsFromOpen < 180 ? `Morning trend window. Breakouts still valid; pullbacks to VWAP preferred.` :
        minsFromOpen < 330 ? `Lunch chop zone. Avoid fresh entries; hold existing winners only.` :
        minsFromOpen < 360 ? `Power hour approach — watch for trend resumption or reversal.` :
        minsFromOpen < 390 ? `Power hour active. Momentum accelerates. Close 0DTE by 15:30 ET per your rules.` :
        `After-hours — no 0DTE entries.`;
      console.log(`  TIMING: ${timingNote}`);
      console.log(`  HARD CLOSE: 15:30 ET (per rules.json). Time stop if not in profit by 14:00 ET.`);

      if (!structureSupportsBias) {
        console.log(`\n  ⛔ NO TRADE — ${noTradeReason}`);
        final[etf].no_trade_reason = noTradeReason;
        final[etf].entry_notes = null;
        continue;
      }

      final[etf].entry_notes = {
        direction: dir,
        triggers: {
          orb_breakout: orbTriggerLong,
          vwap_pullback: vwap15,
          ema21_1H_pullback: ema21_1H,
        },
        stops: { long: stopLong, short: stopShort },
        targets: bullish ? { T1: tgt1_up, T2: tgt2_up } : { T1: tgt1_dn, T2: tgt2_dn },
        invalidation: ema21_1H,
        atr_15m: atr15,
        // Structured blocks for annotation consumers (premarket_setup.mjs draws
        // lines from these). T1/T2 remain plain numbers for backward compat;
        // *_source / *_cluster / confluence are NEW metadata (Layer 1+2+3).
        trigger_a: bullish ? {
          entry: orbTriggerLong,
          stop: stopLong,
          T1: roundOrNull(tgt1_up),
          T2: roundOrNull(tgt2_up),
          T1_source: tA_T1_pick?.source ?? 'ORB+range',
          T2_source: tA_T2_pick?.source ?? 'ORB+2x',
          T1_cluster: tA_T1_pick?.cluster ?? null,
          T2_cluster: tA_T2_pick?.cluster ?? null,
          T1_raw: tgt1_up_raw,    // diagnostic: pre-Layer-2 fallback value
          T2_raw: tgt2_up_raw,
          confluence: tA_confluence,
        } : {
          entry: orbTriggerShort,
          stop: stopShort,
          T1: roundOrNull(tgt1_dn),
          T2: roundOrNull(tgt2_dn),
          T1_source: tA_T1_pick?.source ?? 'ORB-range',
          T2_source: tA_T2_pick?.source ?? 'ORB-2x',
          T1_cluster: tA_T1_pick?.cluster ?? null,
          T2_cluster: tA_T2_pick?.cluster ?? null,
          T1_raw: tgt1_dn_raw,
          T2_raw: tgt2_dn_raw,
          confluence: tA_confluence,
        },
        trigger_b: bullish ? {
          entry_vwap: vwap15,
          entry_ema21_1H: ema21_1H,
          stop: round((vwap15 || px) - atr15),
          // T1/T2 backward-compat: pick the VWAP-candidate values as the
          // primary T1/T2 (matches today's behavior of using a single T1/T2);
          // per-candidate values are added as separate metadata fields.
          T1: roundOrNull(tB_vwap_targets?.t1?.value ?? Math.max(...(tf15.recentHighs || [px]))),
          T2: roundOrNull(tB_vwap_targets?.t2?.value ?? tgt1_up),
          T1_source: tB_vwap_targets?.t1?.source ?? 'recent_swing',
          T2_source: tB_vwap_targets?.t2?.source ?? 'ORB+range',
          T1_cluster: tB_vwap_targets?.t1?.cluster ?? null,
          T2_cluster: tB_vwap_targets?.t2?.cluster ?? null,
          per_candidate: {
            vwap:     tB_vwap_targets ? {
              T1: roundOrNull(tB_vwap_targets.t1?.value ?? Math.max(...(tf15.recentHighs || [px]))),
              T2: roundOrNull(tB_vwap_targets.t2?.value ?? tgt1_up),
              T1_source: tB_vwap_targets.t1?.source ?? 'recent_swing',
              T2_source: tB_vwap_targets.t2?.source ?? 'ORB+range',
              T1_cluster: tB_vwap_targets.t1?.cluster ?? null,
              T2_cluster: tB_vwap_targets.t2?.cluster ?? null,
              confluence: tB_vwap_confluence,
            } : null,
            ema21_1H: tB_ema21_targets ? {
              T1: roundOrNull(tB_ema21_targets.t1?.value ?? Math.max(...(tf15.recentHighs || [px]))),
              T2: roundOrNull(tB_ema21_targets.t2?.value ?? tgt1_up),
              T1_source: tB_ema21_targets.t1?.source ?? 'recent_swing',
              T2_source: tB_ema21_targets.t2?.source ?? 'ORB+range',
              T1_cluster: tB_ema21_targets.t1?.cluster ?? null,
              T2_cluster: tB_ema21_targets.t2?.cluster ?? null,
              confluence: tB_ema21_confluence,
            } : null,
          },
        } : {
          entry_vwap: vwap15,
          entry_ema21_1H: ema21_1H,
          stop: round((vwap15 || px) + atr15),
          T1: roundOrNull(tB_vwap_targets?.t1?.value ?? Math.min(...(tf15.recentLows || [px]))),
          T2: roundOrNull(tB_vwap_targets?.t2?.value ?? tgt1_dn),
          T1_source: tB_vwap_targets?.t1?.source ?? 'recent_swing',
          T2_source: tB_vwap_targets?.t2?.source ?? 'ORB-range',
          T1_cluster: tB_vwap_targets?.t1?.cluster ?? null,
          T2_cluster: tB_vwap_targets?.t2?.cluster ?? null,
          per_candidate: {
            vwap:     tB_vwap_targets ? {
              T1: roundOrNull(tB_vwap_targets.t1?.value ?? Math.min(...(tf15.recentLows || [px]))),
              T2: roundOrNull(tB_vwap_targets.t2?.value ?? tgt1_dn),
              T1_source: tB_vwap_targets.t1?.source ?? 'recent_swing',
              T2_source: tB_vwap_targets.t2?.source ?? 'ORB-range',
              T1_cluster: tB_vwap_targets.t1?.cluster ?? null,
              T2_cluster: tB_vwap_targets.t2?.cluster ?? null,
              confluence: tB_vwap_confluence,
            } : null,
            ema21_1H: tB_ema21_targets ? {
              T1: roundOrNull(tB_ema21_targets.t1?.value ?? Math.min(...(tf15.recentLows || [px]))),
              T2: roundOrNull(tB_ema21_targets.t2?.value ?? tgt1_dn),
              T1_source: tB_ema21_targets.t1?.source ?? 'recent_swing',
              T2_source: tB_ema21_targets.t2?.source ?? 'ORB-range',
              T1_cluster: tB_ema21_targets.t1?.cluster ?? null,
              T2_cluster: tB_ema21_targets.t2?.cluster ?? null,
              confluence: tB_ema21_confluence,
            } : null,
          },
        },
      };
    }
  }

  // Full JSON dump
  console.log(`\n\n─── FULL DATA (JSON) ───`);
  console.log(JSON.stringify({ results, final }, null, 2));

  await restore();
  process.exit(0);
})().catch(async e => { console.error('FATAL:', e); process.exit(1); });
