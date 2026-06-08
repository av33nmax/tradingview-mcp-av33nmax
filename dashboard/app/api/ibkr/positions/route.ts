import { NextResponse } from "next/server";
import { getPositions, type PositionRow } from "@/lib/ibkr-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type PositionsResponse =
  | { ok: true; positions: PositionRow[]; fetchedAt: number }
  | { ok: false; error: string };

export async function GET(): Promise<NextResponse<PositionsResponse>> {
  try {
    const positions = await getPositions();
    // Dedupe by full contract identity. IBKR's reqPositions has been observed
    // emitting the same position twice when stale event listeners accumulate
    // on the singleton TCP connection (hot-reload churn or interrupted prior
    // calls). Dedupe at the API boundary so no consumer (dashboard ticker
    // cards, /account tab, sticky header) can render duplicate React children.
    const seen = new Set<string>();
    const deduped: PositionRow[] = [];
    for (const p of positions) {
      const k = `${p.conId ?? p.symbol}|${p.right ?? ""}|${p.strike ?? ""}|${p.expiry ?? ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(p);
    }
    return NextResponse.json({ ok: true, positions: deduped, fetchedAt: Date.now() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
