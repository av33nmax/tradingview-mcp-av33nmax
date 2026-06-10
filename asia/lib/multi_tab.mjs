/**
 * asia/lib/multi_tab.mjs
 *
 * Read bars/quotes from background TradingView tabs WITHOUT switching focus.
 *
 * Pattern: open a transient CDP connection to a specific tab target by ID,
 * evaluate JS in that tab's window, close. The user's active tab is never
 * disturbed.
 *
 * Requires the user to have one tab open per reference symbol. Naming is
 * flexible — we match by the actual mainSeries().symbol() value, with
 * normalisation so "HKEX:HSI1!", "HKEX:HSImain", "HSI" all match a request
 * for "HSI".
 */

import CDP from "chrome-remote-interface";

const CDP_HOST = "localhost";
const CDP_PORT = 9222;

/**
 * List all TradingView chart tabs (raw CDP targets).
 */
export async function listTabs() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  return targets
    .filter((t) => t.type === "page" && /tradingview\.com\/chart/i.test(t.url))
    .map((t) => ({
      id: t.id,
      title: t.title.replace(/^Live stock.*charts on /, ""),
      url: t.url,
    }));
}

/**
 * Open a CDP session to a specific tab, run multiple evals on a shared
 * connection, then close. Use when you need >1 eval in a tab (e.g. read TF,
 * switch TF, poll for bars, restore TF).
 *
 * The fn receives a `run(expression, opts?)` callback that executes a single
 * eval and returns the value.
 */
export async function withTabSession(tabId, fn) {
  const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: tabId });
  try {
    await client.Runtime.enable();
    const run = async (expression, opts = {}) => {
      const r = await client.Runtime.evaluate({
        expression,
        returnByValue: true,
        awaitPromise: opts.awaitPromise ?? false,
      });
      if (r.exceptionDetails) {
        const msg =
          r.exceptionDetails.exception?.description ||
          r.exceptionDetails.text ||
          "eval error";
        throw new Error(`Tab eval failed: ${msg}`);
      }
      return r.result?.value;
    };
    return await fn(run);
  } finally {
    try {
      await client.close();
    } catch {}
  }
}

/**
 * Connect transiently, run ONE expression, close. Convenience wrapper.
 */
async function withTab(tabId, expression, { awaitPromise = false } = {}) {
  return withTabSession(tabId, async (run) => run(expression, { awaitPromise }));
}

/**
 * Get the symbol currently loaded as the ACTIVE chart in a tab.
 */
async function getTabSymbol(tabId) {
  try {
    return await withTab(
      tabId,
      `(() => { try { return window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().symbol(); } catch(e) { return null; } })()`
    );
  } catch {
    return null;
  }
}

/**
 * Return ALL charts within a tab's multi-chart layout.
 * Each entry is { chartIndex, symbol }.
 *
 * TradingView allows splitting a single tab into multiple charts (e.g. you
 * can have HSI1!, VHSI, and HSI1! side-by-side in one tab). The primary
 * chart's symbol is what `getTabSymbol` returns — but overlay charts in the
 * layout are otherwise invisible to scripts.
 */
export async function getChartsInTab(tabId) {
  try {
    return await withTab(
      tabId,
      `(() => {
        try {
          const defs = window.TradingViewApi._chartWidgetCollection._chartWidgetsDefs;
          const out = [];
          for (let i = 0; i < defs.length; i++) {
            try {
              const sym = defs[i].chartWidget?.model?.()?.mainSeries?.()?.symbol?.();
              if (sym) out.push({ chartIndex: i, symbol: sym });
            } catch (e) {}
          }
          return out;
        } catch (e) { return []; }
      })()`
    );
  } catch {
    return [];
  }
}

/**
 * Focus a specific chart within a multi-chart layout by clicking its main div.
 * After ~400ms, `window.TradingViewApi._activeChartWidgetWV.value()` returns
 * the now-focused chart. Pattern mirrors US `focusPane` from premarket_setup.mjs.
 */
export async function focusChartInSession(run, chartIndex) {
  await run(`
    (() => {
      try {
        const w = window.TradingViewApi._chartWidgetCollection.getAll()[${chartIndex}];
        if (w && w._mainDiv) w._mainDiv.click();
        return true;
      } catch (e) { return false; }
    })()
  `);
  await new Promise((r) => setTimeout(r, 400));
}

/**
 * Normalise a TradingView symbol for matching.
 *
 * Examples:
 *   "HKEX:HSI1!"     → "hsi"
 *   "SGX:CN1!"       → "cn"
 *   "HSI:VHSI"       → "vhsi"
 *   "HKEX:HSImain"   → "hsi"
 *   "HKEX_DLY:700"   → "700"   ← HK stock ticker (numeric)
 *   "HKEX:9988"      → "9988"
 *
 * Keeps both letters and digits so numeric HK stock tickers (700, 9988,
 * 3690, 1211) survive normalisation. Earlier version stripped all digits,
 * which made every numeric ticker collapse to "" → instant false-no-match.
 */
export function normaliseSymbol(s) {
  if (!s) return "";
  // Strip exchange prefix (anything before the last colon)
  const afterColon = s.includes(":") ? s.split(":").slice(-1)[0] : s;
  // Strip "1!" futures suffix and "main" continuous-contract suffix
  return afterColon
    .toLowerCase()
    .replace(/(\d+!|main)$/, "")
    .replace(/[^a-z0-9]/g, ""); // keep letters AND digits
}

/**
 * Find matching panes for a symbol across EVERY open tab — not just the first.
 *
 * The user runs duplicated layouts: each ticker has a dedicated multi-pane tab
 * (15m/5m/1m) AND appears as one pane of a US/Asia overview tab. Draw paths
 * must hit all of them so levels stay consistent everywhere the symbol shows.
 *
 * Returns [{ tab, actualSymbol, chartIndices }] — one entry per tab with ≥1
 * matching pane (MRU tab order). Empty array if no match anywhere.
 */
export async function findChartsAcrossTabs(requestedSymbol) {
  const targetRoot = normaliseSymbol(requestedSymbol);
  if (!targetRoot) return [];

  const tabs = await listTabs();
  const out = [];
  for (const tab of tabs) {
    const charts = await getChartsInTab(tab.id);
    const matching = charts.filter(
      (c) => normaliseSymbol(c.symbol) === targetRoot
    );
    if (matching.length > 0) {
      out.push({
        tab,
        actualSymbol: matching[0].symbol,
        chartIndices: matching.map((c) => c.chartIndex),
      });
    }
  }
  return out;
}

/**
 * Find every matching pane within the FIRST tab that has a match.
 * Thin wrapper over findChartsAcrossTabs — use for reads (bars need one
 * source, not N); draw paths should use findChartsAcrossTabs instead.
 *
 * Returns { tab, actualSymbol, chartIndices } or null if no match.
 */
export async function findAllChartsBySymbol(requestedSymbol) {
  const all = await findChartsAcrossTabs(requestedSymbol);
  return all.length > 0 ? all[0] : null;
}

/**
 * Find the FIRST chart pane whose loaded symbol matches the requested pattern.
 * Scans every chart in every tab's multi-chart layout (not just active).
 *
 * Thin wrapper over findAllChartsBySymbol — returns only the first matching
 * pane, preserving the long-standing single-pane contract used across the
 * codebase (bars/quote reads, multi-TF analysis).
 *
 * Returns { tab, actualSymbol, chartIndex } or null if no match.
 * `chartIndex` is the position in the tab's `_chartWidgetsDefs` array.
 */
export async function findTabBySymbol(requestedSymbol) {
  const found = await findAllChartsBySymbol(requestedSymbol);
  if (!found) return null;
  return {
    tab: found.tab,
    actualSymbol: found.actualSymbol,
    chartIndex: found.chartIndices[0],
  };
}

/**
 * Read the last N bars from a specific tab's main series.
 * Uses bars.lastIndex() / bars.valueAt(i) — values come back as arrays
 * [time, open, high, low, close, volume].
 */
export async function readBarsFromTab(tabId, count = 60, opts = {}) {
  const chartIndex = opts.chartIndex ?? 0;
  // Read DIRECTLY from defs[chartIndex].chartWidget — bypasses the active-chart
  // wrapper entirely. No focus click needed. Crucial for Stage 2 where we
  // read 5 reference quotes in parallel from the same tab — concurrent
  // focus-clicks would race.
  return withTab(tabId, `
    (() => {
      try {
        const cw = window.TradingViewApi._chartWidgetCollection._chartWidgetsDefs[${chartIndex}]?.chartWidget;
        if (!cw) return [];
        const bars = cw.model().mainSeries().bars();
        if (!bars || typeof bars.lastIndex !== 'function') return [];
        const lastIdx = bars.lastIndex();
        const firstIdx = bars.firstIndex ? bars.firstIndex() : Math.max(0, lastIdx - ${count} + 1);
        const startIdx = Math.max(firstIdx, lastIdx - ${count} + 1);
        const out = [];
        for (let i = startIdx; i <= lastIdx; i++) {
          const v = bars.valueAt(i);
          if (!v) continue;
          out.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0 });
        }
        return out;
      } catch (e) { return []; }
    })()
  `);
}

/**
 * Read bars from a tab at a SPECIFIC resolution, switching the tab's TF if
 * needed, polling until enough bars are loaded, then restoring the original TF.
 *
 * Pattern matches the US premarket_setup.mjs (drawDeepZones).
 *
 * @param tabId       CDP target id of the tab
 * @param resolution  TradingView resolution string ("D", "240", "60", "15", "5", "1", "W", "M")
 * @param count       Max number of trailing bars to return
 *
 * Returns { bars, original_tf, target_tf, switched }.
 *
 * If the tab is the user's actively-visible window, they'll see a brief
 * (~500-1500ms) flicker during the swap. Acceptable for a pre-market routine.
 */
export async function readBarsAtResolutionFromTab(tabId, resolution, count = 100, opts = {}) {
  const chartIndex = opts.chartIndex ?? 0;
  const target = String(resolution);
  // Reads operate DIRECTLY on defs[chartIndex].chartWidget — no focus race.
  // chartWidget exposes setResolution() and the model's mainSeries has
  // .interval() (current TF) and .bars(). This works on background charts.
  const CW = `window.TradingViewApi._chartWidgetCollection._chartWidgetsDefs[${chartIndex}].chartWidget`;
  const BARS = `${CW}.model().mainSeries().bars()`;

  return withTabSession(tabId, async (run) => {
    // 1. Read current resolution
    const origRes = await run(
      `(() => { try { return ${CW}.model().mainSeries().interval(); } catch (e) { return null; } })()`
    );

    const needsSwitch = origRes != null && String(origRes) !== target;

    // 2. Switch if needed
    if (needsSwitch) {
      await run(
        `(() => { try { ${CW}.setResolution('${target.replace(/'/g, "\\'")}'); return true; } catch (e) { return false; } })()`
      );

      // 3. Poll for bars to load (up to 10s, 500ms intervals)
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((r) => setTimeout(r, 500));
        const barCount = await run(
          `(() => { try { const b = ${BARS}; return b.lastIndex() - b.firstIndex() + 1; } catch (e) { return 0; } })()`
        ).catch(() => 0);
        if (barCount > 100) break;
      }
    }

    // 4. Read bars
    const bars = await run(`
      (() => {
        try {
          const bars = ${BARS};
          if (!bars || typeof bars.lastIndex !== 'function') return [];
          const lastIdx = bars.lastIndex();
          const firstIdx = bars.firstIndex ? bars.firstIndex() : Math.max(0, lastIdx - ${count} + 1);
          const startIdx = Math.max(firstIdx, lastIdx - ${count} + 1);
          const out = [];
          for (let i = startIdx; i <= lastIdx; i++) {
            const v = bars.valueAt(i);
            if (!v) continue;
            out.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0 });
          }
          return out;
        } catch (e) { return []; }
      })()
    `);

    // 5. Restore original TF
    if (needsSwitch && origRes) {
      await run(
        `(() => { try { ${CW}.setResolution('${String(origRes).replace(/'/g, "\\'")}'); return true; } catch (e) { return false; } })()`
      ).catch(() => {});
    }

    return { bars, original_tf: origRes, target_tf: target, switched: needsSwitch };
  });
}

/**
 * Convenience: read DAILY bars (Stage 1 entry point).
 */
export async function readDailyBarsFromTab(tabId, count = 60, opts = {}) {
  return readBarsAtResolutionFromTab(tabId, "D", count, opts);
}

/**
 * Compute a compact quote summary (last, change, change_pct) from bars.
 */
export function summariseQuote(bars) {
  if (!Array.isArray(bars) || bars.length < 2) {
    return { last: null, change: null, change_pct: null, _error: "insufficient bars" };
  }
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const change = last.close - prev.close;
  const change_pct = prev.close ? (change / prev.close) * 100 : null;
  return {
    last: last.close,
    high: last.high,
    low: last.low,
    open: last.open,
    change: Number(change.toFixed(4)),
    change_pct: change_pct != null ? Number(change_pct.toFixed(2)) : null,
  };
}

/**
 * High-level helper: pull a quote summary for a reference symbol if a tab
 * with that symbol exists. Returns { last, change, change_pct, ... } or
 * { _missing_tab: true } when no tab matches.
 */
export async function readReferenceQuote(requestedSymbol) {
  const found = await findTabBySymbol(requestedSymbol);
  if (!found) {
    return { _missing_tab: true, requested: requestedSymbol };
  }
  const bars = await readBarsFromTab(found.tab.id, 5, {
    chartIndex: found.chartIndex,
  });
  const summary = summariseQuote(bars);
  return {
    ...summary,
    actual_symbol: found.actualSymbol,
    chart_index: found.chartIndex,
  };
}
