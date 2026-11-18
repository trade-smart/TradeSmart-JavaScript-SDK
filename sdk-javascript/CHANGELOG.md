# Changelog

All notable changes to the `tradesmart` JavaScript and TypeScript SDK are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [2.0.0] — 2026-11-18

**The first release**, on npm as `tradesmart`. **TradeSmart SDK behaviour 2.0 — full:** every item the
behaviour contract marks as required or recommended is implemented and passes the shared conformance
vectors (option Greeks and analytics, the login command with saved keys, and the offline broker
included). The saved login files are shared with the Python SDK. Default `User-Agent`:
`tradesmart-javascript/2.0.0`. Node.js 22.12 or newer; ESM-only (loadable from CommonJS with
`require("tradesmart")`, except `tradesmart/testing`).

### Added

- Entry points `tradesmart`, `tradesmart/greeks`, `tradesmart/analytics` and `tradesmart/testing`, and the
  `tradesmart` command (`npx tradesmart login`, `token-path`, `logout`).
- Option Greeks: `black76`, `blackScholes`, `impliedVolatility` and `greeksFromPrice` in
  `tradesmart/greeks`, and `TradeSmart.optionGreeks()` (Black-76 on the underlying future or
  Black-Scholes-Merton on spot). An absurd but finite `rate` or `dividendYield` whose discount or carry
  factor overflows a double is a `RangeError` (the reference's `ValueError`), never an infinite or empty
  result.
- Analytics: `pcr`, `maxPain`, `classifyBuildup` and `buildupFromSnapshot` in `tradesmart/analytics`;
  `TradeSmart.optionChainSnapshot()` (the result has `pcr()` and `maxPain()`) and `TradeSmart.buildup()`.
- The login command with saved keys (`credentials.json`, owner-only, not encrypted) and a `login` service in
  `compose.yaml`.
- `OfflineBroker` in `tradesmart/testing`: a local TradeSmart (REST, orders, GTT, streams) with failure
  drills, for testing a strategy with the real client and stream.
- `TradeSmart`: `loginUrl`, `generateSession`, `profile`, `margins`, `positions`, `holdings`,
  `orders`, `orderHistory`, `trades`, `placeOrder`, `placeSlicedOrder`, `modifyOrder`, `cancelOrder`,
  `exitOrder`, `orderMargin`, `placeGtt`, `modifyGtt`, `cancelGtt`, `pendingGtts`, `triggeredGtts`,
  `gttAlertTypes`, `searchInstruments`, `quote`, `securityInfo`, `optionChain`, `historicalData`,
  `dailyHistory`, `instruments`, `downloadInstruments` and the low-level `request`. Every method
  returns a `Promise` and accepts an `AbortSignal`.
- `TradeSmartStream`: touchline, depth, order and position subscriptions, callbacks and
  `for await`, reconnect with back-off and resubscription, snapshots, ordered delivery with a slow-
  consumer merge.
- `ClientConfig`, a pluggable `Logger` (no-op by default), the error tree rooted at `TradeSmartError`,
  `AccessToken`, the shared saved-login token file and `fromEnv()` on the client and the stream.
- Response models generated from `specifications/models.json`; prices, money and volumes are
  `Decimal` values, and JSON is parsed without ever reading a number through a float.
- A user guide, runnable examples and type-checked documentation.

### Safety

- Orders, GTT and iceberg writes and `GenAcsTok` are never retried; an ambiguous outcome is
  `OrderStatusUnknownError`. Redirects are never followed. Secrets are masked everywhere.

### Differences from the Python SDK

Stated in the guide: a `number` price is sent as its shortest text and a `Decimal` loses trailing
zeros; `quantity` must be a number; unknown option names throw `TypeError`; `APIError.raw` keeps JSON
numbers as exact text; one iterator at a time on a stream; script-master parsing on the main thread; decimal text in analytics
has no `_` digit separators; saved-key client ids match with `toLowerCase`/`trim`; the chain snapshot
is a class (spreading it loses `pcr()` and `maxPain()`); `tradesmart/testing` is ESM-only and binds one
loopback port at import; Greeks take JavaScript numbers only.
