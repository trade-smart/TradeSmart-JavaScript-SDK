# Reference

Every public name of the `tradesmart` package. Version 2.1.0. The package is ESM-only (Node 22.12 or
newer, `"type": "module"`); there is one entry point, `tradesmart`.

## Conventions

- Names are camelCase (the Python SDK's `place_order` is `placeOrder`); classes are `TradeSmart` and
  `TradeSmartStream`. Every client method returns a `Promise`; there is no separate sync or async
  class.
- **Required positional parameters stay positional; optional ones go into one trailing options
  object.** Every client method ends with an optional `{ signal }` for cancellation.
- **An option name the SDK does not know throws a `TypeError`** and nothing is sent.
- Prices, money and volumes are `Decimal` (from `decimal.js`, re-exported). Quantities are `number`
  (safe integers). Ids and tokens are strings. A value TradeSmart did not send is `null`.
- Every model keeps `raw` (the redacted wire object, frozen) and `extra` (the wire keys the model
  does not name).
- Enum fields are the known constant or, for a value the SDK does not know, the original string
  (`OpenEnum<Exchange>`, exported as a type).

## TradeSmart (client)

```ts
import { ClientConfig, TradeSmart } from "tradesmart";

const client = new TradeSmart("CLIENT_ID", {
  accessToken: "A_TOKEN", // string or AccessToken; optional
  appKey: "YOUR_APP_KEY", // for loginUrl() and generateSession(); optional
  secretKey: "YOUR_SECRET_KEY", // for generateSession(); optional
  config: ClientConfig.create({ readTimeout: 20 }), // or a plain object; optional
  // httpDispatcher: an undici Dispatcher, used as is and never closed; optional
});
const fromEnvironment = TradeSmart.fromEnv({ config: { readTimeout: 20 }, env: process.env });
await client.close();
await fromEnvironment.close();
```

| Method                                                                 | Endpoint                                        | Resolves with                                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `loginUrl()` (sync)                                                    | n/a                                             | the authorize URL (needs `appKey`)                                                    |
| `generateSession(code)`                                                | `GenAcsTok`                                     | `AccessToken` (also stored)                                                           |
| `setAccessToken(token)` (sync)                                         | n/a                                             | nothing                                                                               |
| `profile()`                                                            | `UserDetails`                                   | `UserDetails`                                                                         |
| `margins()`                                                            | `Limits`                                        | `Limits`                                                                              |
| `positions()`                                                          | `PositionBook`                                  | `Position[]`                                                                          |
| `holdings({ product })`                                                | `Holdings`                                      | `Holding[]`                                                                           |
| `orders()`                                                             | `OrderBook`                                     | `Order[]`                                                                             |
| `orderHistory(orderId)`                                                | `SingleOrdHist`                                 | `OrderHistoryEntry[]`                                                                 |
| `trades()`                                                             | `TradeBook`                                     | `Trade[]`                                                                             |
| `placeOrder(params)`                                                   | `PlaceOrder`                                    | the order id                                                                          |
| `placeSlicedOrder(params)`                                             | `PlaceOrder`, repeated                          | `SlicedOrderResult`                                                                   |
| `modifyOrder(orderId, params)`                                         | `ModifyOrder`                                   | the order id                                                                          |
| `cancelOrder(orderId)`                                                 | `CancelOrder`                                   | the order id                                                                          |
| `exitOrder(orderId, product)`                                          | `ExitSNOOrder`                                  | the order id                                                                          |
| `orderMargin(params)`                                                  | `GetOrderMargin`                                | `OrderMargin`                                                                         |
| `placeGtt(params)`                                                     | `PlaceGTTOrder`                                 | the alert id                                                                          |
| `modifyGtt(alertId, params)`                                           | `ModifyGTTOrder`                                | the acknowledged alert id                                                             |
| `cancelGtt(alertId)`                                                   | `CancelGTTOrder`                                | the acknowledged alert id                                                             |
| `pendingGtts()`                                                        | `GetPendingGTTOrder`                            | `Gtt[]`                                                                               |
| `triggeredGtts()`                                                      | `GetTrgOi`                                      | `TriggeredGtt[]`                                                                      |
| `gttAlertTypes()`                                                      | `GetEnabledGTTs`                                | `string[]`                                                                            |
| `placeOco(params)`                                                     | `PlaceOCOOrder`                                 | the alert id                                                                          |
| `modifyOco(alertId, params)`                                           | `ModifyOCOOrder`                                | the acknowledged alert id                                                             |
| `cancelOco(alertId)`                                                   | `CancelOCOOrder`                                | the acknowledged alert id                                                             |
| `searchInstruments(text)`                                              | `SearchScrip`                                   | `ScripMatch[]`                                                                        |
| `quote(exchange, token)`                                               | `GetQuotes`                                     | `Quote`                                                                               |
| `securityInfo(exchange, token)`                                        | `GetSecurityInfo`                               | `SecurityInfo`                                                                        |
| `optionChain(exchange, tradingsymbol, strikePrice, count)`             | `GetOptionChain`                                | `OptionContract[]`                                                                    |
| `historicalData(exchange, token, { fromDate, toDate, interval })`      | `TPSeries`                                      | `Candle[]`                                                                            |
| `dailyHistory(exchange, tradingsymbol, fromDate, toDate)`              | `EODChartData`                                  | `DailyCandle[]`                                                                       |
| `optionGreeks(exchange, tradingsymbol, options)`                       | script master + `GetQuotes` (at most two)       | `OptionGreeks` ([Option Greeks](greeks.md))                                           |
| `optionChainSnapshot(exchange, tradingsymbol, strikePrice, { count })` | `GetOptionChain` + one `GetQuotes` per contract | `OptionChainSnapshot` with `pcr()` and `maxPain()` ([Option analytics](analytics.md)) |
| `buildup(exchange, token)`                                             | `GetQuotes` + `TPSeries`                        | `BuildupReading`                                                                      |
| `instruments(exchange)`                                                | script master file                              | header-keyed rows of strings                                                          |
| `downloadInstruments(exchange, { destDir, force })`                    | script master file                              | the file path                                                                         |
| `request(endpoint, payload, { stateChanging, expect })`                | any                                             | the parsed JSON body                                                                  |
| `close()`                                                              | n/a                                             | nothing; later calls reject                                                           |

`accessToken` (getter) returns the held token. `clientId` and `config` are public read-only
properties. The client prints as `TradeSmart(client_id=...)` and never shows its token or keys.

### Prices and quantities

A price is a `Decimal`, decimal text or a finite `number` (the `PriceInput` type):

- **a string is sent exactly as written** (`"2001.00"`);
- **a `number` is sent as its shortest round-trip text** (`0.1 + 0.2` becomes
  `"0.30000000000000004"`; use `roundToTick`);
- **a `Decimal` loses trailing zeros and the sign of `-0`** (decimal.js behaviour).

The grammar is stricter than Python's: no `"2_000"`, no non-ASCII digits, an exponent within +/-1000.
`quantity` must be a JavaScript number (the string `"5"` is refused with a `RequestValidationError`,
Python accepts it); `amo` must be a boolean (otherwise a `RequestValidationError` too).

### Low-level `request()`

`request(endpoint, payload, { stateChanging })` calls any endpoint as `POST {base}/{Endpoint}` with
the form body `jData=<json>` and the bearer token. The name is trimmed of whitespace and slashes and
must be ASCII letters; a known name takes its documented spelling (`placeorder` is the never-retried
`PlaceOrder`). `uid` is appended when absent. Values become wire text: a string as is, a boolean
`Yes` or `No`, a finite number or `Decimal` as plain decimal text, a `bigint` as its digits; a plain object or array of such values is sent nested (the OCO bodies), keys and items in order. A
non-finite number, `null` or `undefined` throws a `TypeError` before sending. `stateChanging: true`
means never retried, and an ambiguous outcome is `OrderStatusUnknownError` (known write endpoints are
treated so whatever you pass). `expect` is `"object"` (default) or `"list"`. The result is the parsed
JSON with **numbers as exact text values**, never floats; a `Not_Ok` "no data" reply is an
`APIError`.

```ts
import { TradeSmart } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  const body = await client.request("UserDetails", {}, { stateChanging: false });
  console.log(body);
} finally {
  await client.close();
}
```

## TradeSmartStream

`new TradeSmartStream(clientId, accessToken, options)`, `TradeSmartStream.fromEnv(options)`,
`TradeSmartStream.fromClient(client, options)`. Options: the callbacks (`onMessage`, `onTouchline`,
`onDepth`, `onOrderUpdate`, `onPosition`, `onConnect`, `onDisconnect`, `onReconnect`, `onError`,
`onStateChange`) and `config`.

| Member                                                   | What                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `connect({ timeoutMs })`                                 | Open and authenticate; resolves once `CONNECTED`            |
| `close()`                                                | Stop; idempotent                                            |
| `subscribeTouchline(keys)`, `unsubscribeTouchline(keys)` | Touchline                                                   |
| `subscribeDepth(keys)`, `unsubscribeDepth(keys)`         | Depth                                                       |
| `subscribeOrders()`, `unsubscribeOrders()`               | Order updates                                               |
| `subscribePositions()`, `unsubscribePositions()`         | Position updates                                            |
| `snapshot(key)`                                          | The latest merged wire fields (text values) or `null`       |
| `state`, `reconnectCount`, `heartbeatAcks`, `closed`     | Status; `closed` resolves with `null` or the terminal error |
| `for await (const message of stream)`                    | Iterate the delivered messages                              |

See [Streaming](stream.md).

## Other entry points

| Import                 | What                                                                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tradesmart/greeks`    | `black76`, `blackScholes`, `impliedVolatility`, `greeksFromPrice`, `DEFAULT_RATE`, `DEFAULT_DIVIDEND_YIELD`, the `Greeks` type ([Option Greeks](greeks.md))                            |
| `tradesmart/analytics` | `pcr`, `maxPain`, `classifyBuildup`, `buildupFromSnapshot`, `Buildup`, and the `ChainRow`, `MaxPain`, `BuildupReading`, `OptionChainSnapshot` types ([Option analytics](analytics.md)) |
| `tradesmart/testing`   | `OfflineBroker`, `drills` ([Testing your code](testing.md)); ESM-only                                                                                                                  |
| `tradesmart` (command) | `tradesmart [login\|token-path\|logout]` ([The login command](login.md))                                                                                                               |

The main entry `tradesmart` never loads the other entry points or the command's code.

## Configuration

`ClientConfig.create(init)`; every setting is in [Configuration](configuration.md). `noopLogger` is
the default logger; the `Logger` and `LogContext` types describe a custom one
([Logging](logging.md)).

## Helpers

| Name                                       | What                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `roundToTick(price, tickSize)`             | The price rounded to the tick grid, as text (a half-way price rounds away from zero)                                                     |
| `istDate("YYYY-MM-DD")`                    | A calendar-date time input (00:00 IST)                                                                                                   |
| `buildAuthorizeUrl(appKey)`                | The login page URL                                                                                                                       |
| `computeChecksum(appKey, secretKey, code)` | The lowercase hex SHA-256 of `appKey + secretKey + code`                                                                                 |
| `AccessToken`                              | The login result: `accessToken` (a masked `Secret`; `.reveal()` gives the text), `userId`, `issuedAt`, `expiresAt`, `isExpired()`        |
| `Decimal`                                  | decimal.js, re-exported                                                                                                                  |
| `isOco(gtt)`, `ocoSides(gtt)`              | OCO row helpers: is it an OCO; `{ stopLoss, target }` as `{ leg, triggerValue }`, or `null` when ambiguous (a repeated or equal trigger) |
| `VERSION`                                  | `"2.1.0"`                                                                                                                                |

## Enums

`Exchange`, `TransactionType`, `OrderType`, `Validity`, `Product`, `OrderStatus`, `GttAlertType`,
`GttValidity`, `Buildup` and `StreamState` are frozen constant objects with a matching union type
(`Exchange.NSE`, type `Exchange`). Request arguments also accept the word in any case or the wire
code.

| Enum              | Members (wire code)                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Exchange`        | `NSE`, `BSE`, `NFO`, `BFO`, `CDS`, `BCD`, `MCX`                                                                                                                                                                                 |
| `TransactionType` | `BUY` (`B`), `SELL` (`S`)                                                                                                                                                                                                       |
| `OrderType`       | `LIMIT` (`LMT`), `MARKET` (`MKT`), `SL` (`SL-LMT`), `SL_M` (`SL-MKT`)                                                                                                                                                           |
| `Validity`        | `DAY`, `IOC`, `EOS`                                                                                                                                                                                                             |
| `Product`         | `CNC` (`C`), `MIS` (`I`), `NRML` (`M`), `CO` (`H`), `BO` (`B`), `MTF` (`F`)                                                                                                                                                     |
| `OrderStatus`     | `PENDING`, `OPEN`, `TRIGGER_PENDING`, `COMPLETE`, `CANCELED`, `REJECTED`                                                                                                                                                        |
| `GttValidity`     | `DAY`, `GTT`                                                                                                                                                                                                                    |
| `GttAlertType`    | `LTP_ABOVE`, `LTP_BELOW`, `CHANGE_PERCENT_ABOVE`, `CHANGE_PERCENT_BELOW`, `ATP_ABOVE`, `ATP_BELOW`, `OI_ABOVE`, `OI_BELOW`, `TOI_ABOVE`, `TOI_BELOW`, `HIGH_52W_ABOVE`, `HIGH_52W_BELOW`, `VOLUME_ABOVE`, `OCO_BUY`, `OCO_SELL` |

## Models

Exported types (all fields `readonly`, camelCase): `UserDetails`, `ProductInfo`, `Limits`, `Position`,
`Holding`, `HoldingInstrument`, `Order`, `OrderHistoryEntry`, `Trade`, `OrderAck`, `OrderMargin`,
`SlicedOrderResult`, `Gtt`, `TriggeredGtt`, `OcoLegRow`, `OcoTrigger`, `OcoSide`, `OcoLeg`, `PlaceOcoParams`, `ModifyOcoParams`, `ScripMatch`, `Quote`, `SecurityInfo`, `OptionContract`,
`Candle`, `DailyCandle`, `OptionGreeks`, `OptionChainSnapshot`, `ChainRow`, `MaxPain`, `BuildupReading`, and for the stream `TouchlineAck`, `TouchlineFeed`, `DepthAck`, `DepthFeed`,
`OrderUpdate`, `PositionAck`, `PositionUpdate`, `ConnectAck`, `HeartbeatAck`, `UnsubscribeAck`,
`UnknownMessage` (the union of those a callback or iterator receives is `InboundStreamMessage`).

A model field named after the API (`tradingsymbol`, `orderId`, `filledQuantity`) is the API key in
camelCase; the field name is **not** a wire alias, so `raw` and `extra` always hold the original keys.

## Errors

The tree and the fields are in [Errors](errors.md).

## Known limitations

- The Greeks are model estimates, not exchange values ([Option Greeks](greeks.md)).
- `OptionChainSnapshot` is a class: spreading it or `structuredClone` loses `pcr()` and `maxPain()`.
- `tradesmart/testing` is ESM-only and binds one loopback port at import ([Testing](testing.md)).
- The script master's column layout is not documented by TradeSmart; rows are plain objects.
- `PlaceMultiOrder` and the iceberg orders have no typed method (use `request()`).
- Parsing a script master runs on the main thread.
- `maxKeepaliveConnections` does not change how many idle connections undici keeps.
- One stream class: one iterator at a time ([Streaming](stream.md#limits-of-the-single-class)).
- Node 22.12 or newer; ESM-only (load from CommonJS with `require("tradesmart")`).
