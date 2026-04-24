"use client";

import { useEffect, useState } from "react";
import { useWatcher, useWatcherRunner } from "@/lib/watcher-runner";
import { cn } from "@/lib/utils";
import { Play, Square, Loader2, CheckCircle2, XCircle, Clock } from "lucide-react";

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function nextCandleBoundaryMs(now = Date.now()): number {
  const d = new Date(now);
  const m = d.getMinutes();
  const nextQuarter = Math.floor(m / 15) * 15 + 15;
  const target = new Date(d);
  target.setSeconds(30);
  target.setMilliseconds(0);
  target.setMinutes(nextQuarter);
  if (target.getTime() - now < 30000) {
    target.setTime(target.getTime() + 15 * 60 * 1000);
  }
  return target.getTime();
}

export function WatcherControls({ ticker, disabled }: { ticker: string; disabled?: boolean }) {
  const { start, stop } = useWatcherRunner();
  const w = useWatcher(ticker);
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const isActive = w.status === "running" || w.status === "starting" || w.status === "pending-confirm";

  const handleStart = async () => {
    setBusy(true);
    try { await start(ticker); }
    finally { setBusy(false); }
  };

  const handleStop = async () => {
    setBusy(true);
    try { await stop(ticker); }
    finally { setBusy(false); }
  };

  if (!isActive && w.status !== "exited" && w.status !== "error") {
    // idle — show Start button only
    return (
      <button
        onClick={handleStart}
        disabled={disabled || busy}
        className={cn(
          "w-full sm:w-auto shrink-0 rounded-full px-5 py-2 text-sm font-semibold transition-colors flex items-center gap-2 justify-center",
          disabled
            ? "bg-white/[0.05] text-[#71717a]"
            : "bg-[#c8a978] hover:bg-[#d4b588] text-[#09090b] shadow-[0_0_0_1px_rgba(200,169,120,0.35)]",
          busy && "opacity-70",
        )}
      >
        <Play className="h-3.5 w-3.5" />
        {busy ? "Starting…" : "Arm watcher"}
      </button>
    );
  }

  // active or recently exited — show status + stop button
  const elapsedSec = w.startedAt ? Math.floor((Date.now() - w.startedAt) / 1000) : 0;
  const untilMs = nextCandleBoundaryMs();
  const toNextCheck = Math.max(0, Math.floor((untilMs - Date.now()) / 1000));

  let statusLabel: string;
  let statusIcon: React.ReactNode;
  let statusColor: string;

  if (w.status === "starting") {
    statusLabel = "Starting…";
    statusIcon = <Loader2 className="h-3.5 w-3.5 animate-spin" />;
    statusColor = "bg-sky-500/10 text-sky-400 ring-sky-500/20";
  } else if (w.status === "pending-confirm") {
    statusLabel = "Confirm trade";
    statusIcon = <Loader2 className="h-3.5 w-3.5 animate-spin" />;
    statusColor = "bg-[#c8a978]/15 text-[#c8a978] ring-[#c8a978]/30";
  } else if (w.status === "running") {
    statusLabel = `Watching · ${formatElapsed(elapsedSec)}`;
    statusIcon = <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />;
    statusColor = "bg-emerald-500/10 text-emerald-400 ring-emerald-500/20";
  } else if (w.status === "exited") {
    statusLabel = w.exitCode === 0 ? "Completed" : `Exited (${w.exitCode})`;
    statusIcon = w.exitCode === 0
      ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
      : <XCircle className="h-3.5 w-3.5 text-rose-400" />;
    statusColor = w.exitCode === 0
      ? "bg-emerald-500/10 text-emerald-400 ring-emerald-500/20"
      : "bg-rose-500/10 text-rose-400 ring-rose-500/20";
  } else {
    statusLabel = "Error";
    statusIcon = <XCircle className="h-3.5 w-3.5" />;
    statusColor = "bg-rose-500/10 text-rose-400 ring-rose-500/20";
  }

  return (
    <div className="flex flex-col items-end gap-2 w-full sm:w-auto">
      <div
        className={cn(
          "inline-flex items-center gap-2 rounded-full px-3 py-1 text-[13px] font-medium ring-1 ring-inset",
          statusColor,
        )}
      >
        {statusIcon}
        <span>{statusLabel}</span>
      </div>

      {w.status === "running" && (
        <div className="text-[12px] text-[#71717a] font-mono">
          next check in {toNextCheck}s
        </div>
      )}

      {w.lastCheck && (
        <div className="text-[12px] text-[#a1a1aa] max-w-full truncate">
          last: {w.lastCheck.reason}
        </div>
      )}

      {(w.status === "running" || w.status === "starting" || w.status === "pending-confirm") && (
        <button
          onClick={handleStop}
          disabled={busy}
          className="rounded-full border border-white/[0.08] bg-white/[0.02] px-3 py-1 text-[12px] font-medium text-[#a1a1aa] hover:bg-rose-500/10 hover:text-rose-400 hover:border-rose-500/30 transition-colors inline-flex items-center gap-1.5"
        >
          <Square className="h-3 w-3 fill-current" />
          {busy ? "Stopping…" : "Stop"}
        </button>
      )}

      {(w.status === "exited" || w.status === "error") && (
        <button
          onClick={handleStart}
          disabled={disabled || busy}
          className="rounded-full border border-white/[0.08] bg-white/[0.02] px-3 py-1 text-[12px] font-medium text-[#a1a1aa] hover:bg-white/[0.05] transition-colors inline-flex items-center gap-1.5"
        >
          <Clock className="h-3 w-3" />
          Restart
        </button>
      )}
    </div>
  );
}
