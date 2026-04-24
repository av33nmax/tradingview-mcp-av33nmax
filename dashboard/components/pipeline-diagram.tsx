"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import {
  CandlestickChart,
  Building2,
  Telescope,
  FileJson,
  Eye,
  ShieldCheck,
  ClipboardCheck,
  Rocket,
  ArrowDown,
  ArrowRight,
} from "lucide-react";

type Tone = "source" | "process" | "data" | "gate" | "exec";

const toneStyles: Record<
  Tone,
  { border: string; bg: string; icon: string; badge: string; glow: string }
> = {
  source:  { border: "border-sky-500/30",     bg: "from-sky-500/10 to-sky-500/0",        icon: "text-sky-400",     badge: "bg-sky-500/15 text-sky-300",     glow: "shadow-sky-500/10" },
  process: { border: "border-emerald-500/30", bg: "from-emerald-500/10 to-emerald-500/0",icon: "text-emerald-400", badge: "bg-emerald-500/15 text-emerald-300", glow: "shadow-emerald-500/10" },
  data:    { border: "border-amber-500/30",   bg: "from-amber-500/10 to-amber-500/0",    icon: "text-amber-400",   badge: "bg-amber-500/15 text-amber-300", glow: "shadow-amber-500/10" },
  gate:    { border: "border-purple-500/30",  bg: "from-purple-500/10 to-purple-500/0",  icon: "text-purple-400",  badge: "bg-purple-500/15 text-purple-300",glow: "shadow-purple-500/10" },
  exec:    { border: "border-rose-500/30",    bg: "from-rose-500/10 to-rose-500/0",      icon: "text-rose-400",    badge: "bg-rose-500/15 text-rose-300",   glow: "shadow-rose-500/10" },
};

type NodeProps = {
  tone: Tone;
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  tag?: string;
  files?: string[];
  index: number;
};

function PipelineNode({ tone, icon, title, subtitle, tag, files, index }: NodeProps) {
  const s = toneStyles[tone];
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.08 }}
      className={cn(
        "relative flex-1 min-w-0 rounded-xl border bg-gradient-to-b p-4 shadow-lg ring-1 ring-white/5 backdrop-blur-sm",
        s.border,
        s.bg,
        s.glow,
      )}
    >
      {tag && (
        <div
          className={cn(
            "absolute -top-2.5 left-4 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ring-inset ring-white/10",
            s.badge,
          )}
        >
          {tag}
        </div>
      )}
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-950/60 ring-1 ring-white/5",
            s.icon,
          )}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold tracking-tight leading-tight">{title}</div>
          {subtitle && (
            <div className="mt-1 text-xs text-muted-foreground leading-snug">{subtitle}</div>
          )}
          {files && files.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {files.map((f) => (
                <code
                  key={f}
                  className="inline-block rounded border border-zinc-700/60 bg-zinc-950/70 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300"
                >
                  {f}
                </code>
              ))}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function FlowArrow({ horizontal = false, delay = 0 }: { horizontal?: boolean; delay?: number }) {
  const Icon = horizontal ? ArrowRight : ArrowDown;
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3, delay }}
      className={cn(
        "flex items-center justify-center",
        horizontal ? "px-2 shrink-0" : "py-2",
      )}
    >
      <div className="relative flex items-center justify-center">
        <div
          className={cn(
            "absolute bg-gradient-to-b from-emerald-500/40 via-emerald-500/20 to-emerald-500/40",
            horizontal ? "h-px w-10" : "w-px h-10",
          )}
        />
        <motion.div
          animate={
            horizontal
              ? { x: [-8, 8, -8] }
              : { y: [-8, 8, -8] }
          }
          transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
          className={cn(
            "relative flex h-6 w-6 items-center justify-center rounded-full bg-zinc-900 text-emerald-400 ring-1 ring-emerald-500/30",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </motion.div>
      </div>
    </motion.div>
  );
}

export function PipelineDiagram() {
  return (
    <div className="relative overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-6 md:p-8">
      {/* Subtle grid background */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.4) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.4) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />

      <div className="relative space-y-1">
        {/* Row 1 — Data sources (two parallel) */}
        <div className="flex flex-col md:flex-row items-stretch gap-3">
          <PipelineNode
            tone="source"
            index={0}
            icon={<CandlestickChart className="h-5 w-5" />}
            tag="source"
            title="TradingView Desktop"
            subtitle="Bias signals, bars, chart drawing surface"
            files={["CDP :9222"]}
          />
          <PipelineNode
            tone="source"
            index={1}
            icon={<Building2 className="h-5 w-5" />}
            tag="source"
            title="IBKR TWS"
            subtitle="Account, market data, orders"
            files={["@stoqey/ib :7497"]}
          />
        </div>

        <FlowArrow delay={0.3} />

        {/* Row 2 — Analysis */}
        <PipelineNode
          tone="process"
          index={2}
          icon={<Telescope className="h-5 w-5" />}
          tag="analysis"
          title="premarket_setup.mjs"
          subtitle="Multi-TF bias · draws S/R + FVG zones · generates entry triggers"
          files={["multi_timeframe_analysis.js", "CDP drawings"]}
        />

        <FlowArrow delay={0.4} />

        {/* Row 3 — Data handoff */}
        <PipelineNode
          tone="data"
          index={3}
          icon={<FileJson className="h-5 w-5" />}
          tag="artifact"
          title="latest_entry_notes.json"
          subtitle="Single source of truth for today's plan — every downstream consumer reads this"
          files={["tickers{SPY,QQQ}", "trigger_a/b", "stops + targets"]}
        />

        <FlowArrow delay={0.5} />

        {/* Row 4 — Two consumers in parallel */}
        <div className="flex flex-col md:flex-row items-stretch gap-3">
          <PipelineNode
            tone="process"
            index={4}
            icon={<Eye className="h-5 w-5" />}
            tag="dashboard"
            title="This dashboard"
            subtitle="Visual read of today's setup — you're here"
            files={["Next.js 16"]}
          />
          <PipelineNode
            tone="process"
            index={5}
            icon={<ShieldCheck className="h-5 w-5" />}
            tag="watcher"
            title="trade_window.mjs"
            subtitle="Time-bounded 15m loop · close + rVol validator"
            files={["9:45 PM – 11:00 PM SGT", "macOS notify"]}
          />
        </div>

        <FlowArrow delay={0.7} />

        {/* Row 5 — Human gate */}
        <PipelineNode
          tone="gate"
          index={6}
          icon={<ClipboardCheck className="h-5 w-5" />}
          tag="human gate"
          title="YES prompt + TWS Transmit"
          subtitle='You type "YES" → order stages "Pending Transmission" → you click Transmit'
          files={["transmit=false", "two-gate safety"]}
        />

        <FlowArrow delay={0.8} />

        {/* Row 6 — Execution */}
        <PipelineNode
          tone="exec"
          index={7}
          icon={<Rocket className="h-5 w-5" />}
          tag="execute"
          title="IBKR → Market"
          subtitle="MKT DAY · filled on next tick"
          files={["orderStatus events", "position tracker"]}
        />
      </div>

      {/* Legend */}
      <div className="relative mt-6 flex flex-wrap items-center gap-4 border-t border-zinc-800/60 pt-4 text-[11px] text-muted-foreground">
        <span className="font-medium">Legend:</span>
        {(
          [
            { tone: "source",  label: "data source" },
            { tone: "process", label: "processing" },
            { tone: "data",    label: "artifact" },
            { tone: "gate",    label: "human gate" },
            { tone: "exec",    label: "execution" },
          ] as { tone: Tone; label: string }[]
        ).map((l) => (
          <span key={l.tone} className="inline-flex items-center gap-1.5">
            <span
              className={cn(
                "h-2 w-2 rounded-full ring-1 ring-inset",
                toneStyles[l.tone].badge,
              )}
            />
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}
