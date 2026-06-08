# tradingview-mcp-av33nmax

> AI-powered 0DTE options trading assistant for SPY & QQQ — built on [tradingview-mcp-jackson](https://github.com/LewisWJackson/tradingview-mcp-jackson) by LewisWJackson.

## What this does

Connects Claude AI to your TradingView Desktop via MCP (Model Context Protocol). Claude reads your live SPY and QQQ charts, identifies Fair Value Gap (FVG) setups, and gives you 0DTE options trade alerts with full risk sizing — all hands-free via voice using Wispr Flow.

## Strategy

- **Instruments:** SPY and QQQ options only
- **Expiry:** 0DTE (same day) strictly
- **Premium range:** $0.50–$0.90 per share ($50–$90 per contract)
- **Max loss per trade:** $30 (50% stop on premium)
- **Indicators:** VWAP + EMA
- **Setup type:** ICT Fair Value Gaps (FVG) with Break of Structure confirmation
- **Best windows:** 9:35–10:30 AM ET and 1:30–2:30 PM ET

## Requirements

- Mac (Apple Silicon or Intel)
- [TradingView Desktop](https://www.tradingview.com/desktop/) with active subscription
- [Interactive Brokers TWS](https://www.interactivebrokers.com/en/trading/tws.php) (connected to TradingView)
- [Claude Code](https://claude.ai/code) (Anthropic)
- [Wispr Flow](https://whisperflow.app) (optional — voice control)
- Node.js 18+

## Installation

### One-command setup:
```bash
curl -fsSL https://raw.githubusercontent.com/av33nmax/tradingview-mcp-av33nmax/main/setup.sh | bash
```

### Manual setup:

1. Clone this repo:
```bash
git clone https://github.com/av33nmax/tradingview-mcp-av33nmax.git ~/tradingview-mcp-av33nmax
cd ~/tradingview-mcp-av33nmax && npm install
```

2. Add to Claude Code:
```bash
claude mcp add tradingview node ~/tradingview-mcp-av33nmax/src/server.js
```

3. Open TradingView Desktop, then launch Claude Code:
```bash
claude
```

## Daily Routine

1. Open **TradingView Desktop**
2. Run `claude` in terminal
3. Enable **Wispr Flow** and say: *"Scan SPY and QQQ for FVG setups"*
4. Claude reads your charts and returns trade alerts
5. Execute confirmed setups via TradingView + Interactive Brokers

## Voice Commands (Wispr Flow)

Speak these into Claude Code:
- *"Give me my morning bias for SPY and QQQ"*
- *"Scan for FVG setups"*
- *"Is there a bullish FVG on SPY 15min?"*
- *"What's the current bias?"*

## Risk Rules

- 0DTE only — no exceptions
- Premium $0.50–$0.90 — skip anything outside this range
- Stop at 50% of premium paid
- Max 2 losing trades per day then stop
- No trading after 3:00 PM ET
- Close all positions by 3:30 PM ET

## Credits

Built on top of [tradingview-mcp-jackson](https://github.com/LewisWJackson/tradingview-mcp-jackson) by LewisWJackson.
FVG strategy based on ICT (Inner Circle Trader) concepts.

---
*For educational purposes only. Not financial advice. Always trade responsibly.*
