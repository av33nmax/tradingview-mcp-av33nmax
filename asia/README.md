# Asia Trading Setup (HSI Morning Session)

Parallel sibling of the US setup at the repo root. **Fully separate** by design — own scripts, own dashboard, own journal, own Discord channel. Nothing here imports from the US side.

## Session

| Time (SGT) | Event |
|---|---|
| 08:30–09:00 | Pre-market routine (`npm run premarket:hsi`) |
| 09:30–10:30 | Opening drive — primary trade window |
| 12:00–13:00 | Lunch break (market closed) |
| 13:00–13:30 | Post-lunch reopen — secondary window |
| 15:30–16:00 | Closing auction — tertiary window |
| 16:00 | End of cash session, run `persist:hsi` |

## Instruments — by role

Two buckets. Don't mix them. (Earlier had a third "indices" layer for HSI / HSTECH but it was redundant — MHI tracks HSI tick-for-tick, so HSI is not a real confluence source.)

### Trade & Analyze (options on these; draw lines on these charts)

| Symbol | Tracks | Multiplier | US analog |
|---|---|---|---|
| **MHI** | Hang Seng Index | HK$10/pt | SPY |
| **MTW** | Hang Seng TECH Index | HK$10/pt | QQQ |

### Confluence (independent signals — read but never trade)

| Symbol | Purpose | US analog |
|---|---|---|
| **A50** (`SGX:CN1!`) | HK direction lead via mainland-exposed Singapore futures | ES handover |
| **CSI 300** (`SSE:000300`) | Mainland China — capital-controlled, different flow | — |
| **VHSI** (`HSI:VHSI`) | Vol regime gate (skip if >35 or <15) | VIX |
| **KWEB** (`AMEX:KWEB`) | US-listed China internet ETF — overnight handover for MTW | QQQ overnight |
| **SPX** (`SP:SPX`) | Broad global risk on/off going into HK open | self |

## Gates (binding, manual Y/N still final)

1. **VHSI regime gate** — skip session if VHSI > 35 (panic) or < 15 (dead)
2. **A50 correlation gate** — A50 and HSI must agree on direction at the open
3. **China policy gate** — no entries within 30 min of scheduled PBoC / Politburo announcements
4. **Manual dashboard Y/N** — final binding gate (mirrors US pattern)

## Commands (from `asia/`)

```bash
npm run refresh:calendar   # Pull this week's China/HK events (run daily before pre-market)
npm run premarket:hsi      # Pre-market analysis + chart annotation (08:30 SGT)
npm run orb:hsi            # ORB trigger computation + lines (09:45 SGT)
npm run verify:drawings    # Cross-check state file vs live chart shapes
npm run watcher:hsi        # Morning watcher (launched from dashboard, future)
npm run persist:hsi        # End-of-session journal + commit (future)
npm run dashboard:asia     # localhost:3001 — Asia Dashboard
```

### Calendar refresh

`refresh:calendar` pulls **China + Hong Kong Medium-and-High impact events** from ForexFactory (via the free Faireconomy mirror — no API key required) and writes to `asia/state/policy_events.json`. The `china_policy_blackout` gate consumes this file and fails any trade attempt within ±30 minutes of a scheduled event.

Run once a day (typically before pre-market). The file covers a rolling week, so a daily refresh keeps it fresh.

## Dashboard setup (one-time)

```bash
cd asia/dashboard
npm install                # installs Next 16, React 19, Tailwind 4, shadcn, framer-motion
cd ..
npm run dashboard:asia     # starts dev server on http://localhost:3001
```

The dashboard reads today's journal at `asia/journal/YYYY-MM-DD.md` plus
state files in `asia/state/`. It auto-polls every 30 seconds and re-fetches
on window focus.

## TradingView tab convention

The pre-market and ORB scripts read bars from background tabs **without
switching focus** (transient CDP connections per tab). Have these tabs open in
TradingView Desktop before running:

| Tab | Symbol | Role |
|---|---|---|
| **Primary (you trade on this)** | `HKEX:MHImain` or `HKEX:MHI1!` | MHI — Mini-Hang Seng |
| **Primary (you trade on this)** | `HKEX:MTWmain` or `HKEX:MTW1!` | MTW — Mini-Hang Seng TECH |
| Confluence | `SGX:CN1!` | A50 |
| Confluence | `SSE:000300` | CSI 300 |
| Confluence | `HSI:VHSI` | VHSI |
| Confluence | `AMEX:KWEB` | KWEB overnight |
| Confluence | `SP:SPX` | SPX overnight |

Tab order doesn't matter. Symbol matching is flexible (e.g. `MHI1!`, `MHImain`,
`MHI` all match a request for "MHI"). Missing tabs are reported as
`_no tab open_` in the journal and don't fail the run.

Lines are drawn on the MHI/MTW charts — these are the charts you actually
watch during trading, so the levels are where they need to be.

## Discord

Separate webhook: **#asia-setups** (env var `DISCORD_WEBHOOK_HSI` in `asia/.env.local`)

## What this setup does NOT share with US

- ❌ No imports from `../` — fully isolated
- ❌ Different Discord channel
- ❌ Different journal directory (`asia/journal/`, not root `journal/`)
- ❌ Different port (3001, not 3000)
- ❌ Different package.json + node_modules

## What it DOES share

- ✅ TradingView MCP server (same port 9222 — just different symbols loaded)
- ✅ IBKR connection (same broker login, different contract permissions)
- ✅ Same git repo, different top-level folder
