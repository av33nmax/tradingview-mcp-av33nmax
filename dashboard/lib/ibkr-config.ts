/**
 * Mirror of the env-driven config in repo-root `ibkr_config.mjs`. Same
 * defaults (LIVE port 7496) and same env-var names (IBKR_HOST, IBKR_PORT)
 * so the dashboard server reads from the same source the watcher scripts do.
 *
 * Why mirrored instead of re-exported: the root file lives outside the
 * dashboard package, and Next.js can't reliably resolve cross-package
 * imports for server bundles. 5 lines of duplication is the lesser evil.
 */
export const IBKR_CONFIG = {
  host: process.env.IBKR_HOST || "127.0.0.1",
  port: parseInt(process.env.IBKR_PORT || "7496", 10),
};

export function isLive(): boolean {
  return IBKR_CONFIG.port === 7496;
}

export function modeLabel(): "LIVE" | "PAPER" {
  return isLive() ? "LIVE" : "PAPER";
}

/**
 * Dashboard server uses clientId 48 — outside the existing 42-47 range
 * (test_connect, option_chain, trade_planner, place_order, market_data,
 * positions). This lets the dashboard query account state alongside any
 * active watcher without a clientId clash.
 */
export const DASHBOARD_CLIENT_ID = 48;
