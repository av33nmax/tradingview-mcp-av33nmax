"use client";

import { useCommandRunner, type CommandState } from "@/lib/command-runner";
import { cn } from "@/lib/utils";
import {
  Telescope,
  Activity,
  Calendar,
  Target,
  CheckSquare,
  Loader2,
  CheckCircle2,
  XCircle,
  Play,
  Rocket,
} from "lucide-react";

type Action = {
  command: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  accent: "emerald" | "sky" | "amber" | "violet" | "rose";
};

// Primary daily action — unified routine that orchestrates all the steps
// below with a single upfront tag-scan cleanup pass. Mirrors the US
// `premarket_setup.mjs` flow. Use this for the daily workflow; the
// individual buttons below are for granular debugging / re-running a
// single step.
const PRIMARY: Action = {
  command: "premarket-asia",
  label: "Pre-market Asia (run all)",
  description:
    "Cleanup → calendar → bias + levels + FVG → A50 + ORB (≥09:45 SGT) → verify. One button, clean slate every run.",
  icon: <Rocket className="h-4 w-4" />,
  accent: "emerald",
};

// Individual steps — kept available for granular debugging and one-off
// re-runs. Daily usage should prefer the PRIMARY unified action above.
const STEPS: Action[] = [
  {
    command: "premarket-hsi",
    label: "Pre-market analysis",
    description: "Prior levels + multi-TF + S/R + FVG + draws on chart for all 5 instruments (08:30 SGT)",
    icon: <Telescope className="h-4 w-4" />,
    accent: "emerald",
  },
  {
    command: "orb-hsi",
    label: "Run ORB",
    description: "Opening range + ±1R/2R triggers + initial VWAP/EMA21 for all 5 instruments (09:45 SGT)",
    icon: <Target className="h-4 w-4" />,
    accent: "sky",
  },
  {
    command: "check-correlation",
    label: "A50 correlation",
    description: "Session-wide regime gate (MHI/A50 first-bar agreement). Applies to all 5 watchers (09:45 SGT)",
    icon: <Activity className="h-4 w-4" />,
    accent: "violet",
  },
  {
    command: "refresh-calendar",
    label: "Refresh calendar",
    description: "Pull this week's China/HK policy blackout windows. Session-wide gate for all 5 watchers (daily)",
    icon: <Calendar className="h-4 w-4" />,
    accent: "amber",
  },
  {
    command: "verify-drawings",
    label: "Verify drawings",
    description: "Cross-check shape state file vs live TradingView across all instruments",
    icon: <CheckSquare className="h-4 w-4" />,
    accent: "rose",
  },
];

const accentStyles = {
  emerald: {
    iconBg: "bg-emerald-500/10 text-emerald-400 ring-emerald-500/20",
    hover: "hover:border-emerald-500/25 hover:bg-emerald-500/[0.04]",
    active: "border-emerald-500/30 bg-emerald-500/[0.06]",
  },
  sky: {
    iconBg: "bg-sky-500/10 text-sky-400 ring-sky-500/20",
    hover: "hover:border-sky-500/25 hover:bg-sky-500/[0.04]",
    active: "border-sky-500/30 bg-sky-500/[0.06]",
  },
  amber: {
    iconBg: "bg-amber-500/10 text-amber-400 ring-amber-500/20",
    hover: "hover:border-amber-500/25 hover:bg-amber-500/[0.04]",
    active: "border-amber-500/30 bg-amber-500/[0.06]",
  },
  violet: {
    iconBg: "bg-violet-500/10 text-violet-400 ring-violet-500/20",
    hover: "hover:border-violet-500/25 hover:bg-violet-500/[0.04]",
    active: "border-violet-500/30 bg-violet-500/[0.06]",
  },
  rose: {
    iconBg: "bg-rose-500/10 text-rose-400 ring-rose-500/20",
    hover: "hover:border-rose-500/25 hover:bg-rose-500/[0.04]",
    active: "border-rose-500/30 bg-rose-500/[0.06]",
  },
};

function statusIcon(state: CommandState) {
  if (state.kind === "running") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" />;
  }
  if (state.kind === "done") {
    return state.exitCode === 0 ? (
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
    ) : (
      <XCircle className="h-3.5 w-3.5 text-rose-400" />
    );
  }
  if (state.kind === "error") {
    return <XCircle className="h-3.5 w-3.5 text-rose-400" />;
  }
  return (
    <Play className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground" />
  );
}

export function ActionsPanel() {
  const { stateOf, run } = useCommandRunner();
  // One-shot actions stay one-at-a-time (they touch the chart / shared state);
  // watchers run concurrently and are unaffected by this gate.
  const anyRunning = [PRIMARY, ...STEPS].some((a) => stateOf(a.command).kind === "running");

  const renderButton = (a: Action, primary = false) => {
    const s = accentStyles[a.accent];
    const st = stateOf(a.command);
    const isThisRunning = st.kind === "running";
    return (
      <button
        key={a.command}
        onClick={() => run(a.command)}
        disabled={anyRunning}
        className={cn(
          "group relative flex flex-col gap-2 rounded-xl border bg-background text-left transition-all",
          primary
            ? "p-5 min-h-[112px] border-2 border-emerald-500/30 bg-emerald-500/[0.03] sm:col-span-2 lg:col-span-3"
            : "p-4 min-h-[88px] border-border",
          s.hover,
          anyRunning && !isThisRunning && "opacity-40 cursor-not-allowed",
          isThisRunning && s.active
        )}
      >
        <div className="flex items-center justify-between">
          <div
            className={cn(
              "flex items-center justify-center rounded-lg ring-1 ring-inset",
              primary ? "h-11 w-11" : "h-9 w-9",
              s.iconBg
            )}
          >
            {a.icon}
          </div>
          {statusIcon(st)}
        </div>
        <div>
          <div
            className={cn(
              "font-semibold leading-tight",
              primary ? "text-[17px]" : "text-[15px]"
            )}
          >
            {a.label}
          </div>
          <div className="mt-1 text-[12px] text-muted-foreground leading-snug">
            {a.description}
          </div>
        </div>
      </button>
    );
  };

  return (
    <div className="rounded-xl border border-border bg-card text-card-foreground p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold tracking-tight">Actions</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            Run the daily routine commands without touching a terminal
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {renderButton(PRIMARY, true)}
      </div>

      <div className="mt-5">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Individual steps
          </span>
          <span className="text-[11px] text-muted-foreground/60">
            · for granular debugging — the unified action above runs all five
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {STEPS.map((a) => renderButton(a))}
        </div>
      </div>
    </div>
  );
}
