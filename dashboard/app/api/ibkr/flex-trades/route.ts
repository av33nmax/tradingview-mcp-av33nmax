import { NextResponse } from "next/server";
import type { ExecutionRow } from "@/lib/ibkr-account";
import { getFlexTrades, isFlexConfigured } from "@/lib/ibkr-flex";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type FlexTradesResponse =
  | { ok: true; configured: boolean; executions: ExecutionRow[]; fetchedAt: number }
  | { ok: false; configured: boolean; error: string };

export async function GET(): Promise<NextResponse<FlexTradesResponse>> {
  const configured = isFlexConfigured();
  // Not set up yet → return an empty, non-error result so Trade History simply
  // falls back to its other sources instead of showing an error banner.
  if (!configured) {
    return NextResponse.json({ ok: true, configured: false, executions: [], fetchedAt: Date.now() });
  }
  try {
    const { executions, fetchedAt } = await getFlexTrades();
    return NextResponse.json({ ok: true, configured: true, executions, fetchedAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, configured: true, error: message }, { status: 500 });
  }
}
