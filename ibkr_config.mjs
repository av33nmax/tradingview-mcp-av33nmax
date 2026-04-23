/**
 * ibkr_config.mjs — shared connection settings for IBKR scripts.
 *
 * Override via env vars if the other laptop's IP changes or you move to live:
 *   IBKR_HOST=192.168.18.40  node foo.mjs
 *   IBKR_PORT=7496 node foo.mjs       # 7496 = live, 7497 = paper
 *
 * clientId is picked per-script so multiple scripts can connect concurrently
 * without stomping on each other's subscriptions (IBKR allows ~32 clients).
 */
export const IBKR_CONFIG = {
  host: process.env.IBKR_HOST || '192.168.18.35',
  port: parseInt(process.env.IBKR_PORT || '7497', 10),
};

/** clientId allocation — keep unique per script to avoid IBKR confusion. */
export const CLIENT_IDS = {
  test_connect:   42,
  option_chain:   43,
  trade_planner:  44,
  place_order:    45,
  market_data:    46,
  positions:      47,
};

/** Standard IBKR "informational" error codes (not real errors, just status). */
export function isInfoCode(code) {
  return code && code >= 2100 && code <= 2200;
}
