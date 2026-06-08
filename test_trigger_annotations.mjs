/**
 * test_trigger_annotations.mjs — test that premarket_setup's trigger-line
 * drawing works end-to-end using mock entry_notes (market is closed so
 * live analysis returns NO_TRADE right now).
 *
 * Injects mock SPY + QQQ entry_notes and calls processTab via import,
 * then verifies the lines landed on both tabs.
 */
import CDP from 'chrome-remote-interface';

const CDP_HOST = 'localhost', CDP_PORT = 9222;
const TRIGGER_A_COLOR = '#ff9500';
const TRIGGER_B_COLOR = '#c77dff';

// Use yesterday's live values that I know are correct (from the morning run).
const MOCK_JSON = {
  final: {
    SPY: {
      entry_notes: {
        direction: 'CALLS',
        trigger_a: { entry: 710.40, stop: 707.07, T1: 712.04, T2: 713.68 },
        trigger_b: { entry_vwap: 706.42, entry_ema21_1H: 707.63, stop: 705.86, T1: 708.75, T2: 712.04 },
      },
    },
    QQQ: {
      entry_notes: {
        direction: 'CALLS',
        trigger_a: { entry: 649.09, stop: 646.79, T1: 652.28, T2: 655.47 },
        trigger_b: { entry_vwap: 646.32, entry_ema21_1H: 647.44, stop: 645.67, T1: 649.71, T2: 652.28 },
      },
    },
  },
};

const TARGETS = [
  { match: 'BATS:SPY', key: 'SPY' },
  { match: 'BATS:QQQ', key: 'QQQ' },
];

async function drawForTab(tabId, tickerKey, entryNotes) {
  const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: tabId });
  await client.Runtime.enable();
  async function run(expr) {
    const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }

  // Focus pane 1
  await run(`
    (function() {
      var w = window.TradingViewApi._chartWidgetCollection.getAll()[1];
      if (w && w._mainDiv) w._mainDiv.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 600));

  const lastTime = await run(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var bars = chart._chartWidget.model().mainSeries().bars();
      var v = bars.valueAt(bars.lastIndex());
      return v ? v[0] : Math.floor(Date.now()/1000);
    })()
  `);

  const lines = [];
  const a = entryNotes.trigger_a;
  if (a) {
    if (a.entry != null) lines.push({ price: a.entry, label: `[T-A] ${tickerKey} Entry ${a.entry}`, color: TRIGGER_A_COLOR, style: 'solid' });
    if (a.stop != null)  lines.push({ price: a.stop,  label: `[T-A] ${tickerKey} Stop ${a.stop}`,   color: TRIGGER_A_COLOR, style: 'dashed' });
    if (a.T1 != null)    lines.push({ price: a.T1,    label: `[T-A] ${tickerKey} T1 ${a.T1}`,       color: TRIGGER_A_COLOR, style: 'solid' });
    if (a.T2 != null)    lines.push({ price: a.T2,    label: `[T-A] ${tickerKey} T2 ${a.T2}`,       color: TRIGGER_A_COLOR, style: 'solid' });
  }
  const b = entryNotes.trigger_b;
  if (b) {
    if (b.entry_vwap != null)    lines.push({ price: b.entry_vwap,     label: `[T-B] ${tickerKey} Entry VWAP ${b.entry_vwap}`,    color: TRIGGER_B_COLOR, style: 'solid' });
    if (b.entry_ema21_1H != null) lines.push({ price: b.entry_ema21_1H, label: `[T-B] ${tickerKey} Entry EMA21 ${b.entry_ema21_1H}`, color: TRIGGER_B_COLOR, style: 'solid' });
    if (b.stop != null)          lines.push({ price: b.stop,           label: `[T-B] ${tickerKey} Stop ${b.stop}`,                 color: TRIGGER_B_COLOR, style: 'dashed' });
    if (b.T1 != null)            lines.push({ price: b.T1,             label: `[T-B] ${tickerKey} T1 ${b.T1}`,                     color: TRIGGER_B_COLOR, style: 'solid' });
    if (b.T2 != null)            lines.push({ price: b.T2,             label: `[T-B] ${tickerKey} T2 ${b.T2}`,                     color: TRIGGER_B_COLOR, style: 'solid' });
  }

  let drawn = 0;
  for (const ln of lines) {
    const style = ln.style === 'dashed' ? 2 : 0;
    try {
      await run(`
        (function() {
          var api = window.TradingViewApi._activeChartWidgetWV.value();
          api.createMultipointShape(
            [{ time: ${lastTime}, price: ${ln.price} }],
            { shape: 'horizontal_line', text: ${JSON.stringify(ln.label)},
              overrides: {
                linecolor: '${ln.color}', linewidth: 2, linestyle: ${style},
                showLabel: true, textcolor: '${ln.color}', fontsize: 11,
                horzLabelsAlign: 'right', vertLabelsAlign: 'top', showPrice: true,
              } }
          );
        })()
      `);
      drawn++;
    } catch (e) { console.log(`  failed: ${ln.label} — ${e.message.slice(0,80)}`); }
    await new Promise(r => setTimeout(r, 80));
  }
  console.log(`  ${tickerKey}: drew ${drawn}/${lines.length} trigger lines`);
  await client.close();
}

const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
const targets = await resp.json();
for (const target of TARGETS) {
  // Find tab whose pane 0 symbol matches
  for (const tab of targets.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))) {
    const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: tab.id });
    await client.Runtime.enable();
    const sym = await client.Runtime.evaluate({
      expression: `
        (function() {
          var w = window.TradingViewApi._chartWidgetCollection.getAll()[0];
          try { return w.model().mainSeries().symbol(); } catch(e) { return ''; }
        })()
      `, returnByValue: true,
    }).then(r => r.result.value).catch(() => '');
    await client.close();
    if (sym === target.match) {
      console.log(`\n── ${target.key} (tab ${tab.url.split('/').slice(-2)[0]}) ──`);
      await drawForTab(tab.id, target.key, MOCK_JSON.final[target.key].entry_notes);
      break;
    }
  }
}
console.log('\n✅ Mock test complete — check SPY and QQQ charts.');
process.exit(0);
