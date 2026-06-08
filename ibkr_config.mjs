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
 *   IBKR_HOST=192.168.1.50 IBKR_PORT=7497 node foo.mjs
 *
 * clientId is picked per-script so multiple scripts can connect concurrently
 * without stomping on each other's subscriptions (IBKR allows ~32 clients).
 */
export const IBKR_CONFIG = {
  host: process.env.IBKR_HOST || '127.0.0.1',
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
  market_data:    46,  // legacy; trade_window now uses per-ticker IDs below
  positions:      47,
  // Per-ticker IDs for trade_window.mjs. Without unique IDs, concurrent
  // watcher processes share the same IBKR session and collide on
  // reqHistoricalData reqIds — one ticker "wins" the response, the others
  // get 0 bars (see 2026-04-28 IWM incident).
  trade_window_SPY: 50,
  trade_window_QQQ: 51,
  trade_window_IWM: 52,
  // Stock watchers (added 2026-05-06 — Friday-weekly expiry, $0.80–$3.00
  // PREMIUM_RANGE, per-ticker rVol calibration, no cross-ticker correlation
  // gate). 53 reserved for scripts/persist_session.mjs.
  trade_window_AAPL: 54,
  trade_window_NVDA: 55,
  trade_window_AMZN: 56,
};

/** Pick the right clientId for a trade_window watcher based on its ticker. */
export function tradeWindowClientId(ticker) {
  const id = CLIENT_IDS[`trade_window_${ticker}`];
  if (id == null) throw new Error(`tradeWindowClientId: no clientId for ticker ${ticker}`);
  return id;
}

/** Standard IBKR "informational" error codes (not real errors, just status). */
export function isInfoCode(code) {
  return code && code >= 2100 && code <= 2200;
}
