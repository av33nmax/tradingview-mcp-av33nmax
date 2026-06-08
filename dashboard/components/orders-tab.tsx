"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { OrdersResponse } from "@/app/api/ibkr/orders/route";
import type { OrderRow } from "@/lib/ibkr-account";

const POLL_MS = 5000;

function formatContract(o: OrderRow): string {
  if (o.secType === "OPT" || o.secType === "FOP") {
    const exp = o.expiry ? `${o.expiry.slice(0, 4)}-${o.expiry.slice(4, 6)}-${o.expiry.slice(6, 8)}` : "?";
    return `${o.symbol} ${o.strike ?? "?"}${o.right ?? ""} ${exp}`;
  }
  return o.symbol;
}

function statusTone(status: string): string {
  const s = status.toLowerCase();
  if (s === "filled") return "text-emerald-400";
  if (s === "cancelled" || s === "apicancelled") return "text-rose-400";
  if (s === "presubmitted" || s === "pendingsubmit") return "text-amber-300";
  if (s === "submitted") return "text-sky-300";
  return "text-[#a1a1aa]";
}

export function OrdersTab() {
  const [state, setState] = useState<{
    kind: "loading" | "ok" | "error";
    orders?: OrderRow[];
    error?: string;
    fetchedAt?: number;
  }>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const res = await fetch("/api/ibkr/orders", { cache: "no-store" });
        const json = (await res.json()) as OrdersResponse;
        if (cancelled) return;
        if (json.ok) {
          setState({ kind: "ok", orders: json.orders, fetchedAt: json.fetchedAt });
        } else {
          setState((p) => ({ kind: "error", error: json.error, orders: p.orders, fetchedAt: p.fetchedAt }));
        }
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setState((p) => ({ kind: "error", error: message, orders: p.orders, fetchedAt: p.fetchedAt }));
      }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (state.kind === "loading") {
    return <div className="rounded-xl border border-white/[0.06] bg-[#131316] p-6 text-sm text-[#a1a1aa]">Loading orders…</div>;
  }
  const orders = state.orders;
  if (state.kind === "error" && !orders) {
    return <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-4 text-sm text-rose-300">Orders unavailable — {state.error}</div>;
  }
  if (!orders || orders.length === 0) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-[#131316] p-8 text-center">
        <div className="text-[15px] font-medium text-[#a1a1aa]">No open orders</div>
        <div className="mt-2 text-[13px] text-[#71717a]">When the watcher places an entry order or arms an OCA bracket, it appears here.</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {state.kind === "error" && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-[12px] text-amber-300/80">
          ⚠ refresh failed ({state.error}) — showing last successful fetch
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-white/[0.06] bg-[#131316]">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-white/[0.06] text-left text-[12px] uppercase tracking-wider text-[#71717a]">
              <th className="px-3 py-2.5 font-medium">#</th>
              <th className="px-3 py-2.5 font-medium">Contract</th>
              <th className="px-3 py-2.5 font-medium">Action</th>
              <th className="px-3 py-2.5 font-medium">Type</th>
              <th className="px-3 py-2.5 text-right font-medium">Qty</th>
              <th className="px-3 py-2.5 text-right font-medium">Limit / Stop</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              <th className="px-3 py-2.5 font-medium">OCA</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.orderId} className="border-b border-white/[0.04] last:border-0">
                <td className="px-3 py-2.5 font-mono text-[12px] text-[#71717a]">{o.orderId}</td>
                <td className="px-3 py-2.5 font-mono text-[#e4e4e7]">{formatContract(o)}</td>
                <td className={cn("px-3 py-2.5 font-semibold", o.action === "BUY" ? "text-emerald-400" : "text-rose-400")}>{o.action}</td>
                <td className="px-3 py-2.5 text-[#a1a1aa]">{o.orderType}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-[#e4e4e7]">{o.qty}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-[#a1a1aa]">
                  {o.limitPrice != null && Number.isFinite(o.limitPrice) && o.limitPrice !== 0 ? `LMT ${o.limitPrice.toFixed(2)}` : null}
                  {o.auxPrice != null && Number.isFinite(o.auxPrice) && o.auxPrice !== 0 ? <> · STP {o.auxPrice.toFixed(2)}</> : null}
                  {(!o.limitPrice && !o.auxPrice) ? "—" : null}
                </td>
                <td className={cn("px-3 py-2.5 font-medium", statusTone(o.status))}>{o.status}</td>
                <td className="px-3 py-2.5 font-mono text-[11px] text-[#71717a]">{o.ocaGroup ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-[11px] text-[#71717a]">
        {orders.length} order{orders.length === 1 ? "" : "s"}
        {state.fetchedAt && <> · last fetch {new Date(state.fetchedAt).toLocaleTimeString("en-US", { hour12: false })}</>}
      </div>
    </div>
  );
}
