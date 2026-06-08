/**
 * asia/lib/draw.mjs
 *
 * Draw shapes (horizontal lines, rectangles) on background TradingView tabs
 * without switching focus. Built on withTabSession from multi_tab.mjs.
 *
 * Cleanup pattern: every shape created here gets its ID returned. Callers
 * persist those IDs to disk and remove them on the next run, so drawings
 * don't stack across pre-market routines.
 *
 * Color convention:
 *   - Swing HIGH (resistance):   red    #E91E63
 *   - Swing LOW  (support):      green  #00C853
 *   - Bullish FVG (gap up):      green  rgba(0, 200, 83, 0.15)
 *   - Bearish FVG (gap down):    red    rgba(233, 30, 99, 0.15)
 */

import { withTabSession, focusChartInSession } from "./multi_tab.mjs";

const COLORS = {
  swing_high: "#E91E63",
  swing_low: "#00C853",
  fvg_bullish_line: "#00C853",
  fvg_bearish_line: "#E91E63",
};

const CHART_PATH = `window.TradingViewApi._activeChartWidgetWV.value()`;
const BARS_PATH = `${CHART_PATH}._chartWidget.model().mainSeries().bars()`;

/**
 * Open a draw session on a specific tab. The `fn` receives a `draw` object
 * with helper methods. All shapes drawn return their entity_id.
 *
 * @param tabId           CDP target id of the tab
 * @param fn              Callback receiving the `draw` helper
 * @param opts.chartIndex If set, focus that chart in a multi-chart layout
 *                        before drawing — so shapes land on the right chart.
 */
export async function withDrawSession(tabId, fn, opts = {}) {
  return withTabSession(tabId, async (run) => {
    // Focus the target chart in a multi-chart layout (if specified). Focus
    // even for index 0 — don't assume pane 0 is already active. A caller that
    // loops the draw over every pane needs each iteration to land on the pane
    // it asked for, not on whatever the user last clicked.
    if (opts.chartIndex != null) {
      await focusChartInSession(run, opts.chartIndex);
    }

    // Verify chart API is reachable on this tab
    const ok = await run(`typeof ${CHART_PATH} !== 'undefined' && ${CHART_PATH} !== null`);
    if (!ok) throw new Error("Chart API not available on this tab");

    // Get last bar time as a default anchor for horizontal lines
    const anchorTime = await run(`
      (() => {
        try {
          const b = ${BARS_PATH};
          if (!b || typeof b.lastIndex !== 'function') return Math.floor(Date.now()/1000);
          const v = b.valueAt(b.lastIndex());
          return v ? v[0] : Math.floor(Date.now()/1000);
        } catch (e) { return Math.floor(Date.now()/1000); }
      })()
    `);

    const draw = {
      /**
       * Draw a horizontal price line. Matches US `drawTriggerAnnotations`
       * style — label right-aligned, top-positioned, includes price value.
       *
       * @param opts.linestyle  0 = solid (default), 1 = dotted, 2 = dashed
       * @param opts.linewidth  default 1
       */
      hline: async (price, text, color = "#888888", opts = {}) => {
        const linestyle = opts.linestyle ?? 0;
        const linewidth = opts.linewidth ?? 1;
        const before = await run(`${CHART_PATH}.getAllShapes().map(s => s.id)`);
        await run(`
          ${CHART_PATH}.createShape(
            { time: ${anchorTime}, price: ${price} },
            {
              shape: 'horizontal_line',
              overrides: {
                linecolor: '${color}',
                linewidth: ${linewidth},
                linestyle: ${linestyle},
                showLabel: true,
                textcolor: '${color}',
                fontsize: 11,
                horzLabelsAlign: 'right',
                vertLabelsAlign: 'top',
                showPrice: true
              },
              text: ${JSON.stringify(text)}
            }
          )
        `);
        await new Promise((r) => setTimeout(r, 150));
        const after = await run(`${CHART_PATH}.getAllShapes().map(s => s.id)`);
        const newId = (after || []).find((id) => !(before || []).includes(id));
        return { entity_id: newId || null, text, price };
      },

      /**
       * Draw a rectangle from (startTime, lowPrice) to (endTime, highPrice).
       *
       * @param opts.transparency  0-100, default 92 (= 8% opaque — barely visible fill)
       * @param opts.linewidth     default 1
       */
      rectangle: async (
        lowPrice,
        highPrice,
        startTime,
        endTime,
        color,
        text = "",
        opts = {}
      ) => {
        const transparency = opts.transparency ?? 92;
        const linewidth = opts.linewidth ?? 1;
        const before = await run(`${CHART_PATH}.getAllShapes().map(s => s.id)`);
        await run(`
          ${CHART_PATH}.createMultipointShape(
            [{ time: ${startTime}, price: ${highPrice} }, { time: ${endTime}, price: ${lowPrice} }],
            {
              shape: 'rectangle',
              overrides: {
                color: '${color}',
                backgroundColor: '${color}',
                linecolor: '${color}',
                linewidth: ${linewidth},
                transparency: ${transparency},
                showLabel: ${text ? "true" : "false"},
                text: ${JSON.stringify(text)},
                textcolor: '${color}',
                fontsize: 10
              },
              text: ${JSON.stringify(text)}
            }
          )
        `);
        await new Promise((r) => setTimeout(r, 150));
        const after = await run(`${CHART_PATH}.getAllShapes().map(s => s.id)`);
        const newId = (after || []).find((id) => !(before || []).includes(id));
        return { entity_id: newId || null, low: lowPrice, high: highPrice };
      },

      /**
       * Remove a shape by ID. Silently no-ops if not found.
       */
      removeById: async (entity_id) => {
        try {
          await run(`${CHART_PATH}.removeEntity('${entity_id}')`);
          return true;
        } catch (e) {
          return false;
        }
      },

      /**
       * Tag-scan cleanup — mirrors the US premarket_setup.mjs pattern.
       * Enumerates every shape on the chart, reads its label text, and
       * removes any whose label starts with the given prefix.
       *
       * Robust against:
       *   - TradingView app restarts (CDP tab IDs change → state-file lookups
       *     return nothing → state-based cleanup leaves shapes orphaned)
       *   - Lost / corrupt state files
       *   - Shapes drawn by prior versions of the script
       *
       * Pass the same tag prefix the script draws with (e.g. `[ORB HSI]`
       * or `[asia-pm 700]`) and every matching shape is wiped before the
       * new run draws fresh ones. No state-file dependency.
       *
       * @returns count of shapes removed
       */
      removeByTagPrefix: async (prefix) => {
        try {
          const removed = await run(`
            (() => {
              try {
                const api = ${CHART_PATH};
                if (!api || !api.getAllShapes) return 0;
                const shapes = api.getAllShapes();
                const prefix = ${JSON.stringify(prefix)};
                let n = 0;
                for (const sh of shapes) {
                  try {
                    const s = api.getShapeById ? api.getShapeById(sh.id) : null;
                    const props = s && s.getProperties ? s.getProperties() : null;
                    const text = props && props.text ? String(props.text) : '';
                    if (text.indexOf(prefix) === 0) { api.removeEntity(sh.id); n++; }
                  } catch (e) {}
                }
                return n;
              } catch (e) { return 0; }
            })()
          `);
          return Number(removed) || 0;
        } catch (e) {
          return 0;
        }
      },

      /**
       * Remove every shape whose label text matches the given regex source.
       * For clean (tag-free) auto-drawn levels like PMH/PML/PDH/PDL.
       * @returns count removed
       */
      removeByLabelMatch: async (patternSource) => {
        try {
          const removed = await run(`
            (() => {
              try {
                const api = ${CHART_PATH};
                if (!api || !api.getAllShapes) return 0;
                const re = new RegExp(${JSON.stringify(patternSource)});
                const shapes = api.getAllShapes();
                let n = 0;
                for (const sh of shapes) {
                  try {
                    const s = api.getShapeById ? api.getShapeById(sh.id) : null;
                    const props = s && s.getProperties ? s.getProperties() : null;
                    const text = props && props.text ? String(props.text).trim() : '';
                    if (re.test(text)) { api.removeEntity(sh.id); n++; }
                  } catch (e) {}
                }
                return n;
              } catch (e) { return 0; }
            })()
          `);
          return Number(removed) || 0;
        } catch (e) {
          return 0;
        }
      },

      /**
       * Get the last bar time on this tab (useful for anchoring future shapes).
       */
      lastBarTime: () => anchorTime,
    };

    return fn(draw);
  });
}
