import CDP from 'chrome-remote-interface';
import fs from 'node:fs';

const resp = await fetch('http://localhost:9222/json/list');
const targets = await resp.json();
const tab = targets.find(t => t.type === 'page' && t.url.includes('/chart/o6Tc3OIX'));
const c = await CDP({ host: 'localhost', port: 9222, target: tab.id });
await c.Runtime.enable();
await c.Page?.enable?.();
await c.Page?.bringToFront?.().catch(() => {});
await new Promise(r => setTimeout(r, 500));

async function run(expr, awaitPromise = false) {
  const r = await c.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) return { err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return { value: r.result?.value };
}

// 1. Scan window for trading-related services
const services = await run(`
  (function() {
    var keys = Object.keys(window);
    var rel = keys.filter(function(k) {
      return /trad|broker|order|position|account|ibkr|interactive/i.test(k);
    });
    var tvKeys = window.TradingViewApi ? Object.keys(window.TradingViewApi) : [];
    var tvTradingKeys = tvKeys.filter(function(k) { return /trad|broker|order|position/i.test(k); });
    return { windowKeys: rel, tvApiTradingKeys: tvTradingKeys };
  })()
`);
console.log('Services scan:', JSON.stringify(services, null, 2));

// 2. Inspect any broker service
const brokerInspect = await run(`
  (function() {
    var out = {};
    try {
      var bs = window.TradingViewApi && window.TradingViewApi._brokerService;
      if (bs) {
        out._brokerService_keys = Object.keys(bs);
      }
    } catch(e) {}
    try {
      // common path: trading host / broker-hub
      var hub = window.TradingViewApi && window.TradingViewApi._brokerHub;
      if (hub) out._brokerHub_keys = Object.keys(hub);
    } catch(e) {}
    try {
      // try all widget chart collection for trading adapter
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      var adapterKeys = api._tradingHost ? Object.keys(api._tradingHost) : null;
      if (adapterKeys) out.tradingHost_keys = adapterKeys;
    } catch(e) {}
    return out;
  })()
`);
console.log('\nBroker inspect:', JSON.stringify(brokerInspect, null, 2));

// 3. DOM scan — trading panel has classes like "bottom-widgetbar", "tradingpanel", etc.
const domScan = await run(`
  (function() {
    var out = { panelFound: false, orderRows: [], positionRows: [], positionTableText: '' };
    // Typical selectors used by TradingView trading panel
    var panelSelectors = [
      '[data-name="bottom-widget-bar"]',
      '[data-name="trading-panel"]',
      '.tv-feed__row',
      '[class*="tradingPanel"]',
      '[class*="trading-panel"]',
    ];
    var panel = null;
    for (var i = 0; i < panelSelectors.length; i++) {
      var el = document.querySelector(panelSelectors[i]);
      if (el) { panel = el; out.panelFound = true; out.panelSelector = panelSelectors[i]; break; }
    }
    if (!panel) panel = document.body;

    // Find rows that look like positions / orders
    var rows = panel.querySelectorAll('[role="row"], .row, [class*="row"]');
    var seen = new Set();
    for (var r = 0; r < Math.min(rows.length, 150); r++) {
      var txt = (rows[r].textContent || '').trim().replace(/\\s+/g, ' ');
      if (!txt || txt.length > 500) continue;
      if (/QQQ|SPY|NQ|ES|CALL|PUT|BUY|SELL|LONG|SHORT/i.test(txt)) {
        if (seen.has(txt)) continue;
        seen.add(txt);
        out.orderRows.push(txt);
      }
    }

    // Look for tabs / buttons showing "Positions", "Orders", "Account Summary", etc.
    var tabs = document.querySelectorAll('[role="tab"], button');
    var tabLabels = [];
    for (var t = 0; t < tabs.length; t++) {
      var tt = (tabs[t].textContent || '').trim();
      if (tt && tt.length < 40 && /position|order|account|activity|history|fill|trade|pnl|summary/i.test(tt)) {
        tabLabels.push(tt);
      }
    }
    out.tabLabels = [...new Set(tabLabels)];

    // Full text of the trading panel area (bottom of screen)
    if (panel && panel !== document.body) {
      out.panelText = (panel.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 3000);
    }
    return out;
  })()
`);
console.log('\nDOM scan:', JSON.stringify(domScan, null, 2));

// 4. Screenshot with trading panel open
await run(`
  (function() {
    // Try to click the Trade tab/button
    var btns = document.querySelectorAll('button, [role="button"], [role="tab"], a');
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || '').trim();
      if (t === 'Trade' || t === 'Account' || t === 'Positions') {
        btns[i].click();
        return 'clicked: ' + t;
      }
    }
    return 'no trade button found';
  })()
`).then(r => console.log('\nClick result:', r.value));
await new Promise(r => setTimeout(r, 1500));

const ss = await c.Page.captureScreenshot({ format: 'png' });
const file = `/Users/aveenbabu/tradingview-mcp-jackson/screenshots/qqq_trading_panel_${Date.now()}.png`;
fs.writeFileSync(file, Buffer.from(ss.data, 'base64'));
console.log('Screenshot:', file);

await c.close();
process.exit(0);
