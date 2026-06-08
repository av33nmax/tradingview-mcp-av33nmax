"use client";

import { Rocket } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PositionRow, OrderRow } from "@/lib/ibkr-account";

function formatContract(p: PositionRow): string {
  if (p.secType === "OPT" || p.secType === "FOP") {
    const exp = p.expiry ? `${p.expiry.slice(0, 4)}-${p.expiry.slice(4, 6)}-${p.expiry.slice(6, 8)}` : "?";
    return `${p.symbol} ${p.strike ?? "?"}${p.right ?? ""} ${exp}`;
  }
  return p.symbol;
}

function formatMoney(n: number, currency = "USD"): string {
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = n < 0 ? "−" : "";
  return currency === "USD" ? `${sign}$${formatted}` : `${sign}${formatted} ${currency}`;
}

/**
 * Renders inside a TickerCard's CardContent when an open position exists
 * for that ticker. Read-only at this stage (Phase 4b) — Phase 4c will add
 * Flatten / Move stop / Take partial buttons.
 *
 * Shows:
 *   - Position summary (contract, side, qty, avg cost, est risk)
 *   - OCA bracket legs (T1 limit + stop) if armed — extracted from
 *     /api/ibkr/orders by filtering to active OCA group orders for this
 *     ticker.
 *
 * For per-position live P&L we'd need reqPnLSingle (subscription per
 * position). Skipped for v1 — account-level Unrealized P&L in the sticky
 * header covers the urgent need; per-position breakdown comes with
 * Phase 4c manual controls.
 */
export function PositionInlineSection({
  positions,
  orders,
}: {
  positions: PositionRow[];
  orders: OrderRow[];
}) {
  if (positions.length === 0) return null;

  // OCA bracket orders for this ticker = open SELL orders linked via ocaGroup
  // Filter to active statuses only; cancelled/filled don't show
  const activeStatuses = new Set(["Submitted", "PreSubmitted", "PendingSubmit"]);
  const bracketOrders = orders.filter(
    (o) =>
      activeStatuses.has(o.status) &&
      o.ocaGroup != null &&
      o.ocaGroup !== "",
  );
  // Group by OCA group so we can show "T1 + Stop" pairs together
  const ocaGroups = new Map<string, OrderRow[]>();
  for (const o of bracketOrders) {
    const key = o.ocaGroup ?? "_none";
    if (!ocaGroups.has(key)) ocaGroups.set(key, []);
    ocaGroups.get(key)!.push(o);
  }

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <Rocket className="h-4 w-4 text-emerald-400" />
        <h4 className="text-[15px] font-semibold text-[#e4e4e7]">Open position</h4>
      </div>

      <div className="space-y-2">
        {positions.map((p, i) => {
          const isShort = p.position < 0;
          const sideTone = isShort ? "text-rose-400" : "text-emerald-400";
          const sideLabel = isShort ? "SHORT" : "LONG";
          // Risk = avgCost × |qty| × multiplier (100 for options)
          const multiplier = p.secType === "OPT" || p.secType === "FOP" ? 100 : 1;
          const totalCost = Math.abs(p.position) * p.avgCost * multiplier;
          return (
            <div
              key={`${p.conId ?? i}-${p.symbol}`}
              className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] px-3 py-2.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[13px] font-semibold text-[#e4e4e7] truncate">
                    {formatContract(p)}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-[#a1a1aa]">
                    <span>
                      <span className={cn("font-bold mr-1", sideTone)}>{sideLabel}</span>
                      <span className="font-mono tabular-nums text-[#e4e4e7]">{Math.abs(p.position)}</span>
                    </span>
                    <span>
                      avg{" "}
                      <span className="font-mono tabular-nums text-[#e4e4e7]">
                        {formatMoney(p.avgCost, p.currency)}
                      </span>
                    </span>
                    <span>
                      cost{" "}
                      <span className="font-mono tabular-nums text-[#e4e4e7]">
                        {formatMoney(totalCost, p.currency)}
                      </span>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {ocaGroups.size > 0 && (
          <div className="rounded-lg border border-white/[0.06] bg-[#0c0c0e] px-3 py-2.5">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">
              OCA bracket{ocaGroups.size === 1 ? "" : "s"} (open)
            </div>
            <div className="space-y-1.5">
              {[...ocaGroups.entries()].map(([groupId, legs]) => (
                <div key={groupId} className="space-y-0.5">
                  {legs.map((o) => {
                    const isLimit = o.orderType === "LMT";
                    const priceShown = isLimit ? o.limitPrice : o.auxPrice;
                    const labelTone = isLimit ? "text-emerald-300" : "text-rose-300";
                    const label = isLimit ? "T1 limit" : "Stop";
                    return (
                      <div
                        key={o.orderId}
                        className="flex items-baseline justify-between text-[12px] font-mono"
                      >
                        <span>
                          <span className={cn("font-semibold mr-2", labelTone)}>{label}</span>
                          <span className="tabular-nums text-[#e4e4e7]">
                            @ {priceShown != null ? priceShown.toFixed(2) : "?"}
                          </span>
                          <span className="ml-2 text-[#71717a]">×{o.qty}</span>
                        </span>
                        <span className="text-[10px] text-[#52525b]">#{o.orderId}</span>
                      </div>
                    );
                  })}
                  <div className="pl-1 text-[10px] text-[#52525b]">
                    OCA: one fills → other auto-cancels
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
