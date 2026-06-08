import { CheckCircle2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

const RULES = [
  "One trade per ticker per day",
  "Max $300 risk per trade",
  "Entry 9:45-14:00 ET only",
  "15m close + rVol ≥ 1.2 required",
  "Hard close 15:30 ET",
];

export function RulesBanner() {
  return (
    <Card className="rounded-2xl border border-white/[0.06] bg-[#131316] shadow-[0_1px_2px_rgba(0,0,0,0.3)]">
      <CardContent className="py-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <span className="text-[13px] font-semibold uppercase tracking-wider text-[#71717a]">
            Rules active
          </span>
          {RULES.map((r) => (
            <div key={r} className="flex items-center gap-2 text-sm text-[#e4e4e7]">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span>{r}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
