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
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<"yes" | "no" | null>(null);

  // Find the first ticker with a pendingPrompt (only one can fire at a time
  // since handleTriggered awaits the prompt before returning)
  const pendingEntry = Object.values(watchers).find((w) => !!w.pendingPrompt);
  const pending: PendingPrompt | null = pendingEntry?.pendingPrompt ?? null;
  const open = !!pending;

  // Reset typed input whenever a new prompt appears
  useEffect(() => {
    if (open) setTyped("");
  }, [pending?.createdAt, open]);

  const handleConfirm = async () => {
    if (!pending || typed !== "YES") return;
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
            {/* Header */}
            <div className="border-b border-white/[0.06] px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#c8a978]/15 ring-1 ring-inset ring-[#c8a978]/30 text-[#c8a978]">
                  <AlertTriangle className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-base font-semibold text-[#e4e4e7]">
                    🎯 {pending.ticker} trigger fired
                  </div>
                  <div className="text-[13px] text-[#a1a1aa] mt-0.5">
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
              <Spec label="Est premium" value={`$${pending.premiumEst.toFixed(2)}`} tone="entry" />
              <Spec label="Est risk" value={`$${(pending.qty * pending.premiumEst * 100).toFixed(2)}`} />

              <div className="my-3 border-t border-white/[0.06]" />

              <Spec label={`Fires when ${pending.ticker}`}  value={`${pending.direction === "CALLS" ? ">" : "<"} ${pending.underlyingEntry.toFixed(2)}`} />
              <Spec label="Stop" value={pending.stop.toFixed(2)} tone="stop" />
              <Spec label="T1" value={pending.T1.toFixed(2)} tone="target" />
              {pending.T2 != null && <Spec label="T2" value={pending.T2.toFixed(2)} tone="target" />}

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

            {/* YES input */}
            <div className="px-5 pb-4">
              <div className="rounded-xl border border-[#c8a978]/30 bg-[#c8a978]/[0.04] p-3">
                <div className="text-[13px] text-[#c8a978] mb-2 font-medium">
                  Type exactly YES to fire this order now.
                </div>
                <input
                  type="text"
                  autoFocus
                  placeholder="Type YES"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && typed === "YES") handleConfirm();
                    if (e.key === "Escape") handleAbort();
                  }}
                  disabled={busy !== null}
                  className="w-full rounded-md border border-white/[0.08] bg-[#09090b] px-3 py-2 font-mono text-sm text-[#e4e4e7] placeholder-[#71717a] outline-none focus:border-[#c8a978]/50 focus:ring-1 focus:ring-[#c8a978]/30"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                />
              </div>
            </div>

            {/* Buttons */}
            <div className="flex gap-2 border-t border-white/[0.06] p-4">
              <button
                onClick={handleAbort}
                disabled={busy !== null}
                className="flex-1 rounded-full border border-white/[0.08] bg-white/[0.02] px-4 py-2.5 text-sm font-medium text-[#e4e4e7] hover:bg-white/[0.05] transition-colors disabled:opacity-40"
              >
                {busy === "no" ? "Aborting..." : "Abort"}
              </button>
              <button
                onClick={handleConfirm}
                disabled={typed !== "YES" || busy !== null}
                className={cn(
                  "flex-1 rounded-full px-4 py-2.5 text-sm font-semibold transition-colors",
                  typed === "YES" && busy === null
                    ? "bg-[#c8a978] text-[#09090b] hover:bg-[#d4b588] shadow-[0_0_0_1px_rgba(200,169,120,0.35),0_4px_12px_rgba(200,169,120,0.2)]"
                    : "bg-white/[0.05] text-[#71717a] cursor-not-allowed",
                )}
              >
                {busy === "yes" ? "Firing..." : "Confirm & fire"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
