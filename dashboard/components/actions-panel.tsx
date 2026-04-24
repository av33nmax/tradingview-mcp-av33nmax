"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useCommandRunner } from "@/lib/command-runner";
import { cn } from "@/lib/utils";
import {
  Telescope,
  Activity,
  MonitorPlay,
  Loader2,
  CheckCircle2,
  XCircle,
  Play,
} from "lucide-react";

type Action = {
  command: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  accent: "emerald" | "sky" | "amber";
};

const ACTIONS: Action[] = [
  {
    command: "premarket-setup",
    label: "Run pre-market setup",
    description: "Analysis + chart drawings + fresh entry_notes",
    icon: <Telescope className="h-4 w-4" />,
    accent: "emerald",
  },
  {
    command: "test-ibkr",
    label: "Test IBKR connection",
    description: "Read-only account summary sanity check",
    icon: <Activity className="h-4 w-4" />,
    accent: "sky",
  },
  {
    command: "launch-tv",
    label: "Launch TradingView (CDP)",
    description: "Start TV with port 9222 open for automation",
    icon: <MonitorPlay className="h-4 w-4" />,
    accent: "amber",
  },
];

const accentStyles = {
  emerald: {
    iconBg: "bg-emerald-500/10 text-emerald-400 ring-emerald-500/20",
    hover: "hover:border-emerald-500/40 hover:bg-emerald-500/5",
  },
  sky: {
    iconBg: "bg-sky-500/10 text-sky-400 ring-sky-500/20",
    hover: "hover:border-sky-500/40 hover:bg-sky-500/5",
  },
  amber: {
    iconBg: "bg-amber-500/10 text-amber-400 ring-amber-500/20",
    hover: "hover:border-amber-500/40 hover:bg-amber-500/5",
  },
};

function statusIcon(state: ReturnType<typeof useCommandRunner>["state"], command: string) {
  if (state.kind === "running" && state.command === command) {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" />;
  }
  if (state.kind === "done" && state.command === command) {
    return state.exitCode === 0 ? (
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
    ) : (
      <XCircle className="h-3.5 w-3.5 text-rose-400" />
    );
  }
  if (state.kind === "error" && state.command === command) {
    return <XCircle className="h-3.5 w-3.5 text-rose-400" />;
  }
  return <Play className="h-3.5 w-3.5 opacity-50 group-hover:opacity-100" />;
}

export function ActionsPanel() {
  const { state, run } = useCommandRunner();
  const anyRunning = state.kind === "running";

  return (
    <Card className="border-zinc-800/60 bg-zinc-950/40">
      <CardContent className="py-5">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold tracking-tight">Actions</h3>
            <p className="text-xs text-muted-foreground">
              Run the daily routine commands without touching a terminal
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {ACTIONS.map((a) => {
            const s = accentStyles[a.accent];
            const isThisRunning = state.kind === "running" && state.command === a.command;
            return (
              <button
                key={a.command}
                onClick={() => run(a.command)}
                disabled={anyRunning}
                className={cn(
                  "group relative flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-left transition-all min-h-[76px]",
                  s.hover,
                  anyRunning && !isThisRunning && "opacity-40 cursor-not-allowed",
                  isThisRunning && "border-emerald-500/40 bg-emerald-500/5",
                )}
              >
                <div className="flex items-center justify-between">
                  <div
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-md ring-1 ring-inset",
                      s.iconBg,
                    )}
                  >
                    {a.icon}
                  </div>
                  {statusIcon(state, a.command)}
                </div>
                <div>
                  <div className="text-sm font-medium leading-tight">{a.label}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground leading-snug">
                    {a.description}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
