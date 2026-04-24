"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { WatcherControls } from "@/components/watcher-controls";
import { cn } from "@/lib/utils";
import {
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  TrendingUp,
  TrendingDown,
  Target,
  ShieldOff,
} from "lucide-react";

type TriggerA = {
  entry: number;
  stop: number;
  T1: number;
  T2: number;
};

type TriggerB = {
  entry_vwap: number;
  entry_ema21_1H: number;
  stop: number;
  T1: number;
  T2: number;
};

export type TickerCardProps = {
  ticker: string;
  bias: string | null;
  aligned: boolean | null;
  direction: "CALLS" | "PUTS" | null;
  triggerA: TriggerA | null;
  triggerB: TriggerB | null;
};

function biasClass(bias: string | null): string {
  if (!bias) return "bg-white/[0.05] text-[#a1a1aa] ring-white/[0.08]";
  const up = bias.toUpperCase();
  if (up === "BULL")     return "bg-emerald-500/10 text-emerald-400 ring-emerald-500/25";
  if (up === "BEAR")     return "bg-rose-500/10 text-rose-400 ring-rose-500/25";
  if (up === "NEUTRAL")  return "bg-amber-500/10 text-amber-400 ring-amber-500/25";
  if (up === "NO_TRADE") return "bg-white/[0.05] text-[#a1a1aa] ring-white/[0.08]";
  return "bg-white/[0.05] text-[#a1a1aa] ring-white/[0.08]";
}

function DirectionIcon({ direction }: { direction: "CALLS" | "PUTS" | null }) {
  if (direction === "CALLS") return <ArrowUpRight className="h-4 w-4 text-emerald-400" />;
  if (direction === "PUTS")  return <ArrowDownRight className="h-4 w-4 text-rose-400" />;
  return <Minus className="h-4 w-4 text-[#71717a]" />;
}

function LevelRow({
  icon,
  label,
  value,
  tone,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string | number | undefined;
  tone?: "neutral" | "stop" | "target" | "entry";
}) {
  const toneClass =
    tone === "stop"   ? "text-rose-400" :
    tone === "target" ? "text-emerald-400" :
    tone === "entry"  ? "text-sky-400" :
                        "text-[#e4e4e7]";
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-2 text-[#a1a1aa]">
        {icon}
        <span className="text-[13px] uppercase tracking-wide font-medium">{label}</span>
      </div>
      <div className={cn("font-mono tabular-nums font-semibold text-[15px]", toneClass)}>
        {value ?? "—"}
      </div>
    </div>
  );
}

export function TickerCard({ ticker, bias, aligned, direction, triggerA, triggerB }: TickerCardProps) {
  const tradeable = !!triggerA;
  const biasLabel = bias ?? "—";

  return (
    <Card
      className={cn(
        "relative overflow-hidden rounded-2xl border border-white/[0.06] bg-[#131316] shadow-[0_1px_2px_rgba(0,0,0,0.3),0_8px_24px_-12px_rgba(0,0,0,0.4)] transition-all",
        !tradeable && "opacity-70",
      )}
    >
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-mono text-3xl font-semibold tracking-tight text-[#e4e4e7]">{ticker}</h3>
              <Badge
                variant="outline"
                className={cn("text-[13px] px-2.5 py-0.5 ring-1 ring-inset border-transparent font-semibold", biasClass(bias))}
              >
                {biasLabel}
              </Badge>
              {aligned ? (
                <span className="text-sm text-emerald-400 font-medium">aligned ✓</span>
              ) : aligned === false ? (
                <span className="text-sm text-[#71717a]">not aligned</span>
              ) : null}
            </div>
            <div className="mt-2 flex items-center gap-2 text-[15px] text-[#a1a1aa]">
              <DirectionIcon direction={direction} />
              <span>{direction ? `${direction} · 0DTE` : "no setup"}</span>
            </div>
          </div>
          <WatcherControls ticker={ticker} disabled={!tradeable} />
        </div>
      </CardHeader>

      {tradeable && triggerA && (
        <CardContent className="space-y-5 pt-0">
          <section>
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="h-4 w-4 text-orange-400" />
              <h4 className="text-[15px] font-semibold text-[#e4e4e7]">Trigger A — ORB breakout</h4>
            </div>
            <LevelRow icon={<Target className="h-3.5 w-3.5" />} label="Entry" value={triggerA.entry?.toFixed(2)} tone="entry" />
            <LevelRow icon={<ShieldOff className="h-3.5 w-3.5" />} label="Stop" value={triggerA.stop?.toFixed(2)} tone="stop" />
            <LevelRow label="T1" value={triggerA.T1?.toFixed(2)} tone="target" />
            <LevelRow label="T2" value={triggerA.T2?.toFixed(2)} tone="target" />
          </section>

          {triggerB && (
            <>
              <Separator className="bg-white/[0.06]" />
              <section>
                <div className="flex items-center gap-2 mb-2">
                  <TrendingDown className="h-4 w-4 text-purple-400" />
                  <h4 className="text-[15px] font-semibold text-[#e4e4e7]">Trigger B — pullback</h4>
                </div>
                <LevelRow label="VWAP" value={triggerB.entry_vwap?.toFixed(2)} tone="entry" />
                <LevelRow label="EMA21" value={triggerB.entry_ema21_1H?.toFixed(2)} tone="entry" />
                <LevelRow icon={<ShieldOff className="h-3.5 w-3.5" />} label="Stop" value={triggerB.stop?.toFixed(2)} tone="stop" />
                <LevelRow label="T1" value={triggerB.T1?.toFixed(2)} tone="target" />
                <LevelRow label="T2" value={triggerB.T2?.toFixed(2)} tone="target" />
              </section>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
