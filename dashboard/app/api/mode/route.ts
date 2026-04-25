import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Returns the current IBKR connection mode based on the configured port.
 * Used by the dashboard header to show a 🔴 LIVE indicator so the user
 * never misclicks while thinking they're on paper.
 *
 * Mirrors logic in ibkr_config.mjs but read directly from env so the
 * dashboard doesn't need to import the script-side module.
 */
export async function GET() {
  const port = parseInt(process.env.IBKR_PORT || "7496", 10);
  const host = process.env.IBKR_HOST || "192.168.18.35";
  const isLive = port === 7496;
  return NextResponse.json({
    ok: true,
    host,
    port,
    isLive,
    label: isLive ? "LIVE" : "PAPER",
  });
}
