# GoldTerm: XAU/USD terminal

A TradingView-style gold chart with live data, a trade outcome estimator and a trading journal with performance analytics. It's three static files with no build step, no server and no API key.

**Run it:** double-click `index.html` (Chrome or Edge).

## Data
| Source | Key | Notes |
|---|---|---|
| **Spot XAU/USD** (Twelve Data + live ticks), recommended | free key | Real spot candle history, re-synced every 3 min. The forming candle moves with every Binance trade, converted to spot |
| Binance XAUUSDT perpetual (default without a key) | none | Trade-by-trade WebSocket, shifted to spot using gold-api.com |
| Binance PAXG/USDT (fallback) | none | Gold-backed token, used as a proxy |

Candles are built to match MT4/MT5 brokers:
- Candles from hours when the spot market is closed (weekends and the daily 17:00–18:00 New York break) are hidden.
- 4H and daily candles open at the 17:00 New York close.

To get within cents of your broker's quote (most brokers chart the bid), use **Settings → Price offset**.

## Features
- **Chart:** candles and volume, EMA 20/50/200, Bollinger Bands, VWAP, an RSI pane, and timeframes from 1m to 1D. Drawing tools (horizontal line, trend line) and your trades marked on the chart.
- **Support/resistance zones:** small rectangles, red for resistance and green for support, with a dashed border when a level has flipped role. A zone counts only price behaviour since price last broke through it, so old levels never mix in. Zones price is chopping through are removed, and up to the best 3 per side are recalculated every second as candles form.
- **Market:** directional bias score (−5…+5), signals, key levels, a multi-timeframe bias table and an auto setup idea.
- **Trade Planner:** estimates the chance of hitting TP before SL by blending:
  1. a bootstrap Monte Carlo (4,000 paths) over recent bars with the trend removed,
  2. a historical test of the same stop/target distances, measured in ATR, at every past bar in the same regime,
  3. your own journal's win rate for that direction.

  It then shows expected value (in R and $), a checklist (stop inside noise, counter-trend, risk %, levels in the way), position sizing at your risk %, and an ETA.
- **Journal:** log trades from the planner or by hand, or import MT4/MT5 CSV history. Open trades show live P&L, the current P(TP) and management tips, and can auto-close at SL/TP.
- **Analytics:** win rate, profit factor, expectancy, R distribution, equity curve and drawdown, broken down by side, session, weekday and setup. Also coaching insights such as revenge trading, oversized losers, early exits and increasing size after losses.

Data is stored in your browser (localStorage). Use **Export CSV** to back it up.

> These are statistical estimates, not predictions or financial advice.
