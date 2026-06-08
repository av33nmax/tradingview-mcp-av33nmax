/**
 * GET /api/state/[market]
 *
 * Reads today's journal (asia/journal/YYYY-MM-DD.md) + state files for the
 * requested market and returns parsed JSON the dashboard can render.
 *
 * `market` is a coarse grouping (currently only "hsi" for the HK morning
 * session). Within that, each instrument from contracts.json `primary`
 * becomes its own block. Adding a stock to contracts.json automatically
 * makes it appear in the response.
 *
 * Future markets: "nikkei", "nifty" → separate journals/state per market.
 */

import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { parseJournal } from "@/lib/journal-parser";
import { buildLiveGates } from "@/lib/live-gates";

const ASIA_ROOT = path.resolve(process.cwd(), "..");

function todayDateString(): string {
  const now = new Date();
  const sgt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return sgt.toISOString().slice(0, 10);
}

type InstrumentSpec = {
  name?: string;
  kind?: string;
  ticker?: string;
  us_analog?: string;
  color_accent?: string;
  notes?: string;
  currency?: string;
  multiplier?: number;
  default_trail_amount?: number;
};

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ market: string }> }
) {
  const { market } = await ctx.params;

  if (!["hsi"].includes(market.toLowerCase())) {
    return NextResponse.json(
      { error: `Unknown market: ${market}. Supported: hsi` },
      { status: 404 }
    );
  }

  const today = todayDateString();
  const journalPath = path.join(ASIA_ROOT, "journal", `${today}.md`);

  // Load instrument specs from contracts.json (drives card order + metadata)
  let primarySpecs: Record<string, InstrumentSpec> = {};
  try {
    const contracts = JSON.parse(
      await fs.readFile(path.join(ASIA_ROOT, "config", "contracts.json"), "utf8")
    );
    primarySpecs = contracts.primary || {};
  } catch {}

  let journalMd: string | null = null;
  try {
    journalMd = await fs.readFile(journalPath, "utf8");
  } catch {
    journalMd = null;
  }

  const parsed = journalMd
    ? parseJournal(journalMd)
    : { date: today, generated_at: null, instruments: {}, gates: [] };

  // Load structured ORB triggers (includes Trigger B levels per instrument).
  // post_open_orb.mjs writes this at 09:45 SGT. Optional — if missing the
  // card just shows em-dashes for VWAP/EMA21.
  let orbTriggers: Record<string, {
    ok?: boolean;
    trigger_b?: { vwap: number | null; ema21_1h: number | null; atr_15: number | null; computed_at: string };
  }> = {};
  try {
    const orbState = JSON.parse(
      await fs.readFile(path.join(ASIA_ROOT, "state", "orb_triggers.json"), "utf8")
    );
    orbTriggers = orbState.instruments || {};
  } catch {}

  // Trailing-stop config per instrument. Missing file → all disabled.
  // Defaults read from spec.default_trail_amount in contracts.json (fallback
  // to kind-based if missing). Sized at ~3× typical HK option bid-ask
  // spread to avoid microstructure wicks.
  const TRAIL_DEFAULT_BY_KIND: Record<string, number> = { index_futures: 10.0, single_stock: 0.60 };
  let trailingStored: Record<string, { enabled?: boolean; trailAmount?: number; set_at?: string; set_by?: string }> = {};
  try {
    const trState = JSON.parse(
      await fs.readFile(path.join(ASIA_ROOT, "state", "trailing_instruments.json"), "utf8")
    );
    trailingStored = trState.instruments || {};
  } catch {}

  // Build an ordered array of instruments matching contracts.primary order.
  // The journal parser populates parsed.instruments[key.toLowerCase()].
  const instruments = Object.keys(primarySpecs)
    .filter((k) => !k.startsWith("_"))
    .map((key) => {
      const spec = primarySpecs[key];
      const data = parsed.instruments[key.toLowerCase()] || {};
      const orbTrig = orbTriggers[key];
      const trStored = trailingStored[key];
      const trDefault = Number.isFinite(spec.default_trail_amount) && (spec.default_trail_amount as number) > 0
        ? (spec.default_trail_amount as number)
        : (TRAIL_DEFAULT_BY_KIND[spec.kind ?? ""] ?? 0.60);
      const trailing = {
        enabled: Boolean(trStored?.enabled),
        trailAmount:
          Number.isFinite(trStored?.trailAmount) && (trStored!.trailAmount as number) > 0
            ? (trStored!.trailAmount as number)
            : trDefault,
        set_at: trStored?.set_at ?? null,
        set_by: trStored?.set_by ?? null,
        isDefault: !trStored,
        currency: spec.currency ?? "HKD",
        multiplier: Number(spec.multiplier ?? 1),
        defaultTrailAmount: trDefault,
      };
      return {
        key,
        symbol: key,
        name: spec.name || key,
        kind: spec.kind || "unknown",
        ticker: spec.ticker || null,
        us_analog: spec.us_analog || null,
        color_accent: spec.color_accent || "emerald",
        levels: data.levels,
        mtf: data.mtf,
        orb: data.orb,
        trigger_b: orbTrig?.ok ? orbTrig.trigger_b : null,
        trailing,
      };
    });

  // Shape counts (across all instruments)
  let pmShapeCount = 0;
  let orbShapeCount = 0;
  try {
    const pmState = JSON.parse(
      await fs.readFile(
        path.join(ASIA_ROOT, "state", "last_drawn_shapes.json"),
        "utf8"
      )
    );
    pmShapeCount = Object.values(pmState).reduce(
      (sum: number, ids) => sum + (Array.isArray(ids) ? ids.length : 0),
      0
    );
  } catch {}
  try {
    const orbState = JSON.parse(
      await fs.readFile(
        path.join(ASIA_ROOT, "state", "last_orb_triggers.json"),
        "utf8"
      )
    );
    orbShapeCount = Object.values(orbState).reduce(
      (sum: number, ids) => sum + (Array.isArray(ids) ? ids.length : 0),
      0
    );
  } catch {}

  // Live gate evaluation — replaces stale journal snapshots for session-wide
  // gates (Y/N, session_window, blackout, cap, A50). VHSI and chase fall
  // back to the journal value since they can't be computed server-side now.
  const instrumentKeys = Object.keys(primarySpecs).filter((k) => !k.startsWith("_"));
  const liveGates = await buildLiveGates(ASIA_ROOT, parsed.gates ?? [], instrumentKeys);

  return NextResponse.json({
    market: market.toLowerCase(),
    journal_date: parsed.date ?? today,
    journal_exists: journalMd !== null,
    journal_generated_at: parsed.generated_at,
    drawings: {
      premarket_shapes: pmShapeCount,
      orb_shapes: orbShapeCount,
    },
    instruments,
    premarket_verdict: parsed.premarket_verdict ?? null,
    gates: liveGates,
    fetched_at: new Date().toISOString(),
  });
}
