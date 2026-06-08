"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown, Bot, Hand, Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ExecutionsResponse } from "@/app/api/ibkr/executions/route";
import type { JournalExecutionsResponse } from "@/app/api/journal/executions/route";
import type { JournalExecutionsRawResponse } from "@/app/api/journal/executions-raw/route";
import type { FxRatesResponse } from "@/app/api/ibkr/fx-rates/route";
import type { FlexTradesResponse } from "@/app/api/ibkr/flex-trades/route";
import type { ExecutionRow } from "@/lib/ibkr-account";
import { buildTrips, type Trip } from "@/lib/round-trips";

const POLL_MS = 15000;

/**
 * Merge FOUR execution sources by execId:
 *   - journal-consolidated  (end-of-day snapshots, post-rollover history)
 *   - flex                  (IBKR Flex Web Service — full history straight from
 *                            IBKR, no local persistence; fills the gaps when a
 *                            session wasn't persisted locally)
 *   - journal-raw           (watcher fills from JSONL appender, durable
 *                            against TWS/Next.js reconnects)
 *   - live IBKR             (current trading day, authoritative for fields,
 *                            includes manual TWS trades the watcher can't see)
 *
 * Order matters: insert least-recent first so the most-recent source wins on
 * field conflicts. Live overrides raw overrides flex overrides consolidated.
 * Flex's ibExecID matches the TWS execId, so today's trades present in both
 * live and flex dedupe (live wins, since flex lags intraday).
 *
 * Without raw in the mix, a Next.js hot-reload mid-session can drop the live
 * IBKR execution buffer (real failure 2026-04-30 — only 1 of 4 round-trips
 * surfaced after a hot-reload). Raw JSONL is append-only on disk so watcher
 * fills survive any in-process reset.
 */
function mergeExecutions(
  live: ExecutionRow[],
  raw: ExecutionRow[],
  journal: ExecutionRow[],
  flex: ExecutionRow[],
): ExecutionRow[] {
  const byId = new Map<string, ExecutionRow>();
  for (const e of journal) byId.set(e.execId, e);
  for (const e of flex) byId.set(e.execId, e);
  for (const e of raw) byId.set(e.execId, e);
  for (const e of live) byId.set(e.execId, e);
  return [...byId.values()];
}

function formatContract(e: ExecutionRow): string {
  if (e.secType === "OPT" || e.secType === "FOP") {
    const exp = e.expiry ? `${e.expiry.slice(0, 4)}-${e.expiry.slice(4, 6)}-${e.expiry.slice(6, 8)}` : "?";
    return `${e.symbol} ${e.strike ?? "?"}${e.right ?? ""} ${exp}`;
  }
  return e.symbol;
}

function formatTime(raw: string): string {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return raw;
  const [, , mo, d, hh, mm, ss] = m;
  return `${mo}-${d} ${hh}:${mm}:${ss}`;
}

function isOption(e: ExecutionRow): boolean {
  return e.secType === "OPT" || e.secType === "FOP";
}

function multiplier(e: ExecutionRow): number {
  // Real contract multiplier from IBKR (HSI=50, US opt=100); fall back to the
  // US-options assumption for legacy journal rows lacking the field.
  if (typeof e.multiplier === "number" && Number.isFinite(e.multiplier) && e.multiplier > 0) {
    return e.multiplier;
  }
  return isOption(e) ? 100 : 1;
}

function pnlTone(pnl: number | null): string {
  if (pnl == null) return "text-[#a1a1aa]";
  if (pnl > 0) return "text-emerald-400";
  if (pnl < 0) return "text-rose-400";
  return "text-[#a1a1aa]";
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

// P&L converted to base currency; native fallback until rates load.
function formatBasePnl(pnl: number | null, currency: string | undefined, rates: Rates, base?: string): string {
  if (pnl == null) return "—";
  if (!rates || currency == null || !(currency in rates)) return money(pnl, currency, true);
  return money(pnl * rates[currency], base ?? "SGD", true);
}

function formatHold(min: number | null): string {
  if (min == null) return "—";
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

// ─── Trip card ──────────────────────────────────────────────────────────────

function TripCard({ trip, rates, base }: { trip: Trip; rates: Rates; base?: string }) {
  const SourceIcon = trip.source === "manual" ? Hand : Bot;
  return (
    <div
      className={cn(
        "rounded-lg border bg-[#131316] px-4 py-3",
        trip.status === "open"
          ? "border-amber-500/30 ring-1 ring-amber-500/10"
          : "border-white/[0.06]",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[14px] font-semibold text-[#e4e4e7]">{trip.contractLabel}</span>
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
        <span className="ml-auto flex items-center gap-3 font-mono text-[13px] tabular-nums">
          <span className={cn("font-semibold", pnlTone(trip.grossPnl))}>{formatBasePnl(trip.grossPnl, trip.currency, rates, base)}</span>
          <span className="text-[#71717a]">·</span>
          <span className="text-[#a1a1aa]">{formatHold(trip.holdMinutes)} hold</span>
        </span>
      </div>
      <div className="mt-2 space-y-0.5 font-mono text-[12px]">
        {trip.fills.map((f) => {
          const isOpen = f.side === trip.fills[0].side;
          return (
            <div key={f.execId} className="flex items-center gap-2 text-[#a1a1aa]">
              <span className="w-3 shrink-0 text-[#52525b]">{isOpen ? "↗" : "↘"}</span>
              <span className="w-32 shrink-0 text-[#71717a]">{formatTime(f.time)}</span>
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
    </div>
  );
}

// ─── Sortable executions table ──────────────────────────────────────────────

type SortKey = "time" | "contract" | "side" | "qty" | "price" | "orderId";
type SortDir = "asc" | "desc";

function SortHeader({
  label,
  sortKey,
  current,
  dir,
  onClick,
  align,
}: {
  label: string;
  sortKey: SortKey;
  current: SortKey | null;
  dir: SortDir;
  onClick: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  const isActive = current === sortKey;
  const Icon = !isActive ? ArrowUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      className={cn(
        "px-3 py-2.5 font-medium cursor-pointer hover:text-[#e4e4e7] transition-colors select-none",
        align === "right" ? "text-right" : "text-left",
        isActive && "text-[#e4e4e7]",
      )}
      onClick={() => onClick(sortKey)}
    >
      <span className={cn("inline-flex items-center gap-1", align === "right" && "flex-row-reverse")}>
        {label}
        <Icon className={cn("h-3 w-3", isActive ? "opacity-100" : "opacity-40")} />
      </span>
    </th>
  );
}

function execSortValue(e: ExecutionRow, key: SortKey): string | number {
  switch (key) {
    case "time": return e.time;
    case "contract": return formatContract(e);
    case "side": return e.side;
    case "qty": return e.qty;
    case "price": return e.price;
    case "orderId": return e.orderId;
  }
}

// ─── Main component ─────────────────────────────────────────────────────────

export function TradeHistoryTab() {
  const [state, setState] = useState<{
    kind: "loading" | "ok" | "error";
    executions?: ExecutionRow[];
    error?: string;
    fetchedAt?: number;
    /** Distinct YYYY-MM-DD covered by persisted journal files. */
    journalDates?: string[];
    rates?: Record<string, number>;
    base?: string;
  }>({ kind: "loading" });

  const [sortKey, setSortKey] = useState<SortKey>("time");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        // Parallel fetch of three sources. Each can fail independently;
        // mergeExecutions() handles partial data. See mergeExecutions doc
        // comment for the precedence rules.
        const [liveRes, rawRes, journalRes, fxRes, flexRes] = await Promise.all([
          fetch("/api/ibkr/executions", { cache: "no-store" }),
          fetch("/api/journal/executions-raw", { cache: "no-store" }),
          fetch("/api/journal/executions", { cache: "no-store" }),
          fetch("/api/ibkr/fx-rates", { cache: "no-store" }),
          fetch("/api/ibkr/flex-trades", { cache: "no-store" }),
        ]);
        const live = (await liveRes.json()) as ExecutionsResponse;
        const raw = (await rawRes.json()) as JournalExecutionsRawResponse;
        const journal = (await journalRes.json()) as JournalExecutionsResponse;
        const fx = (await fxRes.json()) as FxRatesResponse;
        const flex = (await flexRes.json()) as FlexTradesResponse;
        if (cancelled) return;

        // Each source unavailable is fine — others fill the gap.
        const liveExecs = live.ok ? live.executions : [];
        const rawExecs = raw.ok ? raw.executions : [];
        const journalExecs = journal.ok ? journal.executions : [];
        const journalDates = journal.ok ? journal.dates : [];
        const flexExecs = flex.ok ? flex.executions : [];
        const merged = mergeExecutions(liveExecs, rawExecs, journalExecs, flexExecs);

        if (live.ok) {
          setState((p) => ({
            kind: "ok",
            executions: merged,
            fetchedAt: live.fetchedAt,
            journalDates,
            rates: fx.ok ? fx.rates : p.rates,
            base: fx.ok ? fx.base : p.base,
          }));
        } else {
          // Live failed but journal might still have data — keep showing
          // what we have, and surface the live error in a small warning.
          setState((p) => ({
            kind: "error",
            error: live.error,
            executions: merged.length > 0 ? merged : p.executions,
            fetchedAt: p.fetchedAt,
            journalDates,
            rates: fx.ok ? fx.rates : p.rates,
            base: fx.ok ? fx.base : p.base,
          }));
        }
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setState((p) => ({ kind: "error", error: message, executions: p.executions, fetchedAt: p.fetchedAt, journalDates: p.journalDates }));
      }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const trips = useMemo(() => (state.executions ? buildTrips(state.executions) : []), [state.executions]);

  const sortedExecs = useMemo(() => {
    if (!state.executions) return [];
    const out = [...state.executions];
    out.sort((a, b) => {
      const av = execSortValue(a, sortKey);
      const bv = execSortValue(b, sortKey);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return out;
  }, [state.executions, sortKey, sortDir]);

  const onSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "time" ? "desc" : "asc"); }
  };

  if (state.kind === "loading") {
    return <div className="rounded-xl border border-white/[0.06] bg-[#131316] p-6 text-sm text-[#a1a1aa]">Loading trade history…</div>;
  }
  const execs = state.executions;
  if (state.kind === "error" && !execs) {
    return <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-4 text-sm text-rose-300">Trade history unavailable — {state.error}</div>;
  }
  if (!execs || execs.length === 0) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-[#131316] p-8 text-center">
        <div className="text-[15px] font-medium text-[#a1a1aa]">No trades to show</div>
        <div className="mt-2 text-[13px] text-[#71717a]">
          Live IBKR returns only the current trading day&apos;s fills (rolls over at 18:00 ET). Run{" "}
          <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[12px]">node scripts/persist_session.mjs</code>
          {" "}before each rollover to keep history visible across days.
        </div>
      </div>
    );
  }

  // Gross P&L summary in base currency — convert each trip (USD/HKD) to base,
  // then sum into one figure.
  const grossBase = trips.reduce((s, t) => s + (t.grossPnl != null ? toBase(t.grossPnl, t.currency, state.rates) : 0), 0);
  const closedCount = trips.filter((t) => t.status === "closed").length;
  const openCount = trips.length - closedCount;

  return (
    <div className="space-y-5">
      {state.kind === "error" && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-[12px] text-amber-300/80">
          ⚠ refresh failed ({state.error}) — showing last successful fetch
        </div>
      )}

      {/* Round-trip summary — paired BOT/SLD as "trips" */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Repeat className="h-4 w-4 text-sky-400" />
          <h3 className="text-[15px] font-semibold text-[#e4e4e7]">Round trips</h3>
          <span className="text-[12px] text-[#71717a]">
            {closedCount} closed{openCount > 0 ? `, ${openCount} open` : ""}
          </span>
          <span className="ml-auto font-mono text-[13px] tabular-nums">
            Gross P&amp;L:{" "}
            <span className={cn("font-semibold", pnlTone(grossBase))}>
              {state.rates ? money(grossBase, state.base ?? "SGD", true) : "…"}
            </span>
            <span className="text-[11px] text-[#71717a] ml-1">(before commissions)</span>
          </span>
        </div>
        <div className="space-y-2">
          {trips.map((trip) => (
            <TripCard key={trip.key} trip={trip} rates={state.rates} base={state.base} />
          ))}
        </div>
      </section>

      {/* Raw fills — sortable */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-[15px] font-semibold text-[#e4e4e7]">All fills</h3>
          <span className="text-[12px] text-[#71717a]">click any column header to sort</span>
        </div>
        <div className="overflow-x-auto rounded-xl border border-white/[0.06] bg-[#131316]">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-white/[0.06] text-[12px] uppercase tracking-wider text-[#71717a]">
                <SortHeader label="Time" sortKey="time" current={sortKey} dir={sortDir} onClick={onSort} />
                <SortHeader label="Contract" sortKey="contract" current={sortKey} dir={sortDir} onClick={onSort} />
                <SortHeader label="Side" sortKey="side" current={sortKey} dir={sortDir} onClick={onSort} />
                <SortHeader label="Qty" sortKey="qty" current={sortKey} dir={sortDir} onClick={onSort} align="right" />
                <SortHeader label="Fill price" sortKey="price" current={sortKey} dir={sortDir} onClick={onSort} align="right" />
                <th className="px-3 py-2.5 text-right font-medium">Net</th>
                <SortHeader label="Order #" sortKey="orderId" current={sortKey} dir={sortDir} onClick={onSort} />
              </tr>
            </thead>
            <tbody>
              {sortedExecs.map((e) => {
                const isBuy = e.side === "BOT";
                return (
                  <tr key={e.execId} className="border-b border-white/[0.04] last:border-0">
                    <td className="px-3 py-2.5 font-mono text-[12px] text-[#71717a]">{formatTime(e.time)}</td>
                    <td className="px-3 py-2.5 font-mono text-[#e4e4e7]">{formatContract(e)}</td>
                    <td className={cn("px-3 py-2.5 font-semibold", isBuy ? "text-emerald-400" : "text-rose-400")}>{isBuy ? "Buy" : "Sell"}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-[#e4e4e7]">{e.qty}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-[#a1a1aa]">{formatPrice(e.price, e.currency)}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-[#a1a1aa]">{formatPrice(e.qty * e.price * multiplier(e), e.currency)}</td>
                    <td className="px-3 py-2.5 font-mono text-[12px] text-[#71717a]">{e.orderId === 0 ? "manual" : e.orderId}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-2 text-[11px] text-[#71717a]">
          {execs.length} execution{execs.length === 1 ? "" : "s"}
          {state.journalDates && state.journalDates.length > 0 && (
            <> · journal: {state.journalDates.length} day{state.journalDates.length === 1 ? "" : "s"} ({state.journalDates.join(", ")})</>
          )}
          {state.fetchedAt && <> · last fetch {new Date(state.fetchedAt).toLocaleTimeString("en-US", { hour12: false })}</>}
        </div>
      </section>
    </div>
  );
}
