/**
 * asia/lib/ibkr_hk_config.mjs — IBKR connection settings for HK scripts.
 *
 * Mirrors the root ibkr_config.mjs (US side) but with a separate clientId
 * range so HK watchers can run concurrently with US watchers without
 * stomping on each other's reqId space.
 *
 * Defaults to LIVE (port 7496) per user decision 2026-05-17. Set
 * IBKR_PORT=7497 to override to paper. Host overridable via IBKR_HOST.
 */

export const IBKR_HK_CONFIG = {
  host: process.env.IBKR_HOST || '127.0.0.1',
  port: parseInt(process.env.IBKR_PORT || '7496', 10),
};

export function isLive() {
  return IBKR_HK_CONFIG.port === 7496;
}

export function modeLabel() {
  return isLive() ? 'LIVE' : 'PAPER';
}

// Per-instrument clientIds for trade_window_hk.mjs watchers. Range 60-64
// reserved exclusively for HK watchers (US watchers use 50-56; other US
// scripts use 42-47). Each instrument needs its own ID so concurrent
// watcher processes don't share an IBKR session and collide on
// reqHistoricalData reqIds (root cause of the 2026-04-28 US IWM 0-bar
// incident — same failure mode applies here).
//
// 2026-05-18: MHI (60) and MTW (61) slots freed when those products were
// dropped — MHI options at IBKR have no weeklies, MTW doesn't exist as
// HK options. Replaced by HSI (60) for weekly index exposure.
export const HK_CLIENT_IDS = {
  trade_window_HSI: 60,
  trade_window_TENCENT: 62,
  trade_window_ALIBABA: 63,
  trade_window_XIAOMI: 64,
  // 61, 65-69 reserved for future HK watchers (e.g. HSCEI, Meituan, JD, BYD).
  contract_resolve: 70,  // asia/scripts/test_hk_contract_resolve.mjs
};

export function hkWatcherClientId(instrumentKey) {
  const id = HK_CLIENT_IDS[`trade_window_${instrumentKey}`];
  if (id == null) {
    throw new Error(`hkWatcherClientId: no clientId for instrument ${instrumentKey} (valid: HSI, TENCENT, ALIBABA, XIAOMI)`);
  }
  return id;
}

/** IBKR informational codes — not real errors, suppress in handlers. */
export function isInfoCode(code) {
  return code != null && code >= 2100 && code <= 2200;
}

/** Known-noisy codes the HK watcher silences. 200/300 fire during option
 *  chain scans for non-existent strikes; 354 = no market data sub
 *  (informational on a paper account); 2137 = generic TWS warning. */
export function isNoisyHKCode(code) {
  return code === 200 || code === 300 || code === 354 || code === 2137;
}
