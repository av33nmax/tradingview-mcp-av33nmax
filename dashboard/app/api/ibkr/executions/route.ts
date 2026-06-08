import { NextResponse } from "next/server";
import { getExecutions, type ExecutionRow } from "@/lib/ibkr-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type ExecutionsResponse =
  | { ok: true; executions: ExecutionRow[]; fetchedAt: number }
  | { ok: false; error: string };

export async function GET(): Promise<NextResponse<ExecutionsResponse>> {
  try {
    const executions = await getExecutions();
    return NextResponse.json({ ok: true, executions, fetchedAt: Date.now() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
