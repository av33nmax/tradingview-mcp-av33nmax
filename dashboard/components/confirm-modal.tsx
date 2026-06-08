"use client";

import { useEffect, useState } from "react";
import { useWatcherRunner, type PendingPrompt } from "@/lib/watcher-runner";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { AlertTriangle, X } from "lucide-react";

function Spec({
  label,
  value,
  mono = true,
  tone,
}: {
  label: string;
  value: string | number | null | undefined;
  mono?: boolean;
  tone?: "neutral" | "stop" | "target" | "entry";
}) {
  const toneClass =
    tone === "stop"   ? "text-rose-400" :
    tone === "target" ? "text-emerald-400" :
    tone === "entry"  ? "text-sky-400" :
                        "text-[#e4e4e7]";
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-[13px] uppercase tracking-wide text-[#a1a1aa]">{label}</span>
      <span className={cn(mono ? "font-mono tabular-nums" : "", "text-[15px] font-semibold", toneClass)}>
        {value ?? "—"}
      </span>
    </div>
  );
}

export function ConfirmModal() {
  const { watchers, confirm } = useWatcherRunner();
  const [busy, setBusy] = useState<"yes" | "no" | null>(null);
  const [isMac, setIsMac] = useState(true);

  // Find the first ticker with a pendingPrompt (only one can fire at a time
  // since handleTriggered awaits the prompt before returning)
  const pendingEntry = Object.values(watchers).find((w) => !!w.pendingPrompt);
  const pending: PendingPrompt | null = pendingEntry?.pendingPrompt ?? null;
  const isSimulated = !!pendingEntry?.isSimulated;
  const open = !!pending;

  // Detect platform once for shortcut hint rendering (⌘ on Mac, Ctrl elsewhere)
  useEffect(() => {
    if (typeof navigator !== "undefined") {
      setIsMac(/Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || ""));
    }
  }, []);

  const handleConfirm = async () => {
    if (!pending || busy !== null) return;
    setBusy("yes");
    try { await confirm(pending.ticker, "YES"); }
    finally { setBusy(null); }
  };

  const handleAbort = async () => {
    if (!pending) return;
    setBusy("no");
    try { await confirm(pending.ticker, "no"); }
    finally { setBusy(null); }
  };

  // Global keyboard shortcut: Cmd/Ctrl+Enter fires, Escape aborts.
  // Active only while the modal is open. Two-key chord is the safety guard
  // (single Enter could be triggered by stray keypress; chord requires intent).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (busy !== null) return;
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleConfirm();
      } else if (e.key === "Escape") {
        e.preventDefault();
        handleAbort();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, busy, pending?.createdAt]);

  return (
    <AnimatePresence>
      {open && pending && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={(e) => { if (e.target === e.currentTarget) handleAbort(); }}
        >
          <motion.div
            initial={{ scale: 0.95, y: 10 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 10 }}
            transition={{ type: "spring", damping: 25, stiffness: 260 }}
            className="relative w-full max-w-md rounded-2xl border border-white/[0.08] bg-[#131316] shadow-[0_0_0_1px_rgba(200,169,120,0.3),0_12px_60px_rgba(0,0,0,0.6)]"
          >
            {/* Simulation banner */}
            {isSimulated && (
              <div className="border-b border-sky-500/20 bg-sky-500/10 px-5 py-2 text-[13px] text-sky-300 font-medium text-center">
                🧪 DRY RUN — no real order will be placed
              </div>
            )}

            {/* Header */}
            <div className="border-b border-white/[0.06] px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#c8a978]/15 ring-1 ring-inset ring-[#c8a978]/30 text-[#c8a978]">
                  <AlertTriangle className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold text-[#e4e4e7]">
                      🎯 {pending.ticker} fired{isSimulated ? " (sim)" : ""}
                    </span>
                    {pending.triggerType === "A" && (
                      <span className="rounded px-2 py-0.5 text-[11px] font-bold tracking-wider text-orange-300 bg-orange-500/10 ring-1 ring-orange-500/30">
                        TRIGGER A · ORB BREAKOUT
                      </span>
                    )}
                    {pending.triggerType === "A_SNIPER" && (
                      <span className="rounded px-2 py-0.5 text-[11px] font-bold tracking-wider text-emerald-300 bg-emerald-500/10 ring-1 ring-emerald-500/30">
                        🎯 SNIPER · 5M MID-WINDOW
                      </span>
                    )}
                    {pending.triggerType === "B" && (
                      <span className="rounded px-2 py-0.5 text-[11px] font-bold tracking-wider text-purple-300 bg-purple-500/10 ring-1 ring-purple-500/30">
                        TRIGGER B{pending.subType ? ` · ${pending.subType} RECLAIM` : ""}
                      </span>
                    )}
                  </div>
                  <div className="text-[13px] text-[#a1a1aa] mt-1">
                    {pending.direction} · 0DTE · review + confirm
                  </div>
                </div>
                <button
                  onClick={handleAbort}
                  disabled={busy !== null}
                  className="ml-auto h-8 w-8 flex items-center justify-center rounded-md text-[#a1a1aa] hover:bg-white/[0.05] hover:text-[#e4e4e7] transition-colors"
                  title="Abort (no order placed)"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Order spec */}
            <div className="px-5 py-4 space-y-1">
              <Spec label="Contract" value={`${pending.ticker} ${pending.strike} ${pending.direction === "CALLS" ? "CALL" : "PUT"} · ${pending.expiry}`} mono={false} />
              <Spec label="Quantity" value={`${pending.qty} contract${pending.qty === 1 ? "" : "s"}`} mono={false} />
              <Spec
                label="Premium (fresh)"
                value={
                  pending.premiumCached != null && Math.abs(pending.premiumEst - pending.premiumCached) > 0.005
                    ? `$${pending.premiumEst.toFixed(2)}  (cached $${pending.premiumCached.toFixed(2)}, ${pending.premiumEst > pending.premiumCached ? "+" : ""}${(((pending.premiumEst - pending.premiumCached) / pending.premiumCached) * 100).toFixed(0)}%)`
                    : `$${pending.premiumEst.toFixed(2)}${pending.premiumStale ? "  (cached — fresh query failed)" : ""}`
                }
                tone="entry"
              />
              <Spec label="Risk if expires worthless" value={`$${(pending.riskUsd ?? pending.qty * pending.premiumEst * 100).toFixed(2)}`} />

              <div className="my-3 border-t border-white/[0.06]" />

              <Spec label={`Fires when ${pending.ticker}`}  value={`${pending.direction === "CALLS" ? ">" : "<"} ${pending.underlyingEntry.toFixed(2)}`} />
              <Spec
                label="Stop"
                value={
                  pending.atrMultiple != null
                    ? `${pending.stop.toFixed(2)}  (${(pending.stopDistance ?? Math.abs(pending.underlyingEntry - pending.stop)).toFixed(2)} away · ${pending.atrMultiple.toFixed(2)}× ATR)`
                    : `${pending.stop.toFixed(2)}  (${(pending.stopDistance ?? Math.abs(pending.underlyingEntry - pending.stop)).toFixed(2)} away)`
                }
                tone="stop"
              />
              <Spec label="T1" value={pending.T1.toFixed(2)} tone="target" />
              {pending.T2 != null && <Spec label="T2" value={pending.T2.toFixed(2)} tone="target" />}
              {pending.atr15 != null && (
                <Spec label="ATR15" value={pending.atr15.toFixed(2)} />
              )}

              {pending.bracket && (
                <>
                  <div className="my-3 border-t border-white/[0.06]" />
                  <div className="text-[13px] text-[#a1a1aa] space-y-1">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-1.5 rounded-full bg-[#c8a978]" />
                      <span>OCA bracket will auto-arm after fill</span>
                    </div>
                    <div className="pl-3.5 text-[12px] text-[#71717a]">
                      T1 @ {pending.bracket.t1.toFixed(2)} · Stop @ {pending.bracket.stop.toFixed(2)}
                      <br />One fires → other auto-cancels
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Buttons */}
            <div className="flex gap-2 border-t border-white/[0.06] p-4">
              <button
                onClick={handleAbort}
                disabled={busy !== null}
                className="flex-1 rounded-full border border-white/[0.08] bg-white/[0.02] px-4 py-2.5 text-sm font-medium text-[#e4e4e7] hover:bg-white/[0.05] transition-colors disabled:opacity-40"
              >
                {busy === "no" ? "Aborting..." : `Abort  (Esc)`}
              </button>
              <button
                onClick={handleConfirm}
                disabled={busy !== null}
                autoFocus
                className={cn(
                  "flex-1 rounded-full px-4 py-2.5 text-sm font-semibold transition-colors",
                  busy === null
                    ? "bg-[#c8a978] text-[#09090b] hover:bg-[#d4b588] shadow-[0_0_0_1px_rgba(200,169,120,0.35),0_4px_12px_rgba(200,169,120,0.2)]"
                    : "bg-white/[0.05] text-[#71717a] cursor-not-allowed",
                )}
              >
                {busy === "yes" ? "Firing..." : `Confirm & fire  (${isMac ? "⌘" : "Ctrl"}+Enter)`}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
