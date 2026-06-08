"use client";

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  HelpCircle,
  ToggleLeft,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Maps the raw gate name (as written in gates.json + journal Stage 5)
 * to a short human-friendly label that fits in a chip.
 */
const GATE_LABELS: Record<string, string> = {
  vhsi_regime: "VHSI",
  a50_correlation: "A50",
  china_policy_blackout: "Policy",
  session_window: "Window",
  daily_trade_cap: "Cap",
  manual_dashboard_yn: "Y/N",
  correlation_chase_filter: "Chase",
};

type GateStatus = {
  category: "pass" | "fail" | "unknown" | "deferred" | "manual";
  detail: string; // short text shown after the label, e.g. "VHSI=18"
};

/**
 * Classify a raw status string from the journal into a UI category.
 * Examples of inputs:
 *   "pass (VHSI=18, regime=normal)"      → pass
 *   "fail (VHSI=42 outside 15-35, ...)"  → fail
 *   "unknown_no_vhsi_tab"                → unknown
 *   "unknown_data_missing"               → unknown
 *   "unknown_calendar_not_wired"         → unknown
 *   "evaluated_at_open"                  → deferred
 *   "evaluated_at_entry"                 → deferred
 *   "default=N"                          → manual
 */
function classifyStatus(status: string): GateStatus {
  const s = status.toLowerCase();

  if (s.startsWith("pass")) {
    // Try to extract the bracketed detail "(VHSI=18, regime=normal)"
    const m = status.match(/\(([^)]+)\)/);
    return { category: "pass", detail: m ? m[1] : "ok" };
  }
  if (s.startsWith("fail")) {
    const m = status.match(/\(([^)]+)\)/);
    return { category: "fail", detail: m ? m[1] : "fail" };
  }
  // "deferred (next 13:00 SGT in 2h31m)" — used by session_window when out-of-window
  if (s.startsWith("deferred")) {
    const m = status.match(/\(([^)]+)\)/);
    return { category: "deferred", detail: m ? m[1] : "deferred" };
  }
  // Specific unknown_* variants — order matters (most-specific first)
  if (s === "unknown_no_calendar") {
    return { category: "unknown", detail: "no calendar" };
  }
  if (s === "unknown_calendar_stale") {
    return { category: "unknown", detail: "stale" };
  }
  if (s.includes("_no_") && s.includes("tab")) {
    return { category: "unknown", detail: "no tab" };
  }
  if (s.includes("not_wired")) {
    return { category: "unknown", detail: "unwired" };
  }
  if (s.startsWith("unknown")) {
    return { category: "unknown", detail: "no data" };
  }
  if (s.startsWith("evaluated_at_open")) {
    return { category: "deferred", detail: "@open" };
  }
  if (s.startsWith("evaluated_at_entry")) {
    return { category: "deferred", detail: "@entry" };
  }
  if (s.startsWith("default=")) {
    return { category: "manual", detail: status.slice(8) };
  }
  return { category: "unknown", detail: status };
}

function chipClass(category: GateStatus["category"]): string {
  switch (category) {
    case "pass":
      return "bg-emerald-500/10 text-emerald-400 ring-emerald-500/25";
    case "fail":
      return "bg-rose-500/10 text-rose-400 ring-rose-500/25";
    case "unknown":
      return "bg-amber-500/10 text-amber-400 ring-amber-500/25";
    case "deferred":
      return "bg-white/[0.04] text-muted-foreground ring-white/[0.08]";
    case "manual":
      return "bg-sky-500/10 text-sky-400 ring-sky-500/25";
  }
}

function ChipIcon({ category }: { category: GateStatus["category"] }) {
  const cls = "h-3 w-3";
  switch (category) {
    case "pass":
      return <CheckCircle2 className={cls} />;
    case "fail":
      return <XCircle className={cls} />;
    case "unknown":
      return <AlertTriangle className={cls} />;
    case "deferred":
      return <Clock className={cls} />;
    case "manual":
      return <ToggleLeft className={cls} />;
  }
}

export type GatePanelProps = {
  gates: Array<{ name: string; status: string }>;
};

export function GatePanel({ gates }: GatePanelProps) {
  if (!gates || gates.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card/50 p-4 text-sm text-muted-foreground flex items-center gap-2">
        <HelpCircle className="h-4 w-4" />
        No gate data — run{" "}
        <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
          npm run premarket:hsi
        </code>{" "}
        to populate.
      </div>
    );
  }

  // Count categories for the summary line
  const counts = gates.reduce<Record<string, number>>((acc, g) => {
    const c = classifyStatus(g.status).category;
    acc[c] = (acc[c] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5" />
          Gates
        </h3>
        <span className="text-[10px] text-muted-foreground/70 tracking-wide">
          {counts.pass ? `${counts.pass} pass · ` : ""}
          {counts.fail ? `${counts.fail} fail · ` : ""}
          {counts.unknown ? `${counts.unknown} unknown · ` : ""}
          {counts.deferred ? `${counts.deferred} deferred · ` : ""}
          {counts.manual ? `${counts.manual} manual` : ""}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {gates.map((g) => {
          const { category, detail } = classifyStatus(g.status);
          const label = GATE_LABELS[g.name] ?? g.name;
          return (
            <span
              key={g.name}
              className={cn(
                "inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full ring-1 ring-inset",
                chipClass(category)
              )}
              title={`${g.name}: ${g.status}`}
            >
              <ChipIcon category={category} />
              <span className="font-medium">{label}</span>
              <span className="text-[10px] opacity-70 font-mono">{detail}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
