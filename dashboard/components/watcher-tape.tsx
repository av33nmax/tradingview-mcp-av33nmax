"use client";

import { Activity, CheckCircle2, Circle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LastCheck } from "@/lib/watcher-runner";

const MAX_VISIBLE = 8;

export function WatcherTape({ checks }: { checks: LastCheck[] }) {
  if (checks.length === 0) return null;

  // Most recent first, capped at MAX_VISIBLE
  const visible = [...checks].reverse().slice(0, MAX_VISIBLE);
  const hiddenCount = Math.max(0, checks.length - visible.length);

  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <Activity className="h-4 w-4 text-sky-400" />
        <h4 className="text-[15px] font-semibold text-[#e4e4e7]">Live tape</h4>
        <span className="text-[12px] text-[#71717a]">
          last {visible.length}
          {hiddenCount > 0 ? ` of ${checks.length}` : ""}
        </span>
      </div>
      <div className="space-y-1.5 rounded-lg border border-white/[0.06] bg-[#0c0c0e] px-3 py-2.5">
        {visible.map((c) => {
          const Icon = c.triggered ? CheckCircle2 : Circle;
          const trigBadge = c.triggerType
            ? (c.triggerType === "A"
                ? <span className="shrink-0 rounded px-1 py-px text-[10px] font-bold tracking-wider text-orange-300 bg-orange-500/10 ring-1 ring-orange-500/20">A</span>
                : <span className="shrink-0 rounded px-1 py-px text-[10px] font-bold tracking-wider text-purple-300 bg-purple-500/10 ring-1 ring-purple-500/20">B</span>)
            : null;
          return (
            <div
              // 2026-05-06: include triggerType + barTime so checks emitted at
              // the same millisecond on different validators (Trigger A and B
              // both check on the 15m boundary; with 6 tickers that's 12+
              // checks within the same second) don't collide on key={c.at}.
              key={`${c.at}-${c.triggerType ?? ""}-${c.barTime ?? ""}`}
              className="flex items-start gap-2 text-[12.5px] font-mono leading-snug"
            >
              <Icon
                className={cn(
                  "h-3.5 w-3.5 shrink-0 mt-0.5",
                  c.triggered ? "text-emerald-400" : "text-[#52525b]",
                )}
              />
              {trigBadge}
              <span className="shrink-0 text-[#71717a] tabular-nums">
                {c.barTime ?? "—"}
              </span>
              <span
                className={cn(
                  "flex-1 min-w-0 break-words",
                  c.triggered ? "text-emerald-200" : "text-[#a1a1aa]",
                )}
              >
                {c.reason}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
