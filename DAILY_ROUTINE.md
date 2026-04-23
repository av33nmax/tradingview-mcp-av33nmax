# Daily Routine — 0DTE Options Trading (SGT → US RTH)

Practical playbook for trading SPY + QQQ 0DTE options from Singapore using
the TradingView + IBKR pipeline in this repo.

**Timezones used throughout:** SGT = UTC+8, ET = UTC−4 (EDT). US RTH in SGT
is **9:30 PM – 4:00 AM** (next morning).

---

## Quick reference — commands in order

```bash
cd /Users/aveenbabu/tradingview-mcp-jackson

# 8:30 PM SGT — pre-flight: verify IBKR connection works
node test_ibkr_connect.mjs

# 8:45 PM SGT — pre-market brief + chart drawings (SPY + QQQ)
bash scripts/launch_tv_debug_mac.sh     # only if TV not already running with CDP
node premarket_setup.mjs

# 9:00 PM SGT — stage orders (ONLY if bias is aligned, see decision gate)
node place_option_order.mjs SPY A
node place_option_order.mjs QQQ A
# type YES when prompted, then click Transmit in TWS on the other laptop

# 10:00 AM SGT next day — review
node test_ibkr_connect.mjs              # verify P&L
# check TWS trade history + compare fills to plan
```

---

## The routine, in order

### 🔵 8:30 PM SGT — Pre-flight (10 min)

Mechanical. Skip nothing.

1. **Other laptop check** — TWS running on the other laptop (192.168.18.35)?
   Logged into paper account (DUM981590)?
   API port 7497 accepting connections?
2. **Test connection** from the M2 Mac:
   ```bash
   node test_ibkr_connect.mjs
   ```
   Expected: account summary prints in <2 seconds.
   If hangs or errors → restart TWS on the other laptop before continuing.
3. **TradingView Desktop** — launch with CDP:
   ```bash
   bash scripts/launch_tv_debug_mac.sh
   ```
   (or reuse existing instance if responsive)

---

### 🟢 8:45 PM SGT — Pre-market setup (5 min)

```bash
node premarket_setup.mjs
```

This single command does everything from today's build:
- Runs multi-timeframe analysis (ES/NQ/SPY/QQQ × 15m/1H/4H confluence)
- Cleans up yesterday's auto-drawn zones and trigger annotations
- Draws fresh deep S/R + FVG rectangles on SPY (60 pts depth) and QQQ (70 pts depth)
- Draws Trigger A (orange) and Trigger B (purple) horizontal lines with
  entry / stop / T1 / T2 labels
- Prints the full confluence brief with entry triggers

#### 🚦 Decision gate — do we trade today?

Look at the `final` JSON near the bottom of the output:

| Condition | Action |
|---|---|
| `aligned: true` on BOTH SPY and QQQ, same bias direction | ✅ Proceed to stage orders |
| Only one ticker is aligned | ✅ Trade just that one |
| Both show `bias: NO_TRADE` (futures/ETF divergence) | ❌ **No trade today.** Close TV. Sleep. |
| Futures and ETFs disagree (e.g., ES BEAR / SPY BULL) | ❌ **No trade.** This is the risk filter working. |

**The most important rule of the day is knowing when not to trade.**

---

### 🟡 9:00 PM SGT — Stage orders in TWS (10 min, only if bias aligned)

For each tradeable ticker, stage orders for the trigger(s) you believe in:

```bash
node place_option_order.mjs SPY A      # Trigger A on SPY (ORB breakout)
node place_option_order.mjs SPY B      # Trigger B on SPY (pullback), optional
node place_option_order.mjs QQQ A      # Trigger A on QQQ
node place_option_order.mjs QQQ B      # Trigger B on QQQ, optional
```

For each:
1. Review the order spec box that prints
2. Type `YES` (uppercase, exact word)
3. On the **other laptop's TWS**, click **Transmit** on the Orders tab row

Each order stages in TWS as "Pending Transmission" until you click Transmit.
Once transmitted pre-market, status goes to `PreSubmitted` — IBKR holds the
order until market opens and fires it at the ask on open.

#### Sizing

- Each order: max **$300 risk** (premium × 100 × qty ≤ $300)
- 4 orders staged = up to **$1,200 at risk** if all fire
- Most days, **stage only 1–2 orders**, not all four. Start simple.

---

### ⏸ 9:15–9:30 PM SGT — Walk away

Orders are staged. Don't fiddle. Don't add more. Don't preemptively move
stops. Go make dinner, do dishes, whatever.

---

### 🔴 9:30 PM SGT — Market opens, ORB forms (DO NOT TRADE)

**Rule: no trade decisions for the first 15 minutes of RTH.**

Between 9:30 and 9:45:
- Watch SPY and QQQ 15m candles form
- Note whether the market gapped up, gapped down, or opened flat
- Compare actual ORB range to the pre-market estimate
- If ORB is much wider than expected → consider canceling staged orders
  (plan likely invalidated)

This is the same rule `multi_timeframe_analysis.js` enforces:
> TIMING: ORB still forming — do NOT enter before 9:45 ET.

---

### 🟠 9:45 PM SGT — Trigger window opens

This is your active trade window. Watch TWS and TradingView side by side.

#### If Trigger A fires (15m candle closes beyond entry with rVol ≥ 1.2x)

The staged order is already in TWS. It'll auto-fill at the open ask (if not
already). Confirm in TWS:
- Status: `Submitted` → `Filled`
- Position appears in Positions tab

Set exit management:
- Mental trailing stop (or manual TWS bracket)
- T1 price alert in TWS → right-click symbol → Price Alert

#### If Trigger B fires (pullback to VWAP or 1H EMA21 + bullish 5m reclaim)

Transmit the staged B order. Same exit logic.

#### Exit management (lessons from Apr 22)

Your biggest historical mistake: exiting too early before T1. Don't just sit
and wait for T1 or stop. Use these fallbacks:

| Condition | Action |
|---|---|
| Up 50% toward T1 | Move stop to breakeven |
| Up 80% toward T1 | Sell half, trail remainder |
| 2:00 AM SGT (14:00 ET) | Exit if not in profit (your rules.json) |
| 3:30 AM SGT (15:30 ET) | **HARD CLOSE regardless** (your rules.json) |

---

### 🟣 10:30 PM SGT – 2:00 AM SGT — Mid-session

The unsustainable part. Three viable approaches:

#### Option A — Stay up, watch everything
Best for learning, worst for your health. Sustainable max **1–2 nights per week**.

#### Option B — Set TWS alarms, sleep with phone nearby
- TWS → Alerts → create price alert at T1, T2, stop
- Alerts push to phone via IBKR Mobile app
- Wake up, decide, execute manually
- Trade-off: you miss scaling opportunities between alerts

#### Option C — Short trade window (RECOMMENDED while learning)
- Only enter in **9:45–11:00 PM SGT** (first 1h 15m of RTH)
- If no fill by 11:00 PM, **cancel pending orders** in TWS and sleep
- If a trade did fire, manage for ~30 min then set a firm limit sell close
  to T1 and a hard stop, then sleep
- Bed by midnight SGT

---

### ⛔ 3:30 AM SGT — HARD CLOSE

Every 0DTE position MUST be closed by market close. If you're asleep with
open positions, they can expire worthless (total loss).

**Current mitigation:** set a TWS time-based trigger to auto-close at 3:25 AM
SGT, OR set aggressive limit sells that'll fill on any pop.

**Future build:** OCO bracket orders (stop + T1 attached to entry) — would
let you sleep through close safely. Not built yet.

---

### 🌅 10:00 AM SGT next day — Review (15 min)

1. **Verify from Mac**:
   ```bash
   node test_ibkr_connect.mjs
   ```
   Account reflects yesterday's trades.
2. **TWS trade history** — pull fill times, prices, final P&L.
3. **Compare to plan**:
   - Did Trigger A fire at the predicted entry? ± how much?
   - Did T1 hit? T2? Stop?
   - What was the actual session high and low vs. the trigger levels?
4. **Journal 3 lines**:
   - What fired
   - What you did (entry, exit, scaling)
   - What you'd do differently

---

## Weekly rhythm

| Day | What happens |
|---|---|
| Mon–Fri evening SGT | Potential trade day, run the routine |
| Sat–Sun | US markets closed. Real rest. |
| Sunday evening SGT | Optional: review the week's trades, update journal |

---

## Frequency discipline — skip days are features

Not every day is a trade day. **Skip today if:**
- `bias: NO_TRADE` from pre-market output (ES/SPY diverged)
- Major economic event scheduled during US RTH (FOMC, CPI, NFP) — volatility
  can blow through stops
- You had 2 consecutive losses this week (let the emotional reset run)
- You're tired — sleep beats trading, always
- Weekend or US holiday

**Aim for 3–4 trade days per week, not 5.** Sustainability > intensity.

---

## What's next (planned future builds)

1. **OCO bracket orders** — attach stop + T1 + T2 to entry automatically.
   Single biggest risk reduction: lets you sleep through close.
2. **Integrated trade planner + order placement from premarket_setup** —
   one command goes from analysis → order staged, skipping the manual
   `place_option_order.mjs` steps.
3. **Post-trade auto-review** — script that pulls TWS fills + compares to
   plan and prints a grade card (like the one for the Apr 22 QQQ trade).
4. **Live account transition** — separate from paper, with its own safety
   ceremony: small-size live test, verify fill behavior, scale up carefully.

None are urgent. The manual routine above works today.

---

## Reference files

| File | Purpose |
|---|---|
| `premarket_setup.mjs` | One-shot pre-market analysis + S/R + FVG + trigger lines on both charts |
| `multi_timeframe_analysis.js` | ES/NQ/SPY/QQQ × 15m/1H/4H confluence (called by premarket_setup) |
| `trade_planner.mjs` | Preview: pick strike + qty for a given trigger (no order placement) |
| `place_option_order.mjs` | Stage MKT DAY order in TWS with YES prompt + Transmit gate |
| `test_ibkr_connect.mjs` | Read-only sanity check for IBKR connection |
| `option_chain.mjs` | Ad-hoc option chain dump for any underlying |
| `ibkr_config.mjs` | Shared IBKR host/port/clientId config |
| `rules.json` | Hard risk rules (max loss, time stops, asset locks) |

## Memory-referenced rules (in `~/.claude/projects/.../memory/`)

- No background scripts — everything runs on-demand
- Discord alerts only for high-confidence multi-confluence setups, once per setup per day
- "Run the pre-market setup" = `node premarket_setup.mjs`
