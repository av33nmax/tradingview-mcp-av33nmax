"use client";

import { cn } from "@/lib/utils";

export type TrailingInfo = {
  enabled: boolean;
  trailAmount: number;
  set_at: string | null;
  set_by: string | null;
  isDefault: boolean;
  currency: string;
  multiplier: number;
  defaultTrailAmount: number;
};

// A FIXED STOP is the only exit as of 2026-06-04 — the HK watcher places a single
// STP SELL 15% below the option fill (market exit on the live bid; does NOT move).
// No trailing, no OCA bracket. Static "always on" indicator: the 15% rule is not
// per-instrument editable (env WATCHER_HK_STOP_PCT overrides globally). The old
// editable trail-width is retired; trailAmount survives only as the watcher's
// no-mid fallback. Component + file name kept to avoid churn at the call sites.
const HK_STOP_PCT = 0.15;

export function TrailingToggle({
  instrumentKey,
  trailing,
}: {
  instrumentKey: string;
  trailing: TrailingInfo;
}) {
  return (
    <div
      title={`${instrumentKey}: fixed stop ALWAYS ON — STP SELL ${(HK_STOP_PCT * 100).toFixed(0)}% below the option fill (${trailing.currency}; market exit, does not move; the only exit). Manage upside manually. Trailing + OCA bracket retired 2026-06-04.`}
      className={cn(
        "inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full ring-1 ring-inset",
        "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30"
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
      {`Fixed stop · ${(HK_STOP_PCT * 100).toFixed(0)}%`}
    </div>
  );
}
