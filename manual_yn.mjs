/**
 * manual_yn.mjs — session-level trading kill switch for the US watcher.
 *
 * Layers on TOP of the per-fire YES prompt: when yn='Y' you still type YES
 * at the terminal; when yn='N' the watcher skips even prompting (and
 * notifies Discord). Toggled from the dashboard at /api/manual-yn.
 *
 * State file: ./manual_yn.json (at repo root). Date scope: ET (matches the
 * US trading session). Yesterday's Y does NOT auto-arm today — friction
 * is intentional.
 *
 * Mirrors the Asia version at asia/lib/gates_eval.mjs#evaluateManualYN
 * but with ET timezone and file location.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MANUAL_YN_FILE = path.join(__dirname, 'manual_yn.json');

function todayET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function etDateOf(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** Raw read of the state file. Returns null if missing or malformed. */
export function loadManualYN() {
  try {
    if (!fs.existsSync(MANUAL_YN_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(MANUAL_YN_FILE, 'utf8'));
    return {
      yn: raw.yn ?? null,
      set_at: raw.set_at ?? null,
      set_by: raw.set_by ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * True iff trading is currently armed for today (ET).
 * Requirements:
 *   - yn === 'Y'
 *   - set_at is a parseable ISO timestamp
 *   - set_at's ET calendar date === today's ET date
 */
export function isTradingEnabledForToday() {
  const s = loadManualYN();
  if (!s || s.yn !== 'Y' || !s.set_at) return false;
  const setEt = etDateOf(s.set_at);
  return setEt !== null && setEt === todayET();
}

/**
 * Pretty status line for console output / logs.
 * Returns one of:
 *   "ENABLED — armed at 09:32 ET by aveen"
 *   "DISABLED — toggle is 'N' (default)"
 *   "STALE — armed 2026-05-16 (yesterday ET), needs re-enable today"
 *   "MALFORMED — manual_yn.json present but unparseable"
 */
export function formatStatus() {
  const s = loadManualYN();
  if (!s) return "DISABLED — manual_yn.json missing or malformed";
  if (s.yn !== 'Y') return `DISABLED — toggle is '${s.yn ?? 'unset'}'`;
  if (!s.set_at) return "MALFORMED — yn='Y' but no set_at";
  const setEt = etDateOf(s.set_at);
  const todayEt = todayET();
  if (setEt !== todayEt) return `STALE — armed ${setEt} (need re-enable for ${todayEt} ET)`;
  const setBy = s.set_by ? ` by ${s.set_by}` : '';
  const setLocal = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(s.set_at));
  return `ENABLED — armed at ${setLocal} ET${setBy}`;
}
