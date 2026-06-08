#!/usr/bin/env node
/**
 * capture_aurora_zones.mjs — Daily Aurora supply/demand zone snapshot.
 *
 * Why this exists: the historical backtest uses a LuxAlgo-family proxy for
 * Aurora zones because the Aurora Pine script is encrypted and TradingView
 * only keeps ~300 bars in memory at any time. By capturing zones daily,
 * we build a real-data archive that lets us re-validate backtest assumptions
 * (e.g. did the proxy match real Aurora?) after a few months of capture.
 *
 * What it does:
 *   1. Connects to TV via CDP (port 9222)
 *   2. Iterates all chart tabs that match our 10 target tickers (6 US + 4 HK)
 *   3. For each chart, ensures the Aurora indicator (a.k.a. "Supply and Demand
 *      Zones") is visible — Pine doesn't emit box.new() primitives when the
 *      study is toggled off. If it's hidden, we setVisible(true) and wait
 *      800ms for the script to re-emit zones.
 *   4. Reads all currently-drawn box.new() primitives via the established
 *      CDP path: study._graphics._primitivesCollection.dwgboxes.get('boxes')
 *      .get(false)._primitivesDataById
 *   5. Writes the snapshot to data/aurora_history/<YYYY-MM-DD>.json
 *
 * Usage:
 *   node scripts/capture_aurora_zones.mjs                # uses today's date
 *   node scripts/capture_aurora_zones.mjs --date 2026-05-24
 *
 * No mutating side effects on the chart (we only setVisible if hidden, then
 * leave it visible — same behavior as premarket_setup.mjs).
 *
 * Schedule: not automated. Run on-demand from CLI or via dashboard button.
 * No background pollers per project rule.
 */
import CDP from 'chrome-remote-interface';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'data', 'aurora_history');

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

// 6 US + 4 HK tickers we trade. The matcher is symbol-substring (not exact
// match) so it tolerates exchange-prefix variations like 'BATS:SPY' vs
// 'NASDAQ:AAPL' vs 'HKEX:700'. The HK 4-digit codes are unambiguous enough
// that substring matching is safe.
const TARGET_SYMBOLS = {
  US: {
    SPY: 'SPY',
    QQQ: 'QQQ',
    IWM: 'IWM',
    AAPL: 'AAPL',
    NVDA: 'NVDA',
    AMZN: 'AMZN',
  },
  HK: {
    HSI: 'HSI',         // Hang Seng Index
    TENCENT: '700',     // Tencent Holdings on HKEX
    ALIBABA: '9988',    // Alibaba Group on HKEX
    XIAOMI: '1810',     // Xiaomi Corporation on HKEX
  },
};

// ─── Parse args ─────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  let date = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) {
      date = args[i + 1];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        console.error(`Invalid --date format: ${date}. Use YYYY-MM-DD.`);
        process.exit(1);
      }
    }
  }
  if (!date) {
    const d = new Date();
    date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  return { date };
}

// ─── CDP helpers ────────────────────────────────────────────────────────────
function makeRunner(client) {
  return async (expr) => {
    const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
}

async function getChartSymbol(run) {
  // Get the symbol the chart is currently displaying. Tries multiple paths
  // to be robust across TV versions.
  return await run(`
    (function() {
      try {
        var api = window.TradingViewApi._activeChartWidgetWV.value();
        if (api.symbol) return api.symbol();
        var chart = api._chartWidget;
        return chart.model().mainSeries().symbol();
      } catch(e) { return null; }
    })()
  `);
}

// Robust visibility toggle. Different TV indicator classes expose
// visibility differently: most studies have a direct `setVisible(bool)`
// method, but some (observed on IWM 2026-05-24) only expose the standard
// `properties().visible.setValue(bool)` API. Try both, in order.
//
// NOTE: This is intentionally MORE permissive than premarket_setup.mjs's
// version. Once verified working here, the premarket version should be
// updated to match — but defer that change until the capture script's
// approach proves out across multiple sessions.
async function ensureAuroraVisible(run) {
  return await run(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var sources = chart.model().model().dataSources();
      var found = 0, toggled = 0, toggleErrors = [];
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          var lc = name.toLowerCase();
          if (lc.indexOf('aurora') === -1 && lc.indexOf('supply and demand') === -1) continue;
          found++;
          var isVis = true;
          try { isVis = s.isVisible(); } catch(e) {}
          if (!isVis) {
            var didToggle = false;
            // Method 1: direct setVisible (most indicator classes)
            if (typeof s.setVisible === 'function') {
              try { s.setVisible(true); didToggle = true; } catch(e) { toggleErrors.push('setVisible: ' + e.message); }
            }
            // Method 2: properties().visible.setValue (lazy-loaded / hibernated
            // indicators on inactive tabs, e.g. IWM 2026-05-24)
            if (!didToggle) {
              try {
                var props = s.properties && s.properties();
                if (props && props.visible && typeof props.visible.setValue === 'function') {
                  props.visible.setValue(true);
                  didToggle = true;
                }
              } catch(e) { toggleErrors.push('properties: ' + e.message); }
            }
            if (didToggle) toggled++;
          }
        } catch(e) {}
      }
      return { found: found > 0, toggled: toggled, errors: toggleErrors };
    })()
  `);
}

// Mirrors premarket_setup.mjs::fetchAuroraZones — keep in sync.
async function fetchAuroraZones(run) {
  return await run(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var sources = chart.model().model().dataSources();
      var zones = [];
      var seen = {};
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          var lc = name.toLowerCase();
          if (lc.indexOf('aurora') === -1 && lc.indexOf('supply and demand') === -1) continue;
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          var outer = pc.dwgboxes;
          if (!outer) continue;
          var inner = outer.get('boxes');
          if (!inner) continue;
          var coll = inner.get(false);
          if (!coll || !coll._primitivesDataById || coll._primitivesDataById.size === 0) continue;
          coll._primitivesDataById.forEach(function(v) {
            if (v.y1 == null || v.y2 == null) return;
            var hi = Math.round(Math.max(v.y1, v.y2) * 100) / 100;
            var lo = Math.round(Math.min(v.y1, v.y2) * 100) / 100;
            // Also try to capture box color / type if exposed — useful for
            // classifying supply (red) vs demand (green) in the archive.
            var color = null;
            try { color = v.color || v.borderColor || null; } catch(e) {}
            var key = hi + ':' + lo;
            if (!seen[key]) { zones.push({ high: hi, low: lo, color: color }); seen[key] = true; }
          });
        } catch(e) {}
      }
      zones.sort(function(a, b) { return b.high - a.high; });
      return zones;
    })()
  `);
}

// Classify symbol against the target lists; returns { region, key } or null.
function classifySymbol(rawSym) {
  if (!rawSym) return null;
  const sym = String(rawSym).toUpperCase();
  for (const [region, map] of Object.entries(TARGET_SYMBOLS)) {
    for (const [key, needle] of Object.entries(map)) {
      // For HK numeric codes, require the code to appear as a token (preceded
      // by ':' or start of string) to avoid 'HSI1!' matching when we want 'HSI'.
      if (region === 'HK' && /^\d+$/.test(needle)) {
        const re = new RegExp(`(^|:|\\b)${needle}(\\b|$)`);
        if (re.test(sym)) return { region, key };
      } else if (sym.includes(needle)) {
        return { region, key };
      }
    }
  }
  return null;
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  const { date } = parseArgs();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `${date}.json`);

  console.log(`━━━ capture_aurora_zones.mjs ━━━`);
  console.log(`date: ${date}`);
  console.log(`output: ${outFile}\n`);

  // Verify CDP is reachable
  let tabs;
  try {
    const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
    tabs = await resp.json();
  } catch (e) {
    console.error(`✗ CDP unreachable at ${CDP_HOST}:${CDP_PORT}.`);
    console.error(`  Launch TradingView Desktop first (or run scripts/launch_tv_with_tabs.mjs).`);
    process.exit(2);
  }

  const chartTabs = tabs.filter((t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
  console.log(`Found ${chartTabs.length} TV chart tab(s).\n`);

  const snapshot = {
    capturedAt: new Date().toISOString(),
    date,
    source: 'TradingView CDP (real Aurora Pine indicator zones)',
    tickers: {},
  };
  const skipped = [];

  for (const tab of chartTabs) {
    let client;
    try {
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: tab.id });
      await client.Runtime.enable();
      const run = makeRunner(client);

      // Identify the symbol on this chart
      const rawSym = await getChartSymbol(run);
      const cls = classifySymbol(rawSym);
      if (!cls) {
        skipped.push({ sym: rawSym, reason: 'not in target list' });
        await client.close();
        continue;
      }

      // Already captured this ticker? (skip duplicates if user has multiple tabs)
      if (snapshot.tickers[cls.key]) {
        skipped.push({ sym: rawSym, reason: `${cls.key} already captured from another tab` });
        await client.close();
        continue;
      }

      // Ensure Aurora is visible (toggle on if hidden)
      const visStatus = await ensureAuroraVisible(run);
      if (visStatus.toggled > 0) {
        console.log(`  ${cls.key.padEnd(10)} | ${rawSym.padEnd(20)} | Aurora was hidden — toggled on (${visStatus.toggled})`);
        await new Promise((r) => setTimeout(r, 800));
      } else if (!visStatus.found) {
        console.log(`  ${cls.key.padEnd(10)} | ${rawSym.padEnd(20)} | ⚠ Aurora indicator NOT loaded — skipping`);
        skipped.push({ sym: rawSym, reason: 'Aurora not on chart' });
        await client.close();
        continue;
      }

      const zones = await fetchAuroraZones(run);
      snapshot.tickers[cls.key] = {
        rawSymbol: rawSym,
        region: cls.region,
        zoneCount: zones.length,
        zones,
      };
      console.log(`  ${cls.key.padEnd(10)} | ${rawSym.padEnd(20)} | ${zones.length} zones captured`);

      await client.close();
    } catch (e) {
      console.log(`  (error processing tab: ${e.message})`);
      try { if (client) await client.close(); } catch {}
    }
  }

  // Report any expected tickers we didn't find
  const allKeys = [...Object.keys(TARGET_SYMBOLS.US), ...Object.keys(TARGET_SYMBOLS.HK)];
  const missing = allKeys.filter((k) => !snapshot.tickers[k]);
  if (missing.length) {
    console.log(`\n⚠ Missing tickers (no chart tab found): ${missing.join(', ')}`);
  }
  if (skipped.length) {
    console.log(`\nSkipped tabs:`);
    for (const s of skipped) console.log(`  ${s.sym || '?'} — ${s.reason}`);
  }

  // Atomic write
  const tmp = outFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
  fs.renameSync(tmp, outFile);

  const totalZones = Object.values(snapshot.tickers).reduce((s, t) => s + t.zoneCount, 0);
  console.log(`\n✓ wrote ${path.basename(outFile)}: ${Object.keys(snapshot.tickers).length}/${allKeys.length} tickers, ${totalZones} zones total`);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
