import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

/**
 * US session-level kill switch — gates trade_window.mjs from sending any
 * orders to IBKR when off, even if a YES is typed at the terminal.
 *
 * GET  /api/manual-yn → current state + today_et_date + is_armed_today
 * POST /api/manual-yn { yn: 'Y' | 'N', set_by?: string } → writes new state
 *
 * State file: <repo>/manual_yn.json (NOT asia/state/ — US and Asia have
 * separate toggles per the session-isolation requirement). Date scope: ET.
 */

const REPO_ROOT = path.join(process.cwd(), "..");
const MANUAL_YN_PATH = path.join(REPO_ROOT, "manual_yn.json");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ManualYNFile = {
  yn: "Y" | "N" | null;
  set_at: string | null;
  set_by: string | null;
  _note?: string;
};

type ManualYNResponse = ManualYNFile & {
  today_et_date: string;
  is_armed_today: boolean;
  stale_armed: boolean;
  set_et_date: string | null;
};

function todayEtDate(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function etDateOf(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return todayEtDate(d);
}

async function readState(): Promise<ManualYNFile> {
  try {
    const raw = await fs.readFile(MANUAL_YN_PATH, "utf8");
    const parsed = JSON.parse(raw) as ManualYNFile;
    return {
      yn: parsed.yn ?? null,
      set_at: parsed.set_at ?? null,
      set_by: parsed.set_by ?? null,
      _note: parsed._note,
    };
  } catch {
    return { yn: null, set_at: null, set_by: null };
  }
}

function buildResponse(file: ManualYNFile): ManualYNResponse {
  const today = todayEtDate();
  const setEt = etDateOf(file.set_at);
  const is_armed_today = file.yn === "Y" && setEt === today;
  const stale_armed = file.yn === "Y" && setEt !== null && setEt !== today;
  return {
    ...file,
    today_et_date: today,
    is_armed_today,
    stale_armed,
    set_et_date: setEt,
  };
}

export async function GET() {
  const file = await readState();
  return NextResponse.json(buildResponse(file));
}

export async function POST(req: Request) {
  let body: { yn?: string; set_by?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const yn = String(body.yn ?? "").toUpperCase();
  if (yn !== "Y" && yn !== "N") {
    return NextResponse.json({ error: `yn must be 'Y' or 'N' (got '${body.yn}')` }, { status: 400 });
  }
  const set_by =
    typeof body.set_by === "string" && body.set_by.length > 0 && body.set_by.length < 64
      ? body.set_by
      : "dashboard";

  const next: ManualYNFile = {
    yn: yn as "Y" | "N",
    set_at: new Date().toISOString(),
    set_by,
    _note:
      "Session-level kill switch for US trade_window.mjs. Watcher refuses to send orders to IBKR unless yn === 'Y' and set_at is within the current ET trading day. Layers on TOP of the per-fire YES prompt. Toggle from the dashboard.",
  };

  await fs.mkdir(path.dirname(MANUAL_YN_PATH), { recursive: true });
  await fs.writeFile(MANUAL_YN_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");

  return NextResponse.json(buildResponse(next));
}
