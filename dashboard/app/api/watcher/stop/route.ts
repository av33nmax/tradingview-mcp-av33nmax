import { NextResponse } from "next/server";
import { getWatcher, appendLine } from "@/lib/watchers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const ticker = String(body?.ticker ?? "").toUpperCase();

  const w = getWatcher(ticker);
  if (!w) {
    return NextResponse.json({ ok: true, wasRunning: false });
  }

  if (w.status === "exited") {
    return NextResponse.json({ ok: true, wasRunning: false, alreadyExited: true });
  }

  try {
    w.child.kill("SIGTERM");
    appendLine(ticker, "info", "stop requested — SIGTERM sent");
  } catch {
    // best effort
  }

  // Escalate to SIGKILL if still alive after 3s
  setTimeout(() => {
    const still = getWatcher(ticker);
    if (still && still.status !== "exited") {
      try { still.child.kill("SIGKILL"); } catch { /* gone */ }
    }
  }, 3000);

  return NextResponse.json({ ok: true, wasRunning: true });
}
