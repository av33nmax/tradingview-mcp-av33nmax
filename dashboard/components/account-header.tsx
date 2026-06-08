"use client";

import { useAccountSummary } from "@/lib/account-summary-hook";
import { useAllAccountData } from "@/lib/all-account-data-hook";
import { cn } from "@/lib/utils";
import type { PositionRow } from "@/lib/ibkr-account";

function formatPositions(positions: PositionRow[]): string {
  if (positions.length === 0) return "Flat";
  return positions
    .map((p) => `${p.symbol} ${p.strike}${p.right} ×${p.position}`)
    .join(", ");
}

function formatMoney(raw: string | undefined, currency = "USD"): string {
  if (raw == null) return "—";
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = n < 0 ? "−" : ""; // typographic minus
  if (currency === "USD") return `${sign}$${formatted}`;
  return `${sign}${formatted} ${currency}`;
}

function PnLValue({ raw, currency = "USD" }: { raw: string | undefined; currency?: string }) {
  if (raw == null) return <span className="text-[#a1a1aa]">—</span>;
  const n = Number(raw);
  if (!Number.isFinite(n)) return <span className="text-[#a1a1aa]">{raw}</span>;
  const tone = n > 0 ? "text-emerald-400" : n < 0 ? "text-rose-400" : "text-[#a1a1aa]";
  const sign = n > 0 ? "+" : "";
  return (
    <span className={cn("font-mono tabular-nums font-semibold", tone)}>
      {sign}
      {formatMoney(raw, currency)}
    </span>
  );
}

/**
 * Sticky account header that sits below the AppHeader on every Dashboard
 * scroll position. Polls /api/ibkr/account-summary every 8s.
 *
 * Sticky offsets are tuned to AppHeader height:
 *   - Mobile: AppHeader top row (~60px) + nav row (~44px) ≈ 104px
 *   - Desktop (md+): single row (~68px)
 * If AppHeader layout changes, adjust top-[...] values here.
 */
export function AccountHeader() {
  const { loading, error, mode, account, values } = useAccountSummary();
  const { positions } = useAllAccountData();
  const openCount = positions.length;
  const positionsLabel = formatPositions(positions);

  const wrapper = "sticky top-[104px] md:top-[68px] z-20 -mx-4 md:-mx-6 px-4 md:px-6 py-2 border-b backdrop-blur-md";

  if (loading && !values) {
    return (
      <div className={cn(wrapper, "border-white/[0.06] bg-[#09090b]/85 text-[12px] text-[#71717a]")}>
        Loading account summary…
      </div>
    );
  }
  if (error && !values) {
    return (
      <div className={cn(wrapper, "border-rose-500/20 bg-rose-500/5 text-[12px] text-rose-300")}>
        Account summary unavailable — {error}
      </div>
    );
  }

  const netLiq = values?.NetLiquidation;
  const realizedPnl = values?.RealizedPnL;
  const unrealizedPnl = values?.UnrealizedPnL;
  const excessLiq = values?.ExcessLiquidity;
  const baseCcy = netLiq?.currency ?? "USD";

  return (
    <div className={cn(wrapper, "border-white/[0.06] bg-[#09090b]/85")}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12.5px]">
        {mode && (
          <span
            className={cn(
              "rounded px-2 py-0.5 text-[10px] font-bold tracking-wider ring-1 ring-inset",
              mode === "LIVE"
                ? "text-rose-300 bg-rose-500/10 ring-rose-500/30"
                : "text-sky-300 bg-sky-500/10 ring-sky-500/30",
            )}
          >
            {mode}
          </span>
        )}
        {account && <span className="font-mono text-[11px] text-[#71717a]">{account}</span>}
        <div className="flex items-baseline gap-1.5">
          <span className="text-[#71717a]">NetLiq</span>
          <span className="font-mono tabular-nums font-semibold text-[#e4e4e7]">{formatMoney(netLiq?.value, baseCcy)}</span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[#71717a]">Daily P&amp;L</span>
          <PnLValue raw={realizedPnl?.value} currency={realizedPnl?.currency ?? baseCcy} />
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[#71717a]">Unreal P&amp;L</span>
          <PnLValue raw={unrealizedPnl?.value} currency={unrealizedPnl?.currency ?? baseCcy} />
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[#71717a]">Excess Liq</span>
          <span className="font-mono tabular-nums text-[#a1a1aa]">{formatMoney(excessLiq?.value, baseCcy)}</span>
        </div>
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="text-[#71717a]">Open</span>
          <span
            className={cn(
              "font-mono tabular-nums truncate",
              openCount === 0
                ? "text-[#71717a]"
                : "text-amber-300 font-semibold",
            )}
            title={openCount > 0 ? positionsLabel : undefined}
          >
            {positionsLabel}
          </span>
        </div>
        {error && (
          <span className="ml-auto text-[11px] text-amber-300/80" title={error}>
            ⚠ refresh failed (last good: {values?.NetLiquidation ? "shown" : "—"})
          </span>
        )}
      </div>
    </div>
  );
}
