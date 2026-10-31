# Changelog

## 1.1.1 (31 Oct 2026)
- Phones: dragging the price axis stretches the chart again, and a pinch zooms the chart even when one finger lands late (it used to zoom the whole page). Vertical swipes on the candles still scroll the page.
- Deployment: a version tag now runs the release checks and publishes a GitHub Release, and the server installs it, with a backup and automatic rollback. The bot is still updated by hand.

## 1.1.0 (30 Oct 2026)
- Analytics: a **forward-test record** of every paper trade the bot has closed. It shows totals (win rate, R, net $, profit factor, max drawdown), a per-strategy table, a $ equity curve and the full trade list. It refreshes every minute while the tab is open.
- Bot: publishes closed trades to `trades.json` (spot prices, no open-trade or config data) when `GOLDTERM_PUBLIC_DIR` is set.

## 1.0.0 (30 Oct 2026)

The first versioned release. It covers the terminal, the four strategies, the forward-test bot and the backtest.

### Terminal
- Live XAU/USD chart: Binance XAUUSDT perpetual shifted to spot, Twelve Data spot, or PAXG as a fallback. Candles from hours when the spot market is closed are hidden.
- Indicators: EMA 20/50/200, Bollinger Bands, VWAP and RSI. Support/resistance zones, with replaced zones hidden.
- Drawing tools: horizontal lines and boxes, with price alerts. Tap or double-click a line to delete it.
- Bar replay: step or play through history, at speeds from 0.25x up.
- Trade Planner (outcome estimate, checklist and position size), Journal (MT5 sync and today's strategy suggestions) and Analytics.
- Strategy signals (BUY/SELL arrows and entry/SL/TP lines) are hidden by default to keep the chart clean. One toolbar toggle shows them.
- Phones: the page scrolls as one page (the Journal is no longer a nested scroll box), and vertical swipes on the chart scroll the page.
- Fix: the Journal's suggestions stay on the same price scale as the chart. They used to show perp prices next to a spot live price for up to a minute after load.

### Strategies (`strategies.js`)
- ORB: London open breakout (15m).
- SRC: S/R + candlestick (15m).
- SWP: 5m liquidity sweep.
- CMP: 5m compression at S/R.

### Forward-test bot (`tools/forward-test.mjs`)
- Sends Telegram alerts for heads-ups, signals and results. It backfills candles missed while offline and flags late alerts.
- Paper trades use the strategy's own stop and 3R target, with lots sized to risk $45 on a $5,000 account. Results are reported in $ and % of the balance.
- Can run as an always-on systemd service. On hosts without IPv6, Telegram works with IPv4-first Node options.

### Backtest (`tools/backtest.mjs`)
- New. It compares fixed-$ exits with each strategy's own stop and 3R target over all Binance XAUUSDT history. See the README for results.
