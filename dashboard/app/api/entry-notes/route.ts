import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

// latest_entry_notes.json lives at the repo root, one level above the dashboard/
const ENTRY_NOTES_PATH = path.join(process.cwd(), "..", "latest_entry_notes.json");

// Don't cache — we want fresh data every request
export const dynamic = "force-dynamic";
export const revalidate = 0;

type TriggerA = {
  entry: number;
  stop: number;
  T1: number;
  T2: number;
};

type TriggerB = {
  entry_vwap: number;
  entry_ema21_1H: number;
  stop: number;
  T1: number;
  T2: number;
};

type EntryNotes = {
  direction: "CALLS" | "PUTS";
  trigger_a: TriggerA;
  trigger_b: TriggerB;
  triggers?: Record<string, number>;
  stops?: Record<string, number>;
  targets?: Record<string, number>;
  invalidation?: number;
  atr_15m?: number;
};

type TickerState = {
  bias: string | null;
  aligned: boolean | null;
  entry_notes: EntryNotes | null;
};

type RawFile = {
  generatedAt: string;
  tickers: Record<string, TickerState>;
};

export type EntryNotesResponse = {
  ok: true;
  generatedAt: string;
  ageMinutes: number;
  isStale: boolean;
  tickers: Record<string, TickerState>;
} | {
  ok: false;
  error: string;
};

const STALE_THRESHOLD_MIN = 4 * 60; // 4 hours

export async function GET(): Promise<NextResponse<EntryNotesResponse>> {
  try {
    if (!fs.existsSync(ENTRY_NOTES_PATH)) {
      return NextResponse.json(
        { ok: false, error: "latest_entry_notes.json not found — run premarket_setup.mjs first" },
        { status: 404 },
      );
    }
    const raw = JSON.parse(fs.readFileSync(ENTRY_NOTES_PATH, "utf8")) as RawFile;
    const ageMs = Date.now() - new Date(raw.generatedAt).getTime();
    const ageMinutes = Math.round(ageMs / 60000);
    return NextResponse.json({
      ok: true,
      generatedAt: raw.generatedAt,
      ageMinutes,
      isStale: ageMinutes > STALE_THRESHOLD_MIN,
      tickers: raw.tickers ?? {},
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: `failed to read entry notes: ${message}` },
      { status: 500 },
    );
  }
}
