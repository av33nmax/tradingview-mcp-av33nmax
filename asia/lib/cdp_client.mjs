/**
 * asia/lib/cdp_client.mjs
 *
 * Thin wrapper that re-exports the shared CDP connection module from the repo root.
 *
 * WHY SHARE? — Per the asia/ separation design (see asia/README.md), the
 * TradingView MCP / CDP plumbing is treated as shared *infrastructure*. The
 * domain logic (premarket script, gates, journal, dashboard, Discord) stays
 * fully isolated inside asia/. Duplicating the CDP module would mean
 * maintaining two copies of low-level connection code with no benefit.
 *
 * If we ever fully split this into a separate repo, we'd vendor a copy of
 * src/connection.js into asia/lib/_cdp_internal.mjs at that point.
 */

export {
  getClient,
  connect,
  getTargetInfo,
  evaluate,
  evaluateAsync,
  disconnect,
  getChartApi,
  getChartCollection,
  getBottomBar,
  getReplayApi,
  getMainSeriesBars,
  KNOWN_PATHS,
} from "../../src/connection.js";
