"use client";

import { RefreshCw, Clock } from "lucide-react";
import { usePollingState } from "@/hooks/use-polling-state";
import { MarketCard } from "@/components/asia/market-card";
import { GatePanel } from "@/components/asia/gate-panel";
import { ActionsPanel } from "@/components/asia/actions-panel";
import { ManualYNToggle } from "@/components/asia/manual-yn-toggle";

type Instrument = {
  key: string;
  symbol: string;
  name: string;
  kind: string;
  ticker: string | null;
  us_analog: string | null;
  color_accent: string;
  levels?: Parameters<typeof MarketCard>[0]["levels"];
  mtf?: Parameters<typeof MarketCard>[0]["mtf"];
  orb?: Parameters<typeof MarketCard>[0]["orb"];
  trigger_b?: Parameters<typeof MarketCard>[0]["trigger_b"];
  trailing?: Parameters<typeof MarketCard>[0]["trailing"];
};

type StateResponse = {
  market: string;
  journal_date: string;
  journal_exists: boolean;
  journal_generated_at: string | null;
  drawings: { premarket_shapes: number; orb_shapes: number };
  instruments: Instrument[];
  premarket_verdict: string | null;
  gates: Array<{ name: string; status: string }>;
  fetched_at: string;
};

export default function AsiaDashboard() {
  const { data, error, loading, lastFetched, refetch } =
    usePollingState<StateResponse>("/api/state/hsi", 30000);

  return (
    <main className="min-h-screen px-6 py-8 max-w-7xl mx-auto">
      {/* Header */}
      <header className="mb-8 flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Asia Dashboard
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            HK morning session · MHI · MTW · Tencent · Alibaba · Xiaomi
            {data?.journal_date ? ` · ${data.journal_date}` : ""}
            {data?.premarket_verdict ? (
              <>
                {" · "}
                <span
                  className={
                    data.premarket_verdict === "proceed_to_open"
                      ? "text-green-400"
                      : data.premarket_verdict.startsWith("skip")
                      ? "text-red-400"
                      : "text-yellow-400"
                  }
                >
                  {data.premarket_verdict}
                </span>
              </>
            ) : null}
          </p>
        </div>

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {lastFetched && (
            <span className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              {lastFetched.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={refetch}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 hover:bg-accent transition-colors"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </header>

      {/* Status banner */}
      {error && (
        <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          Error fetching state: {error}
        </div>
      )}

      {data && !data.journal_exists && (
        <div className="mb-6 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-200">
          No journal for {data.journal_date} yet. Run{" "}
          <code className="bg-black/30 px-1.5 py-0.5 rounded">
            npm run premarket:hsi
          </code>{" "}
          from the <code>asia/</code> directory.
        </div>
      )}

      {data && data.journal_exists && (
        <div className="mb-4 flex items-center gap-4 text-xs text-muted-foreground">
          <span>
            Drawings on chart:{" "}
            <strong className="text-foreground">
              {data.drawings.premarket_shapes}
            </strong>{" "}
            pre-market shapes ·{" "}
            <strong className="text-foreground">
              {data.drawings.orb_shapes}
            </strong>{" "}
            ORB shapes
          </span>
        </div>
      )}

      {/* Watcher arm/disarm — binding gate for trade_window_hk.mjs */}
      <div className="mb-4">
        <ManualYNToggle />
      </div>

      {/* Actions panel */}
      <div className="mb-4">
        <ActionsPanel />
      </div>

      {/* Gate panel */}
      {data && (
        <div className="mb-6">
          <GatePanel gates={data.gates} />
        </div>
      )}

      {/* Market cards — side-by-side, 2 cols on lg, 3 cols on xl when ≥6 cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-5">
        {data?.instruments?.map((inst) => (
          <MarketCard
            key={inst.key}
            symbol={inst.symbol}
            description={inst.name}
            us_analog={inst.us_analog ?? "—"}
            instrumentKey={inst.key}
            levels={inst.levels}
            mtf={inst.mtf}
            orb={inst.orb}
            trigger_b={inst.trigger_b}
            trailing={inst.trailing}
          />
        ))}

        {loading && !data && (
          <div className="lg:col-span-2 xl:col-span-3 rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
            Loading state…
          </div>
        )}
      </div>

      {/* Future markets placeholder */}
      <div className="mt-12 mb-6 text-xs text-muted-foreground text-center">
        Edit <code className="bg-muted px-1.5 py-0.5 rounded">asia/config/contracts.json</code> to add more instruments. Future markets: Nikkei, Nifty.
      </div>
    </main>
  );
}
