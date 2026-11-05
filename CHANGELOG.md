# Changelog

## 1.2.0 (4 Nov 2026)
- Accounts: sign up and sign in with email and password on the secure site, https://dzlf58s3v400k.cloudfront.net/ (Amazon Cognito; code + PKCE). Your journal, morning plans, drawings and settings sync across browsers and phones; the Twelve Data API key stays on each device. The first sign-in in a browser merges its data into the account and keeps a local backup. Saves from two devices at once are merged, not overwritten.
- Two sites: the earlier version stays at http://<server ip>/ and 1.2.0 and later are served from /v2/ on the server, which is what CloudFront shows. Releases now install into /usr/share/nginx/html-v2 (deploy/nginx-goldterm-v2.conf, deploy/goldterm-deploy.service).
- Hosting: CloudFront in front of the site, with HTTPS and security headers (HSTS, Content-Security-Policy, no framing). The /api/data sync API needs a signed-in token (deploy/auth-stack.yaml).
- Morning plan: on weekdays GoldTerm asks for your view of gold at 8:00 AM IST, and again at 6:00 PM IST for a NY-session check-in before the COMEX open. The check-in starts from the morning view, and the card notes if it changed; "No trading today" in the morning also skips 6 PM. Each time it asks for bias, conviction, reasons, levels, news, max trades and $ risk, then builds a session plan at the top of the Journal: your view against the daily trend and the bias scores; prior-day, Asian and today's levels; session times in IST; scenarios with prices and the point where the view is wrong; your fade setup's trigger level; and rules taken from your journal (risk compared with your usual, no re-entry within 15 min of a stop-out, your best and worst sessions). A plan check scores the day's trades against the plan. "Ask Claude to plan" copies the same data as a prompt and opens Claude. The **☀ Plan** button opens it any time; `?morning` in the URL opens it right away.

## 1.1.4 (6 Nov 2026)
- Analytics: the bot's forward-test record now shows every trade in $ on one paper account: R × 1% of the balance when the trade opened, compounding from $5,000. Balance, profit factor, max drawdown, the equity curve, the per-strategy table and the trade list (with the running balance) all use it, including trades from before $ sizing started.
- Bot: lots are sized at 1% of the paper balance instead of a fixed $45, and Telegram shows the paper account balance. Signals at all hours count. Shared with the site through GoldStrategies.paperAccount in strategies.js.
- Settings: a new browser starts at a $5,000 balance and 1% risk (was $10,000).

## 1.1.3 (5 Nov 2026)
- Chart: removed the 7 TradingView boxes imported from the 14 Oct snapshot (4087–4218). Price had fallen below all of them, so they showed as a stack of red "TV R" resistances. They are also deleted from browsers that already had them. The two TradingView trend lines stay.

## 1.1.2 (31 Oct 2026, not deployed)
- Chart: a weekly (1W) timeframe. Candles open at the Sunday 17:00 New York market open and are labelled with that week's Monday.
- Fix: a chart with fewer than 60 candles no longer stalls the Market panel and the live feed.

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
