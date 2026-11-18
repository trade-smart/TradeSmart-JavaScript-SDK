# Configuration

Every setting of the SDK lives in one object, `ClientConfig`, shared by the client and the stream.
The defaults suit most users; this page explains each setting, the environment variables, the saved
login, rate limits and retries, and how to set up for low latency.

```ts
import { ClientConfig, TradeSmart } from "tradesmart";

const config = ClientConfig.create({ readTimeout: 20, rateLimitMode: "raise" });
const client = TradeSmart.fromEnv({ config });
await client.close();
```

`ClientConfig` is frozen: create a new one to change a value. An invalid value throws
`ConfigurationError` when you create it; so does a setting name the SDK does not know. A property set
to `undefined` means "not given" and keeps the default. Wherever a config is accepted you may also
pass the plain object (`{ readTimeout: 20 }`) and the SDK creates the config for you. **All durations
are in seconds.**

## All settings

| Setting                                       | Default                                                        | Meaning                                                                        |
| --------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `baseUrl`                                     | `https://v2api.tradesmartonline.in/NorenWClientAPIv2`          | REST base URL (a trailing `/` is removed)                                      |
| `wsUrl`                                       | `wss://v2api.tradesmartonline.in/NorenWSAPI/`                  | WebSocket URL                                                                  |
| `authorizeUrl`                                | `https://v2api.tradesmartonline.in/OAuthlogin/authorize/oauth` | Login page for `loginUrl()`                                                    |
| `scriptMasterBaseUrl`                         | `https://v2api.tradesmartonline.in`                            | Where the script master files are downloaded from                              |
| `connectTimeout`                              | `5`                                                            | Seconds to open a connection                                                   |
| `readTimeout`                                 | `10`                                                           | Seconds to wait for a response                                                 |
| `maxRetries`                                  | `2`                                                            | Retries of a read after a network failure, 429 or server error (never a write) |
| `backoffBase`, `backoffCap`                   | `0.5`, `8`                                                     | Retry delay: grows from the base to the cap, randomised                        |
| `rateLimitMode`                               | `"wait"`                                                       | `"wait"` or `"raise"` ([Rate limits](#rate-limits-and-retries))                |
| `orderRateLimitMaxWait`                       | `1`                                                            | Seconds an order waits for a free slot before `RateLimitError`                 |
| `orderRateLimitPerSecond`                     | `10`                                                           | Orders per second, 1 to 30; above 10 only with `algoId`                        |
| `orderRateLimitPerMinute`                     | `200`                                                          | Orders per rolling 60 s, 1 to 600, at least the per-second rate                |
| `algoId`                                      | `null`                                                         | Exchange-approved algo ID sent on every `PlaceOrder` and `ModifyOrder`         |
| `userAgent`                                   | `tradesmart-javascript/<version>`                              | `User-Agent`; the SDK token is appended when your text lacks it                |
| `logPayloads`                                 | `false`                                                        | Log request payloads at debug level (redacted)                                 |
| `checkTokenExpiry`                            | `true`                                                         | Refuse an `AccessToken` that passed 06:00 IST before sending                   |
| `heartbeatInterval`                           | `30`                                                           | Stream heartbeat every N seconds                                               |
| `wsAuthTimeout`                               | `10`                                                           | Seconds to wait for the stream's login reply                                   |
| `reconnectMaxAttempts`                        | `20`                                                           | Stream reconnect attempts; `null` is unlimited                                 |
| `reconnectBackoffBase`, `reconnectBackoffCap` | `1`, `60`                                                      | Stream reconnect delay                                                         |
| `keepaliveExpiry`                             | `50`                                                           | Seconds an idle connection stays open                                          |
| `maxConnections`                              | `10`                                                           | Concurrent REST requests (see below)                                           |
| `maxKeepaliveConnections`                     | `5`                                                            | Validated (at most `maxConnections`); see the note below                       |
| `streamBacklogLimit`                          | `1000`                                                         | Messages waiting for your code before price updates are merged                 |
| `scriptMasterRefreshTime`                     | `"07:00"`                                                      | `HH:MM` IST after which a cached script master counts as stale                 |
| `scriptMasterRecheckMinutes`                  | `15`                                                           | Minimum minutes between checks for a newer script master                       |
| `instrumentsDir`                              | `null`                                                         | Folder for script master files; `null` is the per-user cache folder            |
| `logger`                                      | no-op                                                          | Where the SDK logs ([Logging](logging.md))                                     |

**Connections.** The HTTP layer (undici) has no separate limit for idle keep-alive connections, so
`maxConnections` caps **concurrent requests** from one client; further requests wait for a free
connection (orders at most `connectTimeout`, then `RequestTimeoutError` with nothing sent).
`maxKeepaliveConnections` is accepted for parity with the Python SDK and checked against
`maxConnections`, but it does not change how many idle connections are kept.

To use your own HTTP stack (a proxy, custom TLS) pass an undici `Dispatcher` as the client's
`httpDispatcher` option. It is used as is and never closed by the SDK; redirects are still refused.

## Environment variables and the saved login

`TradeSmart.fromEnv()` and `TradeSmartStream.fromEnv()` look credentials up in this order:

| Value               | Source                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client ID           | `TRADESMART_CLIENT_ID`, else the saved login's                                                                                                                                    |
| Access token        | `TRADESMART_ACCESS_TOKEN` (only together with `TRADESMART_CLIENT_ID`), else the saved login's token when it was issued for the same Client ID. An expired saved login is not used |
| App Key, Secret Key | `TRADESMART_APP_KEY`, `TRADESMART_SECRET_KEY` (a client only): allow `generateSession()` when there is no token                                                                   |
| Token file          | `TRADESMART_TOKEN_FILE`, else `%APPDATA%\tradesmart\token.json` on Windows, else `$XDG_CONFIG_HOME/tradesmart/token.json` (fallback `~/.config/tradesmart/token.json`)            |

Every value is stripped of surrounding whitespace; a blank one counts as unset. A token set without a
Client ID is a `ConfigurationError`: a token from the environment is never paired with the saved
login's Client ID.

**The saved login is shared with the Python SDK.** The login command of either SDK writes the same
file in the same format (created with mode `0600`, replaced atomically; on Linux and macOS a file
owned by another user or open to group or others is refused), so one login serves both. Log in with
`npx tradesmart login` ([Getting started](getting-started.md#3-log-in-once-a-day)).

## Rate limits and retries

The SDK enforces these limits per client instance:

| Calls                                                | Per second                                             | Per minute                                 |
| ---------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------ |
| `placeOrder` (and `PlaceMultiOrder` via `request()`) | `orderRateLimitPerSecond` (10; up to 30 with `algoId`) | `orderRateLimitPerMinute` (200; up to 600) |
| `quote` (and `GetQuotesMultiple` via `request()`)    | 100                                                    | 1,000                                      |
| `historicalData`                                     | 100                                                    | 1,000                                      |
| everything else                                      | no limit                                               | no limit                                   |

- `"wait"` mode (default): a call waits for a free slot. An order waits at most
  `orderRateLimitMaxWait` (1 s); if it would need longer it rejects with `RateLimitError` (with
  `retryAfter`) and is not sent. Reads keep waiting.
- `"raise"` mode: the call rejects with `RateLimitError` at once (`httpStatus` `null`).
- Two clients do not share a limiter: use one client per account and process.

**Retries.** Only read calls are retried, only after `NetworkError`, `RequestTimeoutError`, HTTP 429
and server errors, up to `maxRetries` times with a growing, randomised delay (or the server's
`Retry-After` when it is a finite number). Order calls, the login token exchange and the GTT and
iceberg writes are **never** retried, and a script-master download is a single attempt.

## Low-latency setup

The network dominates the SDK's own cost, so most latency you can save is in where and how you run:

1. **Host close to TradeSmart.** Run on a server with a short, stable path to
   `v2api.tradesmartonline.in`, typically in India, with a fixed public IP that is your registered
   static IP.
2. **Warm start.** Create one client per process and keep it all day. Idle connections close after
   `keepaliveExpiry`, so make a cheap read (`client.profile()`) shortly before you expect to trade.
3. **Connections.** More than `maxConnections` concurrent requests from one client queue for a free
   connection.
4. **Fast stream callbacks.** Do the minimum in a callback (update state, put work on a queue). A
   callback that awaits slow work delays every later message of that stream.
5. **Backlog merging.** If your code falls `streamBacklogLimit` messages behind, price and depth
   updates for the same instrument are merged so you always see the latest values; order and position
   updates are never merged or dropped. `stream.snapshot(key)` always holds the latest values.
