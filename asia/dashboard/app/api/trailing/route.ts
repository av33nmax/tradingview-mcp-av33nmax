import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Per-instrument trailing-stop config.
 *
 * GET  /api/trailing → { instruments: { KEY: { enabled, trailAmount, isDefault, ... } } }
 * POST /api/trailing { instrumentKey, enabled?, trailAmount?, set_by? }
 *     → updated entry for that instrument
 *
 * Backed by asia/state/trailing_instruments.json. Defaults derived from
 * contracts.json `kind` field (index_futures vs single_stock). Dashboard
 * binds to localhost only — no auth.
 */

const ASIA_ROOT = path.join(process.cwd(), "..");
const STATE_PATH = path.join(ASIA_ROOT, "state", "trailing_instruments.json");
const CONTRACTS_PATH = path.join(ASIA_ROOT, "config", "contracts.json");

// Fallback only — defaults are first read from spec.default_trail_amount
// in contracts.json. These are sized at ~3× typical HK option bid-ask
// spread to avoid microstructure wicks.
const DEFAULT_TRAIL_BY_KIND: Record<string, number> = {
  index_futures: 10.0,
  single_stock: 0.60,
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type TrailingEntry = {
  enabled: boolean;
  trailAmount: number;
  set_at?: string | null;
  set_by?: string | null;
};

type TrailingState = {
  updated_at: string | null;
  instruments: Record<string, TrailingEntry>;
};

type Spec = { kind?: string; name?: string; currency?: string; multiplier?: number; default_trail_amount?: number };

async function readState(): Promise<TrailingState> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      updated_at: parsed.updated_at ?? null,
      instruments: parsed.instruments && typeof parsed.instruments === "object" ? parsed.instruments : {},
    };
  } catch {
    return { updated_at: null, instruments: {} };
  }
}

async function readContracts(): Promise<Record<string, Spec>> {
  try {
    const raw = await fs.readFile(CONTRACTS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.primary || {};
  } catch {
    return {};
  }
}

function defaultTrailFor(spec: Spec | undefined): number {
  if (Number.isFinite(spec?.default_trail_amount) && (spec!.default_trail_amount as number) > 0) {
    return spec!.default_trail_amount as number;
  }
  return DEFAULT_TRAIL_BY_KIND[spec?.kind ?? ""] ?? 0.60;
}

function effectiveEntry(key: string, state: TrailingState, spec: Spec | undefined) {
  const stored = state.instruments[key];
  if (!stored) {
    return {
      enabled: false,
      trailAmount: defaultTrailFor(spec),
      set_at: null as string | null,
      set_by: null as string | null,
      isDefault: true,
    };
  }
  const trailAmount = Number.isFinite(stored.trailAmount) && stored.trailAmount > 0
    ? stored.trailAmount
    : defaultTrailFor(spec);
  return {
    enabled: Boolean(stored.enabled),
    trailAmount,
    set_at: stored.set_at ?? null,
    set_by: stored.set_by ?? null,
    isDefault: false,
  };
}

export async function GET() {
  const [state, primary] = await Promise.all([readState(), readContracts()]);
  const keys = Object.keys(primary).filter((k) => !k.startsWith("_"));
  const instruments: Record<string, ReturnType<typeof effectiveEntry> & { currency: string; multiplier: number; defaultTrailAmount: number }> = {};
  for (const key of keys) {
    const spec = primary[key];
    instruments[key] = {
      ...effectiveEntry(key, state, spec),
      currency: spec?.currency ?? "HKD",
      multiplier: Number(spec?.multiplier ?? 1),
      defaultTrailAmount: defaultTrailFor(spec),
    };
  }
  return Response.json({ updated_at: state.updated_at, instruments });
}

export async function POST(req: Request) {
  let body: { instrumentKey?: string; enabled?: boolean; trailAmount?: number; set_by?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  const instrumentKey = String(body.instrumentKey ?? "");
  if (!instrumentKey) {
    return Response.json({ error: "instrumentKey required" }, { status: 400 });
  }
  const primary = await readContracts();
  if (!primary[instrumentKey]) {
    return Response.json(
      { error: `unknown instrument '${instrumentKey}' (valid: ${Object.keys(primary).filter((k) => !k.startsWith("_")).join(", ")})` },
      { status: 400 }
    );
  }
  if (body.trailAmount != null) {
    const ta = Number(body.trailAmount);
    if (!Number.isFinite(ta) || ta <= 0 || ta > 1000) {
      return Response.json({ error: `trailAmount must be > 0 and ≤ 1000 (got ${body.trailAmount})` }, { status: 400 });
    }
  }
  const set_by = typeof body.set_by === "string" && body.set_by.length > 0 && body.set_by.length < 64
    ? body.set_by
    : "dashboard";

  const state = await readState();
  const existing = state.instruments[instrumentKey] ?? {};
  const spec = primary[instrumentKey];
  const next: TrailingEntry = {
    enabled: body.enabled != null ? Boolean(body.enabled) : Boolean(existing.enabled),
    trailAmount: body.trailAmount != null
      ? Number(body.trailAmount)
      : (Number.isFinite(existing.trailAmount) && (existing.trailAmount as number) > 0
          ? (existing.trailAmount as number)
          : defaultTrailFor(spec)),
    set_at: new Date().toISOString(),
    set_by,
  };
  state.instruments[instrumentKey] = next;
  state.updated_at = next.set_at as string;

  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");

  return Response.json({
    instrumentKey,
    ...effectiveEntry(instrumentKey, state, spec),
    currency: spec?.currency ?? "HKD",
    multiplier: Number(spec?.multiplier ?? 1),
    defaultTrailAmount: defaultTrailFor(spec),
  });
}
