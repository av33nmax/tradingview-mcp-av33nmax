"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, ShieldAlert, ShieldOff, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Manual Y/N toggle — the binding watcher arm switch.
 *
 * Three visual states:
 *   DISARMED        yn='N' or unset      — red, prominent, "ARM" button
 *   ARMED today     yn='Y', set today    — green, glowing, "DISARM" button
 *   ARMED stale     yn='Y', yesterday    — amber, "RE-ARM TODAY" button
 *
 * Polls every 10s so a state change made via curl (or by another tab) is
 * reflected within a window.
 */

type State = {
  yn: "Y" | "N" | null;
  set_at: string | null;
  set_by: string | null;
  today_sgt_date: string;
  set_sgt_date: string | null;
  is_armed_today: boolean;
  stale_armed: boolean;
};

function formatSetAt(iso: string | null): string {
  if (!iso) return "never";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Hong_Kong",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso)) + " SGT";
  } catch {
    return iso;
  }
}

export function ManualYNToggle() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch("/api/manual-yn", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as State;
      setState(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    fetchState();
    const id = setInterval(fetchState, 10_000);
    return () => clearInterval(id);
  }, [fetchState]);

  const toggle = useCallback(
    async (next: "Y" | "N") => {
      setPending(true);
      try {
        const res = await fetch("/api/manual-yn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ yn: next, set_by: "dashboard" }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as State;
        setState(json);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(false);
      }
    },
    []
  );

  if (!state) {
    return (
      <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
        Loading watcher arm state…
      </div>
    );
  }

  const isArmed = state.is_armed_today;
  const isStale = state.stale_armed;

  const accent = isArmed
    ? {
        border: "border-emerald-500/40",
        bg: "bg-emerald-500/[0.06]",
        ring: "ring-emerald-500/30",
        text: "text-emerald-300",
        label: "ENABLED",
        Icon: ShieldCheck,
      }
    : isStale
      ? {
          border: "border-amber-500/40",
          bg: "bg-amber-500/[0.06]",
          ring: "ring-amber-500/30",
          text: "text-amber-300",
          label: "STALE — re-enable for today",
          Icon: ShieldAlert,
        }
      : {
          border: "border-rose-500/40",
          bg: "bg-rose-500/[0.06]",
          ring: "ring-rose-500/30",
          text: "text-rose-300",
          label: "DISABLED",
          Icon: ShieldOff,
        };

  const { Icon } = accent;
  const targetYn: "Y" | "N" = isArmed ? "N" : "Y";
  const buttonLabel = isArmed ? "DISABLE TRADING" : isStale ? "RE-ENABLE TODAY" : "ENABLE TRADING";

  return (
    <div
      className={cn(
        "rounded-xl border p-5 shadow-sm transition-colors",
        accent.border,
        accent.bg
      )}
    >
      <div className="flex flex-wrap items-center gap-4 justify-between">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex h-11 w-11 items-center justify-center rounded-lg ring-1 ring-inset",
              accent.ring,
              accent.text
            )}
          >
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-baseline gap-2">
              <h3 className={cn("text-base font-bold tracking-tight", accent.text)}>
                Trading · {accent.label}
              </h3>
              <span className="text-xs text-muted-foreground">
                {state.today_sgt_date} SGT
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {isArmed
                ? `Enabled by ${state.set_by ?? "unknown"} at ${formatSetAt(state.set_at)}. Watcher fires that pass all gates will send orders to IBKR.`
                : isStale
                  ? `Last enabled ${formatSetAt(state.set_at)} (${state.set_sgt_date}) — does not count for ${state.today_sgt_date}. Re-enable to send orders today.`
                  : `Watchers run dry — every fire attempt logs to Discord + JSONL but no IBKR order is placed.`}
            </p>
          </div>
        </div>

        <button
          onClick={() => toggle(targetYn)}
          disabled={pending}
          className={cn(
            "inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors",
            isArmed
              ? "border-rose-500/40 text-rose-300 hover:bg-rose-500/10"
              : "border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10",
            pending && "opacity-50 cursor-not-allowed"
          )}
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {buttonLabel}
        </button>
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      )}
    </div>
  );
}
