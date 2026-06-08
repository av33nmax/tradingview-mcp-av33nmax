import { NextResponse } from "next/server";
import { getBalances, type BalancesResult } from "@/lib/ibkr-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type BalancesResponse =
  | { ok: true; balances: BalancesResult; fetchedAt: number }
  | { ok: false; error: string };

export async function GET(): Promise<NextResponse<BalancesResponse>> {
  try {
    const balances = await getBalances();
    return NextResponse.json({ ok: true, balances, fetchedAt: Date.now() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
