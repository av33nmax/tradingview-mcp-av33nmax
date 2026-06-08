"use client";

import { useEffect, useState } from "react";
import type { BalancesResponse } from "@/app/api/ibkr/balances/route";
import type { BalancesResult } from "@/lib/ibkr-account";

const POLL_MS = 15000;

function formatAmount(n: number): string {
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `−${formatted}` : formatted;
}

export function BalancesTab() {
  const [state, setState] = useState<{
    kind: "loading" | "ok" | "error";
    balances?: BalancesResult;
    error?: string;
    fetchedAt?: number;
  }>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const res = await fetch("/api/ibkr/balances", { cache: "no-store" });
        const json = (await res.json()) as BalancesResponse;
        if (cancelled) return;
        if (json.ok) setState({ kind: "ok", balances: json.balances, fetchedAt: json.fetchedAt });
        else setState((p) => ({ kind: "error", error: json.error, balances: p.balances, fetchedAt: p.fetchedAt }));
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setState((p) => ({ kind: "error", error: message, balances: p.balances, fetchedAt: p.fetchedAt }));
      }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (state.kind === "loading") {
    return <div className="rounded-xl border border-white/[0.06] bg-[#131316] p-6 text-sm text-[#a1a1aa]">Loading balances…</div>;
  }
  const b = state.balances;
  if (state.kind === "error" && !b) {
    return <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-4 text-sm text-rose-300">Balances unavailable — {state.error}</div>;
  }
  if (!b) return null;

  return (
    <div className="space-y-4">
      {state.kind === "error" && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-[12px] text-amber-300/80">
          ⚠ refresh failed ({state.error}) — showing last successful fetch
        </div>
      )}

      {/* Per-currency cash balances */}
      <div className="overflow-x-auto rounded-xl border border-white/[0.06] bg-[#131316]">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-white/[0.06] text-left text-[12px] uppercase tracking-wider text-[#71717a]">
              <th className="px-4 py-2.5 font-medium">Currency</th>
              <th className="px-4 py-2.5 text-right font-medium">Cash Balance</th>
            </tr>
          </thead>
          <tbody>
            {b.byCurrency.length === 0 ? (
              <tr>
                <td colSpan={2} className="px-4 py-6 text-center text-[#71717a]">No per-currency balances reported.</td>
              </tr>
            ) : (
              b.byCurrency.map((row) => (
                <tr key={row.currency} className="border-b border-white/[0.04] last:border-0">
                  <td className="px-4 py-2.5 font-mono text-[#e4e4e7]">
                    {row.currency}
                    {row.currency === b.baseCurrency && (
                      <span className="ml-2 text-[11px] text-[#71717a]">(Base Currency)</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#e4e4e7]">{formatAmount(row.cashBalance)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Total cash in base currency */}
      <div className="overflow-x-auto rounded-xl border border-white/[0.06] bg-[#131316]">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-white/[0.06] text-left text-[12px] uppercase tracking-wider text-[#71717a]">
              <th className="px-4 py-2.5 font-medium">Total Cash Currency</th>
              <th className="px-4 py-2.5 text-right font-medium">Total Cash Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="px-4 py-2.5 font-mono text-[#e4e4e7]">{b.baseCurrency}</td>
              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#e4e4e7]">{formatAmount(b.totalCashBase)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {state.fetchedAt && (
        <div className="text-[11px] text-[#71717a]">
          Last fetch {new Date(state.fetchedAt).toLocaleTimeString("en-US", { hour12: false })}
        </div>
      )}
    </div>
  );
}
