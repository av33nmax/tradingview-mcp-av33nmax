/**
 * Read persisted execution snapshots from journal/executions-YYYY-MM-DD.json.
 *
 * Why this exists: IBKR's reqExecutions API only returns executions from the
 * current trading day, and the "trading day" rolls over at 18:00 ET. After
 * that boundary, the previous day's executions are no longer queryable via
 * the API even though they exist in the user's permanent IBKR records.
 *
 * scripts/persist_session.mjs writes journal/executions-YYYY-MM-DD.json at
 * end-of-session before the rollover. This endpoint reads those files so
 * the Trade History tab can render a full history that survives rollover.
 *
 * Response shape mirrors /api/ibkr/executions so the trade-history-tab
 * component can merge them by execId.
 */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import type { ExecutionRow } from "@/lib/ibkr-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// journal/ lives at repo root, one level above the dashboard/.
const JOURNAL_DIR = path.join(process.cwd(), "..", "journal");
const FILE_RE = /^executions-(\d{4}-\d{2}-\d{2})\.json$/;

export type JournalExecutionsResponse =
  | {
      ok: true;
      executions: ExecutionRow[];
      dates: string[]; // distinct YYYY-MM-DD covered
      fetchedAt: number;
    }
  | { ok: false; error: string };

export async function GET(): Promise<NextResponse<JournalExecutionsResponse>> {
  try {
    if (!fs.existsSync(JOURNAL_DIR)) {
      return NextResponse.json({ ok: true, executions: [], dates: [], fetchedAt: Date.now() });
    }
    const files = fs.readdirSync(JOURNAL_DIR).filter((f) => FILE_RE.test(f));
    const all: ExecutionRow[] = [];
    const dates: string[] = [];
    for (const f of files) {
      const m = f.match(FILE_RE);
      if (!m) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(JOURNAL_DIR, f), "utf8"));
        const execs = Array.isArray(raw?.executions) ? (raw.executions as ExecutionRow[]) : [];
        all.push(...execs);
        dates.push(m[1]);
      } catch (e) {
        // Malformed file — skip it but don't fail the whole request.
        console.warn(`[journal/executions] skipped malformed ${f}: ${e instanceof Error ? e.message : e}`);
      }
    }
    dates.sort();
    return NextResponse.json({ ok: true, executions: all, dates, fetchedAt: Date.now() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
