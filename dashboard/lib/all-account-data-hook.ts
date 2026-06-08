"use client";

import { useEffect, useState } from "react";
import type { PositionsResponse } from "@/app/api/ibkr/positions/route";
import type { OrdersResponse } from "@/app/api/ibkr/orders/route";
import type { PositionRow, OrderRow } from "@/lib/ibkr-account";

const POLL_MS = 8000;

export type AllAccountData = {
  positions: PositionRow[];
  orders: OrderRow[];
  loading: boolean;
  error: string | null;
};

const initial: AllAccountData = { positions: [], orders: [], loading: true, error: null };

/**
 * Single shared poll for positions + orders, used by Dashboard to feed
 * filtered slices into each TickerCard. Polling at the page level (one
 * fetch pair every 8s) avoids N pollers running on N ticker cards.
 *
 * Last-good-data-on-error: if a poll fails, the previous successful data
 * stays rendered. Only the loading flag and error change.
 */
export function useAllAccountData(intervalMs = POLL_MS): AllAccountData {
  const [data, setData] = useState<AllAccountData>(initial);

  useEffect(() => {
    let cancelled = false;

    const fetchOnce = async () => {
      try {
        const [posRes, ordRes] = await Promise.all([
          fetch("/api/ibkr/positions", { cache: "no-store" }),
          fetch("/api/ibkr/orders", { cache: "no-store" }),
        ]);
        const posJson = (await posRes.json()) as PositionsResponse;
        const ordJson = (await ordRes.json()) as OrdersResponse;
        if (cancelled) return;

        if (posJson.ok && ordJson.ok) {
          // Dedupe by conId+symbol+right+strike+expiry. IBKR's reqPositions
          // can occasionally re-emit the same position via stale event
          // listeners on the singleton TCP connection (hot-reload churn,
          // interrupted prior calls). Belt-and-suspenders: even if
          // duplicates leak from getPositions(), don't propagate to the UI.
          const seen = new Set<string>();
          const dedupedPositions = posJson.positions.filter((p) => {
            const k = `${p.conId ?? p.symbol}-${p.right ?? ""}-${p.strike ?? ""}-${p.expiry ?? ""}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
          setData({
            positions: dedupedPositions,
            orders: ordJson.orders,
            loading: false,
            error: null,
          });
        } else {
          // At least one failed — keep last-good arrays, surface the first error.
          const errMsg = (!posJson.ok && posJson.error) || (!ordJson.ok && ordJson.error) || "unknown error";
          setData((prev) => ({ ...prev, loading: false, error: errMsg }));
        }
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setData((prev) => ({ ...prev, loading: false, error: message }));
      }
    };

    fetchOnce();
    const id = setInterval(fetchOnce, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return data;
}
