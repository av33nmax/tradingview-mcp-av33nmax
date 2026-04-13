#!/bin/bash

echo "================================================"
echo "  tradingview-mcp-av33nmax Setup"
echo "  0DTE FVG Options Trading Assistant"
echo "================================================"
echo ""

if ! command -v brew &> /dev/null; then
    echo "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    eval "$(/opt/homebrew/bin/brew shellenv zsh)"
fi

if ! command -v node &> /dev/null; then
    echo "Installing Node.js..."
    brew install node
fi

echo "Cloning tradingview-mcp-av33nmax..."
git clone https://github.com/av33nmax/tradingview-mcp-av33nmax.git ~/tradingview-mcp-av33nmax
cd ~/tradingview-mcp-av33nmax && npm install

if ! command -v claude &> /dev/null; then
    echo "Installing Claude Code..."
    npm install -g @anthropic-ai/claude-code
fi

echo "Configuring Claude Code MCP..."
claude mcp add tradingview node ~/tradingview-mcp-av33nmax/src/server.js

echo ""
echo "================================================"
echo "  Setup complete!"
echo "  1. Open TradingView Desktop"
echo "  2. Run: claude"
echo "  3. Say: Scan SPY and QQQ for FVG setups"
echo "================================================"
