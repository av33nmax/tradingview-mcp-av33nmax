"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  Crosshair,
  Ban,
  Play,
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCommandRunner } from "@/lib/command-runner";
import { TrailingToggle, type TrailingInfo } from "./trailing-toggle";

/* ------------------------------------------------------------------------- */
/* Types                                                                      */
/* ------------------------------------------------------------------------- */

type Levels = {
  source?: string;
  prev_high?: number;
  prev_low?: number;
  prev_close?: number;
  prev_open?: number;
  prev_range_pct?: number;
};

type ORBSide = { entry: number; stop: number; T1: number; T2: number };

type ORBTrigger = {
  orb_high: number;
  orb_low: number;
  range: number;
  range_vs_atr?: number;
  long: ORBSide;
  short: ORBSide;
};

type TriggerB = {
  vwap: number | null;
  ema21_1h: number | null;
  atr_15: number | null;
  computed_at?: string;
};

type MTF = {
  alignment?: string;
  key_levels?: Array<{ type: string; price: number; tf: string }>;
  fvg_zones?: Array<{
    type: "bullish" | "bearish";
    low: number;
    high: number;
    tf: string;
  }>;
};

export type MarketCardProps = {
  symbol: string;
  description: string;
  us_analog: string;
  /** contracts.json primary key — used to derive the watcher command (e.g. "MHI" → "watcher-mhi") */
  instrumentKey: string;
  levels?: Levels;
  mtf?: MTF;
  orb?: ORBTrigger;
  trigger_b?: TriggerB | null;
  trailing?: TrailingInfo | null;
};

/* ------------------------------------------------------------------------- */
/* Bias derivation                                                            */
/* ------------------------------------------------------------------------- */

type Bias = "BULL" | "BEAR" | "NEUTRAL" | null;
type Direction = "CALLS" | "PUTS" | null;

function alignmentToBias(alignment?: string): Bias {
  if (!alignment) return null;
  if (alignment.startsWith("bullish")) return "BULL";
  if (alignment.startsWith("bearish")) return "BEAR";
  if (alignment === "mixed") return "NEUTRAL";
  return null;
}

function alignmentToDirection(alignment?: string): Direction {
  if (!alignment) return null;
  if (alignment.startsWith("bullish")) return "CALLS";
  if (alignment.startsWith("bearish")) return "PUTS";
  return null;
}

function biasClass(bias: Bias): string {
  if (bias === "BULL")
    return "bg-emerald-500/10 text-emerald-400 ring-emerald-500/25";
  if (bias === "BEAR") return "bg-rose-500/10 text-rose-400 ring-rose-500/25";
  if (bias === "NEUTRAL")
    return "bg-amber-500/10 text-amber-400 ring-amber-500/25";
  return "bg-white/[0.05] text-muted-foreground ring-white/[0.08]";
}

function DirectionIcon({ direction }: { direction: Direction }) {
  if (direction === "CALLS")
    return <ArrowUpRight className="h-4 w-4 text-emerald-400" />;
  if (direction === "PUTS")
    return <ArrowDownRight className="h-4 w-4 text-rose-400" />;
  return <Minus className="h-4 w-4 text-muted-foreground" />;
}

/* ------------------------------------------------------------------------- */
/* LevelRow — matches US Trigger A/B row style                                */
/* ------------------------------------------------------------------------- */

function LevelRow({
  icon,
  label,
  value,
  tone,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string | number | undefined | null;
  tone?: "neutral" | "stop" | "target" | "entry";
}) {
  const toneClass =
    tone === "stop"
      ? "text-rose-400"
      : tone === "target"
      ? "text-emerald-400"
      : tone === "entry"
      ? "text-sky-400"
      : "text-foreground";
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-[13px] uppercase tracking-wide font-medium">
          {label}
        </span>
      </div>
      <div
        className={cn(
          "font-mono tabular-nums font-semibold text-[15px]",
          toneClass
        )}
      >
        {value ?? "—"}
      </div>
    </div>
  );
}

function fmt(n: number | undefined | null) {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/* ------------------------------------------------------------------------- */
/* MarketCard                                                                 */
/* ------------------------------------------------------------------------- */

export function MarketCard({
  symbol,
  description,
  us_analog,
  instrumentKey,
  levels,
  mtf,
  orb,
  trigger_b,
  trailing,
}: MarketCardProps) {
  const bias = alignmentToBias(mtf?.alignment);
  const direction = alignmentToDirection(mtf?.alignment);
  const aligned =
    mtf?.alignment === "bullish_all" || mtf?.alignment === "bearish_all";
  const isMajority =
    mtf?.alignment === "bullish_majority" ||
    mtf?.alignment === "bearish_majority";
  const tradeable = bias === "BULL" || bias === "BEAR";

  // Pick the bias-aligned side of the ORB trigger
  const sidedTrigger =
    bias === "BULL" ? orb?.long : bias === "BEAR" ? orb?.short : null;

  const [detailsOpen, setDetailsOpen] = useState(false);

  // Watcher launch — wires the Arm button to the SSE runner. Each card controls
  // its OWN watcher; the runner is per-command, so all HK watchers run at once
  // (2026-06-04). isThisRunning/Done/Errored read this card's command directly.
  const { stateOf, run, setDrawerOpen, setActiveCommand } = useCommandRunner();
  const watcherCommand = `watcher-${instrumentKey.toLowerCase()}`;
  const runState = stateOf(watcherCommand);
  const isThisRunning = runState.kind === "running";
  const isThisDone = runState.kind === "done";
  const isThisErrored = runState.kind === "error";

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={cn(
        "relative overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-sm",
        !tradeable && "opacity-80"
      )}
    >
      {/* Header */}
      <div className="px-6 pt-5 pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          {/* Left side — ticker + bias */}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="font-mono text-3xl font-semibold tracking-tight">
                {symbol}
              </h2>
              {bias && (
                <span
                  className={cn(
                    "text-xs px-2.5 py-1 rounded-full ring-1 ring-inset font-semibold tracking-wide",
                    biasClass(bias)
                  )}
                >
                  {bias}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {description} · US analog: {us_analog}
            </p>
          </div>

          {/* Right side — Fixed-stop indicator + Arm watcher button */}
          <div className="flex items-center gap-2">
            {trailing ? (
              <TrailingToggle instrumentKey={instrumentKey} trailing={trailing} />
            ) : (
              <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-muted text-muted-foreground ring-1 ring-border">
                Fixed stop —
              </span>
            )}
            <button
              onClick={() => {
                setActiveCommand(watcherCommand);
                if (isThisRunning) {
                  setDrawerOpen(true);
                } else {
                  run(watcherCommand);
                }
              }}
              title={
                isThisRunning
                  ? "Watcher is running. Click to open its output drawer."
                  : `Spawn trade_window_hk.mjs ${instrumentKey}. Hard-blocked on Y/N until you arm trading.`
              }
              className={cn(
                "flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg ring-1 transition-colors",
                isThisRunning
                  ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30 hover:bg-emerald-500/15"
                  : isThisDone
                    ? "bg-sky-500/10 text-sky-300 ring-sky-500/30 hover:bg-sky-500/15"
                    : isThisErrored
                      ? "bg-rose-500/10 text-rose-300 ring-rose-500/30 hover:bg-rose-500/15"
                      : "bg-amber-500/[0.08] text-amber-300 ring-amber-500/25 hover:bg-amber-500/15"
              )}
            >
              {isThisRunning ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Running
                </>
              ) : isThisDone ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Done
                </>
              ) : isThisErrored ? (
                <>
                  <XCircle className="h-3.5 w-3.5" />
                  Errored
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5" />
                  Arm watcher
                </>
              )}
            </button>
          </div>
        </div>

        {/* Aligned indicator + direction line */}
        <div className="mt-3 flex items-center flex-wrap gap-x-3 gap-y-1">
          {aligned ? (
            <span className="text-sm text-emerald-400 font-medium">
              aligned ✓
            </span>
          ) : isMajority ? (
            <span className="text-sm text-amber-400 font-medium">
              majority
            </span>
          ) : bias === "NEUTRAL" ? (
            <span className="text-sm text-muted-foreground">not aligned</span>
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
          {direction && (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <DirectionIcon direction={direction} />
              <span className="font-medium uppercase tracking-wide">
                {direction} · 0DTE
              </span>
            </span>
          )}
        </div>
      </div>

      {/* Trigger A — ORB breakout */}
      <div className="px-6 py-4 border-t border-border">
        <div className="flex items-center gap-2 mb-1">
          <ArrowUpRight
            className={cn(
              "h-4 w-4",
              direction === "PUTS" ? "text-rose-400 rotate-90" : "text-amber-400"
            )}
          />
          <h3 className="text-[15px] font-semibold">
            Trigger A &mdash; ORB breakout
          </h3>
        </div>

        {/* Always render the 4 rows so the card layout matches the US version
            even before ORB is computed. Empty values render as em-dash. */}
        <div className={cn(!sidedTrigger && "opacity-50")}>
          <LevelRow
            icon={<Crosshair className="h-3.5 w-3.5" />}
            label="Entry"
            value={sidedTrigger ? fmt(sidedTrigger.entry) : "—"}
            tone="entry"
          />
          <LevelRow
            icon={<Ban className="h-3.5 w-3.5" />}
            label="Stop"
            value={sidedTrigger ? fmt(sidedTrigger.stop) : "—"}
            tone="stop"
          />
          <LevelRow
            label="T1"
            value={sidedTrigger ? fmt(sidedTrigger.T1) : "—"}
            tone="target"
          />
          <LevelRow
            label="T2"
            value={sidedTrigger ? fmt(sidedTrigger.T2) : "—"}
            tone="target"
          />
        </div>

        {/* Hint below the rows — only shown when no trigger data yet */}
        {!sidedTrigger && (
          <p className="text-xs text-muted-foreground/70 italic mt-2">
            {!orb
              ? "ORB not yet computed (waiting for 09:45 SGT)."
              : "Waiting for BULL/BEAR alignment to pick long/short side."}
            {!orb && (
              <>
                {" "}Run{" "}
                <code className="bg-muted px-1.5 py-0.5 rounded">
                  npm run orb:hsi
                </code>{" "}
                post-open.
              </>
            )}
          </p>
        )}
      </div>

      {/* Trigger B — VWAP / EMA21 reclaim (bias-locked, live values from
          orb_triggers.json snapshot taken at 09:45 SGT; watcher recomputes
          each 15m cycle while armed) */}
      <div className="px-6 py-4 border-t border-border">
        <div className="flex items-center gap-2 mb-1">
          <ArrowDownRight className="h-4 w-4 text-violet-400" />
          <h3 className="text-[15px] font-semibold">
            Trigger B &mdash; VWAP / EMA21 reclaim
          </h3>
        </div>
        <div className={cn(!tradeable && "opacity-50")}>
          <LevelRow
            icon={<Crosshair className="h-3.5 w-3.5" />}
            label="VWAP (anchored 09:30)"
            value={trigger_b?.vwap != null ? fmt(trigger_b.vwap) : "—"}
            tone="entry"
          />
          <LevelRow
            icon={<Crosshair className="h-3.5 w-3.5" />}
            label="EMA21 (1H)"
            value={trigger_b?.ema21_1h != null ? fmt(trigger_b.ema21_1h) : "—"}
            tone="entry"
          />
          <LevelRow
            icon={<Ban className="h-3.5 w-3.5" />}
            label="Stop"
            value={trigger_b ? "= level at reclaim" : "—"}
            tone="stop"
          />
          <LevelRow
            label="T1"
            value={trigger_b ? "entry + 1R" : "—"}
            tone="target"
          />
          <LevelRow
            label="T2"
            value={trigger_b ? "entry + 2R" : "—"}
            tone="target"
          />
        </div>
        {!trigger_b ? (
          <p className="text-xs text-muted-foreground/70 italic mt-2">
            Trigger B levels populate after ORB runs at 09:45 SGT. Run{" "}
            <code className="bg-muted px-1.5 py-0.5 rounded">
              npm run orb:hsi
            </code>{" "}
            to compute the initial snapshot; watcher then refreshes them every
            15m while armed.
          </p>
        ) : !tradeable ? (
          <p className="text-xs text-muted-foreground/70 italic mt-2">
            Trigger B is bias-locked. Premarket alignment must be BULL or BEAR
            to fire (currently {bias ?? "no alignment data"}).
          </p>
        ) : (
          <p className="text-xs text-muted-foreground/70 italic mt-2">
            R = |entry − level|; ATR-15 reference {trigger_b.atr_15 != null ? fmt(trigger_b.atr_15) : "—"}. VWAP checked first, then EMA21.
          </p>
        )}
      </div>

      {/* Pre-market context — compact, collapsible */}
      <div className="px-6 py-3 border-t border-border bg-muted/20">
        <button
          onClick={() => setDetailsOpen((v) => !v)}
          className="flex items-center justify-between w-full text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <span className="flex items-center gap-2">
            {detailsOpen ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
            Pre-market context
            {levels?.source && (
              <span className="text-muted-foreground/60">
                · {levels.source}
              </span>
            )}
          </span>
          {!detailsOpen && (
            <span className="font-mono tabular-nums">
              PDH {fmt(levels?.prev_high)} · PDL {fmt(levels?.prev_low)} ·
              Range {levels?.prev_range_pct ? `${levels.prev_range_pct}%` : "—"}
            </span>
          )}
        </button>

        {detailsOpen && (
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
            <Stat label="PDH" value={fmt(levels?.prev_high)} color="text-red-400" />
            <Stat label="PDL" value={fmt(levels?.prev_low)} color="text-green-400" />
            <Stat label="PDC" value={fmt(levels?.prev_close)} />
            <Stat label="Open" value={fmt(levels?.prev_open)} />
            <Stat
              label="Range"
              value={
                levels?.prev_range_pct != null
                  ? `${levels.prev_range_pct}%`
                  : "—"
              }
            />
          </div>
        )}

        {detailsOpen && mtf?.key_levels && mtf.key_levels.length > 0 && (
          <div className="mt-3 pt-3 border-t border-border/50 space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
              Key D-Swings
            </div>
            {mtf.key_levels.slice(0, 5).map((lv, i) => (
              <div
                key={i}
                className="flex items-center justify-between text-xs"
              >
                <span
                  className={
                    lv.type === "high" ? "text-rose-400/80" : "text-emerald-400/80"
                  }
                >
                  {lv.type === "high" ? "Resistance" : "Support"}
                </span>
                <span className="font-mono tabular-nums">{fmt(lv.price)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "font-mono font-medium tabular-nums",
          value === "—" ? "text-muted-foreground" : color ?? "text-foreground"
        )}
      >
        {value}
      </span>
    </div>
  );
}
