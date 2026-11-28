# TradeSmart SDK for JavaScript and TypeScript: user guide

`tradesmart` is TradeSmart's official SDK for the
[TradeSmart API V2](https://apidocs.tradesmartonline.in/v2/): log in, read your account, find
instruments, place and manage orders, and stream live prices and order updates from Node.js, in
TypeScript or JavaScript.

This guide is for traders and developers who want to automate trading on a TradeSmart account. You do
not need to read the SDK's source code: everything you need is here and in the
[reference](reference.md). **TradeSmart SDK behaviour 2.0 — full**: every required and recommended item is
implemented (Greeks, analytics, the login command and the offline broker included).

## The 10-minute path

1. **Get API access** on the TradeSmart web platform (<https://web.tradesmartonline.in/api>): generate
   an API key with your static IP and the Redirect URL `http://127.0.0.1:8080/callback`. The dashboard
   shows an **App ID**; that is the **App Key** of this SDK.
2. **Install:** `npm install tradesmart` (Node.js 22.19 or newer).
3. **Log in** once a day (the token is valid until 06:00 IST) with `npx tradesmart login`; the
   Python SDK shares the saved login.
4. **Call the API** with `TradeSmart.fromEnv()`: no keys in your code.
5. **Place, check, modify and cancel** your first order.

Step by step, with copy-paste code: **[Your first order in 10 minutes](getting-started.md)**.

## Pages

| Page                                          | What is in it                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Getting started](getting-started.md)         | API access, install, login, first call, first order (place, status, modify, cancel), live updates, common errors                                       |
| [Orders](orders.md)                           | Every order call and parameter, prices, validation, the status lifecycle, recovery by tag, rate limits, sliced orders, GTT, OCO, logging, cancellation |
| [Streaming](stream.md)                        | `TradeSmartStream`: callbacks and `for await`, reconnects, catching up, message types, snapshots                                                       |
| [Instruments and market data](instruments.md) | Search, the script master and when it is refreshed, quotes, candles, option chains                                                                     |
| [Option Greeks](greeks.md)                    | `optionGreeks()`, the pure functions of `tradesmart/greeks`, models, status, units                                                                     |
| [Option analytics](analytics.md)              | Chain snapshot, put-call ratio, max pain, buildup                                                                                                      |
| [The login command](login.md)                 | `npx tradesmart login`, saved keys, logout, Docker                                                                                                     |
| [Errors](errors.md)                           | The error tree, what each error carries, what "unknown" means, troubleshooting                                                                         |
| [Configuration](configuration.md)             | Every `ClientConfig` setting, environment variables, the saved login, rate limits and retries, low latency                                             |
| [Logging](logging.md)                         | Plugging in a logger, what is logged, how secrets are masked                                                                                           |
| [Testing your code](testing.md)               | The offline broker and its failure drills, mocking the REST calls, testing a stream, the SDK's own tests                                               |
| [Reference](reference.md)                     | Every method, helper, enum, model and error in one page; known limitations                                                                             |
| [Architecture](architecture.md)               | How the SDK is built                                                                                                                                   |

## More

- [Examples](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/tree/main/sdk-javascript/examples):
  runnable scripts (first call, read your account, quotes and candles, Greeks, analytics, a test with the
  offline broker, place and cancel on a test
  account, a stream, sliced orders, GTT, OCO, CommonJS).
- [Changelog](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/CHANGELOG.md).

> Trading involves real money. The SDK never retries an order and tells you when an order's outcome is
> unknown; read [Orders](orders.md#recovery-tag-every-order-never-resend-blindly) before running a
> strategy.
