"use client";

import { useEffect, useState } from "react";
import type { AccountSummaryResponse } from "@/app/api/ibkr/account-summary/route";

export type AccountSummaryState = {
  loading: boolean;
  error: string | null;
  mode: "LIVE" | "PAPER" | null;
  account: string | null;
  values: Record<string, { value: string; currency: string }> | null;
  fetchedAt: number | null;
};

const initialState: AccountSummaryState = {
  loading: true,
  error: null,
  mode: null,
  account: null,
  values: null,
  fetchedAt: null,
};

/**
 * Polls /api/ibkr/account-summary every `intervalMs`. Default 8s — fast
 * enough to feel live for P&L during a held position, slow enough not to
 * hammer TWS with reqAccountSummary subscriptions.
 *
 * On error, keeps last successful values displayed (only flips to error
 * state if the very first fetch fails).
 */
export function useAccountSummary(intervalMs = 8000): AccountSummaryState {
  const [state, setState] = useState<AccountSummaryState>(initialState);

  useEffect(() => {
    let cancelled = false;

    const fetchOnce = async () => {
      try {
        const res = await fetch("/api/ibkr/account-summary", { cache: "no-store" });
        const json = (await res.json()) as AccountSummaryResponse;
        if (cancelled) return;
        if (json.ok) {
          setState({
            loading: false,
            error: null,
            mode: json.mode,
            account: json.summary.account,
            values: json.summary.values,
            fetchedAt: json.summary.fetchedAt,
          });
        } else {
          setState((prev) => ({
            ...prev,
            loading: false,
            error: json.error,
          }));
        }
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setState((prev) => ({ ...prev, loading: false, error: message }));
      }
    };

    fetchOnce();
    const id = setInterval(fetchOnce, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return state;
}
