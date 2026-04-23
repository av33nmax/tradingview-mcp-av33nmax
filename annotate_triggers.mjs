/**
 * annotate_triggers.mjs — one-off: draw Trigger A and Trigger B levels
 * on the SPY chart as labelled horizontal lines in different colors.
 * Also pulls SPY's RTH 5m bars to report actual vs plan.
 *
 * Colors:
 *   Trigger A: ORANGE  (breakout play)
 *   Trigger B: PURPLE  (pullback play)
 *
 * Labels are prefixed "[T-A]" / "[T-B]" so they're easy to identify and remove.
 * These labels are NOT matched by premarket_setup.mjs cleanup, so they persist
 * until you remove them manually.
 */
import CDP from 'chrome-remote-interface';

// From morning pre-market plan (2026-04-22 7:11 AM ET)
const TRIGGER_A = {
  name: 'T-A  ORB breakout',
  color: '#ff9500',  // orange
  colorFill: 'rgba(255, 149, 0, 0.18)',
  levels: [
    { label: 'T-A Entry 710.40', price: 710.40, style: 'solid' },
    { label: 'T-A Stop 707.07',  price: 707.07, style: 'dashed' },
    { label: 'T-A T1 712.04',    price: 712.04, style: 'solid' },
    { label: 'T-A T2 713.68',    price: 713.68, style: 'solid' },
  ],
};

const TRIGGER_B = {
  name: 'T-B  Pullback',
  color: '#c77dff',  // purple
  colorFill: 'rgba(199, 125, 255, 0.18)',
  levels: [
    { label: 'T-B Entry VWAP 706.42',   price: 706.42, style: 'solid' },
    { label: 'T-B Entry EMA21 707.63',  price: 707.63, style: 'solid' },
    { label: 'T-B Stop 705.86',         price: 705.86, style: 'dashed' },
    { label: 'T-B T1 708.75',           price: 708.75, style: 'solid' },
    { label: 'T-B T2 712.04',           price: 712.04, style: 'solid' },
  ],
};

const resp = await fetch('http://localhost:9222/json/list');
const targets = await resp.json();
const tab = targets.find(t => t.type === 'page' && t.url.includes('/chart/PbLW86HI'));  // SPY tab
if (!tab) { console.error('SPY tab not found'); process.exit(1); }

const c = await CDP({ host: 'localhost', port: 9222, target: tab.id });
await c.Runtime.enable();
await c.Page?.bringToFront?.().catch(() => {});
await new Promise(r => setTimeout(r, 1500));

async function run(expr) {
  const r = await c.Runtime.evaluate({ expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

// Focus pane 1 (15m) — drawings layout-shared
await run(`
  (function() {
    var w = window.TradingViewApi._chartWidgetCollection.getAll()[1];
    if (w && w._mainDiv) w._mainDiv.click();
  })()
`);
await new Promise(r => setTimeout(r, 800));

// ─── Pull SPY RTH 5m bars for 2026-04-22 ───
// Switch briefly to 5m for granularity
const origRes = await run(`window.TradingViewApi._activeChartWidgetWV.value().resolution()`);
if (origRes !== '5') {
  await run(`window.TradingViewApi._activeChartWidgetWV.value().setResolution('5')`);
  await new Promise(r => setTimeout(r, 2500));
}

const data = await run(`
  (function() {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var bars = chart._chartWidget.model().mainSeries().bars();
    var out = [];
    var end = bars.lastIndex();
    var start = Math.max(bars.firstIndex(), end - 200);
    for (var i = start; i <= end; i++) {
      var v = bars.valueAt(i);
      if (v) out.push([v[0], v[1], v[2], v[3], v[4], v[5] || 0]);
    }
    return { sym: chart.symbol(), bars: out };
  })()
`);

// Filter to 2026-04-22 RTH (ET 9:30 - 16:00 = UTC 13:30 - 20:00)
const rthBars = data.bars.filter(([t]) => {
  const d = new Date(t * 1000);
  const iso = d.toISOString();
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return iso.startsWith('2026-04-22') && m >= 13 * 60 + 30 && m <= 20 * 60;
});

const lastTime = data.bars.length ? data.bars[data.bars.length - 1][0] : Math.floor(Date.now() / 1000);
const anchorTime = rthBars.length ? rthBars[0][0] : lastTime - 3600 * 2;
const extendTo = lastTime + 7 * 24 * 3600;

// ─── Restore original resolution before drawing (so lines anchor at 15m view) ───
if (origRes !== '5') {
  await run(`window.TradingViewApi._activeChartWidgetWV.value().setResolution('${origRes}')`);
  await new Promise(r => setTimeout(r, 1500));
}

// ─── Draw horizontal lines ───
async function drawLine(time, price, label, color, style) {
  // style: 0=solid, 1=dotted, 2=dashed (TV line style codes)
  const styleCode = style === 'dashed' ? 2 : (style === 'dotted' ? 1 : 0);
  try {
    await run(`
      (function() {
        var api = window.TradingViewApi._activeChartWidgetWV.value();
        api.createMultipointShape(
          [{ time: ${time}, price: ${price} }],
          {
            shape: 'horizontal_line',
            text: ${JSON.stringify(label)},
            overrides: {
              linecolor: '${color}',
              linewidth: 2,
              linestyle: ${styleCode},
              showLabel: true,
              textcolor: '${color}',
              fontsize: 11,
              bold: false,
              horzLabelsAlign: 'right',
              vertLabelsAlign: 'top',
              showPrice: true,
            }
          }
        );
      })()
    `);
    return true;
  } catch (e) {
    console.log(`  failed: ${label} — ${e.message.slice(0, 100)}`);
    return false;
  }
}

console.log(`\nDrawing Trigger A (${TRIGGER_A.color} orange) levels...`);
let drawn = 0;
for (const lvl of TRIGGER_A.levels) {
  const ok = await drawLine(anchorTime, lvl.price, lvl.label, TRIGGER_A.color, lvl.style);
  if (ok) drawn++;
  await new Promise(r => setTimeout(r, 80));
}

console.log(`Drawing Trigger B (${TRIGGER_B.color} purple) levels...`);
for (const lvl of TRIGGER_B.levels) {
  const ok = await drawLine(anchorTime, lvl.price, lvl.label, TRIGGER_B.color, lvl.style);
  if (ok) drawn++;
  await new Promise(r => setTimeout(r, 80));
}
console.log(`Drew ${drawn} horizontal lines total.`);

// ─── Report SPY's RTH path vs triggers ───
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  SPY RTH path 2026-04-22 vs Trigger A / Trigger B');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
if (rthBars.length === 0) {
  console.log('No RTH bars found — possibly pre-market or chart data incomplete.');
} else {
  const open = rthBars[0][1];
  const high = Math.max(...rthBars.map(b => b[2]));
  const low = Math.min(...rthBars.map(b => b[3]));
  const close = rthBars[rthBars.length - 1][4];
  const highBar = rthBars.find(b => b[2] === high);
  const lowBar = rthBars.find(b => b[3] === low);
  function etTime(t) {
    const et = new Date(t * 1000 - 4 * 3600 * 1000);
    return et.toISOString().slice(11, 16);
  }
  console.log(`RTH bars: ${rthBars.length} (5m) · Open ${open.toFixed(2)}  High ${high.toFixed(2)} @${etTime(highBar[0])}  Low ${low.toFixed(2)} @${etTime(lowBar[0])}  Last ${close.toFixed(2)}`);

  // ORB 9:30-9:45 (3 × 5m bars)
  const orb = rthBars.slice(0, 3);
  if (orb.length === 3) {
    const orbHigh = Math.max(...orb.map(b => b[2]));
    const orbLow = Math.min(...orb.map(b => b[3]));
    console.log(`RTH ORB (9:30-9:45): ${orbLow.toFixed(2)} - ${orbHigh.toFixed(2)}`);
  }

  // Trigger A evaluation (5m close > 710.40)
  const aFired = rthBars.find(b => b[4] > TRIGGER_A.levels[0].price);
  console.log(`\n── Trigger A (entry > 710.40) ──`);
  if (aFired) {
    console.log(`  FIRED at ${etTime(aFired[0])} ET · 5m close ${aFired[4].toFixed(2)}`);
    // After firing, did price reach T1/T2 or stop?
    const postA = rthBars.filter(b => b[0] >= aFired[0]);
    const hitT1 = postA.find(b => b[2] >= 712.04);
    const hitT2 = postA.find(b => b[2] >= 713.68);
    const hitStop = postA.find(b => b[3] <= 707.07);
    console.log(`  T1 712.04 → ${hitT1 ? `HIT at ${etTime(hitT1[0])}` : 'NEVER HIT'}`);
    console.log(`  T2 713.68 → ${hitT2 ? `HIT at ${etTime(hitT2[0])}` : 'NEVER HIT'}`);
    console.log(`  Stop 707.07 → ${hitStop ? `HIT at ${etTime(hitStop[0])} (STOPPED OUT)` : 'NEVER HIT'}`);
    const postHigh = Math.max(...postA.map(b => b[2]));
    const postLow = Math.min(...postA.map(b => b[3]));
    console.log(`  Post-entry range: low ${postLow.toFixed(2)}  high ${postHigh.toFixed(2)}`);
  } else {
    console.log(`  NEVER FIRED — no 5m close above 710.40 during RTH`);
  }

  // Trigger B evaluation (tag VWAP 706.42 or EMA21 707.63)
  console.log(`\n── Trigger B (pullback to 706.42 VWAP or 707.63 EMA21) ──`);
  const bFiredVwap = rthBars.find(b => b[3] <= 706.42);
  const bFiredEma = rthBars.find(b => b[3] <= 707.63);
  if (bFiredEma) {
    console.log(`  Price tagged EMA21 (707.63) at ${etTime(bFiredEma[0])} — low ${bFiredEma[3].toFixed(2)}`);
  }
  if (bFiredVwap) {
    console.log(`  Price tagged VWAP (706.42) at ${etTime(bFiredVwap[0])} — low ${bFiredVwap[3].toFixed(2)}`);
  }
  if (!bFiredEma && !bFiredVwap) {
    console.log(`  NEVER TAGGED — session low was ${low.toFixed(2)}, didn't reach 707.63`);
  }
}

await c.close();
console.log('\n✅ Lines drawn. Review on SPY chart.');
console.log('   Labels use prefixes [T-A] (orange) and [T-B] (purple) — they persist through future pre-market runs.');
process.exit(0);
