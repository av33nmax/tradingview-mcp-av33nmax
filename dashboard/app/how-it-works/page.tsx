import { AppHeader } from "@/components/app-header";
import { PipelineDiagram } from "@/components/pipeline-diagram";
import { AvalgoWordmark } from "@/components/avalgo-wordmark";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Activity,
  ChartNoAxesCombined,
  CircleCheck,
  ClipboardCheck,
  Clock,
  Cpu,
  Eye,
  LineChart,
  ListChecks,
  Notebook,
  Server,
  Shield,
  ShieldCheck,
  Target,
  Terminal,
  TriangleAlert,
  Workflow,
  Zap,
} from "lucide-react";

function SectionHeading({ icon, children, sub }: { icon: React.ReactNode; children: React.ReactNode; sub?: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-white/[0.05] text-[#e4e4e7]">
        {icon}
      </div>
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-[#e4e4e7]">{children}</h2>
        {sub && <p className="mt-0.5 text-[15px] text-[#a1a1aa]">{sub}</p>}
      </div>
    </div>
  );
}

function ComponentCard({
  icon,
  name,
  file,
  description,
}: {
  icon: React.ReactNode;
  name: string;
  file: string;
  description: React.ReactNode;
}) {
  return (
    <Card className="border-white/[0.06] bg-[#131316] shadow-[0_1px_2px_rgba(0,0,0,0.3)]">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <div className="text-emerald-400">{icon}</div>
          <div className="flex flex-col">
            <div className="font-semibold tracking-tight">{name}</div>
            <code className="font-mono text-[13px] text-[#a1a1aa]">{file}</code>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 text-[15px] text-[#e4e4e7] leading-relaxed">
        {description}
      </CardContent>
    </Card>
  );
}

function TimelineStep({
  time,
  title,
  body,
  command,
}: {
  time: string;
  title: string;
  body: React.ReactNode;
  command?: string;
}) {
  return (
    <div className="relative pl-8">
      <div className="absolute left-0 top-1 h-3 w-3 rounded-full bg-emerald-500 ring-4 ring-emerald-500/15" />
      <div className="absolute left-[5px] top-4 h-[calc(100%-1rem)] w-px bg-white/[0.08]" />
      <div className="flex flex-col gap-1 pb-6">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-[13px] font-semibold text-emerald-400">{time}</span>
          <span className="font-medium text-foreground">{title}</span>
        </div>
        <p className="text-[15px] text-[#a1a1aa] leading-relaxed">{body}</p>
        {command && (
          <code className="mt-1 inline-block rounded-md border border-white/[0.06] bg-[#09090b] px-2.5 py-1 font-mono text-[13px] text-[#e4e4e7] w-fit">
            {command}
          </code>
        )}
      </div>
    </div>
  );
}

function RuleRow({ rule, prevents }: { rule: string; prevents: string }) {
  return (
    <tr className="border-b border-white/[0.06] bg-[#131316] shadow-[0_1px_2px_rgba(0,0,0,0.3)] last:border-0">
      <td className="py-3.5 pr-4 align-top text-[15px] text-[#e4e4e7] font-medium">{rule}</td>
      <td className="py-3.5 text-[15px] text-[#a1a1aa]">{prevents}</td>
    </tr>
  );
}

function RoadmapItem({ done, label }: { done: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {done ? (
        <CircleCheck className="h-4 w-4 text-emerald-400" />
      ) : (
        <Clock className="h-4 w-4 text-[#71717a]" />
      )}
      <span className={done ? "text-foreground" : "text-[#a1a1aa]"}>{label}</span>
    </div>
  );
}

export default function HowItWorks() {
  return (
    <div className="min-h-screen bg-[#09090b]">
      <AppHeader />

      <main className="mx-auto max-w-4xl px-4 py-8 space-y-10 md:px-6 md:py-16 md:space-y-16">
        {/* Hero */}
        <section className="space-y-4 text-center md:text-left">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-[#131316] px-3 py-1.5 text-[13px] text-[#a1a1aa]">
            <Activity className="h-3 w-3 text-emerald-400" /> Path A · systematic trader
          </div>
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight text-[#e4e4e7] leading-[1.05]">
            How <AvalgoWordmark />
            <br />
            Cro<span className="text-emerald-400">$$</span>hair works.
          </h1>
          <p className="text-lg md:text-xl text-[#a1a1aa] leading-relaxed max-w-2xl mx-auto md:mx-0">
            0DTE retail options traders lose money not because they can&apos;t read charts, but
            because execution discipline breaks under pressure. This system makes the discipline
            mechanical — so you don&apos;t have to be heroic in the moment.
          </p>
        </section>

        {/* Architecture diagram */}
        <section className="space-y-4">
          <SectionHeading
            icon={<Workflow className="h-5 w-5" />}
            sub="How the pieces connect"
          >
            The pipeline
          </SectionHeading>

          <PipelineDiagram />
        </section>

        {/* Components */}
        <section className="space-y-4">
          <SectionHeading
            icon={<Cpu className="h-5 w-5" />}
            sub="What each module does"
          >
            Components
          </SectionHeading>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <ComponentCard
              icon={<ChartNoAxesCombined className="h-4 w-4" />}
              name="Multi-TF analysis engine"
              file="multi_timeframe_analysis.js"
              description={
                <>
                  Pre-market analyzer. Pulls ES, NQ, SPY, QQQ across 15m / 1H / 4H timeframes via
                  TradingView. Scores: EMAs, VWAP, MACD, ORB, Fib levels, relative volume,
                  supply/demand zones, FVGs. Outputs <span className="text-emerald-400">BULL / BEAR / NEUTRAL</span> with confidence %.
                  Builds entry triggers, stops, and targets.
                </>
              }
            />
            <ComponentCard
              icon={<Target className="h-4 w-4" />}
              name="Pre-market orchestrator"
              file="premarket_setup.mjs"
              description={
                <>
                  The one-command morning routine. Runs the analysis, cleans up yesterday&apos;s
                  drawings, draws fresh deep S/R + FVG zones, annotates Trigger A (orange) and
                  Trigger B (purple) lines, and writes{" "}
                  <code className="font-mono text-xs rounded bg-white/[0.05] px-1">latest_entry_notes.json</code>.
                </>
              }
            />
            <ComponentCard
              icon={<Eye className="h-4 w-4" />}
              name="Watcher"
              file="trade_window.mjs"
              description={
                <>
                  Intraday systematic loop. Time-bounded 9:45 PM → 11:00 PM SGT. Every 15-min
                  candle close: pulls the just-completed bar, checks close + rVol. On valid
                  trigger: macOS notification → order prompt → TWS staging.
                </>
              }
            />
            <ComponentCard
              icon={<Terminal className="h-4 w-4" />}
              name="Manual order placer"
              file="place_option_order.mjs"
              description={
                <>
                  On-demand order staging for when you see a setup live. Same strike/qty logic
                  as the watcher, same YES gate, same TWS transmit click. Used when you want
                  to commit to a trade outside the automated window.
                </>
              }
            />
            <ComponentCard
              icon={<Server className="h-4 w-4" />}
              name="Shared IBKR library"
              file="ibkr_orders.mjs"
              description={
                <>
                  Wraps <code className="font-mono text-xs rounded bg-white/[0.05] px-1">@stoqey/ib</code>{" "}
                  calls — contract resolution, option chain params, strike picker (premium $0.50-$0.90, nearest-ATM),
                  order placement. One source of truth for anything that talks to IBKR.
                </>
              }
            />
            <ComponentCard
              icon={<Shield className="h-4 w-4" />}
              name="One-trade-per-day guard"
              file="one_trade_per_day.mjs"
              description={
                <>
                  Persistent flag file keyed to the ET trading day. Once you&apos;ve placed a trade
                  on a ticker, further attempts are blocked with a clear message. Auto-resets at
                  ET midnight. Manual override requires{" "}
                  <code className="font-mono text-xs rounded bg-white/[0.05] px-1">rm traded_today.json</code>.
                </>
              }
            />
          </div>
        </section>

        {/* Daily routine */}
        <section className="space-y-4">
          <SectionHeading
            icon={<Clock className="h-5 w-5" />}
            sub="A trading day, in order"
          >
            Daily workflow
          </SectionHeading>

          <Card className="border-white/[0.06] bg-[#131316] shadow-[0_1px_2px_rgba(0,0,0,0.3)]">
            <CardContent className="py-6">
              <TimelineStep
                time="8:30 PM SGT"
                title="Pre-flight"
                body="Launch TradingView with CDP. Verify TWS is running on the other laptop. Sanity check the IBKR connection."
                command="node test_ibkr_connect.mjs"
              />
              <TimelineStep
                time="8:45 PM SGT"
                title="Pre-market chart prep (provisional)"
                body="Runs analysis against overnight ES/NQ + Friday SPY/QQQ data. Refreshes daily-chart drawings: S/R levels, FVG zones, key swing pivots. The entry_notes generated here are PROVISIONAL — based on stale Friday/overnight ORB. They will be regenerated at 9:46 PM SGT once the real Monday ORB exists. Don't act on these levels yet."
                command="node premarket_setup.mjs"
              />
              <TimelineStep
                time="9:00 PM SGT"
                title="Review chart context"
                body="Look at the chart annotations and overnight futures action. Get a feel for the day's bias. The dashboard's entry_notes are still provisional at this point — don't trade off them."
              />
              <TimelineStep
                time="9:30 PM SGT"
                title="Market opens — do nothing"
                body="No trades during the first 15 min. Watch the opening range form."
              />
              <TimelineStep
                time="9:46 PM SGT"
                title="Re-run premarket_setup — this is the run that matters"
                body="The first Monday 15m bar just closed → real ORB now exists. This re-run locks in today's actual Trigger A entry / stop / T1 / T2 from real Monday data. The structure check (ORB high vs 1H EMA21) now uses live values. Re-running again later won't change Trigger A — once ORB completes, it's fixed for the day."
                command="node premarket_setup.mjs"
              />
              <TimelineStep
                time="9:47 PM SGT"
                title="Verify dashboard + arm watcher"
                body="Hard-refresh the dashboard. If structure check passes → 'Arm watcher' is enabled, click it (default --until 02:00 SGT covers the full 9:45–14:00 ET entry window). If it shows 'no setup' (structure check disqualified) → no trade tonight, don't override. The watcher then runs its own 15m loop emitting CHECK markers — don't re-run premarket_setup periodically; it adds nothing."
                command="node trade_window.mjs SPY"
              />
              <TimelineStep
                time="On trigger fire"
                title="Notification + portal YES gate"
                body="Script emits a __PROMPT_YES__ marker with the order spec, the portal modal appears, and a macOS notification fires. Click YES on the portal — the order auto-transmits to the market immediately (STAGED_MODE = false). There is NO second TWS-side click."
              />
              <TimelineStep
                time="After fill"
                title="Auto-armed OCA bracket"
                body="Script auto-arms an OCA bracket on the underlying price: T1 limit + stop, both full size — whichever fills first cancels the other. Binary outcome (no partial sell, no breakeven trail). TIME_STOP_ET_HOUR (14:00 ET) only blocks NEW entries — it does NOT close existing positions."
              />
              <TimelineStep
                time="03:30 SGT (15:30 ET)"
                title="Manual flatten alarm"
                body="Set a phone alarm. If neither T1 nor stop has hit by this time, manually close the position via TWS (or the dashboard once the position panel ships). 0DTE expires worthless / auto-exercises into 100 shares per contract after 16:00 ET if you don't."
              />
              <TimelineStep
                time="10:00 AM SGT next day"
                title="Review"
                body="Pull trade history, compare fills to plan, journal the outcome. Grade: did you follow your system?"
              />
            </CardContent>
          </Card>
        </section>

        {/* Discipline */}
        <section className="space-y-4">
          <SectionHeading
            icon={<ShieldCheck className="h-5 w-5" />}
            sub="Why these rules exist — each one has a scar"
          >
            Discipline system
          </SectionHeading>

          <Card className="border-white/[0.06] bg-[#131316] shadow-[0_1px_2px_rgba(0,0,0,0.3)]">
            <CardContent className="py-2">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className="py-3 pr-4 text-left text-[12px] font-semibold uppercase tracking-wider text-[#a1a1aa]">Rule</th>
                    <th className="py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-[#a1a1aa]">Prevents</th>
                  </tr>
                </thead>
                <tbody>
                  <RuleRow rule="One trade per ticker per day" prevents="Revenge trading after a loss" />
                  <RuleRow rule="Max $300 risk per trade" prevents="Size blowup on a single bad fill" />
                  <RuleRow rule="Entry 9:45–14:00 ET only" prevents="Opening volatility + afternoon chop losses" />
                  <RuleRow rule="15m close + rVol ≥ 1.2×" prevents="Tick-touch entries on fake breakouts" />
                  <RuleRow rule="Premium between $0.50–$0.90" prevents="Too-cheap lotto tickets or too-rich ATM" />
                  <RuleRow rule="Hard close 15:30 ET" prevents="0DTE expiring worthless overnight" />
                  <RuleRow rule="Stale entry_notes refused (>4h)" prevents="Trading on bias that already flipped" />
                  <RuleRow rule="YES prompt + TWS Transmit click" prevents="Accidental order fires" />
                </tbody>
              </table>
            </CardContent>
          </Card>
        </section>

        {/* Tech stack */}
        <section className="space-y-4">
          <SectionHeading
            icon={<LineChart className="h-5 w-5" />}
            sub="What's under the hood"
          >
            Tech stack
          </SectionHeading>

          <Card className="border-white/[0.06] bg-[#131316] shadow-[0_1px_2px_rgba(0,0,0,0.3)]">
            <CardContent className="py-5">
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-[#a1a1aa]">Backend / scripts</dt>
                  <dd className="text-right font-mono text-[13px] text-[#e4e4e7]">Node.js 20+</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-[#a1a1aa]">IBKR API</dt>
                  <dd className="text-right font-mono text-[13px] text-[#e4e4e7]">@stoqey/ib</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-[#a1a1aa]">TradingView automation</dt>
                  <dd className="text-right font-mono text-[13px] text-[#e4e4e7]">Chrome DevTools Protocol</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-[#a1a1aa]">Broker hosting</dt>
                  <dd className="text-right font-mono text-[13px] text-[#e4e4e7]">TWS paper/live on LAN</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-[#a1a1aa]">Dashboard</dt>
                  <dd className="text-right font-mono text-[13px] text-[#e4e4e7]">Next.js 16 · React 19</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-[#a1a1aa]">Styling</dt>
                  <dd className="text-right font-mono text-[13px] text-[#e4e4e7]">Tailwind + shadcn/ui</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-[#a1a1aa]">Notifications</dt>
                  <dd className="text-right font-mono text-[13px] text-[#e4e4e7]">macOS osascript</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-[#a1a1aa]">First-time setup</dt>
                  <dd className="text-right font-mono text-[13px] text-[#e4e4e7]">Paper account</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </section>

        {/* Roadmap */}
        <section className="space-y-4">
          <SectionHeading
            icon={<ListChecks className="h-5 w-5" />}
            sub="What's built vs what's next"
          >
            Roadmap
          </SectionHeading>

          <Card className="border-white/[0.06] bg-[#131316] shadow-[0_1px_2px_rgba(0,0,0,0.3)]">
            <CardContent className="py-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-y-2 gap-x-6">
                <RoadmapItem done label="Pre-market analysis + chart annotations" />
                <RoadmapItem done label="Manual order placement + safety gates" />
                <RoadmapItem done label="Automated candle-close validator" />
                <RoadmapItem done label="One-trade-per-day persistent guard" />
                <RoadmapItem done label="Read-only dashboard" />
                <RoadmapItem done label="Live watcher control (start/stop + YES confirm modal)" />
                <RoadmapItem done label="OCA bracket orders (T1 limit + stop, auto-armed on fill)" />
                <RoadmapItem done label="Discord alerts on trigger fire + fill" />
                <RoadmapItem done label="Structure-check disqualification (ORB vs 1H EMA21)" />
                <RoadmapItem done label="Per-check live tape (scrolling feed of every 15m validation)" />
                <RoadmapItem done label="Phase 1 — Structure-check loosening (K=0.25 ATR, calibrated via backtest)" />
                <RoadmapItem done label="Phase 2 — Trigger B validator + multi-trade-per-day (cap=2, $100 risk)" />
                <RoadmapItem done label="Phase 3 — Add IWM (Russell 2000 ETF + RTY futures pair)" />
                <RoadmapItem done label="Phase 4a — Read-only /account tab (Positions / Orders / Trade History / Balances / Summary) + sticky account header" />
                <RoadmapItem done label="Phase 4b — Inline position section in ticker card after fill" />
                <RoadmapItem done={false} label="Phase 4c — Manual control buttons (Flatten / Move stop to BE / Take partial)" />
                <RoadmapItem done={false} label="Auto-close at 15:30 ET (prevent 0DTE expiry / auto-exercise)" />
                <RoadmapItem done={false} label="Post-trade auto-journal with Claude" />
                <RoadmapItem done={false} label="60-day backtest re-validation of structure-check K value" />
                <RoadmapItem done={false} label="Mobile push notifications (iOS/Android, beyond Discord)" />
                <RoadmapItem done={false} label="TradingView webhook integration" />
                <RoadmapItem done={false} label="Multi-broker support" />
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Philosophy */}
        <section className="space-y-4">
          <SectionHeading
            icon={<Notebook className="h-5 w-5" />}
            sub="Why this exists"
          >
            Design philosophy
          </SectionHeading>

          <Card className="border-white/[0.06] bg-[#131316] shadow-[0_1px_2px_rgba(0,0,0,0.3)]">
            <CardContent className="py-6 space-y-4 text-[15px] leading-relaxed text-[#e4e4e7]">
              <p>
                <span className="font-medium text-emerald-400">Process over outcome.</span>{" "}
                A well-executed loss is a better trade than a rule-breaking win. The rule-breaking win
                teaches you that rules are optional, which compounds until it blows up the account.
                This tool enforces process first, outcome second.
              </p>
              <Separator className="bg-white/[0.06]" />
              <p>
                <span className="font-medium text-emerald-400">Friction where friction helps.</span>{" "}
                The YES prompt, the TWS Transmit click, the one-trade-per-day flag — each is a
                deliberate bump in the road. In the moment they feel annoying. In aggregate they are
                what separates a trader from a gambler.
              </p>
              <Separator className="bg-white/[0.06]" />
              <p>
                <span className="font-medium text-emerald-400">Paper first, always.</span>{" "}
                Every script ships and ages on paper before ever touching live money. Real-money
                trading is tested, not speculative.
              </p>
              <Separator className="bg-white/[0.06]" />
              <p>
                <span className="font-medium text-emerald-400">Human in the loop.</span>{" "}
                No fully autonomous order submission. The script watches; the human decides. The
                script enforces the rules the human wrote. The combination is disciplined and honest.
              </p>
            </CardContent>
          </Card>
        </section>

        {/* Footer */}
        <section className="pt-4 text-[13px] text-[#a1a1aa]">
          <div className="flex items-center gap-2">
            <TriangleAlert className="h-3.5 w-3.5 text-amber-500" />
            <p>
              Educational tool. Not investment advice. Trading options involves substantial risk of loss,
              especially 0DTE. Paper-test first.
            </p>
          </div>
          <p className="mt-2">
            Built with <ClipboardCheck className="inline h-3 w-3 text-emerald-400" /> discipline and{" "}
            <Zap className="inline h-3 w-3 text-amber-400" /> a lot of screen time.
          </p>
        </section>
      </main>
    </div>
  );
}
