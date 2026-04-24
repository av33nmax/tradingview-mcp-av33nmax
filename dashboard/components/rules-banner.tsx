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
    <Card className="border-zinc-800/60 bg-zinc-900/30">
      <CardContent className="py-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
            Rules active
          </span>
          {RULES.map((r) => (
            <div key={r} className="flex items-center gap-1.5 text-xs text-zinc-300">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              <span>{r}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
