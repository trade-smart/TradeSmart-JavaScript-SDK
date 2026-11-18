<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.jsdelivr.net/gh/trade-smart/TradeSmart-JavaScript-SDK@v2.0.0/sdk-javascript/docs/assets/tradesmart-logo-dark.svg">
    <img src="https://cdn.jsdelivr.net/gh/trade-smart/TradeSmart-JavaScript-SDK@v2.0.0/sdk-javascript/docs/assets/tradesmart-logo.svg" alt="TradeSmart" width="240">
  </picture>
</p>

# TradeSmart SDK for JavaScript and TypeScript

TradeSmart's official SDK for the [TradeSmart API V2](https://apidocs.tradesmartonline.in/v2/), for
Node.js. Log in once a day, read your account, find instruments, place and manage orders, and stream
live prices and order updates, from TypeScript or plain JavaScript.

> **Version 2.0.0. TradeSmart SDK behaviour 2.0 — full.** Everything the behaviour
> contract requires and recommends is implemented: option Greeks and analytics, the login command
> and an offline broker for tests. Trading involves real money: read the
> [Orders guide](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/docs/orders.md)
> before sending anything that changes state.

## What you get

- **One client, one stream:** `TradeSmart` (every method returns a `Promise`) and `TradeSmartStream`
  (callbacks or `for await`).
- **Orders:** place, modify, cancel and exit; large orders sent in slices; GTT (good-till-triggered)
  orders. Orders are never retried automatically, and an unclear outcome is reported, not guessed.
- **Market data:** instrument search, the script master, quotes, candles and option chains.
- **Option Greeks and analytics:** implied volatility and Greeks (`client.optionGreeks()` and the pure
  functions of `tradesmart/greeks`), chain snapshots with put-call ratio and max pain, and buildup
  (`tradesmart/analytics`).
- **A login command:** `npx tradesmart login` saves the day's token (and, if you allow it, your keys),
  shared with the Python SDK.
- **An offline broker:** `tradesmart/testing` is a local TradeSmart for testing your strategy, with
  failure drills, and no account or network.
- **Live streaming:** prices and order updates over a WebSocket that reconnects and resubscribes by
  itself.
- **Typed results:** prices are `Decimal` values (decimal.js), never floats; no number is read through a
  float on the way in.
- **Small:** ESM-only, four runtime dependencies (`decimal.js`, `undici`, `ws`, `fflate`), built-in
  TypeScript types. Also loadable from CommonJS with `require("tradesmart")`.

## Install

Node.js 22.12 or newer:

```bash
npm install tradesmart
```

You also need a TradeSmart API app (free, self-service on the TradeSmart web platform's API
Dashboard): its **App Key** (shown as "App ID"), **Secret Key**, your **Client ID**, the Redirect URL
`http://127.0.0.1:8080/callback` and your static IP. Step by step:
[Get API access](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/docs/getting-started.md#1-get-api-access).

No TradeSmart account yet? [Open one online](https://signup.tradesmartonline.in/?utm_source=TypeScriptSDK&utm_medium=Organic&utm_campaign=SDK_Open_Demat&utm_content=registry&channel=Organic&platform=web).

## Quick start

Log in once a day (the token is valid until 06:00 IST) with the login command; it saves the same
login file the Python SDK's `python -m tradesmart login` writes, so one login serves both:

```bash
npx tradesmart login
```

Or set `TRADESMART_CLIENT_ID` and `TRADESMART_ACCESS_TOKEN` in the environment. Then, in TypeScript:

```ts
import { TradeSmart } from "tradesmart";

const client = TradeSmart.fromEnv(); // the saved login or the TRADESMART_* variables
try {
  console.log((await client.profile()).userId);
  console.log((await client.margins()).cash?.toFixed(2));
} finally {
  await client.close();
}
```

The same in JavaScript (ES module):

```js
import { TradeSmart } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  console.log((await client.profile()).userId);
} finally {
  await client.close();
}
```

**New here?** Follow
[Your first order in 10 minutes](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/docs/getting-started.md):
API access, install, login, and a first order placed, checked, modified and cancelled.

## User guide

| Page                                                                                                                                 | What is in it                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| [Getting started](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/docs/getting-started.md)         | API access, install, login, first call, first order                                                       |
| [Orders](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/docs/orders.md)                           | Every order call, prices, validation, order status, recovery after an unclear outcome, sliced orders, GTT |
| [Streaming](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/docs/stream.md)                        | Live prices and order updates                                                                             |
| [Instruments and market data](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/docs/instruments.md) | Search, script master, quotes, candles, option chains                                                     |
| [Option Greeks](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/docs/greeks.md)                    | Implied volatility and Greeks, the pure functions, status, units                                          |
| [Option analytics](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/docs/analytics.md)              | Chain snapshot, put-call ratio, max pain, buildup                                                         |
| [The login command](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/docs/login.md)                 | `npx tradesmart login`, saved keys, Docker                                                                |
| [Errors](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/docs/errors.md)                           | The error tree and troubleshooting                                                                        |
| [Configuration](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/docs/configuration.md)             | Settings, environment variables, rate limits, retries                                                     |
| [Logging](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/docs/logging.md)                         | Plugging in a logger                                                                                      |
| [Testing your code](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/docs/testing.md)               | The offline broker, mocking the REST calls, testing a stream                                              |
| [Reference](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/docs/reference.md)                     | Every method, model, enum and error; known limitations                                                    |

Runnable scripts are in
[`examples/`](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/tree/main/sdk-javascript/examples).
The ones that place orders are marked for a test account and are a dry run unless you pass their
flag.

## Support

- Bugs and questions: [GitHub issues](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/issues).
- Security issues: the [security policy](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/SECURITY.md).
- Account and API access: `support@tradesmartonline.in`.
- Changes: [changelog](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/CHANGELOG.md).
- Contributing: [CONTRIBUTING.md](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/CONTRIBUTING.md).

## Licence

Apache License 2.0, see [LICENSE](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/LICENSE)
and [NOTICE](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/NOTICE).
Copyright (c) 2026 TradeSmart Fintech Securities Limited.
