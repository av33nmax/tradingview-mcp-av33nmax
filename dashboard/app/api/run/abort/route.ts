import { NextResponse } from "next/server";
import { killCurrentChild, getCurrentChild } from "@/lib/running-child";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const current = getCurrentChild();
  if (!current) {
    return NextResponse.json({ ok: true, wasRunning: false });
  }
  const { killed, command } = killCurrentChild();
  return NextResponse.json({
    ok: true,
    wasRunning: true,
    killed,
    command: command ?? null,
  });
}
