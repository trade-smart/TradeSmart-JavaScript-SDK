# Streaming (WebSocket)

`TradeSmartStream` delivers live prices, market depth, order updates and position updates over a
WebSocket. It reconnects and resubscribes by itself. It only reads: it never places, modifies or
cancels orders.

One class serves both calling styles: **callbacks** in the constructor options, and
`for await (const message of stream)`. Both can be used together.

## Credentials for the stream

A stream logs in with your **Client ID** and **access token**. Three ways to give it them:

- **`TradeSmartStream.fromEnv(options)`** uses `TRADESMART_CLIENT_ID` with `TRADESMART_ACCESS_TOKEN`
  when set, else the saved login (see [Getting started](getting-started.md#3-log-in-once-a-day)).
  `TRADESMART_APP_KEY` is ignored: a stream cannot log in by itself. Without a usable login it throws
  `ConfigurationError` (`AuthenticationError` for an expired saved login).
- **`TradeSmartStream.fromClient(client, options)`** takes the client id, current token and
  configuration of a `TradeSmart` you already have. Nothing is sent. It throws `AuthenticationError`
  when the client has no token or its token has expired.
- **The constructor**: `new TradeSmartStream(clientId, accessToken, options)` with a token string or
  the `AccessToken` returned by `generateSession()`.

An `AccessToken` is checked against its 06:00 IST expiry before connecting (switch it off with
`checkTokenExpiry: false`). A plain string token is not checked locally; the server refuses an
expired one with `AuthenticationError`.

## Instruments

Subscriptions take `"EXCHANGE|TOKEN"` keys (`"NSE|22"`), `[exchange, token]` pairs, or an array of
either. The exchange may be in any case (`"nse|22"` is sent as `"NSE|22"`); an invalid key throws
`RequestValidationError`. Find tokens with `client.searchInstruments()` or the script master
([Instruments](instruments.md)). At most **1,000** touchline and depth subscriptions per connection;
more throws `SubscriptionLimitError` before anything is sent.

## Callbacks

```ts
import { TradeSmartStream } from "tradesmart";

const stream = TradeSmartStream.fromEnv({
  onTouchline: (tick) => {
    console.log(
      `${tick.tradingsymbol ?? tick.token ?? "?"} ${tick.lastPrice?.toFixed(2) ?? "n/a"}`,
    );
  },
  onOrderUpdate: (update) => {
    console.log(`${update.orderId ?? "?"} ${update.status ?? "?"}`);
  },
  onError: (error) => {
    console.error(error.message);
  },
});

await stream.connect(); // resolves once CONNECTED; rejects with the connect error
await stream.subscribeTouchline(["NSE|22", ["NSE", "3045"]]);
await stream.subscribeOrders();
await stream.closed; // resolves with null after close(), or with the terminal error
```

The callbacks are `onMessage` (every message, before its typed callback), `onTouchline`, `onDepth`,
`onOrderUpdate`, `onPosition`, `onConnect`, `onDisconnect`, `onReconnect`, `onError` and
`onStateChange`. Each may be a plain or an `async` function.

- The ordered callbacks run **one at a time, in arrival order**, in one dispatch loop; a returned
  Promise is awaited before the next message. A slow callback therefore never delays reading,
  heartbeats or reconnects: the socket handler only parses and queues.
- `onStateChange` runs out of band (it is not part of the ordered loop).
- A callback that throws (or whose Promise rejects) is logged and passed to `onError`; it never stops
  the stream. A throwing `onError` is only logged.
- `onError` receives the terminal error after the messages received before it.

`stream.close()` is idempotent. After it, no message reaches a callback; the skipped ones are counted
in one debug line. `await using stream = ...` also closes it.

## Iterating

```ts
import { TradeSmartStream } from "tradesmart";

const stream = TradeSmartStream.fromEnv();
await stream.connect();
await stream.subscribeTouchline("NSE|22");

const stop = setTimeout(() => void stream.close(), 20_000);
try {
  for await (const message of stream) {
    // `message.t` is the wire message type: "tk", "tf", "om", ...
    console.log(message.t);
  }
} finally {
  clearTimeout(stop);
  await stream.close();
}
```

Start iterating **before** subscribing when you must not miss the first messages: messages are
buffered only for an active consumer. After `close()` an iterator still yields the messages already
received, then ends. A terminal error is thrown by the iterator after the messages before it.

### Limits of the single class

These follow from one class serving both styles:

- **One iterator at a time.** Two concurrent iterators share the same queue and split the messages
  between them.
- If the first `connect()` fails, an iterator that was already started ends quietly and `connect()`
  rejects with the error.
- A callback whose Promise never settles cannot be cancelled. After `close()` the stream waits at most
  two seconds for the callbacks, then logs a warning and abandons them, so the callback may still
  finish after `close()` resolves.
- `stream.closed` waits for the dispatch loop. A callback that never settles, with no `close()` call,
  keeps `closed` pending.
- The backlog limit (below) applies **per consumer kind**: the callbacks and the iterator each have
  their own backlog.

## After a reconnect: catch up

Order and position updates sent while the stream was down are **not replayed**. `onReconnect` runs
right after `onConnect` each time the stream is connected again after a reconnect (never on the first
connect). Refresh your state there:

```ts
import { TradeSmart, TradeSmartStream } from "tradesmart";

const client = TradeSmart.fromEnv();
const stream = TradeSmartStream.fromClient(client, {
  onReconnect: async () => {
    const [orders, positions] = await Promise.all([client.orders(), client.positions()]);
    console.log(
      `reconciled ${String(orders.length)} orders, ${String(positions.length)} positions`,
    );
  },
});
await stream.connect();
await stream.subscribeOrders();
await stream.closed;
await client.close();
```

`stream.reconnectCount` counts the successful reconnects; it is already incremented when
`onReconnect` runs. `stream.heartbeatAcks` counts the server's heartbeat replies.

## Messages

| Message                            | Delivered for                                      | Useful fields                                                                                                   |
| ---------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `TouchlineAck` / `TouchlineFeed`   | touchline subscribe / update                       | `exchange`, `token`, `lastPrice`, `percentChange`, `volume`, `open`, `high`, `low`, `close`, `bp1`, `sp1`       |
| `DepthAck` / `DepthFeed`           | depth subscribe / update                           | five levels `bp1`..`bp5`, `bq1`..`bq5`, `sp1`..`sp5`, `sq1`..`sq5`                                              |
| `OrderUpdate`                      | every order event                                  | `orderId`, `status`, `reporttype`, `price`, `quantity`, `filledQuantity`, `averagePrice`, `rejectReason`, `tag` |
| `PositionAck` / `PositionUpdate`   | position subscribe / update                        | `netQuantity`, `realizedPnl`, `product`, buy and sell averages                                                  |
| `UnsubscribeAck`, `UnknownMessage` | unsubscribes; anything unreadable (`raw` keeps it) |                                                                                                                 |

Update messages carry only the fields that changed; the others are `null`. Prices are `Decimal`
values. On the fields the contract types as stream prices, TradeSmart's "price not set" value
`42949672.95` becomes `null` while the original stays in `.raw`; other fields keep it as sent.

### Snapshots

`stream.snapshot("NSE|22")` returns the latest merged **wire fields** of one instrument (wire keys
such as `"lp"` and `"bp1"`, values as wire text), or `null` when the instrument has not been seen.
Numbers are their exact text (`"2001.50"`), never floats: convert with `new Decimal(value)`. The key
is normalised like a subscription (`"nse|22"` finds `"NSE|22"`); a list or an invalid key throws
`RequestValidationError`. It is not a typed `TouchlineFeed`.

```ts
import { Decimal, TradeSmartStream } from "tradesmart";

const stream = TradeSmartStream.fromEnv();
await stream.connect();
await stream.subscribeTouchline("NSE|22");
await new Promise((resolve) => setTimeout(resolve, 5000));
const fields = stream.snapshot("NSE|22");
const lp = fields?.["lp"];
console.log(typeof lp === "string" ? new Decimal(lp).toFixed(2) : "no price yet");
await stream.close();
```

## Connection behaviour

| Topic         | Behaviour                                                                                                                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heartbeat     | Sent every `heartbeatInterval` (30 s). No frame at all for 2 x `heartbeatInterval` (60 s by default): the connection is treated as dead and the stream reconnects.                                                                                          |
| Reconnect     | Exponential backoff with jitter (1 s base, 60 s cap), at most `reconnectMaxAttempts` (20; `null` is unlimited). Exhausted: a terminal `NetworkError`.                                                                                                       |
| Restore       | After every re-login all subscriptions are sent again, once.                                                                                                                                                                                                |
| Login refused | `AuthenticationError`, terminal and never retried (for example an expired token). Log in again and create a new stream.                                                                                                                                     |
| Token expiry  | With an `AccessToken`, the 06:00 IST expiry is checked before connecting and before every reconnect attempt. A connected stream is not ended at 06:00 by the SDK.                                                                                           |
| Close         | The closing handshake waits at most 2 s; a server that does not answer is then disconnected.                                                                                                                                                                |
| States        | `stream.state`: `DISCONNECTED`, `CONNECTING`, `AUTHENTICATING`, `CONNECTED`, `RECONNECTING`, `CLOSED` (the `StreamState` constants).                                                                                                                        |
| Slow consumer | When 1,000 or more messages wait for your code (`streamBacklogLimit`), price and depth updates for the same instrument are merged, latest value wins. Order and position updates are never merged or dropped. A warning marks the start and end of merging. |

`connect()` waits at most `(2 x wsAuthTimeout + 5)` seconds by default (`{ timeoutMs }` changes it)
and rejects with `RequestTimeoutError`; it can be called once per stream. A stream is single-use:
after `close()` build a new one. Settings are in [Configuration](configuration.md).
