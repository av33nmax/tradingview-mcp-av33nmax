/**
 * asia/lib/trailing_config.mjs — per-instrument trailing-stop config.
 *
 * State file at asia/state/trailing_instruments.json. Schema:
 *   {
 *     updated_at: ISO,
 *     instruments: {
 *       MHI:     { enabled: true,  trailAmount: 5.0, set_at, set_by },
 *       TENCENT: { enabled: false, trailAmount: 0.30 },
 *       ...
 *     }
 *   }
 *
 * Missing file or missing instrument → defaults to disabled with the
 * kind-based default trailAmount (index_futures: 5.0, single_stock: 0.30).
 *
 * When enabled, the watcher's handleTriggered places a single TRAIL order
 * on the HK option (premium-trailing) instead of the OCA bracket.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASIA_ROOT = path.resolve(__dirname, '..');
export const TRAILING_FILE = path.join(ASIA_ROOT, 'state', 'trailing_instruments.json');

/**
 * Default trail width per instrument. First reads spec.default_trail_amount
 * (per-instrument calibration from contracts.json), falls back to kind-based
 * defaults sized at ~3× typical bid-ask spread to avoid microstructure wicks.
 *
 * Per-instrument values in contracts.json as of 2026-05-17:
 *   MHI/MTW   : 10.0 HKD   (~100 HKD worst case per contract = $13)
 *   TENCENT   : 0.60 HKD   (~60 HKD worst case = $8)
 *   ALIBABA   : 0.60 HKD   (~60 HKD = $8)
 *   XIAOMI    : 0.40 HKD   (~40 HKD = $5)
 *
 * The kind-based fallbacks only kick in for instruments added to
 * contracts.json without an explicit default_trail_amount.
 */
const DEFAULT_TRAIL_BY_KIND = {
  index_futures: 10.0,
  single_stock: 0.60,
};

export function defaultTrailAmount(spec) {
  if (Number.isFinite(spec?.default_trail_amount) && spec.default_trail_amount > 0) {
    return spec.default_trail_amount;
  }
  return DEFAULT_TRAIL_BY_KIND[spec?.kind] ?? 0.60;
}

function readRaw() {
  try {
    if (!fs.existsSync(TRAILING_FILE)) return null;
    return JSON.parse(fs.readFileSync(TRAILING_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Load full state. Returns { updated_at, instruments } shape. */
export function loadTrailingState() {
  const raw = readRaw();
  if (!raw || typeof raw !== 'object') {
    return { updated_at: null, instruments: {} };
  }
  return {
    updated_at: raw.updated_at ?? null,
    instruments: raw.instruments && typeof raw.instruments === 'object' ? raw.instruments : {},
  };
}

/**
 * Get effective trailing config for an instrument, merging defaults.
 * Returns { enabled, trailAmount, set_at, set_by, isDefault }.
 *   isDefault=true when no explicit state was stored for this key.
 */
export function getTrailing(instrumentKey, spec) {
  const state = loadTrailingState();
  const entry = state.instruments[instrumentKey];
  if (!entry) {
    return {
      enabled: false,
      trailAmount: defaultTrailAmount(spec),
      set_at: null,
      set_by: null,
      isDefault: true,
    };
  }
  return {
    enabled: Boolean(entry.enabled),
    trailAmount: Number.isFinite(entry.trailAmount) && entry.trailAmount > 0
      ? entry.trailAmount
      : defaultTrailAmount(spec),
    set_at: entry.set_at ?? null,
    set_by: entry.set_by ?? null,
    isDefault: false,
  };
}

/**
 * Update trailing config for one instrument. Pass enabled and/or trailAmount.
 * If trailAmount is omitted, the existing value is kept (or default seeded).
 */
export async function setTrailing(instrumentKey, { enabled, trailAmount, set_by = 'dashboard', spec = null } = {}) {
  const state = loadTrailingState();
  const existing = state.instruments[instrumentKey] ?? {};
  const next = {
    enabled: enabled != null ? Boolean(enabled) : Boolean(existing.enabled),
    trailAmount: Number.isFinite(trailAmount) && trailAmount > 0
      ? trailAmount
      : (Number.isFinite(existing.trailAmount) && existing.trailAmount > 0
          ? existing.trailAmount
          : defaultTrailAmount(spec)),
    set_at: new Date().toISOString(),
    set_by,
  };
  state.instruments[instrumentKey] = next;
  state.updated_at = next.set_at;
  await fsp.mkdir(path.dirname(TRAILING_FILE), { recursive: true });
  await fsp.writeFile(TRAILING_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
  return next;
}
