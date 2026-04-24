"use client";

import { useEffect, useState } from "react";
import { getClockState, type ClockState } from "@/lib/session";
import { cn } from "@/lib/utils";

const phaseColorClasses: Record<ClockState["phaseColor"], string> = {
  bull:  "bg-emerald-500/15 text-emerald-400 ring-emerald-500/20",
  bear:  "bg-rose-500/15 text-rose-400 ring-rose-500/20",
  warn:  "bg-amber-500/15 text-amber-400 ring-amber-500/20",
  muted: "bg-zinc-500/15 text-zinc-400 ring-zinc-500/20",
};

export function SessionClock({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<ClockState | null>(null);

  useEffect(() => {
    const update = () => setState(getClockState(new Date()));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);

  if (!state) return <div className={compact ? "h-9" : "h-16"} />;

  if (compact) {
    // Mobile layout: clock time + phase pill, horizontal compact
    return (
      <div className="flex items-center gap-2">
        <div className="font-mono text-sm font-medium tabular-nums tracking-tight leading-none">
          {state.sgt.replace(" SGT", "")}
        </div>
        <div
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset whitespace-nowrap",
            phaseColorClasses[state.phaseColor],
          )}
        >
          {state.phaseLabel}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-baseline gap-6">
      <div className="flex flex-col">
        <div className="font-mono text-3xl font-medium tabular-nums tracking-tight">
          {state.sgt}
        </div>
        <div className="font-mono text-xs text-muted-foreground tabular-nums">
          {state.et}
        </div>
      </div>
      <div
        className={cn(
          "rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset",
          phaseColorClasses[state.phaseColor],
        )}
      >
        {state.phaseLabel}
      </div>
      <div className="hidden lg:block text-xs text-muted-foreground">
        {state.minsToNextPhase}m to {state.nextPhaseLabel}
      </div>
    </div>
  );
}
