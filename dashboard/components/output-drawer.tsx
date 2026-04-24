"use client";

import { useEffect, useRef, useState } from "react";
import { useCommandRunner, type OutputLine } from "@/lib/command-runner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "framer-motion";
import {
  Terminal,
  ChevronDown,
  ChevronUp,
  X,
  Trash2,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Square,
} from "lucide-react";

function LineRow({ line }: { line: OutputLine }) {
  const toneClass =
    line.type === "stderr" ? "text-rose-300" :
    line.type === "error"  ? "text-rose-400" :
    line.type === "info"   ? "text-emerald-300" :
                             "text-[#e4e4e7]";
  return (
    <div className={cn("whitespace-pre-wrap break-words", toneClass)}>
      {line.text}
    </div>
  );
}

function StatusPill() {
  const { state } = useCommandRunner();
  if (state.kind === "running") {
    const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300 ring-1 ring-emerald-500/20">
        <Loader2 className="h-3 w-3 animate-spin" />
        running · {elapsed}s
      </span>
    );
  }
  if (state.kind === "done") {
    const sec = (state.durationMs / 1000).toFixed(1);
    const ok = state.exitCode === 0;
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ring-1 ring-inset",
          ok
            ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20"
            : "bg-rose-500/10 text-rose-300 ring-rose-500/20",
        )}
      >
        {ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
        {ok ? `done · ${sec}s` : `failed (code ${state.exitCode}) · ${sec}s`}
      </span>
    );
  }
  if (state.kind === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/10 px-2 py-0.5 text-xs text-rose-300 ring-1 ring-rose-500/20">
        <XCircle className="h-3 w-3" />
        error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] px-2 py-0.5 text-xs text-[#a1a1aa] ring-1 ring-white/[0.08]">
      <Clock className="h-3 w-3" />
      idle
    </span>
  );
}

export function OutputDrawer() {
  const { state, output, abort, clear, drawerOpen, setDrawerOpen } = useCommandRunner();
  const [collapsed, setCollapsed] = useState(false);
  const [aborting, setAborting] = useState(false);

  const handleAbort = async () => {
    setAborting(true);
    try {
      await abort();
    } finally {
      setAborting(false);
    }
  };
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new output
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [output.length]);

  // Auto-update elapsed time when running
  const [, setTick] = useState(0);
  useEffect(() => {
    if (state.kind !== "running") return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [state.kind]);

  const label = state.kind === "idle" ? "Output" : "label" in state ? state.label : "Output";

  return (
    <AnimatePresence>
      {drawerOpen && (
        <motion.div
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 25, stiffness: 220 }}
          className="fixed bottom-0 left-0 right-0 z-40 border-t border-white/[0.08] bg-[#0e0e10] shadow-[0_-12px_32px_-8px_rgba(0,0,0,0.5)] backdrop-blur"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-3 py-2.5 md:px-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-white/[0.05] text-[#a1a1aa]">
                <Terminal className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[#e4e4e7] truncate">{label}</span>
                  <StatusPill />
                </div>
                <div className="text-[10px] text-[#71717a] font-mono">
                  {output.length} line{output.length === 1 ? "" : "s"}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {state.kind === "running" && (
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-7 px-2.5 gap-1.5"
                  onClick={handleAbort}
                  disabled={aborting}
                  title="Send SIGTERM then SIGKILL"
                >
                  <Square className="h-3 w-3 fill-current" />
                  {aborting ? "Stopping…" : "Stop"}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-9 md:h-7 md:w-7 p-0"
                onClick={clear}
                disabled={state.kind === "running"}
                title="Clear"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-9 md:h-7 md:w-7 p-0"
                onClick={() => setCollapsed((c) => !c)}
                title={collapsed ? "Expand" : "Collapse"}
              >
                {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-9 md:h-7 md:w-7 p-0"
                onClick={() => setDrawerOpen(false)}
                title="Close"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {/* Body — sized in viewport heights for better mobile behavior */}
          {!collapsed && (
            <div
              ref={scrollRef}
              className="h-[40dvh] max-h-[40dvh] md:h-72 md:max-h-72 overflow-y-auto overscroll-contain bg-[#09090b] px-3 py-3 md:px-4 font-mono text-[12px] leading-relaxed"
            >
              {output.length === 0 ? (
                <div className="flex h-full items-center justify-center text-[#71717a]">
                  no output yet
                </div>
              ) : (
                output.map((line) => <LineRow key={line.id} line={line} />)
              )}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
