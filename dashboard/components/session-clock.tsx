"use client";

import { useEffect, useState } from "react";
import { getClockState, type ClockState } from "@/lib/session";
import { cn } from "@/lib/utils";

const phaseColorClasses: Record<ClockState["phaseColor"], string> = {
  bull:  "bg-emerald-500/10 text-emerald-400 ring-emerald-500/20",
  bear:  "bg-rose-500/10 text-rose-400 ring-rose-500/20",
  warn:  "bg-amber-500/10 text-amber-400 ring-amber-500/20",
  muted: "bg-white/[0.05] text-[#a1a1aa] ring-white/[0.08]",
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
    return (
      <div className="flex items-center gap-2">
        <div className="font-mono text-base font-medium tabular-nums tracking-tight leading-none text-[#e4e4e7]">
          {state.sgt.replace(" SGT", "")}
        </div>
        <div
          className={cn(
            "rounded-full px-2.5 py-0.5 text-[11px] font-medium ring-1 ring-inset whitespace-nowrap",
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
        <div className="font-mono text-3xl font-medium tabular-nums tracking-tight text-[#e4e4e7]">
          {state.sgt}
        </div>
        <div className="font-mono text-[13px] text-[#71717a] tabular-nums">
          {state.et}
        </div>
      </div>
      <div
        className={cn(
          "rounded-full px-3.5 py-1 text-[13px] font-medium ring-1 ring-inset",
          phaseColorClasses[state.phaseColor],
        )}
      >
        {state.phaseLabel}
      </div>
      <div className="hidden lg:block text-[13px] text-[#71717a]">
        {state.minsToNextPhase}m to {state.nextPhaseLabel}
      </div>
    </div>
  );
}
