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

## Strategies
All signal logic lives in `strategies.js`, which the chart and the forward-test bot both use. Every strategy works the same way:
- A signal is confirmed only once its candle has closed.
- You enter at the open of the next candle.
- The target is **3R**.
- If one candle touches both the stop and the target, it counts as a stop.

| Code | Name | Timeframe | Entry rule | Stop | Limits |
|---|---|---|---|---|---|
| **ORB** | London open breakout | 15m | Range = high/low from 01:00 to 08:00 London. Signal on the first 15m close outside the range between 08:00 and 12:00 London. | Middle of the range | 1 trade a day |
| **SRC** | S/R + candlestick | 15m | 1H S/R boxes (swing levels touched 2+ times) and a 1H bias of ±2 or more. A bullish or bearish 15m pattern (hammer, shooting star, engulfing, strong candle) at a box, in the bias direction. RSI not stretched, 15m MACD turning, no opposite box within 1.5R. | Beyond the pattern or box + 0.2 × 15m ATR | none |
| **SWP** | 5m liquidity sweep | 5m | Levels: prior-day high/low, Asian range, 1H swing zones, $25 round numbers. A 5m candle trades 0.2 × ATR through a level untouched for the last hour, then closes back on the original side. Only with the 1H bias (±2 or more) and price on the trend side of session VWAP. | Sweep wick + 0.3 × ATR | Max 2 a day, exit after 4 h |
| **CMP** | 5m compression at S/R | 5m | 1H bias ±3 or more. The last hour of 5m candles forms a range 1.5–5 ATR wide. Its capped side (high for shorts, low for longs) sits within 0.5 ATR of a level tested 2+ times. Signal on a 5m close 0.1 ATR beyond the other side. | 0.2 ATR past the capped side | Max 2 a day, exit after 6 h |

**1H bias score:** each 1H condition below adds +1 when bullish and −1 when bearish:
- close vs EMA 50
- EMA 50 vs EMA 200
- EMA 20 slope over 5 bars

SWP and CMP add two more conditions, giving a range of −5…+5:
- RSI above 55 (+1) or below 45 (−1)
- MACD histogram sign

The 5m strategies need about 7,000 5m candles of history, so the 1H EMA 200 has time to settle.

**Heads-up alerts:** every strategy also posts "watch" messages while a candle is still forming, up to 15 minutes before a possible signal.

### 30-day backtest (24 Sep – 24 Oct 2026, spot-session candles, 0.0075% cost per trade)
| Strategy | Trades | Win rate | Total R |
|---|---|---|---|
| ORB | 13 | 23% | −0.86R |
| SRC | 18 | 22% | −2.60R |
| SWP | 14 | 36% | +5.02R |
| CMP | 27 | 52% | +13.13R |
| **All** | **72** | **36%** | **+14.69R** (PF 1.32) |

Past results on one month of data don't predict future results.

## Forward-test bot
`tools/forward-test.mjs` runs the same strategies live and sends each signal and its outcome to Telegram.
- **Data:** Binance XAUUSDT perpetual 15m and 5m candles, converted to spot prices.
- **Timing:** it polls 2 seconds after every 5m candle closes.
- **Catching up:** after the PC sleeps, it backfills any missed candles. Alerts that arrive more than 2 minutes late are marked **⏰ LATE**.

```
node tools/forward-test.mjs
```

It needs two files:
- `~/.goldterm/telegram_token.txt`: your bot token
- `~/.goldterm/telegram_chat_id.txt`: your chat ID

The bot writes its state and logs to `forward/`. That folder holds personal data, and `.gitignore` keeps it out of git.

> These are statistical estimates, not predictions or financial advice.
