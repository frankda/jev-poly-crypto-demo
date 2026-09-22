# Jev / Poly — BTC 5m Decision Lab

A research tool for Polymarket's BTC 5-minute Up/Down markets, following the "market state → Jev class scores → independent execution logic → live dashboard" structure of [jarrodwatts/jev-trader](https://github.com/jarrodwatts/jev-trader).

This version implements a **live market-data adapter, Jev integration, paper trading and a dashboard**. It does not connect a wallet or submit real orders. `TRADING_MODE=live` is rejected at startup.

## Quick start

Requires Bun (verified locally with 1.2.6).

```bash
bun install --frozen-lockfile
bun run demo
```

Open <http://127.0.0.1:3000>. The demo uses deterministic synthetic prices, simulated order books and a mock model. It exercises entries, 5-minute round changes, settlement and ledger recovery end to end, but says nothing about strategy returns. After the first start, a trade may only appear once the entry window or the next round begins.

### Live data with Jev

```bash
cp .env.example .env
```

In your local `.env`, set:

```dotenv
DATA_MODE=live
MODEL=jev
TYPESAFE_AI_API_KEY=your_TypeSafe_AI_key
JEV_MODEL_ID=jev-latest
TRADING_MODE=paper
DATA_DIR=data/paper
```

Stop the demo with Ctrl+C, then start:

```bash
bun run start
```

To check only the live data pipeline, set `MODEL=mock` first. `bun run demo` always forces synthetic data and the mock model; it never calls Jev. With `MODEL=jev` and no key, startup fails instead of silently falling back to the mock. The API key is only used server-side and `.env` is excluded by `.gitignore`.

By default the server listens on localhost only. Use `PORT=3050 bun run start` if the port is taken. Do not expose the local dashboard to the internet as is; for a public deployment see [Deployment](#deployment-demo-engine-on-a-server-dashboard-on-vercel) (`CONTROL=off`, `CORS_ORIGIN`, `LEDGER=memory`).

## How decisions are made

1. Derive `btc-updown-5m-{round start in epoch seconds}` from UTC time and fetch that event from Gamma. Verify it is exactly a 300-second market and map the Up/Down tokens by outcome label; Up is never assumed to be first.
2. Pick Chainlink spot, 30-second TWAP or 60-second TWAP according to the market's `resolutionSource`. The current BTC 5m rules use the **60-second TWAP**. The source is read from each round's metadata; an exchange price is never passed off as the settlement reference.
3. Prefer Gamma's `eventMetadata.priceToBeat`. Without it, only accept an observation from the matching RTDS stream whose **timestamp is exactly the round's opening time**. If the engine starts mid-round and cannot obtain the price to beat, it skips the round; it never uses the startup price as the opening price.
4. Give Jev the price to beat, current reference price, seconds remaining, 10/30/60-second changes and both outcome order books. The question is "will this round end at or above the opening price", not a fresh five-minute forecast.
   Auxiliary features from the **Binance USDⓈ-M BTCUSDT perpetual** are attached as well (`PERP_FEATURES=on`, the default): top-5/20 book imbalance, microprice offset, 10/30/60-second taker buy/sell volume, 10/30/60-second and since-round-open returns, and basis to Chainlink spot. Data comes from the `/public` (depth20@100ms) and `/market` (aggTrade) routes on `fstream.binance.com`. These are leading indicators only; **they never decide settlement and are never used as the price to beat**. If the data is older than `MAX_DATA_AGE_MS` the whole block is null, and windows without enough coverage are null individually. Jev treats missing values as unknown and keeps deciding without them.
5. Use the same `experimental_evaluate` / `@ai-sdk/typesafe-ai` as the reference project. Read the Up/Down class probabilities and validate them; if they are missing or time out, wait. The trading rules separately decide `UP / DOWN / WAIT`.
6. Re-fetch the order books after the model returns. If the round changed, the price to beat changed or the input went stale, discard the result. Simulated fills walk the visible asks level by level; depth is never invented.
7. At most one open position at a time. Entry: the fee-inclusive cost of one side is at least `MIN_EDGE` (default 5¢) below Jev's probability for that side. While holding, every decision checks whether that side's Polymarket best bid is **above** Jev's current probability for it; if so, the position is sold by walking the bids (sell fees deducted; if depth is insufficient it keeps holding). Otherwise it is held to official settlement. After a sell, the same round may be re-entered. In live mode the Data API `/v2/resolutions` is used, and a trade is only booked when `status=resolved` with valid payouts; 50/50 refunds are supported. Expired but unconfirmed positions stay open; the engine never guesses the outcome from local prices.

Jev's class scores are **not calibrated win rates**. They can be shrunk toward 0.5 before the experimental entry rules use them:

```text
direction score = 0.5 + SCORE_WEIGHT × (raw class score - 0.5)
entry edge      = direction score - fee-inclusive cost per share   (buy if ≥ MIN_EDGE)
sell condition  = best bid of held side > current direction score of that side
```

The default shrink weight is 0.5 (set `SCORE_WEIGHT=1` to compare against Jev's raw probability). There is no minimum direction score by default (`MIN_SCORE=0`); an entry needs an edge of at least 0.05. These are adjustable research parameters with no proven profitability. The dashboard shows **Up / Down raw scores** with the model's lean in large type; the paper trading action is shown separately and may buy either side or wait.

Each model result that passes freshness and round checks leaves a green (Up) / red (Down) dot at its input reference price and triggers one expanding ring. The DECISION card and the new log entry highlight together, and a direction flip is called out. SSE heartbeats, history replay and duplicate pushes never masquerade as new decisions. Stale scores are clearly marked as earlier decisions.

The model is called every 6 s (`POLL_SCHEDULE`, default `300:6000`; a schedule can still vary the interval by how far into the round it is), and not at all in the last 30 s of a round (`MODEL_STOP_SECONDS_LEFT`): positions still open then are held to official settlement. Scheduling is start-to-start, so time spent on the request counts toward the interval rather than sleeping a full interval after it completes. Only one request is in flight; timeouts and slow requests skip missed slots instead of piling up, a tick never spills into the next round, and failures back off exponentially. The dashboard shows the target interval, the actual interval between results and the current stage. While market data is complete and more than 30 s remain, the model keeps being called for observation even outside the entry window, while holding or when risk limits block entries; entry restrictions apply independently. Model calls stop when reliable data is missing or while paused; settlement checks run independently.

### Fees and simulated fills

Fees are read from the market's `feeSchedule` or from `fd.r` / `fd.e` on CLOB `/clob-markets/{condition_id}`; without a reliable schedule the engine does not trade. The fee is `shares × rate × [price × (1-price)]^exponent`, which covers both the current linear curve and the older exponent curve. Zero fees are only used when the market explicitly has `feesEnabled=false`.

Each trade amount includes principal plus the cash equivalent of fees. Buys walk the asks only up to `bestAsk + SLIPPAGE_BUFFER`; sells walk the bids only down to `bestBid - SLIPPAGE_BUFFER`; if that is not enough, nothing fills. The simulation does not reproduce queue position, balance precision, fees charged in token units on buys, or network competition, so the results are not reproducible live returns. Amounts are USD equivalents; no real collateral is touched.

### Parameters

| Variable | Default | Meaning |
| --- | --- | --- |
| `POLL_SCHEDULE` | `300:6000` | Decision interval by time elapsed in the round (`endSecond:intervalMs`, ending at 300): every 6 s for the whole round by default, e.g. `120:2000,240:4000,300:7000` to vary it. Set to `fixed` to use `POLL_MS` |
| `POLL_MS` | 2000 | Fixed interval when `POLL_SCHEDULE=fixed`; slow requests skip slots, one in flight |
| `MODEL_STOP_SECONDS_LEFT` | 30 | No model calls in the last N seconds of a round; open positions are held to settlement. `0` disables |
| `MODEL_TIMEOUT_MS` | 3000 | Model request timeout; SDK retries are disabled |
| `MAX_DATA_AGE_MS` | 15000 | Maximum age of the reference price and order books |
| `MIN_SECONDS_LEFT` / `MAX_SECONDS_LEFT` | 30 / 240 | Entries are only considered with 30–240 seconds left |
| `BANKROLL_USD` | 1000 | Starting paper bankroll |
| `TRADE_USD` | 10 | Fee-inclusive budget per trade; at most one open position at a time |
| `MAX_OPEN_EXPOSURE_USD` | 50 | Cap on the cost of unsettled positions |
| `DAILY_LOSS_LIMIT_USD` | 30 | UTC daily loss budget; entry checks also reserve the worst-case loss of open positions. Set to `off` to disable |
| `MAX_SPREAD` | 0.06 | Maximum allowed bid/ask spread |
| `MIN_EDGE` | 0.05 | Entry requirement: Jev probability − fee-inclusive cost ≥ this value |
| `MIN_SCORE` | 0 | Optional minimum direction score; 0 means no minimum |
| `SLIPPAGE_BUFFER` | 0.01 | How far from the best price a buy or sell may walk the book |
| `SCORE_WEIGHT` | 0.5 | Shrink weight toward 0.5; 1 compares buys and sells directly against Jev's raw probability |
| `PERP_FEATURES` | `on` | Attach Binance perpetual features to the Jev input |
| `LEDGER` | `sqlite` | `sqlite` = ledger on disk under `DATA_DIR`; `memory` = no disk writes, resets on restart |
| `CONTROL` | `on` | `off` hides the pause button and rejects `POST /api/control` |
| `CORS_ORIGIN` | unset | The one exact origin (e.g. your Vercel URL) allowed to read the API |
| `MAX_SSE_CLIENTS` | 200 | Maximum concurrent live-update connections |

## Project layout

```text
src/config.ts          Environment variables and startup validation
src/polymarket.ts      Gamma / CLOB / RTDS / official settlement adapter
src/binance.ts         Binance perpetual book and trade-flow features (auxiliary)
src/model.ts           Jev request, input features and mock model
src/policy.ts          Fees, simulated fills, entry/exit and risk rules
src/engine.ts          Single-flight loop, timeouts, quote re-check, settlement
src/cadence.ts         Round-based poll schedule and failure backoff
src/store.ts           SQLite trade ledger and decision audit log
src/memory-store.ts    In-memory ledger for hosted demos
src/demo.ts            Offline synthetic market data
src/index.ts           HTTP, SSE, CORS and the single-instance lock
web/                   Dashboard
scripts/build-web.mjs  Static dashboard build for Vercel
scripts/smoke.ts       Read-only live data connectivity check
scripts/check-jev.ts   One authenticated Jev connectivity request
tests/                 Market contract, risk, SDK adapter, ledger and security tests
```

`GET /api/state` returns current state, decision points and scheduling times; `GET /api/history` returns the latest 200 audit events; `GET /events` is SSE; `GET /health` reports whether the loop succeeded recently (a healthy engine does not imply that entry conditions are met). The dashboard button calls `POST /api/control` to pause or resume model decisions and entries; settlement checks for open positions continue while paused.

Locally the default is `LEDGER=sqlite`: the ledger is written to `DATA_DIR/{live|demo}-{jev|mock}.sqlite`, separating data modes and models. Restarts keep the bankroll, positions and history. Only one process may use a ledger at a time. Startup is refused if the starting bankroll differs from the existing ledger; use a new `DATA_DIR` for a new experiment. Audit records include sampled model inputs, scores, order books and actions, and old files are not cleaned up automatically. The process lock detects whether the previous PID has exited after a crash (including `bun --watch` restarts, which reuse the PID).

## Verification and current limits

```bash
bun run check      # TypeScript + automated tests, no network needed
bun run smoke      # Read-only Polymarket live data check, does not call Jev
bun run check:jev  # One real Jev connectivity request with the configured key (uses API quota)
```

The automated tests cover fee deduction, insufficient depth, stale data, wrong data sources, missing opening price, model timeouts, round changes, quote re-checks, buying either side, selling and re-entry, duplicate positions, ledger recovery and migration, official payout mapping and idempotent settlement, the round-based schedule, slow-request slot skipping, continuous decisions, settlement not blocking inference, pulse de-duplication, Binance feature extraction, API key redaction and CORS validation. The Jev SDK tests use the real SDK with a mocked HTTP transport; they are not an integration test against the hosted model.

`bun run smoke` was run against the live market `btc-updown-5m-1789993800`, verifying Gamma market detection, the Chainlink 60-second TWAP, both CLOB books and the actual fee parameters `rate=0.07, exponent=1`. That check happened mid-round, so no price to beat was captured. An initial Python HTTP probe got a 403, while the Bun client succeeded afterwards; on access errors the engine backs off and waits instead of switching to fake data.

On 2026-09-22 (Sydney time), after configuring the key, one authenticated Jev inference request succeeded: `jev-latest` resolved to `jev-1.13.0`, took 2059 ms and used 355 input and 31 output tokens. This was an explicitly labelled connectivity check, not a market prediction; the result is saved to `DATA_DIR/jev-connectivity.json` without the key.

At 07:46 the same day, the full decision path was verified on the live market `btc-updown-5m-1790027100`: capturing the 60-second TWAP price to beat at the opening tick, reading both order books, calling Jev and running the independent entry rules. The first market request took about 1847 ms with 2300 input tokens; raw scores were Up 0.03 / Down 0.97, shrunk to 0.265 / 0.735. The entry rules found the edge or book conditions insufficient and waited; no fill was forced for the sake of verification. Two later Down paper positions were settled through official resolution; this only validates the execution flow, not profitability.

From 08:05:03 to 08:07:50 the same day, 83 consecutive Jev results were received on market `btc-updown-5m-1790028300` with a fixed 2-second schedule: median interval **2.00 s**, P95 2.17 s, max 3.124 s; median model latency about 634 ms. External service latency still affects individual rounds; the interval is a scheduling target, not a guarantee.

Strictly skipping rounds without an exact opening price may leave the engine flat more often. Let the process run across a full round boundary and confirm it records the RTDS observation at the exact opening time before evaluating strategy performance.

Next steps: collect real samples, run time-separated out-of-sample evaluation, compare Jev against order-book implied probabilities and simple baselines, and measure after-fee returns, drawdown and score calibration. Only after that should authorized live execution, balance reconciliation and order recovery be implemented separately; this version has no live trading.

## Deployment (demo): engine on a server, dashboard on Vercel

Same split as jev-trader. The engine must run continuously (a decision every few seconds, persistent Chainlink / Binance WebSockets), so it runs as a long-lived Bun process on a server. Vercel only hosts the static dashboard, which connects to the engine through `JEV_API_URL`.

**Security design**
- The API key lives only in the server's environment file (root-only, mode 600). It is not in the code, the dashboard or Vercel; the dashboard only knows the engine's public URL.
- Visitors cannot trigger Jev calls: only the engine's own loop calls the model on its schedule, so cost does not depend on the number of viewers.
- Error messages replace the key with `[redacted]` before they are shown; Bun's development error page is disabled.
- `CONTROL=off` disables the pause endpoint; `CORS_ORIGIN` lets only your Vercel domain read the data; `MAX_SSE_CLIENTS` limits concurrent live connections.
- `.vercelignore` uploads only `web/` and the build script; `.env` and `data/` are never uploaded.

**Engine (server)**: run `bun run src/index.ts` from the project directory under a process manager such as systemd, bound to `127.0.0.1`, behind a reverse proxy with TLS (e.g. Caddy). Environment:

| Variable | Value |
| --- | --- |
| `TYPESAFE_AI_API_KEY` | Your key (set on the server only) |
| `DATA_MODE` / `MODEL` | `live` / `jev` |
| `LEDGER` | `memory` |
| `CONTROL` | `off` |
| `HOST` / `PORT` | `127.0.0.1` / a free port that the reverse proxy forwards to |
| `CORS_ORIGIN` | Your Vercel URL, e.g. `https://your-project.vercel.app` |
| `SCORE_WEIGHT` / `DAILY_LOSS_LIMIT_USD` | As needed, e.g. `1` / `off` |
| `POLL_SCHEDULE` / `MODEL_STOP_SECONDS_LEFT` | Leave unset for the defaults (a Jev call every 6 s, none in the last 30 s). An env file copied from an older `.env.example` sets `POLL_SCHEDULE=120:2000,240:4000,300:7000`; remove that line or set `300:6000` |

Measured on a 2 vCPU server, the engine uses about 100 MB of memory and roughly 10–15% of one core. Capping it in systemd (e.g. `MemoryMax=300M`, `CPUQuota=50%`) keeps it from affecting other services.

**Dashboard (Vercel)**: set the project environment variable `JEV_API_URL` to the engine's public URL (https, no path) and redeploy. The build command `node scripts/build-web.mjs` (configured in `vercel.json`) writes it into `config.js` and generates a CSP that only allows connecting to that URL.

Notes: with `LEDGER=memory` the ledger resets on every restart. Binance blocks egress IPs from some regions (e.g. the US); when blocked, the perpetual features are null and everything else keeps working.

## References

- [jev-trader: architecture and how Jev is called](https://github.com/jarrodwatts/jev-trader)
- [Polymarket: discovering markets](https://docs.polymarket.com/market-data/discover-markets)
- [Polymarket: Chainlink TWAP / RTDS](https://docs.polymarket.com/market-data/chainlink-twap)
- [Polymarket: trading fees](https://docs.polymarket.com/trading/fees)
- [Polymarket: official resolution state API](https://docs.polymarket.com/api-reference/markets/get-resolution-state)
- [BTC 5m market rules that were checked](https://polymarket.com/event/btc-updown-5m-1789980900)

Documentation and APIs checked on 2026-09-21. The reference project is MIT-licensed; this project re-implements the Polymarket data and paper execution logic and does not reuse its Monad / Kuru trading code.
