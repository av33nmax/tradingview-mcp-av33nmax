import { NextResponse } from "next/server";
import { killChild, getChild } from "@/lib/running-child";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Kill a specific command's child: POST /api/run/abort?command=watcher-tencent
 *
 * Was a no-arg "kill the one running child" until 2026-06-04 — now that multiple
 * commands (all HK watchers) run concurrently, abort must name its target.
 */
export async function POST(req: Request) {
  const command = new URL(req.url).searchParams.get("command");
  if (!command) {
    return NextResponse.json({ ok: false, error: "command query param required" }, { status: 400 });
  }
  const current = getChild(command);
  if (!current) {
    return NextResponse.json({ ok: true, wasRunning: false, command });
  }
  const { killed } = killChild(command);
  return NextResponse.json({ ok: true, wasRunning: true, killed, command });
}
