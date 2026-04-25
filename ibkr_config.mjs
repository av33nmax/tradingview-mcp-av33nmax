/**
 * ibkr_config.mjs — shared connection settings for IBKR scripts.
 *
 * DEFAULT IS LIVE (port 7496) as of 2026-04-25 per user decision to switch
 * from paper to live for Monday trading. The user has chosen to keep the
 * existing $300 max risk per trade and rely on watching the screen for
 * safety. To run on paper instead, set IBKR_PORT=7497 explicitly:
 *
 *   IBKR_PORT=7497 node test_ibkr_connect.mjs
 *
 * Override host the same way:
 *   IBKR_HOST=192.168.18.40 IBKR_PORT=7497 node foo.mjs
 *
 * clientId is picked per-script so multiple scripts can connect concurrently
 * without stomping on each other's subscriptions (IBKR allows ~32 clients).
 */
export const IBKR_CONFIG = {
  host: process.env.IBKR_HOST || '192.168.18.35',
  port: parseInt(process.env.IBKR_PORT || '7496', 10),
};

/** True iff connected to the live trading port (7496). */
export function isLive() {
  return IBKR_CONFIG.port === 7496;
}

/** Pretty label for logs/banners — "LIVE" or "PAPER". */
export function modeLabel() {
  return isLive() ? 'LIVE' : 'PAPER';
}

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
