import CDP from 'chrome-remote-interface';
const resp = await fetch('http://localhost:9222/json/list');
const targets = await resp.json();
const tab = targets.find(t => t.type === 'page' && t.url.includes('/chart/o6Tc3OIX'));
const c = await CDP({ host: 'localhost', port: 9222, target: tab.id });
await c.Runtime.enable();

const r = await c.Runtime.evaluate({
  expression: `
    (function() {
      var w = window.TradingViewApi._chartWidgetCollection.getAll()[1];
      if (w && w._mainDiv) w._mainDiv.click();
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      var shapes = api.getAllShapes();
      var out = [];
      for (var i = 0; i < shapes.length; i++) {
        try {
          var s = api.getShapeById(shapes[i].id);
          var props = s && s.getProperties ? s.getProperties() : null;
          var text = props && props.text ? String(props.text) : '';
          if (text.indexOf('[auto] ') === 0) {
            // Also get points
            var pts = s.getPoints ? s.getPoints() : [];
            var prices = pts.map(function(p) { return p.price; });
            out.push({ text: text, minPrice: Math.min.apply(null, prices), maxPrice: Math.max.apply(null, prices) });
          }
        } catch(e) {}
      }
      return out;
    })()
  `,
  returnByValue: true,
});
const shapes = r.result.value;
console.log(`Total auto-drawn: ${shapes.length}`);
shapes.sort((a, b) => a.minPrice - b.minPrice);
for (const s of shapes) {
  console.log(`  [${s.minPrice.toFixed(2)} - ${s.maxPrice.toFixed(2)}]  ${s.text}`);
}
await c.close();
process.exit(0);
