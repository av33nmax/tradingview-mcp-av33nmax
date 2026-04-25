# Paper Session Post-Mortem — Fri 2026-04-24

**TL;DR** — Both SPY and QQQ Trigger A would have fired cleanly at 10:45 ET
(22:45 SGT) and reached T1, with QQQ reaching T2 as well. The watchers
missed both fires because IBKR returned **zero historical bars** on every
validator check. Compounded by a too-short `--until 23:00` cutoff that would
have killed the watchers 15 minutes after the trigger anyway.

Estimated missed paper profit: **~$500–$800 combined**.

Fix landed same morning in commit `80749a3`.

---

## The setups (per dashboard at session start)

| Ticker | Bias    | Entry  | Stop   | T1     | T2     |
|--------|---------|--------|--------|--------|--------|
| SPY    | BULL    | 711.16 | 708.26 | 712.77 | 714.38 |
| QQQ    | BULL    | 659.69 | 653.75 | 661.65 | 663.61 |

Both `aligned: true`, both CALLS, 0DTE.

---

## What actually happened in the market (validated post-hoc from TV)

### SPY — Trigger A would have fired at 10:45 ET

```
time(ET)     O        H        L        C        vol      rVol   cross  rVol≥1.2  → fire
─────────────────────────────────────────────────────────────────────────────────────────
09:30      710.74   711.16   709.55   709.98   352,828   24.91    no      yes
09:45      710.02   710.52   709.01   709.94   194,728    6.15    no      yes
10:00      709.91   710.67   709.14   710.05   216,572    5.24    no      yes
10:15      710.08   710.66   709.52   709.79   166,074    3.19    no      yes
10:30      709.89   711.10   709.45   711.00   149,033    2.49    no      yes
10:45      711.00   711.60   710.70   711.45   131,316    1.95   YES      yes    🔔 FIRE
11:00      711.50   711.86   711.21   711.77   109,684    1.49   YES      yes    🔔 confirm
11:30      711.83   713.70   711.55   713.29   141,800    1.70   YES      yes    T1 hit (712.77)
11:45      713.29   714.13   712.63   713.78   435,271    4.83   YES      yes    running
```

- Session H/L: **709.01 / 714.46** (T2 of 714.38 tagged at session high)
- Session close: 713.75
- Trigger A entry hit in the 10:45 candle close + volume confirmation
- T1 reached 45 minutes after entry

### QQQ — Trigger A would have fired at 10:45 ET (very strong)

```
time(ET)     O        H        L        C        vol      rVol   cross  rVol≥1.2  → fire
─────────────────────────────────────────────────────────────────────────────────────────
09:30      658.45   659.69   657.73   658.60   469,335   24.63    no      yes
09:45      658.64   659.51   656.54   658.10   306,021    7.23    no      yes
10:00      657.93   659.85   657.27   659.03   260,394    4.53    no      yes
10:15      659.07   659.74   657.94   658.13   220,698    3.13    no      yes
10:30      658.28   659.60   657.47   659.42   153,536    1.90    no      yes
10:45      659.49   660.55   658.92   660.38   219,833    2.49   YES      yes    🔔 FIRE (strong)
11:00      660.41   661.04   660.32   661.02   167,749    1.69   YES      yes    🔔 confirm
11:15      661.02   661.36   660.49   661.22   195,817    1.83   YES      yes    🔔 confirm
11:30      661.23   662.86   660.77   662.45   208,871    1.80   YES      yes    T1 hit (661.65)
11:45      662.70   663.42   661.66   662.90   412,068    3.26   YES      yes    running
13:45      663.39   664.51   663.29   663.81   163,055    0.96   YES       no    T2 hit (663.61, intraday H)
```

- Session H/L: **656.54 / 664.51** (T2 of 663.61 tagged at 13:45 high)
- Session close: 663.46
- Trigger A entry hit in the 10:45 candle close + 2.49x rVol — strongest signal of the session
- T1 reached at 11:30 (45 min after entry)
- T2 reached at 13:45

---

## What the watcher actually saw

The `trade_window.mjs` server-side state from the session:

```
SPY (started 20:50:44 SGT, ran 8 checks, exited 23:00:00 SGT exit code 0):

  [09:00:30 ET] Check #1 → "stale bar (1021m old) — market may be closed"
  [09:15:30 ET] Check #2 → "insufficient bars (0)"
  [09:30:30 ET] Check #3 → "insufficient bars (0)"
  [09:45:30 ET] Check #4 → "insufficient bars (0)"
  [10:00:30 ET] Check #5 → "insufficient bars (0)"
  [10:15:30 ET] Check #6 → "insufficient bars (0)"
  [10:30:30 ET] Check #7 → "insufficient bars (0)"
  [10:45:30 ET] Check #8 → "insufficient bars (0)"   ← TRIGGER MOMENT
  [23:00 SGT]   exit (--until reached)
```

QQQ identical pattern. Every single call to `reqHistoricalData('1 D', '15 mins', 'TRADES')`
returned an empty array.

---

## Compounding bugs (4 of them)

### Bug 1 — IBKR returned 0 bars on every call

`reqHistoricalData` with duration `1 D` returned an empty array consistently. Likely causes
(no definitive proof yet):

- TWS session entered a degraded state after the earlier afternoon's repeated test-fire
  timeouts (`resolveStockConId timeout` on QQQ at 04:56 ET; SPY strike-picker stuck around
  the same time). When TWS gets stuck on one async path, downstream historical data
  requests can silently start failing.
- IBKR's `1 D` interpretation during pre-market may roll the lookback window such that
  it covers no completed bars at the time of query.
- Paper account historical-data limits — IBKR paper has a soft cap on options/equities
  history that paid live accounts don't have. After enough requests, queries return empty
  rather than erroring.

We never saw an explicit error code (162 was suppressed in the script's error filter at the
time — also fixed in `80749a3`).

### Bug 2 — Validator emitted `__CHECK__` only on the happy path

Every early-return failure (insufficient bars, stale bar, outside trading window) returned
without emitting a `__CHECK__` marker. The dashboard "last check" line stayed empty all
night. No way to tell the validator was failing without `curl`-ing the server-side state.

### Bug 3 — `--until 23:00` cut the trade window short

Default was 23:00 SGT (11:00 ET), but per `rules.json` the trade window is 9:45-14:00 ET
which is 21:45-02:00 SGT. The 23:00 default missed more than half of the valid trading
window. The 10:45 ET trigger was 15 minutes BEFORE the watcher's exit time anyway, so this
specific session would still have been caught had the bar-query worked. But on a session
where a trigger fires later (12:00 ET, 13:00 ET, etc.), the watcher would have already died.

### Bug 4 — Error code 162 (historical data pacing / no data) was silenced

The error handler suppressed code 162 alongside truly noisy codes (200, 354, 2137).
That meant when IBKR was actively rejecting our historical data requests with a pacing
violation or "no data" response, we couldn't see it. Just got the silent empty arrays.

---

## What was fixed (commit 80749a3)

1. **`emitCheckMarker` on every return path** — every check result (success or failure)
   now publishes a structured event the dashboard consumes. "insufficient bars (0)" will
   show up in the ticker card's last-check line in real time.

2. **`fetchStockBarsWithRetry` — three-tier fallback** — try `2 D`, then `5 D`, then
   `10 D` if previous duration returned empty. Recovers from narrow-window IBKR
   responses without requiring user intervention.

3. **`consecutiveZeroBars` warning** — three consecutive 0-bar responses prints a loud
   warning telling the user to restart TWS. Earliest possible signal: ~45 min into the
   session if the feed is dead.

4. **`--until` default 02:00 SGT** with auto-roll to tomorrow — covers the full RTH
   trade window per rules.json.

5. **Un-silenced IBKR error 162** — pacing violations and no-data responses now surface
   in the script output instead of being silently swallowed.

---

## Estimated cost of the bug

Optimistic execution (entry at 10:45 fire, exit at T1):

| Trade        | Entry premium est | Exit at T1 est | Gross paper P&L |
|--------------|-------------------|----------------|-----------------|
| SPY 712 CALL × 3 | $0.80         | $1.50          | +$210           |
| QQQ 660 CALL × 3 | $0.85         | $1.85          | +$300           |
| **Combined** |                   |                | **+$510**       |

T2 hold (with disciplined trail) on QQQ would have added another ~$200-300.

So **roughly $500-800 paper missed** because the data feed was dead.

---

## Lessons / action items

1. **TWS hygiene matters.** When test-fires hang or strike pickers stall, restart TWS
   before relying on the same session for live trading. Yesterday's afternoon issues
   probably set up the night's failure.

2. **Auto-reconnect on persistent 0-bar responses** — not yet built. If a check returns
   0 bars, the next check should force a fresh CDP/IBKR connection rather than reuse
   the potentially-broken one. Filed for a future commit.

3. **Real-time visibility in the dashboard is non-negotiable.** Yesterday we sat watching
   a green "Watching" pill thinking everything was fine. Going forward, the
   ticker card should also show: which duration was used, how old the last bar was,
   whether the bar was completed, and warn loudly on degraded states.

4. **Backtesting is now urgent.** Yesterday's setup was a textbook clean fire — both T1
   and T2 reached on QQQ. If this is the typical signal, the system has serious edge.
   We need 60-90 days of historical setups to know the actual hit rate.

5. **The watcher should validate that bars actually flow before declaring "running".**
   Today it just confirms IBKR is connected. Should also confirm the first
   `reqHistoricalData` call returns >0 bars before going into the loop. Filed.

---

## Replication

To re-run this analysis on any day's missed-trigger debate:

```bash
# Save the entry levels in latest_entry_notes.json (or the appropriate dated file)
node analyze_yesterday.mjs
```

The script pulls 15m bars from the active TV chart, evaluates each completed bar against
the trigger criteria, and reports whether/when Trigger A would have fired.
