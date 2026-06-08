"use client";

import { useEffect, useState, useCallback, useRef } from "react";

/**
 * Poll an API endpoint at a fixed interval. Re-fetches immediately when the
 * window regains focus, so coming back from another tab gets you fresh data.
 */
export function usePollingState<T>(url: string, intervalMs = 30000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const aliveRef = useRef(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as T;
      if (aliveRef.current) {
        setData(json);
        setError(null);
        setLastFetched(new Date());
      }
    } catch (e) {
      if (aliveRef.current) setError((e as Error).message);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    aliveRef.current = true;
    fetchData();
    const id = setInterval(fetchData, intervalMs);
    const onFocus = () => fetchData();
    window.addEventListener("focus", onFocus);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchData, intervalMs]);

  return { data, error, loading, lastFetched, refetch: fetchData };
}
