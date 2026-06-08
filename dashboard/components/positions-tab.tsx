"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { PositionsResponse } from "@/app/api/ibkr/positions/route";
import type { PositionRow } from "@/lib/ibkr-account";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string; lastGood: PositionRow[] | null; lastFetchedAt: number | null }
  | { kind: "ok"; positions: PositionRow[]; fetchedAt: number };

const POLL_MS = 8000;

/**
 * Format an option contract for display: "SPY 720C 2026-04-28".
 * For non-option contracts (stocks/ETFs), just the symbol.
 */
function formatContract(p: PositionRow): string {
  if (p.secType === "OPT" || p.secType === "FOP") {
    const expiryFormatted = p.expiry
      ? `${p.expiry.slice(0, 4)}-${p.expiry.slice(4, 6)}-${p.expiry.slice(6, 8)}`
      : "?";
    return `${p.symbol} ${p.strike ?? "?"}${p.right ?? ""} ${expiryFormatted}`;
  }
  return p.symbol;
}

function formatMoney(n: number, currency = "USD"): string {
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = n < 0 ? "−" : "";
  return currency === "USD" ? `${sign}$${formatted}` : `${sign}${formatted} ${currency}`;
}

export function PositionsTab() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const res = await fetch("/api/ibkr/positions", { cache: "no-store" });
        const json = (await res.json()) as PositionsResponse;
        if (cancelled) return;
        if (json.ok) {
          setState({ kind: "ok", positions: json.positions, fetchedAt: json.fetchedAt });
        } else {
          setState((prev) => ({
            kind: "error",
            message: json.error,
            lastGood: prev.kind === "ok" ? prev.positions : prev.kind === "error" ? prev.lastGood : null,
            lastFetchedAt: prev.kind === "ok" ? prev.fetchedAt : prev.kind === "error" ? prev.lastFetchedAt : null,
          }));
        }
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setState((prev) => ({
          kind: "error",
          message,
          lastGood: prev.kind === "ok" ? prev.positions : prev.kind === "error" ? prev.lastGood : null,
          lastFetchedAt: prev.kind === "ok" ? prev.fetchedAt : prev.kind === "error" ? prev.lastFetchedAt : null,
        }));
      }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-[#131316] p-6 text-sm text-[#a1a1aa]">
        Loading positions…
      </div>
    );
  }

  // If we have last-good data, render it (with stale notice). Otherwise show error.
  const positions =
    state.kind === "ok"
      ? state.positions
      : state.kind === "error" && state.lastGood
        ? state.lastGood
        : null;

  if (state.kind === "error" && !positions) {
    return (
      <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-4 text-sm text-rose-300">
        Positions unavailable — {state.message}
      </div>
    );
  }
  if (!positions || positions.length === 0) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-[#131316] p-8 text-center">
        <div className="text-[15px] font-medium text-[#a1a1aa]">No open positions</div>
        <div className="mt-2 text-[13px] text-[#71717a]">
          When a watcher fires and a fill happens, the position will appear here.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {state.kind === "error" && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-[12px] text-amber-300/80">
          ⚠ refresh failed ({state.message}) — showing last successful fetch
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-white/[0.06] bg-[#131316]">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-white/[0.06] text-left text-[12px] uppercase tracking-wider text-[#71717a]">
              <th className="px-4 py-2.5 font-medium">Contract</th>
              <th className="px-4 py-2.5 font-medium">Side</th>
              <th className="px-4 py-2.5 text-right font-medium">Qty</th>
              <th className="px-4 py-2.5 text-right font-medium">Avg Cost</th>
              <th className="px-4 py-2.5 font-medium">Account</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p, i) => {
              const isShort = p.position < 0;
              const sideTone = isShort ? "text-rose-400" : "text-emerald-400";
              const sideLabel = isShort ? "SHORT" : "LONG";
              return (
                <tr key={`${p.conId ?? i}-${p.symbol}`} className="border-b border-white/[0.04] last:border-0">
                  <td className="px-4 py-2.5 font-mono text-[#e4e4e7]">{formatContract(p)}</td>
                  <td className={cn("px-4 py-2.5 font-semibold", sideTone)}>{sideLabel}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#e4e4e7]">{Math.abs(p.position)}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#a1a1aa]">{formatMoney(p.avgCost, p.currency)}</td>
                  <td className="px-4 py-2.5 font-mono text-[12px] text-[#71717a]">{p.account}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="text-[11px] text-[#71717a]">
        {positions.length} position{positions.length === 1 ? "" : "s"}
        {state.kind === "ok" && (
          <> · last fetch {new Date(state.fetchedAt).toLocaleTimeString("en-US", { hour12: false })}</>
        )}
      </div>
    </div>
  );
}
