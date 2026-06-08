import { NextResponse } from "next/server";
import { getExchangeRates, type ExchangeRates } from "@/lib/ibkr-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type FxRatesResponse =
  | ({ ok: true } & ExchangeRates)
  | { ok: false; error: string };

export async function GET(): Promise<NextResponse<FxRatesResponse>> {
  try {
    const fx = await getExchangeRates();
    return NextResponse.json({ ok: true, ...fx });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
