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

import { evaluate, evaluateAsync } from './src/connection.js';

const SYMBOLS = ['CME_MINI:ES1!', 'CME_MINI:NQ1!', 'BATS:SPY', 'NASDAQ:QQQ'];
const LABELS = { 'CME_MINI:ES1!': 'ES', 'CME_MINI:NQ1!': 'NQ', 'BATS:SPY': 'SPY', 'NASDAQ:QQQ': 'QQQ' };
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
        setTimeout(resolve, 1500);
      });
    })()
  `);
}

async function setTimeframe(res) {
  await evaluate(`${CHART_API}.setResolution('${res}', {})`);
  await new Promise(r => setTimeout(r, 1500));
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

  return {
    price: round(price),
    bars: bars.length,
    ema: emaNow, emaStack, priceVsEMA,
    vwap: vwap ? round(vwap) : null,
    vwapSide, vwapDistPct: vwapDist,
    relVol,
    macd: macdNow,
    recentHighs, recentLows,
    fib,
    sdZones,
    fvgs,
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
        await new Promise(r => setTimeout(r, 800));
        const bars = await getOhlcv(tf.barsNeeded);
        const a = analyzeBars(bars);
        results[label].tfs[tf.label] = a;
        if (a.error) {
          console.log(`  ${tf.label}: ERROR — ${a.error}`);
        } else {
          console.log(`  ${tf.label}: px=${a.price} ema9/21/50=${a.ema.ema9}/${a.ema.ema21}/${a.ema.ema50} (${a.emaStack}) vwap=${a.vwap} (${a.vwapSide}) macd=${a.macd.trend}/${a.macd.histDirection} rVol=${a.relVol}x FVGs=${a.fvgs.length} SD=${a.sdZones.length}`);
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

  const pairs = [['ES', 'SPY'], ['NQ', 'QQQ']];
  const final = {};
  for (const [fut, etf] of pairs) {
    const fs = results[fut]?.score?.bias;
    const es = results[etf]?.score?.bias;
    const aligned = fs === es && fs !== 'NEUTRAL';
    console.log(`\n${fut}→${etf}: ${fut}=${fs} ${etf}=${es} ${aligned ? '✓ ALIGNED' : '✗ divergent'}`);
    final[etf] = { fut, etf, aligned, bias: fs === es ? fs : 'NO_TRADE' };

    if (aligned) {
      const etfData = results[etf];
      const px = etfData.tfs['15m']?.price;
      const ema21_1H = etfData.tfs['1H']?.ema?.ema21;
      const ema50_4H = etfData.tfs['4H']?.ema?.ema50;
      const vwap15 = etfData.tfs['15m']?.vwap;
      const fvgs15 = etfData.tfs['15m']?.fvgs || [];
      const nearestFVG = fvgs15.length ? fvgs15[fvgs15.length - 1] : null;
      const fib1H = etfData.tfs['1H']?.fib;

      console.log(`  Direction: ${fs === 'BULL' ? 'CALLS' : 'PUTS'}`);
      console.log(`  Price: ${px}`);
      console.log(`  Key supports (bull case): VWAP=${vwap15}, 1H EMA21=${ema21_1H}, 4H EMA50=${ema50_4H}`);
      if (nearestFVG) console.log(`  Nearest 15m FVG: ${nearestFVG.type} ${nearestFVG.low}-${nearestFVG.high}`);
      if (fib1H) console.log(`  1H Fib (${fib1H.direction}): 38.2=${fib1H.fib_382} 50=${fib1H.fib_500} 61.8=${fib1H.fib_618}`);
      final[etf].entry_notes = {
        price: px,
        direction: fs === 'BULL' ? 'CALLS' : 'PUTS',
        confluences: { vwap15, ema21_1H, ema50_4H, nearestFVG, fib1H },
      };
    }
  }

  // Full JSON dump
  console.log(`\n\n─── FULL DATA (JSON) ───`);
  console.log(JSON.stringify({ results, final }, null, 2));

  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
