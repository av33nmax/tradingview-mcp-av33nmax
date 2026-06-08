"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, ShieldAlert, ShieldOff, Loader2 } from "lucide-react";

/**
 * US session-level trading kill switch. Layers on top of the per-fire YES
 * prompt — when DISABLED, trade_window.mjs skips even prompting and posts
 * a Discord "🚧 would have fired BLOCKED" notification.
 *
 * Three visual states:
 *   DISABLED        yn='N' or unset      — red, "ENABLE TRADING" button
 *   ENABLED today   yn='Y', set today    — green, "DISABLE TRADING" button
 *   STALE           yn='Y', yesterday    — amber, "RE-ENABLE TODAY" button
 *
 * Polls every 10s so a state change made via curl is reflected.
 */

type State = {
  yn: "Y" | "N" | null;
  set_at: string | null;
  set_by: string | null;
  today_et_date: string;
  set_et_date: string | null;
  is_armed_today: boolean;
  stale_armed: boolean;
};

function formatSetAt(iso: string | null): string {
  if (!iso) return "never";
  try {
    return (
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(iso)) + " ET"
    );
  } catch {
    return iso;
  }
}

export function TradingToggle() {
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

  const toggle = useCallback(async (next: "Y" | "N") => {
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
  }, []);

  if (!state) {
    return (
      <div className="rounded-2xl border border-white/[0.06] bg-[#131316] p-4 text-sm text-[#a1a1aa]">
        Loading trading-enable state…
      </div>
    );
  }

  const isArmed = state.is_armed_today;
  const isStale = state.stale_armed;

  let borderCls = "border-rose-500/30";
  let bgCls = "bg-rose-500/[0.06]";
  let iconBg = "bg-rose-500/10 text-rose-300 ring-rose-500/30";
  let labelCls = "text-rose-300";
  let label = "DISABLED";
  let buttonCls = "border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10";
  let buttonLabel = "ENABLE TRADING";
  let Icon: typeof ShieldOff = ShieldOff;
  let descLine = "Watchers run dry — every fire attempt is logged but no IBKR order is sent.";

  if (isArmed) {
    borderCls = "border-emerald-500/30";
    bgCls = "bg-emerald-500/[0.06]";
    iconBg = "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30";
    labelCls = "text-emerald-300";
    label = "ENABLED";
    buttonCls = "border-rose-500/40 text-rose-300 hover:bg-rose-500/10";
    buttonLabel = "DISABLE TRADING";
    Icon = ShieldCheck;
    descLine = `Enabled by ${state.set_by ?? "unknown"} at ${formatSetAt(state.set_at)}. Watcher fires reach the YES prompt; typing YES sends the order.`;
  } else if (isStale) {
    borderCls = "border-amber-500/30";
    bgCls = "bg-amber-500/[0.06]";
    iconBg = "bg-amber-500/10 text-amber-300 ring-amber-500/30";
    labelCls = "text-amber-300";
    label = "STALE — re-enable for today";
    buttonCls = "border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10";
    buttonLabel = "RE-ENABLE TODAY";
    Icon = ShieldAlert;
    descLine = `Last enabled ${formatSetAt(state.set_at)} (${state.set_et_date}) — does not count for ${state.today_et_date}. Re-enable to send orders today.`;
  }

  const targetYn: "Y" | "N" = isArmed ? "N" : "Y";

  return (
    <div className={`rounded-2xl border ${borderCls} ${bgCls} p-5 shadow-sm transition-colors`}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className={`flex h-11 w-11 items-center justify-center rounded-lg ring-1 ring-inset ${iconBg}`}>
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-baseline gap-2">
              <h3 className={`text-base font-bold tracking-tight ${labelCls}`}>
                Trading · {label}
              </h3>
              <span className="text-xs text-[#71717a]">{state.today_et_date} ET</span>
            </div>
            <p className="mt-0.5 text-xs text-[#a1a1aa]">{descLine}</p>
          </div>
        </div>

        <button
          onClick={() => toggle(targetYn)}
          disabled={pending}
          className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors ${buttonCls} ${pending ? "opacity-50 cursor-not-allowed" : ""}`}
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
