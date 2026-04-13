/**
 * fvg_live_commentary.js
 * Event-driven live commentary for SPY + QQQ 0DTE FVG trading.
 * Polls every 1 minute. Only fires Discord messages on actual events.
 *
 * Events tracked:
 *   - VWAP cross (price crossing above/below VWAP)
 *   - EMA flip (MA#1 crossing MA#2)
 *   - New FVG formed on 15min
 *   - Price entering/exiting an FVG zone
 *   - Gap detection at open
 *   - Time-based reminders (gap protocol end, time stop, hard close)
 *
 * Usage: node fvg_live_commentary.js
 */

import { evaluate } from './src/connection.js';
import https from 'https';

const SYMBOLS = ['SPY', 'QQQ'];
const POLL_INTERVAL_MS = 60 * 1000; // 1 minute
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK;

if (!WEBHOOK_URL) {
  console.error('Error: DISCORD_WEBHOOK environment variable is not set.');
  process.exit(1);
}

// ─── Per-symbol state ─────────────────────────────────────────────────────────

const state = {};
for (const sym of SYMBOLS) {
  state[sym] = {
    lastPrice: null,
    lastVWAP: null,
    lastMA1: null,
    lastMA2: null,
    knownFVGKeys: new Set(),
    activeZoneKey: null,
    prevClose: null,
    gapAlertFired: false,
    firedTimeEvents: new Set(),
  };
}

let sessionDate = null; // yyyy-mm-dd — resets state at day boundary

// ─── Time helpers ─────────────────────────────────────────────────────────────

function getNowET() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function todayET() {
  const now = getNowET();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

function isWeekday() {
  const d = getNowET().getDay();
  return d >= 1 && d <= 5;
}

function timeMins() {
  const n = getNowET();
  return n.getHours() * 60 + n.getMinutes();
}

// ─── Discord ──────────────────────────────────────────────────────────────────

function postDiscord(content) {
  return new Promise((resolve) => {
    const url = new URL(WEBHOOK_URL);
    const data = JSON.stringify({ content });
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', (err) => {
      console.error('Discord error:', err.message);
      resolve(null);
    });
    req.write(data);
    req.end();
  });
}

function emit(msg) {
  const t = getNowET().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const line = `**${t} ET** ${msg}`;
  console.log(`[EMIT] ${line}`);
  return postDiscord(line);
}

// ─── TradingView data ─────────────────────────────────────────────────────────

async function switchToSymbol(symbol) {
  await evaluate(`
    (function() {
      var api = window.TradingViewApi;
      if (api && api.activeChart) api.activeChart().setSymbol('BATS:${symbol}', function() {});
    })()
  `);
  await new Promise(r => setTimeout(r, 1500));
}

async function getBars(count = 30) {
  return evaluate(`
    (function() {
      var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
      if (!bars || typeof bars.lastIndex !== 'function') return null;
      var out = [];
      var end = bars.lastIndex();
      var start = Math.max(bars.firstIndex(), end - ${count} + 1);
      for (var i = start; i <= end; i++) {
        var v = bars.valueAt(i);
        if (v) out.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4] });
      }
      return out;
    })()
  `);
}

async function getStudyValues() {
  return evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var sources = chart.model().model().dataSources();
      var result = {};
      for (var i = 0; i < sources.length; i++) {
        var s = sources[i];
        if (!s.metaInfo) continue;
        try {
          var name = (s.metaInfo().description || s.metaInfo().shortDescription || '');
          if (!name) continue;
          var plots = s.data && s.data.value && s.data.value();
          if (plots && plots.length > 0) result[name] = plots[plots.length - 1];
        } catch(e) {}
      }
      return result;
    })()
  `);
}

async function getQuote() {
  return evaluate(`
    (function() {
      var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
      if (!bars) return null;
      var last = bars.valueAt(bars.lastIndex());
      if (!last) return null;
      return { time: last[0], open: last[1], high: last[2], low: last[3], close: last[4] };
    })()
  `);
}

// ─── FVG detection ────────────────────────────────────────────────────────────

function findFVGs(bars) {
  const fvgs = [];
  for (let i = 2; i < bars.length; i++) {
    const c1 = bars[i - 2];
    const c3 = bars[i];
    if (c1.high < c3.low) {
      fvgs.push({ type: 'BULL', top: c3.low, bottom: c1.high, ce: (c3.low + c1.high) / 2, time: c3.time });
    }
    if (c1.low > c3.high) {
      fvgs.push({ type: 'BEAR', top: c1.low, bottom: c3.high, ce: (c1.low + c3.high) / 2, time: c3.time });
    }
  }
  return fvgs.filter(f => (f.top - f.bottom) > 0.10);
}

function fvgKey(fvg) {
  return `${fvg.type}-${fvg.time}-${fvg.top.toFixed(2)}-${fvg.bottom.toFixed(2)}`;
}

// ─── Event detection per symbol ──────────────────────────────────────────────

async function checkSymbol(symbol) {
  const s = state[symbol];
  await switchToSymbol(symbol);

  const [bars, quote, studies] = await Promise.all([
    getBars(30),
    getQuote(),
    getStudyValues(),
  ]);

  if (!bars || !quote) return;

  const price = quote.close;
  let vwap = null, ma1 = null, ma2 = null;
  for (const [name, values] of Object.entries(studies || {})) {
    if (name.includes('Volume Weighted Average Price') && values?.[0]) vwap = values[0];
    if (name.includes('Moving Average Ribbon') && values?.[0]) { ma1 = values[0]; ma2 = values[1] || null; }
  }

  // ── GAP detection (once per day, near market open) ──
  if (!s.gapAlertFired && timeMins() >= 9 * 60 + 30 && timeMins() <= 9 * 60 + 45) {
    const openBar = bars[bars.length - 1];
    // Find previous session close (last bar before today's first bar)
    // Simple heuristic: if we have bars from yesterday's close, compare
    const firstToday = bars.find(b => {
      const d = new Date(b.time * 1000);
      const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      return et.toDateString() === getNowET().toDateString();
    });
    const prevBars = bars.filter(b => {
      const d = new Date(b.time * 1000);
      const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      return et.toDateString() !== getNowET().toDateString();
    });
    if (firstToday && prevBars.length > 0) {
      const prevClose = prevBars[prevBars.length - 1].close;
      const todayOpen = firstToday.open;
      const gapPct = ((todayOpen - prevClose) / prevClose) * 100;
      if (Math.abs(gapPct) > 0.5) {
        const direction = gapPct > 0 ? 'UP' : 'DOWN';
        await emit(`📊 **${symbol} GAP ${direction} ${gapPct.toFixed(2)}%** — Opened at $${todayOpen.toFixed(2)} vs prior close $${prevClose.toFixed(2)}. **Gap day protocol active. No trading until 10:00 AM ET.**`);
      }
    }
    s.gapAlertFired = true;
  }

  // ── VWAP cross ──
  if (vwap && s.lastPrice !== null && s.lastVWAP !== null) {
    const wasAbove = s.lastPrice > s.lastVWAP;
    const nowAbove = price > vwap;
    if (wasAbove !== nowAbove) {
      const dir = nowAbove ? 'ABOVE' : 'BELOW';
      const impact = nowAbove
        ? 'Bull bias confirmed. PUT positions: EXIT NOW. CALL setups become valid.'
        : 'Bear bias confirmed. CALL positions: EXIT NOW. PUT setups become valid.';
      await emit(`🔔 **${symbol} VWAP CROSS** — Price $${price.toFixed(2)} crossed ${dir} VWAP ($${vwap.toFixed(2)}). ${impact}`);
    }
  }

  // ── EMA flip ──
  if (ma1 && ma2 && s.lastMA1 !== null && s.lastMA2 !== null) {
    const wasBullish = s.lastMA1 > s.lastMA2;
    const nowBullish = ma1 > ma2;
    if (wasBullish !== nowBullish) {
      const dir = nowBullish ? 'BULLISH' : 'BEARISH';
      await emit(`⚡ **${symbol} EMA FLIP — ${dir}** — MA#1 $${ma1.toFixed(2)} ${nowBullish ? '>' : '<'} MA#2 $${ma2.toFixed(2)}. Bias has changed. Re-evaluate open positions.`);
    }
  }

  // ── New FVG detection ──
  const currentFVGs = findFVGs(bars);
  for (const fvg of currentFVGs) {
    const key = fvgKey(fvg);
    if (!s.knownFVGKeys.has(key)) {
      s.knownFVGKeys.add(key);
      // Only alert on the most recent FVG (not historical ones on first run)
      const ageMin = (Date.now() / 1000 - fvg.time) / 60;
      if (ageMin < 20 && s.lastPrice !== null) { // fresh FVG within 20 min
        const typeEmoji = fvg.type === 'BULL' ? '🟢' : '🔴';
        await emit(`${typeEmoji} **${symbol} NEW ${fvg.type} FVG** formed at $${fvg.bottom.toFixed(2)}–$${fvg.top.toFixed(2)} | CE $${fvg.ce.toFixed(2)} | Watch for retest.`);
      }
    }
  }

  // ── FVG zone entry/exit ──
  let currentZone = null;
  for (const fvg of currentFVGs) {
    if (price >= fvg.bottom && price <= fvg.top) {
      currentZone = fvgKey(fvg);
      if (s.activeZoneKey !== currentZone) {
        const typeEmoji = fvg.type === 'BULL' ? '🟢' : '🔴';
        const action = fvg.type === 'BULL' ? 'Watch for bounce — CALL setup' : 'Watch for rejection — PUT setup';
        await emit(`${typeEmoji} **${symbol} ENTERED ${fvg.type} FVG** — Price $${price.toFixed(2)} inside $${fvg.bottom.toFixed(2)}–$${fvg.top.toFixed(2)}. CE $${fvg.ce.toFixed(2)}. ${action}.`);
      }
      break;
    }
  }
  if (s.activeZoneKey && !currentZone) {
    await emit(`↗️ **${symbol} EXITED FVG zone** — Price $${price.toFixed(2)} broke out of previously active FVG.`);
  }
  s.activeZoneKey = currentZone;

  // Update state
  s.lastPrice = price;
  s.lastVWAP = vwap;
  s.lastMA1 = ma1;
  s.lastMA2 = ma2;
}

// ─── Time-based events ───────────────────────────────────────────────────────

async function checkTimeEvents() {
  const mins = timeMins();
  const globalState = state.__time || (state.__time = { fired: new Set() });

  const events = [
    { mins: 9 * 60 + 30, key: 'open', msg: '🔔 **Market OPEN** — Do not trade the first 5 minutes. Watch for direction.' },
    { mins: 10 * 60, key: 'gap-end', msg: '⏰ **10:00 AM** — Gap day protocol window ends. If applicable, confirm direction before entering.' },
    { mins: 11 * 60 + 30, key: 'time-stop', msg: '⚠️ **11:30 AM TIME STOP** — If any position has not worked by now, EXIT regardless of P&L. News setups either work fast or not at all.' },
    { mins: 12 * 60 + 30, key: '3hr-end', msg: '⏰ **12:30 PM** — First 3 hours done. Per your rules, no more trades today.' },
    { mins: 13 * 60, key: 'tp2', msg: '🎯 **1:00 PM TP2 DEADLINE** — Close any remaining runner positions from morning trades.' },
    { mins: 15 * 60, key: 'no-entries', msg: '🛑 **3:00 PM** — No new 0DTE entries from this point.' },
    { mins: 15 * 60 + 30, key: 'hard-close', msg: '🚨 **3:30 PM HARD CLOSE** — Close ALL 0DTE positions NOW. No exceptions.' },
  ];

  for (const e of events) {
    if (mins >= e.mins && mins < e.mins + 2 && !globalState.fired.has(e.key)) {
      globalState.fired.add(e.key);
      await emit(e.msg);
    }
  }
}

// ─── Reset state at day boundary ─────────────────────────────────────────────

function maybeResetState() {
  const today = todayET();
  if (sessionDate !== today) {
    sessionDate = today;
    for (const sym of SYMBOLS) {
      state[sym] = {
        lastPrice: null, lastVWAP: null, lastMA1: null, lastMA2: null,
        knownFVGKeys: new Set(), activeZoneKey: null,
        prevClose: null, gapAlertFired: false, firedTimeEvents: new Set(),
      };
    }
    state.__time = { fired: new Set() };
    console.log(`[RESET] New session: ${today}`);
  }
}

// ─── Main loop ───────────────────────────────────────────────────────────────

async function tick() {
  maybeResetState();

  if (!isWeekday()) return;

  const mins = timeMins();
  // Only run during 9:15 AM – 4:00 PM ET (covers pre-open to close)
  if (mins < 9 * 60 + 15 || mins > 16 * 60) return;

  try {
    await checkTimeEvents();
    for (let i = 0; i < SYMBOLS.length; i++) {
      await checkSymbol(SYMBOLS[i]);
      if (i < SYMBOLS.length - 1) await new Promise(r => setTimeout(r, 1500));
    }
  } catch (err) {
    console.error(`[ERROR] tick failed: ${err.message}`);
  }
}

console.log('🎙  FVG Live Commentary started');
console.log('   Symbols: SPY + QQQ');
console.log('   Poll:    every 1 minute');
console.log('   Events:  VWAP cross, EMA flip, new FVG, zone entry/exit, time-based\n');

tick();
setInterval(tick, POLL_INTERVAL_MS);
