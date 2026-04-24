"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { ArrowUpRight, ArrowDownRight, Minus, TrendingUp, TrendingDown, Target, ShieldOff } from "lucide-react";

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
  if (!bias) return "bg-zinc-500/10 text-zinc-400 ring-zinc-500/20";
  const up = bias.toUpperCase();
  if (up === "BULL")     return "bg-emerald-500/15 text-emerald-300 ring-emerald-500/25";
  if (up === "BEAR")     return "bg-rose-500/15 text-rose-300 ring-rose-500/25";
  if (up === "NEUTRAL")  return "bg-amber-500/15 text-amber-300 ring-amber-500/25";
  if (up === "NO_TRADE") return "bg-zinc-500/10 text-zinc-400 ring-zinc-500/20";
  return "bg-zinc-500/10 text-zinc-400 ring-zinc-500/20";
}

function DirectionIcon({ direction }: { direction: "CALLS" | "PUTS" | null }) {
  if (direction === "CALLS") return <ArrowUpRight className="h-4 w-4 text-emerald-400" />;
  if (direction === "PUTS")  return <ArrowDownRight className="h-4 w-4 text-rose-400" />;
  return <Minus className="h-4 w-4 text-zinc-500" />;
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
                        "text-foreground";
  return (
    <div className="flex items-center justify-between text-sm py-1">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs uppercase tracking-wide">{label}</span>
      </div>
      <div className={cn("font-mono tabular-nums font-medium", toneClass)}>
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
        "relative overflow-hidden transition-all",
        tradeable ? "border-zinc-700/80" : "border-zinc-800/60 opacity-70",
      )}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-3">
              <h3 className="font-mono text-2xl font-semibold tracking-tight">{ticker}</h3>
              <Badge variant="outline" className={cn("ring-1 ring-inset", biasClass(bias))}>
                {biasLabel}
              </Badge>
              {aligned ? (
                <span className="text-xs text-emerald-400/90">aligned ✓</span>
              ) : aligned === false ? (
                <span className="text-xs text-zinc-500">not aligned</span>
              ) : null}
            </div>
            <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
              <DirectionIcon direction={direction} />
              <span>{direction ? `${direction} · 0DTE` : "no setup"}</span>
            </div>
          </div>
          <Button size="sm" disabled={!tradeable} variant={tradeable ? "default" : "secondary"}>
            {tradeable ? "Arm watcher" : "Skip"}
          </Button>
        </div>
      </CardHeader>

      {tradeable && triggerA && (
        <CardContent className="space-y-5 pt-0">
          <section>
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="h-4 w-4 text-orange-400" />
              <h4 className="text-sm font-medium">Trigger A — ORB breakout</h4>
            </div>
            <LevelRow icon={<Target className="h-3.5 w-3.5" />} label="Entry" value={triggerA.entry?.toFixed(2)} tone="entry" />
            <LevelRow icon={<ShieldOff className="h-3.5 w-3.5" />} label="Stop" value={triggerA.stop?.toFixed(2)} tone="stop" />
            <LevelRow label="T1" value={triggerA.T1?.toFixed(2)} tone="target" />
            <LevelRow label="T2" value={triggerA.T2?.toFixed(2)} tone="target" />
          </section>

          {triggerB && (
            <>
              <Separator />
              <section>
                <div className="flex items-center gap-2 mb-2">
                  <TrendingDown className="h-4 w-4 text-purple-400" />
                  <h4 className="text-sm font-medium">Trigger B — pullback</h4>
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
