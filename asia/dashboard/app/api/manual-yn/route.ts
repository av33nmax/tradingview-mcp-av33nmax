import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Manual Y/N toggle — the binding gate for asia/scripts/trade_window_hk.mjs.
 *
 * GET  /api/manual-yn → current state + computed armed-today flags
 * POST /api/manual-yn { yn: 'Y' | 'N', set_by?: string } → writes new state
 *
 * Reads/writes asia/state/manual_yn.json. The watcher's gate evaluator
 * (asia/lib/gates_eval.mjs#evaluateManualYN) requires:
 *   - yn === 'Y'
 *   - set_at is a parseable ISO timestamp
 *   - set_at's SGT calendar date === today's SGT date (yesterday's Y
 *     does NOT auto-arm today — friction is intentional)
 *
 * Dashboard binds to localhost only so no auth on this route.
 */

const ASIA_ROOT = path.join(process.cwd(), "..");
const MANUAL_YN_PATH = path.join(ASIA_ROOT, "state", "manual_yn.json");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ManualYNFile = {
  yn: "Y" | "N" | null;
  set_at: string | null;
  set_by: string | null;
  _note?: string;
};

type ManualYNResponse = ManualYNFile & {
  today_sgt_date: string;
  is_armed_today: boolean;
  stale_armed: boolean;
  set_sgt_date: string | null;
};

function todaySgtDate(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function sgtDateOf(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return todaySgtDate(d);
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
  const today = todaySgtDate();
  const setSgt = sgtDateOf(file.set_at);
  const is_armed_today = file.yn === "Y" && setSgt === today;
  const stale_armed = file.yn === "Y" && setSgt !== null && setSgt !== today;
  return {
    ...file,
    today_sgt_date: today,
    is_armed_today,
    stale_armed,
    set_sgt_date: setSgt,
  };
}

export async function GET() {
  const file = await readState();
  return Response.json(buildResponse(file));
}

export async function POST(req: Request) {
  let body: { yn?: string; set_by?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  const yn = String(body.yn ?? "").toUpperCase();
  if (yn !== "Y" && yn !== "N") {
    return Response.json({ error: `yn must be 'Y' or 'N' (got '${body.yn}')` }, { status: 400 });
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
      "Binding gate for asia/scripts/trade_window_hk.mjs. Watcher refuses to fire unless yn === 'Y' and set_at is within the current SGT trading day. Toggle from the dashboard.",
  };

  await fs.mkdir(path.dirname(MANUAL_YN_PATH), { recursive: true });
  await fs.writeFile(MANUAL_YN_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");

  return Response.json(buildResponse(next));
}
