import { NextResponse } from "next/server";
import { getAccountSummary, type AccountSummary } from "@/lib/ibkr-account";
import { isLive } from "@/lib/ibkr-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type AccountSummaryResponse =
  | { ok: true; mode: "LIVE" | "PAPER"; summary: AccountSummary }
  | { ok: false; error: string };

export async function GET(): Promise<NextResponse<AccountSummaryResponse>> {
  try {
    const summary = await getAccountSummary();
    return NextResponse.json({
      ok: true,
      mode: isLive() ? "LIVE" : "PAPER",
      summary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
