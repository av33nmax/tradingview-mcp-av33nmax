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
  { iconBg: string; icon: string; badge: string; dot: string; borderAccent: string }
> = {
  source:  { iconBg: "bg-sky-500/10",     icon: "text-sky-400",     badge: "bg-sky-500/10 text-sky-300 ring-sky-500/20",           dot: "bg-sky-400",     borderAccent: "before:bg-sky-500/40" },
  process: { iconBg: "bg-emerald-500/10", icon: "text-emerald-400", badge: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20", dot: "bg-emerald-400", borderAccent: "before:bg-emerald-500/40" },
  data:    { iconBg: "bg-amber-500/10",   icon: "text-amber-400",   badge: "bg-amber-500/10 text-amber-300 ring-amber-500/20",     dot: "bg-amber-400",   borderAccent: "before:bg-amber-500/40" },
  gate:    { iconBg: "bg-purple-500/10",  icon: "text-purple-400",  badge: "bg-purple-500/10 text-purple-300 ring-purple-500/20",   dot: "bg-purple-400",  borderAccent: "before:bg-purple-500/40" },
  exec:    { iconBg: "bg-rose-500/10",    icon: "text-rose-400",    badge: "bg-rose-500/10 text-rose-300 ring-rose-500/20",         dot: "bg-rose-400",    borderAccent: "before:bg-rose-500/40" },
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
        "relative flex-1 min-w-0 rounded-2xl border border-white/[0.06] bg-[#131316] p-4 md:p-5 shadow-[0_1px_2px_rgba(0,0,0,0.3),0_8px_24px_-12px_rgba(0,0,0,0.4)]",
        // colored left accent
        "before:absolute before:inset-y-3 before:left-0 before:w-[3px] before:rounded-full",
        s.borderAccent,
      )}
    >
      {tag && (
        <div
          className={cn(
            "absolute -top-2.5 left-4 rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ring-1 ring-inset",
            s.badge,
          )}
        >
          {tag}
        </div>
      )}
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ring-white/[0.06]",
            s.iconBg,
            s.icon,
          )}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold tracking-tight leading-tight text-[#e4e4e7]">{title}</div>
          {subtitle && (
            <div className="mt-1.5 text-[13px] text-[#a1a1aa] leading-snug">{subtitle}</div>
          )}
          {files && files.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {files.map((f) => (
                <code
                  key={f}
                  className="inline-block rounded-md border border-white/[0.06] bg-[#09090b] px-2 py-0.5 font-mono text-[11px] text-[#a1a1aa]"
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
        horizontal ? "px-2 shrink-0" : "py-1 md:py-2",
      )}
    >
      <div className="relative flex items-center justify-center">
        <div
          className={cn(
            "absolute bg-gradient-to-b from-emerald-500/30 via-emerald-500/15 to-emerald-500/30",
            horizontal ? "h-px w-10" : "w-px h-6 md:h-10",
          )}
        />
        <motion.div
          animate={horizontal ? { x: [-8, 8, -8] } : { y: [-5, 5, -5] }}
          transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
          className="relative flex h-5 w-5 md:h-6 md:w-6 items-center justify-center rounded-full bg-[#131316] text-emerald-400 ring-1 ring-emerald-500/30"
        >
          <Icon className="h-3 w-3 md:h-3.5 md:w-3.5" />
        </motion.div>
      </div>
    </motion.div>
  );
}

export function PipelineDiagram() {
  return (
    <div className="relative rounded-2xl border border-white/[0.06] bg-[#0e0e10] p-3 pt-5 md:p-8 shadow-[0_1px_2px_rgba(0,0,0,0.3)]">
      <div className="relative space-y-1">
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

      <div className="relative mt-6 flex flex-wrap items-center gap-4 border-t border-white/[0.06] pt-4 text-[13px] text-[#a1a1aa]">
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
            <span className={cn("h-2 w-2 rounded-full", toneStyles[l.tone].dot)} />
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}
