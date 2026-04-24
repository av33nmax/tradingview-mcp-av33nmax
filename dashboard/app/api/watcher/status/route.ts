import { NextResponse } from "next/server";
import { snapshotAll } from "@/lib/watchers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ ok: true, watchers: snapshotAll() });
}
