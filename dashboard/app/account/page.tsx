"use client";

import { useState } from "react";
import { AppHeader } from "@/components/app-header";
import { AccountHeader } from "@/components/account-header";
import { AccountSummaryTab } from "@/components/account-summary-tab";
import { PositionsTab } from "@/components/positions-tab";
import { OrdersTab } from "@/components/orders-tab";
import { TradeHistoryTab } from "@/components/trade-history-tab";
import { BalancesTab } from "@/components/balances-tab";
import { DayPnLTab } from "@/components/day-pnl-tab";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "day-pnl", label: "Day P&L" },
  { id: "positions", label: "Positions" },
  { id: "orders", label: "Orders" },
  { id: "trade-history", label: "Trade History" },
  { id: "balances", label: "Balances" },
  { id: "account-summary", label: "Account Summary" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function AccountPage() {
  const [activeTab, setActiveTab] = useState<TabId>("day-pnl");

  return (
    <div className="min-h-screen bg-[#09090b]">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-6 space-y-5 md:px-6 md:py-8 md:space-y-6">
        <AccountHeader />

        <div className="space-y-1">
          <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-[#e4e4e7]">Account</h2>
          <p className="text-sm text-[#a1a1aa]">
            Live data from your IBKR account via TWS API. Polls every 8s.
          </p>
        </div>

        {/* Tab navigation */}
        <div className="flex flex-wrap gap-0 border-b border-white/[0.06] -mx-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={cn(
                "px-4 py-2.5 text-sm transition-colors -mb-px border-b-2",
                activeTab === t.id
                  ? "border-[#c8a978] text-[#e4e4e7] font-semibold"
                  : "border-transparent text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-white/[0.02]",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === "day-pnl" && <DayPnLTab />}
        {activeTab === "positions" && <PositionsTab />}
        {activeTab === "orders" && <OrdersTab />}
        {activeTab === "trade-history" && <TradeHistoryTab />}
        {activeTab === "balances" && <BalancesTab />}
        {activeTab === "account-summary" && <AccountSummaryTab />}
      </main>
    </div>
  );
}
