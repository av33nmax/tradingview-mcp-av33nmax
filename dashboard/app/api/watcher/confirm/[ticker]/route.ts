import { NextResponse } from "next/server";
import { getWatcher, appendLine } from "@/lib/watchers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Responds to the user's YES (or abort) from the dashboard modal.
 * Writes the response into the child's stdin so the script's readline
 * prompt resolves.
 *
 * Body: { answer: "YES" | "no" }
 *   "YES" → script fires the order + auto-arms OCA bracket
 *   "no"  → script returns false from handleTriggered, watcher loop continues
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ ticker: string }> },
) {
  const { ticker: tickerRaw } = await ctx.params;
  const ticker = tickerRaw.toUpperCase();

  const body = await req.json().catch(() => ({}));
  const answerRaw = String(body?.answer ?? "").trim();
  // Only exact "YES" counts as confirmation; anything else is abort
  const answer = answerRaw === "YES" ? "YES" : "no";

  const w = getWatcher(ticker);
  if (!w) {
    return NextResponse.json(
      { ok: false, error: `no watcher for ${ticker}` },
      { status: 404 },
    );
  }
  if (w.status !== "pending-confirm") {
    return NextResponse.json(
      { ok: false, error: `watcher status is ${w.status}, not pending-confirm` },
      { status: 409 },
    );
  }
  if (!w.child.stdin || w.child.stdin.destroyed) {
    return NextResponse.json(
      { ok: false, error: "child stdin unavailable" },
      { status: 500 },
    );
  }

  try {
    w.child.stdin.write(answer + "\n");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `stdin write failed: ${message}` }, { status: 500 });
  }

  appendLine(
    ticker,
    "info",
    answer === "YES"
      ? "✓ YES confirmed from dashboard — order firing"
      : "✗ aborted from dashboard — watcher continues",
  );

  // Clear pendingPrompt regardless of answer; status transitions back to running
  // (for "no" path) or to "running" (for YES path — script will emit exit
  // event after order placed and bracket armed).
  w.pendingPrompt = null;
  if (answer !== "YES") w.status = "running";

  return NextResponse.json({ ok: true, answer });
}
