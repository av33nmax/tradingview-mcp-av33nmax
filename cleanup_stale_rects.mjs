/**
 * cleanup_stale_rects.mjs — delete rectangles matching the script's label pattern
 * but missing the [auto] prefix (leftover from old script versions).
 * Usage: node cleanup_stale_rects.mjs <tabUrlFragment>
 */
import CDP from 'chrome-remote-interface';

const tabFragment = process.argv[2] || '/chart/PbLW86HI';  // default: SPY tab
const OLD_PATTERN = /^(FVG[↑↓]|[RS]) /;  // legacy auto-label pattern without [auto] prefix

const resp = await fetch('http://localhost:9222/json/list');
const targets = await resp.json();
const tab = targets.find(t => t.type === 'page' && t.url.includes(tabFragment));
if (!tab) {
  console.error(`Tab not found matching "${tabFragment}"`);
  process.exit(1);
}
console.log(`Target tab: ${tab.url}`);

const c = await CDP({ host: 'localhost', port: 9222, target: tab.id });
await c.Runtime.enable();

async function run(expr) {
  const r = await c.Runtime.evaluate({ expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

// Use a single active widget — drawings are layout-shared in this TV build
const result = await run(`
  (function() {
    var w = window.TradingViewApi._chartWidgetCollection.getAll()[0];
    if (w && w._mainDiv) w._mainDiv.click();
    var api = window.TradingViewApi._activeChartWidgetWV.value();
    var shapes = api.getAllShapes();
    var pattern = ${OLD_PATTERN.toString()};
    var toRemove = [];
    for (var i = 0; i < shapes.length; i++) {
      try {
        if ((shapes[i].name || '').toLowerCase().indexOf('rectangle') < 0) continue;
        var s = api.getShapeById(shapes[i].id);
        var props = s && s.getProperties ? s.getProperties() : null;
        var text = props && props.text ? String(props.text) : '';
        if (text.indexOf('[auto] ') === 0) continue;  // keep current-format auto
        if (pattern.test(text)) toRemove.push({ id: shapes[i].id, text: text });
      } catch(e) {}
    }
    var removed = 0;
    for (var k = 0; k < toRemove.length; k++) {
      try { api.removeEntity(toRemove[k].id); removed++; } catch(e) {}
    }
    return { removedCount: removed, removedLabels: toRemove.map(function(r) { return r.text; }) };
  })()
`);

console.log(`Removed ${result.removedCount} stale rectangles:`);
for (const t of result.removedLabels) console.log(`  - ${t}`);

await c.close();
process.exit(0);
