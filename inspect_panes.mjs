import CDP from 'chrome-remote-interface';
const resp = await fetch('http://localhost:9222/json/list');
const targets = await resp.json();
const tabs = targets.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));

for (const tab of tabs) {
  console.log(`\n━━━ Tab: ${tab.url} ━━━`);
  const c = await CDP({ host: 'localhost', port: 9222, target: tab.id });
  await c.Runtime.enable();

  async function run(expr) {
    const r = await c.Runtime.evaluate({ expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }

  // Enumerate panes and their shapes — try multiple internal paths
  const paneShapes = await run(`
    (function() {
      var all = window.TradingViewApi._chartWidgetCollection.getAll();
      var out = [];
      for (var i = 0; i < all.length; i++) {
        var w = all[i];
        var sym = '', res = '', shapes = [];
        try { sym = w.model().mainSeries().symbol(); } catch(e) {}
        try { res = w.model().mainSeries().properties().resolution ? w.model().mainSeries().properties().resolution().value() : ''; } catch(e) {}
        try {
          var model = w.model();
          var sources = [];
          // Try lineToolsAndGroups
          try {
            var ls = model.lineToolsAndGroups ? model.lineToolsAndGroups() : null;
            if (ls) {
              if (ls.getAll) sources = ls.getAll();
              else if (ls._all) sources = Object.values(ls._all);
              else if (ls._map) sources = Array.from(ls._map.values());
            }
          } catch(e) {}
          // Fallback: scan dataSources
          if (!sources.length) {
            try {
              var ds = model._dataSources || (model.dataSources && model.dataSources());
              if (ds) {
                if (typeof ds === 'function') ds = ds();
                if (Array.isArray(ds)) sources = ds;
                else if (ds._map) sources = Array.from(ds._map.values());
                else sources = Object.values(ds);
              }
            } catch(e) {}
          }
          // Final fallback: model.dataSources() via iterator
          if (!sources.length) {
            try {
              var iter = model.dataSources();
              sources = [];
              if (iter && iter[Symbol.iterator]) for (var x of iter) sources.push(x);
              else if (Array.isArray(iter)) sources = iter;
            } catch(e) {}
          }
          for (var j = 0; j < sources.length; j++) {
            var s = sources[j];
            var name = '', text = '', id = '';
            try { name = typeof s.name === 'function' ? s.name() : (s.name || s._name || ''); } catch(e) {}
            try {
              var props = s.properties && s.properties();
              if (props) {
                if (props.child && typeof props.child === 'function') {
                  try { var t = props.child('text'); if (t && t.value) text = t.value() || ''; } catch(e) {}
                }
                if (!text && props.text && typeof props.text === 'function') {
                  try { text = props.text().value() || ''; } catch(e) {}
                }
              }
            } catch(e) {}
            try { id = typeof s.id === 'function' ? s.id() : (s.id || s._id || ''); } catch(e) {}
            // Only keep things that look like line tools / shapes (not the main series / study)
            var isShape = s._lineSource !== undefined
              || (name && /^(rectangle|trend|horizontal|vertical|extended|ray|text|arrow|callout|label|price_label|ellipse|triangle|path|polyline|brush|rotated|note|pitchfork|fib|gann|cycle|range|schiff|head|elliott|forecast|projection|anchored|parallel|regression|signpost|balloon|icon|emoji|sticker|flag|cross_line|price_line|disjoint_channel|highlighter)/i.test(name))
              || (s.pointsProperty || s._points);
            if (isShape) shapes.push({ name: name, text: text, id: String(id) });
          }
        } catch(e) {}
        out.push({ paneIndex: i, symbol: sym, resolution: res, shapeCount: shapes.length, shapes: shapes });
      }
      return out;
    })()
  `);

  for (const p of paneShapes) {
    console.log(`  [${p.paneIndex}] ${p.symbol} @ ${p.resolution} — ${p.shapeCount} shape(s)`);
    const byName = {};
    for (const s of p.shapes) byName[s.name] = (byName[s.name] || 0) + 1;
    if (Object.keys(byName).length) console.log(`       types: ${JSON.stringify(byName)}`);
    const autos = p.shapes.filter(s => s.text && s.text.indexOf('[auto] ') === 0).length;
    const hands = p.shapeCount - autos;
    if (p.shapeCount) console.log(`       auto: ${autos}, hand-drawn: ${hands}`);
    const handSamples = p.shapes.filter(s => !s.text || s.text.indexOf('[auto] ') !== 0).slice(0, 5);
    if (handSamples.length) {
      console.log(`       hand samples: ${handSamples.map(s => `${s.name}${s.text ? `("${s.text.slice(0,40)}")` : ''}`).join(', ')}`);
    }
  }

  await c.close();
}
process.exit(0);
