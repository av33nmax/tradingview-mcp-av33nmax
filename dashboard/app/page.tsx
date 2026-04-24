"use client";

import { useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { ActionsPanel } from "@/components/actions-panel";
import { TickerCard, type TickerCardProps } from "@/components/ticker-card";
import { RulesBanner } from "@/components/rules-banner";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { AlertCircle, RefreshCw } from "lucide-react";
import type { EntryNotesResponse } from "./api/entry-notes/route";

type UIState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ok";
      generatedAt: string;
      ageMinutes: number;
      isStale: boolean;
      tickers: Record<string, TickerCardProps>;
    };

type RawTickerState = {
  bias: string | null;
  aligned: boolean | null;
  entry_notes: {
    direction: "CALLS" | "PUTS";
    trigger_a: { entry: number; stop: number; T1: number; T2: number };
    trigger_b: {
      entry_vwap: number;
      entry_ema21_1H: number;
      stop: number;
      T1: number;
      T2: number;
    };
  } | null;
};

function toTickerProps(ticker: string, raw: RawTickerState): TickerCardProps {
  return {
    ticker,
    bias: raw.bias,
    aligned: raw.aligned,
    direction: raw.entry_notes?.direction ?? null,
    triggerA: raw.entry_notes?.trigger_a ?? null,
    triggerB: raw.entry_notes?.trigger_b ?? null,
  };
}

export default function Dashboard() {
  const [state, setState] = useState<UIState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/entry-notes", { cache: "no-store" });
      const json = (await res.json()) as EntryNotesResponse;
      if (!json.ok) {
        setState({ kind: "error", message: json.error });
      } else {
        const tickers: Record<string, TickerCardProps> = {};
        for (const [t, v] of Object.entries(json.tickers)) {
          tickers[t] = toTickerProps(t, v as RawTickerState);
        }
        setState({
          kind: "ok",
          generatedAt: json.generatedAt,
          ageMinutes: json.ageMinutes,
          isStale: json.isStale,
          tickers,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ kind: "error", message });
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-[#09090b]">
      <AppHeader />

      <main className="mx-auto max-w-6xl px-4 py-6 space-y-5 md:px-6 md:py-8 md:space-y-6">
        <ActionsPanel />

        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-[#e4e4e7]">Today&apos;s setup</h2>
            {state.kind === "ok" && (
              <p className="mt-1.5 text-sm text-[#a1a1aa]">
                Generated {state.ageMinutes}m ago
                {state.isStale && (
                  <span className="ml-2 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-[13px] text-amber-300 ring-1 ring-amber-500/20">
                    stale — re-run premarket_setup.mjs
                  </span>
                )}
              </p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={load}
            disabled={refreshing}
            className="rounded-full border-white/[0.08] bg-[#131316] hover:bg-white/[0.05] text-[#e4e4e7]"
          >
            <RefreshCw className={refreshing ? "animate-spin" : ""} />
            Refresh
          </Button>
        </div>

        {state.kind === "loading" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Skeleton className="h-80" />
            <Skeleton className="h-80" />
          </div>
        )}

        {state.kind === "error" && (
          <div className="flex items-start gap-3 rounded-2xl border border-rose-500/20 bg-rose-500/10 p-4 text-sm text-rose-300">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <div className="font-semibold">Unable to load entry notes</div>
              <div className="mt-1 text-xs text-rose-300/80">{state.message}</div>
              <div className="mt-2 font-mono text-xs text-rose-300/60">
                $ node premarket_setup.mjs
              </div>
            </div>
          </div>
        )}

        {state.kind === "ok" && (
          <>
            {Object.keys(state.tickers).length === 0 ? (
              <div className="rounded-2xl border border-white/[0.06] bg-[#131316] p-8 text-center text-sm text-[#a1a1aa]">
                No tickers in latest_entry_notes.json
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {Object.values(state.tickers).map((props) => (
                  <TickerCard key={props.ticker} {...props} />
                ))}
              </div>
            )}
          </>
        )}

        <RulesBanner />

        <footer className="pt-4 text-[13px] text-[#71717a]">
          <p>Path A systematic trader. Read-only dashboard — all orders placed via TWS.</p>
        </footer>
      </main>
    </div>
  );
}
