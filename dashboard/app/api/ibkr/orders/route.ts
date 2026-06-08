import { NextResponse } from "next/server";
import { getOpenOrders, type OrderRow } from "@/lib/ibkr-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type OrdersResponse =
  | { ok: true; orders: OrderRow[]; fetchedAt: number }
  | { ok: false; error: string };

export async function GET(): Promise<NextResponse<OrdersResponse>> {
  try {
    const orders = await getOpenOrders();
    return NextResponse.json({ ok: true, orders, fetchedAt: Date.now() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
