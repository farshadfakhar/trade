# Safe crypto trading bot (Nobitex, spot only)

A small-capital **spot** bot with a web dashboard. Capital preservation first. It starts in **paper** mode and cannot trade real money until you opt in twice.

> No bot can promise profit, and most retail bots lose money after fees. Use only money you can afford to lose. The first backtests of this strategy **lost money** (see the rollout gates below).

## What it enforces (in code, `server/src/risk/RiskManager.ts`, 100% test coverage)
Spot only · stop-loss required on every position · 1% risk per trade · max open positions · max trades/day · daily loss limit (halts until next UTC day) · drawdown kill switch (manual reset) · no trading on stale data (>60 s) or after 3 consecutive exchange errors · exchange min size/precision. These limits survive restarts (saved in the DB), so restarting cannot reset them.

Flow: `Strategy → RiskManager → Executor → PaperAdapter | NobitexAdapter`. Backtest, paper and live use the same code path.

## Setup
Requires Node 20+ (tested on 22).

```bash
npm install
cp .env.example .env          # then edit it (see below)
cd server && npx prisma db push   # creates prisma/data/bot.db (mkdir prisma/data first)
npm run hash-password -- "a password of 12+ chars"   # paste the printed line into ../.env
```
In `.env` set `DASHBOARD_PASSWORD_HASH`, `JWT_SECRET` (e.g. `openssl rand -hex 32`) and, for plain-http local use, `COOKIE_SECURE=false`.

### Run
```bash
npm run build -w web          # build the dashboard once
cd server && npm start        # http://127.0.0.1:3000  (bot is STOPPED until you press Start)
```
Dev UI with hot reload: `cd web && npm run dev` (proxies to the server on :3000).

### Strategies
Set `STRATEGY` in `.env` (default `emaRsi`). `pullback15m` trades 15m candles with a 1h trend filter: it buys a dip inside an uptrend, sells half at 1.5× the risk then moves the stop to breakeven and trails under the 15m EMA20, exits after 16 candles at the latest, waits 4 candles after a loss, and skips trades whose first target is under 0.6% (fees) or whose stop is over 2% away. Every number is editable in Settings. The bot records every closed candle it sees, so a 15m history builds up over time.
**Nobitex serves 15m candles for only the last ~7 days**, so `pullback15m` cannot be backtested over years (the 100+ trade check in the spec) from Nobitex alone. Paper-trade it, or backtest it on your own longer data.

### Coin scanner (`AUTO_SCAN=true`, with `STRATEGY=donchian`)
The bot chooses its own coin. Every `SCAN_INTERVAL_HOURS` it takes the liquid Nobitex USDT markets (daily volume, spread and listing filters; stablecoins, index funds, stocks and test listings excluded), runs the strategy **unchanged** on each coin over an earlier and a later period, and keeps only coins that are profitable after fees (plus half the spread per side) in **both** periods, with enough trades, a profit factor of at least 1.2 and a drawdown under 12% in the later one. It trades the best passing coin and keeps it while it still passes. If no coin passes, it stays in cash. It only switches coins while it holds no position, and the risk rules, stops and kill switch are unchanged. The Scanner tab shows every coin with the reason it passed or failed.
Passing is a minimum bar, not a forecast: you are picking the best of several backtests, which flatters results, and coins that passed in the past can stop working. LIVE still needs `TRADING_MODE=live` and your typed confirmation; the scanner never turns it on. A scan takes a few minutes the first time (it downloads candle history) and about a minute afterwards.

### Backtest from the terminal
```bash
cd server
npm run backtest -- --symbol BTC/USDT --from 2023-11-01 --split 2025-06-01
npm run backtest -- --strategy pullback15m --compare-fees    # 15m: last ~6 days; shows results with and without fees
```
`--split` reports the earlier range (tune here) and the later range (judge here). Candles are downloaded from Nobitex's public API and cached in SQLite.

### Docker
```bash
docker compose up -d --build                  # http://127.0.0.1:3000
docker compose --profile https up -d          # + Caddy with automatic HTTPS (set DOMAIN in .env)
```
Keep the dashboard behind HTTPS if it is reachable from anywhere but your own machine. (Docker files are untested: Docker was not available where they were written.)

## Paper Shorts

Sign into the dashboard, open **Paper Shorts**, choose BTC/USDT or ZEC/USDT, and press **Start shorts**. Each market has separate baseline and cost-filtered portfolios starting at 10 simulated USDT each. The filtered portfolio skips entries when estimated round-trip costs exceed one-third of the gross target.

The dashboard shows quotes, open positions, fees, recent closes, and realized P&L. Positions and results persist in SQLite. After a server restart, press **Start shorts** to resume. Pausing suspends entry and exit checks. The runner uses public quotes and simulated fills and is independent of spot trading. Margin-specific charges and liquidation are outside the simulation.

## Paper trading (the step before any real money)
1. Set `STRATEGY=pullback15m` (or any other) and `TRADING_MODE=paper` in `.env`, restart, press Start. Paper mode uses live Nobitex prices, the same fees (`FEE_PCT`) and slippage as the backtest, and the same risk rules.
2. **Keep it running.** The 15m strategy only sees a candle if the bot is up when it closes. A sleeping laptop means missed candles; run it on an always-on machine (`docker compose up -d`).
3. A restart resumes the paper session (wallet, position, daily limits) as long as mode, strategy, pair and capital are unchanged; change any of them and it starts a fresh session.
4. Check the dashboard: Overview ("what is it waiting for?"), Trades, Logs. Test PANIC and the kill switch once on purpose.
5. After 4 to 8 weeks the bot has recorded its own 15m history. Re-run the backtest over exactly those dates (`npm run backtest -- --strategy pullback15m --from <first day> --compare-fees`) and compare trades, fees and drawdown with what paper trading did. They should roughly match, and the 100+ trade check from the spec becomes possible only once enough history exists.
Paper fills are optimistic: stops and targets fill at their exact price, and real orders will slip. Treat paper results as an upper bound.

## Going live (only after the gates)
1. Nobitex: enable 2FA, create an API key with **READ + TRADE only** (never WITHDRAW), IP-whitelisted, shortest expiry. Try the **testnet** first (`NOBITEX_BASE_URL=https://testnetapiv2.nobitex.ir`).
2. `.env`: `TRADING_MODE=live`, `EXCHANGE_API_KEY` (= Nobitex-Key), `EXCHANGE_API_SECRET` (Ed25519 private key, URL-safe base64), small `BOT_CAPITAL_USDT`. Restart.
3. Dashboard → Settings → type `I UNDERSTAND`. The badge turns red (LIVE).
The bot **cannot verify** key permissions itself (Nobitex only lists them to a logged-in session): check them by hand.

Live safety: a protective **stop-market order is placed on the exchange** right after every buy (if that fails, the position is closed at once). On restart the bot reloads its state, checks the stop and wallet against the exchange, and refuses to trade (red banner) until you review anything it can't reconcile. Orders use deterministic `clientOrderId`s plus a write-ahead record, so a crash mid-order is flagged rather than repeated.
If an order's or stop's outcome can't be determined (lost response and the lookup fails), the bot **stops itself and shows a red banner** instead of guessing; it never retries such an order blindly. Partial fills are cancelled at the exchange and booked pro rata; the rest stays tracked and protected.
**PANIC** stops the bot, revokes the LIVE confirmation, market-sells first if you chose to (that removes our stop in the same step), cancels stray orders, and then re-checks that any remaining position still has its stop. Without market-sell the position stays open with its stop.

## Rollout plan
1. Tests pass. 2. Backtest 2+ years incl. 2022: profitable after fees, max DD < 20%, ≥ 50 trades, beats hold or has much lower drawdown, **and holds on data you didn't tune on**. 3. Paper-trade 4–8 weeks: results ≈ backtest, no crashes or stuck orders, kill switches tested. 4. Tiny live ($20–50, 4+ weeks), never top up after losses. 5. Scale at most 2× per month; withdraw profits.

## Known limits (read these)
- Nobitex live paths (signing, market orders, stop orders, fee handling) are tested against mocks only. Fees are estimated from `FEE_PCT` because the API's fee unit is undocumented. Verify on the testnet before real money.
- Requests may need an Iranian IP (per Nobitex docs). Use an exchange you can legally use.
- Runtime settings edited in the UI are in memory only; they revert to `.env`/defaults on restart. Paper mode starts fresh on every restart.
- One pair is traded at a time (`PAIR`, default BTC/USDT, or the coin the scanner picks). There is no pair whitelist: the scanner's liquidity and spread filters are what keep it to liquid markets, so with `AUTO_SCAN=false` only set `PAIR` to a coin you have checked yourself. The chart marks exits only (entry times aren't stored).
- Sessions are plain 12-hour JWT cookies with no server-side revocation (logout only clears the cookie). Login throttling is in-memory (single instance). Schema is applied with `prisma db push`, not migrations.
