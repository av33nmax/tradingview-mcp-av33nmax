"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, Hand, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ExecutionsResponse } from "@/app/api/ibkr/executions/route";
import type { JournalExecutionsResponse } from "@/app/api/journal/executions/route";
import type { FxRatesResponse } from "@/app/api/ibkr/fx-rates/route";
import type { ExecutionRow } from "@/lib/ibkr-account";
import { buildTrips, latestTripDate, todayET, type Trip } from "@/lib/round-trips";

const POLL_MS = 15000;

function mergeExecutions(live: ExecutionRow[], journal: ExecutionRow[]): ExecutionRow[] {
  const byId = new Map<string, ExecutionRow>();
  for (const e of journal) byId.set(e.execId, e);
  for (const e of live) byId.set(e.execId, e);
  return [...byId.values()];
}

function money(amount: number, currency?: string, signed = false): string {
  const ccy = currency ?? "USD";
  const sign = signed ? (amount > 0 ? "+" : amount < 0 ? "−" : "") : "";
  const sym = ccy === "USD" ? "$" : "";
  const suffix = ccy === "USD" ? "" : ` ${ccy}`;
  return `${sign}${sym}${Math.abs(amount).toFixed(2)}${suffix}`;
}

function formatPnl(pnl: number | null, currency?: string): string {
  if (pnl == null) return "—";
  return money(pnl, currency, true);
}

function formatPrice(price: number, currency?: string): string {
  return money(price, currency, false);
}

type Rates = Record<string, number> | undefined;

function toBase(amount: number, currency: string | undefined, rates: Rates): number {
  if (!rates) return amount;
  const r = rates[currency ?? ""];
  return typeof r === "number" && r > 0 ? amount * r : amount;
}

// P&L converted to the account base currency. Falls back to native display
// until rates load, so a native number is never briefly mislabeled as base.
function formatBasePnl(pnl: number | null, currency: string | undefined, rates: Rates, base?: string): string {
  if (pnl == null) return "—";
  if (!rates || currency == null || !(currency in rates)) return money(pnl, currency, true);
  return money(pnl * rates[currency], base ?? "SGD", true);
}

function formatPct(pct: number | null): string {
  if (pct == null) return "—";
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(2)}%`;
}

function pnlTone(pnl: number | null): string {
  if (pnl == null || pnl === 0) return "text-[#a1a1aa]";
  return pnl > 0 ? "text-emerald-400" : "text-rose-400";
}

function formatDateLabel(dateET: string): string {
  if (dateET === todayET()) return `Today (${dateET})`;
  return dateET;
}

function formatTimeShort(raw: string): string {
  const m = raw.match(/^\d{8}\s+(\d{2}:\d{2})/);
  return m ? m[1] : raw;
}

/**
 * IBKR-mobile-style per-contract P&L breakdown for the latest trading day
 * with activity. Each row shows the contract (compact format), source badge
 * (Manual / Watcher), qty, entry/exit prices, and color-coded gross P&L
 * with %. Click a row to see the underlying fill rows.
 */
export function DayPnLTab() {
  const [state, setState] = useState<{
    kind: "loading" | "ok" | "error";
    executions?: ExecutionRow[];
    error?: string;
    fetchedAt?: number;
    rates?: Record<string, number>;
    base?: string;
  }>({ kind: "loading" });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const [liveRes, journalRes, fxRes] = await Promise.all([
          fetch("/api/ibkr/executions", { cache: "no-store" }),
          fetch("/api/journal/executions", { cache: "no-store" }),
          fetch("/api/ibkr/fx-rates", { cache: "no-store" }),
        ]);
        const live = (await liveRes.json()) as ExecutionsResponse;
        const journal = (await journalRes.json()) as JournalExecutionsResponse;
        const fx = (await fxRes.json()) as FxRatesResponse;
        if (cancelled) return;
        const liveExecs = live.ok ? live.executions : [];
        const journalExecs = journal.ok ? journal.executions : [];
        const merged = mergeExecutions(liveExecs, journalExecs);
        setState((prev) => ({
          kind: live.ok || journal.ok ? "ok" : "error",
          executions: merged,
          fetchedAt: live.ok ? live.fetchedAt : Date.now(),
          error: !live.ok && !journal.ok ? (!live.ok ? live.error : "journal unavailable") : undefined,
          rates: fx.ok ? fx.rates : prev.rates,
          base: fx.ok ? fx.base : prev.base,
        }));
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setState((p) => ({ kind: "error", error: msg, executions: p.executions, fetchedAt: p.fetchedAt }));
      }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const allTrips = useMemo(() => buildTrips(state.executions ?? []), [state.executions]);
  const targetDate = useMemo(() => latestTripDate(allTrips), [allTrips]);
  const dayTrips = useMemo(() => allTrips.filter((t) => t.dateET === targetDate), [allTrips, targetDate]);

  const totals = useMemo(() => {
    const closed = dayTrips.filter((t) => t.status === "closed");
    // Convert each trip's gross + cost to base currency, then sum — lets a day
    // mixing HKD/USD trades roll up to one base-currency figure.
    const grossPnl = closed.reduce((s, t) => s + (t.grossPnl != null ? toBase(t.grossPnl, t.currency, state.rates) : 0), 0);
    const totalCost = closed.reduce((s, t) => s + toBase(t.avgEntryPrice * t.qtyTraded * t.multiplier, t.currency, state.rates), 0);
    const pnlPercent = totalCost > 0 ? (grossPnl / totalCost) * 100 : null;
    const currency = state.rates ? (state.base ?? "SGD") : (dayTrips[0]?.currency ?? "USD");
    return { count: closed.length, grossPnl, pnlPercent, currency, openCount: dayTrips.length - closed.length };
  }, [dayTrips, state.rates, state.base]);

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (state.kind === "loading") {
    return <div className="rounded-xl border border-white/[0.06] bg-[#131316] p-6 text-sm text-[#a1a1aa]">Loading day P&amp;L…</div>;
  }
  if (dayTrips.length === 0) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-[#131316] p-8 text-center">
        <div className="text-[15px] font-medium text-[#a1a1aa]">No trades to show</div>
        <div className="mt-2 text-[13px] text-[#71717a]">
          Day P&amp;L populates as round trips close. Live IBKR data resets at 18:00 ET each
          day; persisted journal files survive the rollover. Run{" "}
          <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[12px]">node scripts/persist_session.mjs</code>
          {" "}after each session to keep history.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {state.kind === "error" && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-[12px] text-amber-300/80">
          ⚠ refresh failed ({state.error}) — showing last successful fetch
        </div>
      )}

      {/* Header strip — date + day-total P&L */}
      <div className="rounded-xl border border-white/[0.06] bg-[#131316] px-5 py-4 flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <div className="text-[13px] uppercase tracking-wider text-[#71717a]">Day P&amp;L · {formatDateLabel(targetDate)}</div>
          <div className="mt-1 text-[12px] text-[#a1a1aa]">
            {totals.count} closed{totals.openCount > 0 ? `, ${totals.openCount} open` : ""}
          </div>
        </div>
        <div className="text-right">
          <div className={cn("font-mono tabular-nums text-2xl font-semibold", pnlTone(totals.grossPnl))}>
            {formatPnl(totals.grossPnl, totals.currency)}
          </div>
          {totals.pnlPercent != null && (
            <div className={cn("font-mono tabular-nums text-[13px]", pnlTone(totals.pnlPercent))}>
              {formatPct(totals.pnlPercent)}
            </div>
          )}
          <div className="text-[11px] text-[#71717a] mt-0.5">gross · before commissions</div>
        </div>
      </div>

      {/* Per-contract list */}
      <div className="rounded-xl border border-white/[0.06] bg-[#131316] overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-4 py-2.5 border-b border-white/[0.06] text-[11px] uppercase tracking-wider text-[#71717a]">
          <div>Contract</div>
          <div className="text-right">P/L Day</div>
          <div className="text-right">P/L %</div>
        </div>
        {dayTrips.map((trip) => {
          const isExpanded = expanded.has(trip.key);
          const SourceIcon = trip.source === "manual" ? Hand : Bot;
          return (
            <div key={trip.key} className="border-b border-white/[0.04] last:border-0">
              <button
                onClick={() => toggle(trip.key)}
                className="w-full grid grid-cols-[1fr_auto_auto] gap-x-4 px-4 py-3 hover:bg-white/[0.02] transition-colors text-left"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[14px] font-medium text-[#e4e4e7]">{trip.contractCompact}</span>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider ring-1 ring-inset",
                        trip.source === "manual"
                          ? "text-amber-300 bg-amber-500/10 ring-amber-500/30"
                          : "text-sky-300 bg-sky-500/10 ring-sky-500/30",
                      )}
                    >
                      <SourceIcon className="h-3 w-3" />
                      {trip.source === "manual" ? "MANUAL" : "WATCHER"}
                    </span>
                    {trip.status === "open" && (
                      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-amber-300 bg-amber-500/15 ring-1 ring-amber-500/40 animate-pulse">
                        STILL OPEN
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[12px] text-[#71717a] font-mono">
                    <span>×{trip.qtyTraded}</span>
                    <span>·</span>
                    <span>{formatPrice(trip.avgEntryPrice, trip.currency)} → {trip.avgExitPrice != null ? formatPrice(trip.avgExitPrice, trip.currency) : "—"}</span>
                    {trip.holdMinutes != null && <><span>·</span><span>{trip.holdMinutes}m hold</span></>}
                  </div>
                </div>
                <div className="text-right">
                  <div className={cn("font-mono tabular-nums text-[15px] font-semibold", pnlTone(trip.grossPnl))}>
                    {formatBasePnl(trip.grossPnl, trip.currency, state.rates, state.base)}
                  </div>
                </div>
                <div className="text-right flex items-center gap-2 justify-end">
                  <span className={cn("font-mono tabular-nums text-[13px]", pnlTone(trip.pnlPercent))}>
                    {formatPct(trip.pnlPercent)}
                  </span>
                  {isExpanded ? <ChevronUp className="h-4 w-4 text-[#71717a]" /> : <ChevronDown className="h-4 w-4 text-[#71717a]" />}
                </div>
              </button>
              {isExpanded && (
                <div className="bg-[#0c0c0e] px-4 py-2 space-y-0.5 font-mono text-[12px] border-t border-white/[0.04]">
                  {trip.fills.map((f) => {
                    const isOpen = f.side === trip.fills[0].side;
                    return (
                      <div key={f.execId} className="flex items-center gap-2 text-[#a1a1aa]">
                        <span className="w-3 shrink-0 text-[#52525b]">{isOpen ? "↗" : "↘"}</span>
                        <span className="w-12 shrink-0 text-[#71717a]">{formatTimeShort(f.time)}</span>
                        <span className={cn("w-10 shrink-0 font-semibold", f.side === "BOT" ? "text-emerald-400" : "text-rose-400")}>
                          {f.side === "BOT" ? "BUY" : "SELL"}
                        </span>
                        <span className="w-10 shrink-0 tabular-nums text-[#e4e4e7]">{f.qty}x</span>
                        <span className="shrink-0 tabular-nums">@ {formatPrice(f.price, trip.currency)}</span>
                        <span className="text-[#52525b] text-[11px]">#{f.orderId === 0 ? "manual" : f.orderId}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
