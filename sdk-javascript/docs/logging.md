# Logging

The SDK logs through a logger **you** supply. The default is a no-op logger: the library never
writes to the console by itself and never configures anything global.

Any object with `debug`, `info`, `warn` and `error` methods works, so `console`, pino and winston
fit as they are. Each method receives the message and a context object whose `logger` field names
the emitting logger, so a structured logger can filter on it.

```ts
import { ClientConfig, TradeSmart, type Logger } from "tradesmart";

// `console` is a valid Logger.
const config = ClientConfig.create({ logger: console });

// Or filter and format yourself.
const logger: Logger = {
  debug: () => undefined, // drop debug lines
  info: (msg, ctx) => {
    console.log(`[${ctx?.logger ?? "tradesmart"}] ${msg}`);
  },
  warn: (msg) => {
    console.warn(msg);
  },
  error: (msg) => {
    console.error(msg);
  },
};

const client = TradeSmart.fromEnv({ config: ClientConfig.create({ logger }) });
await client.close();
```

## What is logged

| Level   | Logger                      | What                                                                                                                                                                                                   |
| ------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `debug` | `tradesmart.transport`      | One line per REST call (endpoint, HTTP status, time); request payloads only with `logPayloads: true`, redacted                                                                                         |
| `debug` | `tradesmart`                | The acknowledged GTT alert id differs from the one sent                                                                                                                                                |
| `info`  | `tradesmart.orders`         | One line per order call: `PlaceOrder accepted order_id=26110700000001 in 42 ms` (`accepted`, `rejected`, `unknown`, `not_sent`; see [Orders](orders.md#order-logging)). Invalid parameters log no line |
| `warn`  | `tradesmart.orders`         | Every `OrderStatusUnknownError` ("check orders() before acting"; a GTT write names `pendingGtts()`); an abort after the request was handed over                                                        |
| `warn`  | `tradesmart.stream`, others | Connection lost and reconnect attempts; a slow consumer (merging started and ended); a cached script master used after a failed re-check; an unknown timestamp format                                  |
| `error` | `tradesmart.stream`         | The stream stopped by a terminal error with no `onError` and no iterator to receive it; an exception thrown by your callback                                                                           |

The logger names are `tradesmart` (the root), `tradesmart.transport`, `tradesmart.orders`,
`tradesmart.stream` and `tradesmart.instruments`.

## Secrets are masked

Tokens, the secret key, the app key, checksums and login codes are replaced by `***` in every message
and context the SDK passes to your logger, and in the bodies stored on errors. Prices, symbols and
payloads are never logged by default. Masking is by key name and pattern: values you log yourself
under other names are not masked.

A logger that throws never breaks the call that logged: the exception is swallowed.
