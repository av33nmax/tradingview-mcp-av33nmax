"use client";

import { useAccountSummary } from "@/lib/account-summary-hook";
import { cn } from "@/lib/utils";

function formatMoney(raw: string | undefined, currency = "USD"): string {
  if (raw == null) return "—";
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = n < 0 ? "−" : "";
  if (currency === "USD") return `${sign}$${formatted}`;
  return `${sign}${formatted} ${currency}`;
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "pnl-pos" | "pnl-neg" | "muted";
}) {
  const toneClass =
    tone === "pnl-pos" ? "text-emerald-400" :
    tone === "pnl-neg" ? "text-rose-400" :
    tone === "muted"   ? "text-[#a1a1aa]" :
                         "text-[#e4e4e7]";
  return (
    <div className="flex items-baseline justify-between border-b border-white/[0.04] py-2.5">
      <span className="text-[13px] text-[#a1a1aa]">{label}</span>
      <span className={cn("font-mono tabular-nums text-[14px] font-semibold", toneClass)}>{value}</span>
    </div>
  );
}

function pnlTone(raw: string | undefined): "pnl-pos" | "pnl-neg" | "neutral" {
  if (raw == null) return "neutral";
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return "neutral";
  return n > 0 ? "pnl-pos" : "pnl-neg";
}

function pnlValue(raw: string | undefined, currency = "USD"): string {
  if (raw == null) return "—";
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const sign = n > 0 ? "+" : "";
  return `${sign}${formatMoney(raw, currency)}`;
}

export function AccountSummaryTab() {
  const { loading, error, account, values } = useAccountSummary();

  if (loading && !values) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-[#131316] p-6 text-sm text-[#a1a1aa]">
        Loading account summary…
      </div>
    );
  }
  if (error && !values) {
    return (
      <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-4 text-sm text-rose-300">
        Account summary unavailable — {error}
      </div>
    );
  }
  if (!values) return null;

  const ccy = values.NetLiquidation?.currency ?? "USD";
  const get = (k: string) => values[k]?.value;

  return (
    <div className="space-y-6">
      {account && (
        <div className="text-[13px] text-[#71717a]">
          Account <span className="font-mono text-[#a1a1aa]">{account}</span>
        </div>
      )}

      <section className="rounded-xl border border-white/[0.06] bg-[#131316] p-5">
        <h3 className="mb-3 text-[15px] font-semibold text-[#e4e4e7]">Overview</h3>
        <Row label="Net Liquidation" value={formatMoney(get("NetLiquidation"), ccy)} />
        <Row label="Total Cash Value" value={formatMoney(get("TotalCashValue"), ccy)} />
        <Row label="Available Funds" value={formatMoney(get("AvailableFunds"), ccy)} />
        <Row label="Buying Power" value={formatMoney(get("BuyingPower"), ccy)} />
        <Row label="Equity With Loan" value={formatMoney(get("EquityWithLoanValue"), ccy)} />
        <Row label="Gross Position Value" value={formatMoney(get("GrossPositionValue"), ccy)} tone="muted" />
        <Row label="Excess Liquidity" value={formatMoney(get("ExcessLiquidity"), ccy)} />
        <Row label="Accrued Cash" value={formatMoney(get("AccruedCash"), ccy)} tone="muted" />
        <Row label="Leverage" value={get("Leverage") ?? "—"} tone="muted" />
      </section>

      <section className="rounded-xl border border-white/[0.06] bg-[#131316] p-5">
        <h3 className="mb-3 text-[15px] font-semibold text-[#e4e4e7]">P&amp;L</h3>
        <Row label="Realized P&L (today)" value={pnlValue(get("RealizedPnL"), ccy)} tone={pnlTone(get("RealizedPnL"))} />
        <Row label="Unrealized P&L" value={pnlValue(get("UnrealizedPnL"), ccy)} tone={pnlTone(get("UnrealizedPnL"))} />
      </section>

      <section className="rounded-xl border border-white/[0.06] bg-[#131316] p-5">
        <h3 className="mb-3 text-[15px] font-semibold text-[#e4e4e7]">Margin Requirements</h3>
        <Row label="Initial Margin Required" value={formatMoney(get("InitMarginReq"), ccy)} tone="muted" />
        <Row label="Maintenance Margin Required" value={formatMoney(get("MaintMarginReq"), ccy)} tone="muted" />
        <Row label="Day Trades Remaining" value={get("DayTradesRemaining") ?? "—"} tone="muted" />
      </section>
    </div>
  );
}
