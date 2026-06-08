"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { CircleDot } from "lucide-react";

type ModeInfo = {
  isLive: boolean;
  label: "LIVE" | "PAPER";
  port: number;
};

export function ModeBadge() {
  const [mode, setMode] = useState<ModeInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/mode", { cache: "no-store" });
        const json = await res.json();
        if (!cancelled && json?.ok) {
          setMode({ isLive: !!json.isLive, label: json.label, port: json.port });
        }
      } catch {
        // ignore — badge stays hidden
      }
    };
    load();
    // Poll every 30s in case dev server gets restarted with different env
    const id = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!mode) return null;

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider ring-1 ring-inset whitespace-nowrap",
        mode.isLive
          ? "bg-rose-500/15 text-rose-300 ring-rose-500/40"
          : "bg-emerald-500/10 text-emerald-300 ring-emerald-500/25",
      )}
      title={`IBKR port ${mode.port} — ${mode.isLive ? "real money" : "paper account"}`}
    >
      <CircleDot
        className={cn(
          "h-2.5 w-2.5",
          mode.isLive ? "text-rose-400 animate-pulse" : "text-emerald-400",
        )}
        strokeWidth={3}
      />
      {mode.label}
    </div>
  );
}
