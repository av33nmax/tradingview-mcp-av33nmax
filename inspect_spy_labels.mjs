import CDP from 'chrome-remote-interface';
const resp = await fetch('http://localhost:9222/json/list');
const targets = await resp.json();
const tab = targets.find(t => t.type === 'page' && t.url.includes('/chart/PbLW86HI'));
const c = await CDP({ host: 'localhost', port: 9222, target: tab.id });
await c.Runtime.enable();

const r = await c.Runtime.evaluate({
  expression: `
    (function() {
      var w = window.TradingViewApi._chartWidgetCollection.getAll()[0];
      if (w && w._mainDiv) w._mainDiv.click();
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      var shapes = api.getAllShapes();
      var out = [];
      for (var i = 0; i < shapes.length; i++) {
        try {
          var s = api.getShapeById(shapes[i].id);
          var props = s && s.getProperties ? s.getProperties() : null;
          var text = props && props.text ? String(props.text) : '';
          var pts = s.getPoints ? s.getPoints() : [];
          var prices = pts.map(function(p) { return p.price; });
          out.push({
            id: shapes[i].id,
            name: shapes[i].name || '',
            text: text,
            minPrice: prices.length ? Math.min.apply(null, prices) : null,
            maxPrice: prices.length ? Math.max.apply(null, prices) : null,
          });
        } catch(e) {}
      }
      return out;
    })()
  `,
  returnByValue: true,
});
const shapes = r.result.value;

// Group by label pattern
const withAutoPrefix = shapes.filter(s => s.text.startsWith('[auto] '));
const oldPattern = shapes.filter(s => !s.text.startsWith('[auto] ') && /^(FVG[↑↓]|[RS]) /.test(s.text));
const truly_hand = shapes.filter(s => !s.text.startsWith('[auto] ') && !/^(FVG[↑↓]|[RS]) /.test(s.text));

console.log(`Total shapes on SPY pane 0: ${shapes.length}`);
console.log(`\n── Current-format auto ([auto] prefix, ${withAutoPrefix.length}):`);
for (const s of withAutoPrefix.sort((a,b) => (a.minPrice||0) - (b.minPrice||0))) {
  console.log(`  [${(s.minPrice||0).toFixed(2)}-${(s.maxPrice||0).toFixed(2)}]  ${s.text}`);
}
console.log(`\n── Old-format auto (matches script label pattern, ${oldPattern.length} — candidates to delete):`);
for (const s of oldPattern.sort((a,b) => (a.minPrice||0) - (b.minPrice||0))) {
  console.log(`  [${(s.minPrice||0).toFixed(2)}-${(s.maxPrice||0).toFixed(2)}]  ${s.text}`);
}
console.log(`\n── Truly hand-drawn / other (keep, ${truly_hand.length}):`);
for (const s of truly_hand) {
  console.log(`  ${s.name}${s.text ? ` "${s.text.slice(0,60)}"` : ''}  [${(s.minPrice||0).toFixed(2)}-${(s.maxPrice||0).toFixed(2)}]`);
}
await c.close();
process.exit(0);
