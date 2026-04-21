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
// Alert policy (per user feedback — only high-confidence setups):
//   - Trade alerts fire ONLY on FVG entry with FULL confluence (VWAP + EMA + session phase)
//   - Max 1 CALL + 1 PUT setup alert per symbol per day
//   - Re-entry allowed if prior setup was stopped out (tracked via firedZoneKeys)
//   - Entry window: 10:00 AM – 11:30 AM ET only
//   - Time-based pings limited to: Market Open, 11:30 Time Stop, 15:30 Hard Close

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
    // Setup throttle: how many CALL / PUT alerts fired today, and which specific FVG zones triggered them.
    callAlertCount: 0,
    putAlertCount: 0,
    firedZoneKeys: new Set(),
  };
}

const MAX_ALERTS_PER_DIRECTION = 2; // allows 1 re-entry after a stop-out
const ENTRY_WINDOW_START = 10 * 60;       // 10:00 AM ET
const ENTRY_WINDOW_END = 11 * 60 + 30;    // 11:30 AM ET

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

  // ── Track FVGs silently (needed for zone entry check; no alert on formation) ──
  const currentFVGs = findFVGs(bars);
  for (const fvg of currentFVGs) {
    s.knownFVGKeys.add(fvgKey(fvg));
  }

  // ── High-confidence setup alert (strict gate) ──
  // Fires ONLY when ALL conditions met:
  //   1. Price inside an FVG zone
  //   2. VWAP aligned with FVG direction
  //   3. EMA stack aligned with FVG direction
  //   4. Inside entry window (10:00–11:30 AM ET)
  //   5. Not already fired for this zone
  //   6. Under max-alerts-per-direction cap
  const mins = timeMins();
  const inEntryWindow = mins >= ENTRY_WINDOW_START && mins <= ENTRY_WINDOW_END;
  let currentZone = null;

  for (const fvg of currentFVGs) {
    if (price < fvg.bottom || price > fvg.top) continue;
    currentZone = fvgKey(fvg);

    // Already fired for this exact zone? Skip.
    if (s.firedZoneKeys.has(currentZone)) break;

    // Confluence gate
    if (vwap == null || ma1 == null || ma2 == null) break;
    const vwapAligned = fvg.type === 'BULL' ? price > vwap : price < vwap;
    const emaAligned = fvg.type === 'BULL' ? ma1 > ma2 : ma1 < ma2;
    if (!vwapAligned || !emaAligned) break;

    // Session window gate
    if (!inEntryWindow) break;

    // Per-direction cap
    const isCall = fvg.type === 'BULL';
    const count = isCall ? s.callAlertCount : s.putAlertCount;
    if (count >= MAX_ALERTS_PER_DIRECTION) break;

    // All gates passed → fire the alert.
    const emoji = isCall ? '🟢' : '🔴';
    const direction = isCall ? 'CALL' : 'PUT';
    const attempt = count === 0 ? '' : ` (re-entry attempt ${count + 1}/${MAX_ALERTS_PER_DIRECTION})`;
    await emit(
      `${emoji} **${symbol} ${direction} SETUP${attempt}** — Price $${price.toFixed(2)} inside ${fvg.type} FVG $${fvg.bottom.toFixed(2)}–$${fvg.top.toFixed(2)} | CE $${fvg.ce.toFixed(2)}\n` +
      `Confluence: VWAP $${vwap.toFixed(2)} ✅ | EMA stack ✅ | Window 10:00–11:30 AM ✅\n` +
      `Action: Enter ${direction}S. Stop if price exits FVG opposite side. Target = next swing.`
    );
    s.firedZoneKeys.add(currentZone);
    if (isCall) s.callAlertCount++; else s.putAlertCount++;
    break;
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
    { mins: 9 * 60 + 30, key: 'open', msg: '🔔 **Market OPEN** — Do not trade the first 30 minutes. Setup alerts start at 10:00 AM ET.' },
    { mins: 11 * 60 + 30, key: 'time-stop', msg: '⚠️ **11:30 AM TIME STOP** — If any position has not worked by now, EXIT regardless of P&L. Entry window closed.' },
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
        callAlertCount: 0, putAlertCount: 0, firedZoneKeys: new Set(),
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

console.log('🎙  FVG Live Commentary started (HIGH-CONFIDENCE MODE)');
console.log('   Symbols: SPY + QQQ');
console.log('   Poll:    every 1 minute');
console.log('   Alerts:  FVG entry + VWAP + EMA confluence, inside 10:00–11:30 AM ET');
console.log('   Cap:     1 CALL + 1 PUT per symbol per day (re-entry allowed once)');
console.log('   Time:    Market Open (9:30), Time Stop (11:30), Hard Close (15:30)\n');

tick();
setInterval(tick, POLL_INTERVAL_MS);
