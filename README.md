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
- **Support/resistance zones:** small rectangles, red for resistance and green for support, with a dashed border when a level has flipped role. A zone counts only price behaviour since price last broke through it, so old levels never mix in. Zones update only when a candle closes. Once drawn, a zone keeps its exact position until price closes through it, drifts more than 8 ATR away, or 3 closer zones push it out (up to 3 per side). A replaced zone stays on the chart, faded and dotted with an "old R/S" label, ending at the candle where it was replaced. The last 12 per timeframe are kept, and they persist across page reloads.
- **Bar replay** (**▶ Replay** in the top bar, or the ▶ icon in the left toolbar):
  1. Click a candle to start from it.
  2. Step with Shift+→ / Shift+←, or press Space to play at 1×–30×. **Jump** picks a new start, and **Esc** goes back to live.

  The chart shows only what GoldTerm knew at the close of each replayed candle: indicators, S/R zones (including faded old ones), strategy signals with their entry/SL/TP, and your trades. A signal's outcome appears once its exit candle has closed. Live data keeps loading in the background, and alerts and journal auto-close are paused during a replay.
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

Full results are in [Results](#results) below.

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

## Results
All results are in **R** (1R = the amount risked on the trade) and include a 0.0075% cost per trade. Prices are spot XAU/USD.

### Forward test (live paper trading, 16 Oct – 23 Oct 2026)
These are signals the bot sent live to Telegram, scored as they played out. Nothing here was backtested after the fact.

| Strategy | Trades | Wins | Win rate | Total | Avg/trade | Profit factor | Max drawdown |
|---|---|---|---|---|---|---|---|
| ORB | 4 | 2 | 50% | +3.91R | +0.98R | 2.92 | 1.02R |
| SRC | 8 | 4 | 50% | +7.75R | +0.97R | 2.88 | 3.10R |
| SWP | 2 | 0 | 0% | −2.22R | −1.11R | 0.00 | 2.22R |
| CMP | 7 | 4 | 57% | +8.80R | +1.26R | 3.87 | 2.04R |
| **All** | 21 | 10 | 48% | **+18.24R** | +0.87R | 2.59 | 4.24R |

<details><summary>All 21 forward-test trades</summary>

| Strategy | Side | Signal (UTC) | Entry | Stop | Target | Result | Exit | R | Reason |
|---|---|---|---|---|---|---|---|---|---|
| ORB | BUY | 16 Oct, 07:15 | 4194.20 | 4173.53 | 4256.19 | STOP | 4173.53 | −1.02R | close above the Asian range 4154.02-4193.05 |
| ORB | SELL | 19 Oct, 10:30 | 4172.08 | 4183.49 | 4137.84 | TARGET | 4137.84 | +2.97R | close below the Asian range 4173.05-4193.94 |
| SRC | SELL | 19 Oct, 20:00 | 4147.10 | 4152.34 | 4131.39 | TARGET | 4131.39 | +2.94R | bearish engulfing at resistance 4148.04-4151.49, 1H bias -3 |
| SWP | SELL | 20 Oct, 00:00 | 4143.51 | 4145.20 | 4138.44 | STOP | 4145.20 | −1.18R | swept the prior-day low 4144.05 and closed back below it, below VWAP 4144.05, 1H bias -5 |
| ORB | SELL | 20 Oct, 09:45 | 4121.32 | 4138.87 | 4068.67 | STOP | 4138.87 | −1.02R | close below the Asian range 4123.46-4154.28 |
| CMP | SELL | 21 Oct, 01:05 | 4115.72 | 4129.95 | 4073.03 | STOP | 4129.95 | −1.02R | broke down from a 1-hour range 4118.84-4129.33 capped by the 1H swing zone 4128.14 (2 tests), 1H bias -3 |
| CMP | SELL | 21 Oct, 06:20 | 4121.70 | 4137.47 | 4074.38 | STOP | 4137.47 | −1.02R | broke down from a 1-hour range 4122.20-4136.77 capped by the Asian high 4136.77 (2 tests), 1H bias -3 |
| CMP | SELL | 22 Oct, 05:10 | 4095.29 | 4101.13 | 4077.77 | TARGET | 4077.77 | +2.95R | broke down from a 1-hour range 4095.78-4100.54 capped by the round number 4100.00 (4 tests), 1H bias -5 |
| SWP | SELL | 22 Oct, 06:05 | 4099.34 | 4106.26 | 4078.58 | STOP | 4106.26 | −1.04R | swept the round number 4100.00 and closed back below it, below VWAP 4107.90, 1H bias -5 |
| CMP | SELL | 22 Oct, 07:45 | 4093.31 | 4108.67 | 4047.24 | TARGET | 4047.24 | +2.98R | broke down from a 1-hour range 4095.81-4107.76 capped by the 1H swing zone 4109.68 (4 tests), 1H bias -5 |
| ORB | SELL | 22 Oct, 07:45 | 4094.81 | 4113.90 | 4037.55 | TARGET | 4037.55 | +2.98R | close below the Asian range 4095.08-4132.71 |
| CMP | SELL | 22 Oct, 10:50 | 4089.35 | 4100.34 | 4056.37 | TARGET | 4056.37 | +2.97R | broke down from a 1-hour range 4091.46-4099.68 capped by the round number 4100.00 (4 tests), 1H bias -5 |
| SRC | SELL | 22 Oct, 11:45 | 4067.50 | 4078.93 | 4033.20 | STOP | 4078.93 | −1.03R | bearish engulfing at resistance 4072.26-4076.40, 1H bias -5 |
| SRC | SELL | 22 Oct, 13:30 | 4068.15 | 4089.95 | 4002.74 | TARGET | 4002.74 | +2.99R | strong bearish candle at resistance 4071.99-4076.67, 1H bias -5 |
| SRC | SELL | 22 Oct, 13:45 | 4065.60 | 4078.71 | 4026.28 | TARGET | 4026.28 | +2.98R | shooting star at resistance 4071.99-4076.67, 1H bias -5 |
| CMP | SELL | 22 Oct, 23:00 | 4032.01 | 4040.67 | 4006.02 | TARGET | 4006.02 | +2.97R | broke down from a 1-hour range 4033.00-4040.16 capped by the Asian high 4040.21 (2 tests), 1H bias -5 |
| CMP | SELL | 23 Oct, 04:00 | 4020.14 | 4028.95 | 3993.70 | STOP | 4028.95 | −1.03R | broke down from a 1-hour range 4020.69-4028.08 capped by the prior-day low 4027.18 (5 tests), 1H bias -5 |
| SRC | SELL | 23 Oct, 09:30 | 4032.09 | 4042.27 | 4001.55 | STOP | 4042.27 | −1.03R | bearish engulfing at resistance 4036.06-4040.92, 1H bias -3 |
| SRC | SELL | 23 Oct, 12:00 | 4031.14 | 4041.85 | 3999.02 | STOP | 4041.85 | −1.03R | shooting star at resistance 4036.32-4040.66, 1H bias -3 |
| SRC | SELL | 23 Oct, 12:45 | 4034.96 | 4041.90 | 4014.13 | STOP | 4041.90 | −1.04R | shooting star at resistance 4036.32-4040.66, 1H bias -3 |
| SRC | SELL | 23 Oct, 13:15 | 4034.68 | 4044.24 | 4006.01 | TARGET | 4006.01 | +2.97R | bearish engulfing at resistance 4036.37-4040.61, 1H bias -3 |

</details>

### 30-day backtest (23 Sep – 23 Oct 2026)
The same `strategies.js` code run over past Binance XAUUSDT candles (converted to spot-session hours) and scored the same way as the bot.

| Strategy | Trades | Wins | Win rate | Total | Avg/trade | Profit factor | Max drawdown |
|---|---|---|---|---|---|---|---|
| ORB | 13 | 3 | 23% | −0.86R | −0.07R | 0.91 | 5.06R |
| SRC | 18 | 4 | 22% | −2.60R | −0.14R | 0.82 | 11.41R |
| SWP | 14 | 5 | 36% | +5.02R | +0.36R | 1.52 | 4.20R |
| CMP | 27 | 14 | 52% | +13.13R | +0.49R | 2.15 | 2.50R |
| **All** | 72 | 26 | 36% | **+14.69R** | +0.20R | 1.32 | 12.22R |

<details><summary>All 72 backtest trades</summary>

| Strategy | Side | Signal (UTC) | Entry | Stop | Target | Result | Exit | R | Reason |
|---|---|---|---|---|---|---|---|---|---|
| CMP | SELL | 24 Sept, 01:45 | 4288.00 | 4307.74 | 4228.77 | TIME | 4286.39 | +0.07R | broke down from a 1-hour range 4293.68-4306.87 capped by the 1H swing zone 4305.98 (2 tests), 1H bias -3 |
| SRC | SELL | 24 Sept, 08:00 | 4281.38 | 4291.34 | 4251.50 | TARGET | 4251.50 | +2.97R | shooting star at resistance 4285.64-4289.98, 1H bias -3 |
| ORB | SELL | 24 Sept, 08:15 | 4268.17 | 4291.99 | 4196.72 | STOP | 4291.99 | −1.01R | close below the Asian range 4277.10-4306.87 |
| SRC | SELL | 24 Sept, 08:15 | 4268.17 | 4284.40 | 4219.48 | STOP | 4284.40 | −1.02R | strong bearish candle at resistance 4277.09-4281.43, 1H bias -3 |
| CMP | SELL | 24 Sept, 08:55 | 4265.43 | 4289.57 | 4193.01 | TIME | 4255.31 | +0.41R | broke down from a 1-hour range 4266.00-4288.58 capped by the 1H swing zone 4287.81 (2 tests), 1H bias -3 |
| SWP | SELL | 24 Sept, 18:30 | 4274.40 | 4282.00 | 4251.61 | STOP | 4282.00 | −1.04R | swept the 1H swing zone 4279.26 and closed back below it, below VWAP 4276.46, 1H bias -3 |
| SRC | SELL | 24 Sept, 19:00 | 4272.09 | 4283.89 | 4236.68 | STOP | 4283.89 | −1.03R | bearish engulfing at resistance 4276.53-4281.99, 1H bias -2 |
| ORB | BUY | 25 Sept, 10:00 | 4310.46 | 4279.85 | 4402.30 | STOP | 4279.85 | −1.01R | close above the Asian range 4260.59-4299.10 |
| ORB | SELL | 28 Sept, 07:00 | 4165.80 | 4215.97 | 4015.31 | TIME | 4199.26 | −0.67R | close below the Asian range 4166.54-4265.39 |
| CMP | SELL | 28 Sept, 07:10 | 4165.80 | 4186.87 | 4102.59 | TIME | 4153.36 | +0.58R | broke down from a 1-hour range 4166.44-4185.90 capped by the Asian low 4184.08 (2 tests), 1H bias -5 |
| SWP | SELL | 28 Sept, 12:20 | 4166.82 | 4178.47 | 4131.86 | TARGET | 4131.86 | +2.97R | swept the round number 4175.00 and closed back below it, below VWAP 4194.94, 1H bias -5 |
| SWP | SELL | 28 Sept, 16:25 | 4148.29 | 4154.41 | 4129.93 | TARGET | 4129.93 | +2.95R | swept the round number 4150.00 and closed back below it, below VWAP 4178.71, 1H bias -5 |
| ORB | BUY | 29 Sept, 10:00 | 4153.54 | 4135.53 | 4207.57 | TARGET | 4207.57 | +2.98R | close above the Asian range 4118.51-4152.55 |
| SRC | BUY | 29 Sept, 20:30 | 4188.66 | 4174.14 | 4232.23 | STOP | 4174.14 | −1.02R | strong bullish candle at support 4175.60-4180.05, 1H bias +3 |
| CMP | BUY | 29 Sept, 20:30 | 4182.50 | 4172.97 | 4211.10 | STOP | 4172.97 | −1.03R | broke out of a 1-hour range 4173.66-4181.67 held by the round number 4175.00 (5 tests), 1H bias +3 |
| CMP | BUY | 30 Sept, 06:50 | 4195.66 | 4177.94 | 4248.83 | TIME | 4211.93 | +0.90R | broke out of a 1-hour range 4178.71-4189.04 held by the 1H swing zone 4177.82 (2 tests), 1H bias +3 |
| ORB | BUY | 30 Sept, 07:15 | 4199.25 | 4184.91 | 4242.27 | STOP | 4184.91 | −1.02R | close above the Asian range 4170.84-4198.98 |
| SWP | BUY | 30 Sept, 10:45 | 4189.55 | 4186.52 | 4198.65 | STOP | 4186.52 | −1.10R | swept the prior-day high 4188.80 and closed back above it, above VWAP 4188.13, 1H bias +3 |
| SWP | BUY | 01 Oct, 13:15 | 4177.65 | 4172.26 | 4193.81 | STOP | 4172.26 | −1.06R | swept the round number 4175.00 and closed back above it, above VWAP 4173.46, 1H bias +2 |
| CMP | SELL | 02 Oct, 15:00 | 4156.13 | 4201.69 | 4019.46 | TIME | 4146.79 | +0.20R | broke down from a 1-hour range 4160.38-4199.97 capped by the prior-day high 4196.68 (2 tests), 1H bias -3 |
| CMP | SELL | 05 Oct, 04:10 | 4139.67 | 4150.89 | 4106.01 | STOP | 4150.89 | −1.03R | broke down from a 1-hour range 4141.15-4150.25 capped by the round number 4150.00 (5 tests), 1H bias -5 |
| ORB | BUY | 05 Oct, 08:00 | 4172.11 | 4148.22 | 4243.78 | STOP | 4148.22 | −1.01R | close above the Asian range 4130.00-4166.44 |
| CMP | SELL | 06 Oct, 06:00 | 4120.66 | 4130.07 | 4092.43 | STOP | 4130.07 | −1.03R | broke down from a 1-hour range 4121.06-4129.42 capped by the prior-day low 4128.02 (3 tests), 1H bias -5 |
| ORB | BUY | 06 Oct, 08:30 | 4156.17 | 4131.98 | 4228.75 | STOP | 4131.98 | −1.01R | close above the Asian range 4108.80-4155.15 |
| SWP | BUY | 06 Oct, 14:20 | 4150.96 | 4147.48 | 4161.39 | TARGET | 4161.39 | +2.91R | swept the round number 4150.00 and closed back above it, above VWAP 4150.67, 1H bias +2 |
| CMP | SELL | 07 Oct, 05:15 | 4137.00 | 4147.49 | 4105.52 | TIME | 4123.99 | +1.21R | broke down from a 1-hour range 4137.44-4147.08 capped by the 1H swing zone 4146.20 (3 tests), 1H bias -5 |
| ORB | SELL | 07 Oct, 08:15 | 4130.97 | 4152.03 | 4067.78 | STOP | 4152.03 | −1.01R | close below the Asian range 4131.56-4172.51 |
| CMP | SELL | 07 Oct, 12:20 | 4118.19 | 4129.62 | 4083.91 | TARGET | 4083.91 | +2.97R | broke down from a 1-hour range 4119.58-4128.92 capped by the 1H swing zone 4129.03 (3 tests), 1H bias -5 |
| SRC | SELL | 07 Oct, 16:30 | 4112.90 | 4121.61 | 4086.77 | STOP | 4121.61 | −1.04R | bearish engulfing at resistance 4115.59-4119.89, 1H bias -5 |
| SRC | SELL | 07 Oct, 22:00 | 4112.92 | 4122.14 | 4085.26 | STOP | 4122.14 | −1.03R | bearish engulfing at resistance 4115.66-4119.83, 1H bias -3 |
| SRC | SELL | 07 Oct, 23:45 | 4112.77 | 4120.92 | 4088.32 | STOP | 4120.92 | −1.04R | bearish engulfing at resistance 4115.67-4119.82, 1H bias -3 |
| SWP | BUY | 08 Oct, 05:30 | 4134.83 | 4127.80 | 4155.93 | STOP | 4127.80 | −1.04R | swept the 1H swing zone 4129.51 and closed back above it, above VWAP 4131.08, 1H bias +3 |
| SWP | SELL | 08 Oct, 16:15 | 4125.32 | 4139.23 | 4083.58 | STOP | 4139.23 | −1.02R | swept the 1H swing zone 4129.51 and closed back below it, below VWAP 4128.50, 1H bias -3 |
| CMP | BUY | 09 Oct, 01:05 | 4155.65 | 4146.46 | 4183.23 | TARGET | 4183.23 | +2.97R | broke out of a 1-hour range 4147.16-4155.22 held by the 1H swing zone 4146.36 (5 tests), 1H bias +3 |
| ORB | SELL | 12 Oct, 08:00 | 4182.50 | 4203.59 | 4119.22 | STOP | 4203.59 | −1.01R | close below the Asian range 4184.61-4222.58 |
| CMP | BUY | 13 Oct, 04:15 | 4198.67 | 4181.60 | 4249.88 | TIME | 4188.76 | −0.60R | broke out of a 1-hour range 4182.29-4196.27 held by the 1H swing zone 4182.94 (2 tests), 1H bias +3 |
| SRC | SELL | 13 Oct, 15:30 | 4166.90 | 4172.55 | 4149.94 | STOP | 4172.55 | −1.06R | shooting star at resistance 4167.42-4170.85, 1H bias -3 |
| CMP | SELL | 13 Oct, 16:00 | 4163.30 | 4176.41 | 4123.98 | TIME | 4168.62 | −0.43R | broke down from a 1-hour range 4163.69-4175.70 capped by the 1H swing zone 4175.98 (3 tests), 1H bias -3 |
| SWP | SELL | 13 Oct, 18:05 | 4166.24 | 4170.91 | 4152.24 | STOP | 4170.91 | −1.07R | swept the 1H swing zone 4169.14 and closed back below it, below VWAP 4180.67, 1H bias -3 |
| SRC | SELL | 13 Oct, 23:00 | 4164.20 | 4168.74 | 4150.57 | STOP | 4168.74 | −1.07R | strong bearish candle at resistance 4164.81-4167.87, 1H bias -3 |
| CMP | SELL | 14 Oct, 01:35 | 4153.57 | 4173.20 | 4094.69 | STOP | 4173.20 | −1.02R | broke down from a 1-hour range 4154.07-4172.24 capped by the 1H swing zone 4172.39 (2 tests), 1H bias -5 |
| CMP | SELL | 14 Oct, 04:00 | 4167.53 | 4177.16 | 4138.63 | TIME | 4150.50 | +1.74R | broke down from a 1-hour range 4168.16-4176.59 capped by the 1H swing zone 4177.82 (2 tests), 1H bias -4 |
| ORB | SELL | 14 Oct, 08:45 | 4150.44 | 4163.87 | 4110.15 | TARGET | 4110.15 | +2.98R | close below the Asian range 4151.15-4176.59 |
| SWP | SELL | 14 Oct, 12:05 | 4153.51 | 4158.19 | 4139.46 | STOP | 4158.19 | −1.07R | swept the prior-day low 4153.86 and closed back below it, below VWAP 4158.94, 1H bias -5 |
| SRC | SELL | 14 Oct, 13:45 | 4095.71 | 4115.33 | 4036.84 | STOP | 4115.33 | −1.02R | bearish engulfing at resistance 4106.37-4110.87, 1H bias -5 |
| SRC | SELL | 14 Oct, 20:30 | 4106.33 | 4112.27 | 4088.50 | STOP | 4112.27 | −1.05R | bearish engulfing at resistance 4106.32-4110.92, 1H bias -5 |
| CMP | BUY | 15 Oct, 08:10 | 4160.72 | 4145.67 | 4205.88 | STOP | 4145.67 | −1.02R | broke out of a 1-hour range 4146.33-4156.98 held by the 1H swing zone 4147.88 (2 tests), 1H bias +3 |
| CMP | BUY | 15 Oct, 14:35 | 4170.39 | 4150.72 | 4229.41 | STOP | 4150.72 | −1.02R | broke out of a 1-hour range 4152.00-4169.67 held by the 1H swing zone 4154.53 (2 tests), 1H bias +3 |
| CMP | BUY | 16 Oct, 06:30 | 4186.30 | 4175.56 | 4218.52 | TIME | 4184.95 | −0.15R | broke out of a 1-hour range 4176.26-4184.23 held by the 1H swing zone 4175.12 (3 tests), 1H bias +3 |
| ORB | BUY | 16 Oct, 07:15 | 4194.20 | 4173.53 | 4256.19 | STOP | 4173.53 | −1.02R | close above the Asian range 4154.02-4193.05 |
| SWP | BUY | 16 Oct, 10:00 | 4183.58 | 4181.52 | 4189.75 | TARGET | 4189.75 | +2.85R | swept the prior-day high 4183.52 and closed back above it, above VWAP 4178.92, 1H bias +3 |
| ORB | SELL | 19 Oct, 10:30 | 4172.08 | 4183.49 | 4137.84 | TARGET | 4137.84 | +2.97R | close below the Asian range 4173.05-4193.94 |
| SWP | SELL | 19 Oct, 13:30 | 4167.73 | 4175.21 | 4145.28 | TARGET | 4145.28 | +2.96R | swept the Asian low 4173.05 and closed back below it, below VWAP 4180.22, 1H bias -3 |
| CMP | SELL | 19 Oct, 20:00 | 4148.22 | 4153.59 | 4132.10 | TARGET | 4132.10 | +2.94R | broke down from a 1-hour range 4149.40-4153.22 capped by the prior-day low 4154.02 (2 tests), 1H bias -5 |
| SWP | SELL | 20 Oct, 00:00 | 4143.51 | 4145.20 | 4138.44 | STOP | 4145.20 | −1.18R | swept the prior-day low 4144.05 and closed back below it, below VWAP 4144.05, 1H bias -5 |
| CMP | SELL | 20 Oct, 01:10 | 4129.93 | 4147.34 | 4077.71 | STOP | 4147.34 | −1.02R | broke down from a 1-hour range 4131.01-4146.57 capped by the 1H swing zone 4145.97 (2 tests), 1H bias -5 |
| CMP | SELL | 20 Oct, 05:05 | 4146.08 | 4154.81 | 4119.88 | TIME | 4131.22 | +1.67R | broke down from a 1-hour range 4149.08-4154.28 capped by the 1H swing zone 4153.61 (2 tests), 1H bias -3 |
| ORB | SELL | 20 Oct, 09:45 | 4121.32 | 4138.87 | 4068.67 | STOP | 4138.87 | −1.02R | close below the Asian range 4123.46-4154.28 |
| CMP | SELL | 21 Oct, 01:05 | 4115.72 | 4129.95 | 4073.03 | STOP | 4129.95 | −1.02R | broke down from a 1-hour range 4118.84-4129.33 capped by the 1H swing zone 4128.14 (2 tests), 1H bias -3 |
| CMP | SELL | 21 Oct, 06:20 | 4121.70 | 4137.48 | 4074.37 | STOP | 4137.48 | −1.02R | broke down from a 1-hour range 4122.20-4136.77 capped by the Asian high 4136.77 (2 tests), 1H bias -3 |
| CMP | SELL | 22 Oct, 05:10 | 4095.29 | 4101.13 | 4077.77 | TARGET | 4077.77 | +2.95R | broke down from a 1-hour range 4095.78-4100.54 capped by the round number 4100.00 (4 tests), 1H bias -5 |
| SWP | SELL | 22 Oct, 06:05 | 4099.34 | 4106.26 | 4078.58 | STOP | 4106.26 | −1.04R | swept the round number 4100.00 and closed back below it, below VWAP 4107.90, 1H bias -5 |
| CMP | SELL | 22 Oct, 10:50 | 4089.35 | 4100.34 | 4056.37 | TARGET | 4056.37 | +2.97R | broke down from a 1-hour range 4091.46-4099.68 capped by the round number 4100.00 (4 tests), 1H bias -5 |
| SRC | SELL | 22 Oct, 11:45 | 4067.50 | 4078.93 | 4033.20 | STOP | 4078.93 | −1.03R | bearish engulfing at resistance 4072.26-4076.40, 1H bias -5 |
| SRC | SELL | 22 Oct, 13:30 | 4068.15 | 4089.95 | 4002.74 | TARGET | 4002.74 | +2.99R | strong bearish candle at resistance 4071.99-4076.67, 1H bias -5 |
| SRC | SELL | 22 Oct, 13:45 | 4065.60 | 4078.71 | 4026.28 | TARGET | 4026.28 | +2.98R | shooting star at resistance 4071.99-4076.67, 1H bias -5 |
| CMP | SELL | 22 Oct, 23:00 | 4032.01 | 4040.67 | 4006.02 | TARGET | 4006.02 | +2.97R | broke down from a 1-hour range 4033.00-4040.16 capped by the Asian high 4040.21 (2 tests), 1H bias -5 |
| CMP | SELL | 23 Oct, 04:00 | 4020.14 | 4028.95 | 3993.70 | STOP | 4028.95 | −1.03R | broke down from a 1-hour range 4020.69-4028.08 capped by the prior-day low 4027.18 (5 tests), 1H bias -5 |
| SRC | SELL | 23 Oct, 09:30 | 4032.09 | 4042.27 | 4001.55 | STOP | 4042.27 | −1.03R | bearish engulfing at resistance 4036.06-4040.92, 1H bias -3 |
| SRC | SELL | 23 Oct, 12:00 | 4031.14 | 4041.85 | 3999.02 | STOP | 4041.85 | −1.03R | shooting star at resistance 4036.32-4040.66, 1H bias -3 |
| SRC | SELL | 23 Oct, 12:45 | 4034.96 | 4041.90 | 4014.13 | STOP | 4041.90 | −1.04R | shooting star at resistance 4036.32-4040.66, 1H bias -3 |
| SRC | SELL | 23 Oct, 13:15 | 4034.68 | 4044.24 | 4006.01 | TARGET | 4006.01 | +2.97R | bearish engulfing at resistance 4036.37-4040.61, 1H bias -3 |

</details>

> Small samples: a few weeks of trades can't show whether a strategy has a real edge. Past results don't predict future results, and none of this is financial advice.

> These are statistical estimates, not predictions or financial advice.
