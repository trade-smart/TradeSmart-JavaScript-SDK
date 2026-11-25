# Orders

Placing, modifying, cancelling and exiting orders with the TradeSmart SDK for JavaScript and
TypeScript; GTT (good till triggered) orders; how to read an order's status; and how to recover
safely when the network fails at the wrong moment. New to the SDK? Start with
[Your first order in 10 minutes](getting-started.md).

Every code block on this page uses real SDK calls with placeholder values, and **running one that
places, modifies or cancels an order changes your real account**. `client` is a `TradeSmart`.

## The order calls

| Call                                          | What it does                                                                 | Resolves with           |
| --------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------- |
| `client.placeOrder(params)`                   | New order (`PlaceOrder`)                                                     | the order id            |
| `client.modifyOrder(orderId, params)`         | Change price, quantity, type or trigger of an open order (`ModifyOrder`)     | the order id            |
| `client.cancelOrder(orderId)`                 | Cancel an open order (`CancelOrder`)                                         | the order id you passed |
| `client.exitOrder(orderId, product)`          | Exit a cover (`CO`) or bracket (`BO`) order (`ExitSNOOrder`)                 | the order id you passed |
| `client.orderMargin(params)`                  | The margin an order would need (`GetOrderMargin`); a read, nothing is placed | an `OrderMargin`        |
| `client.placeSlicedOrder(params)`             | One large order as freeze-limit slices ([Sliced orders](#sliced-orders))     | a `SlicedOrderResult`   |
| `client.placeGtt` / `modifyGtt` / `cancelGtt` | GTT orders ([GTT orders](#gtt-orders))                                       | the alert id            |
| `client.placeOco` / `modifyOco` / `cancelOco` | OCO (target and stop-loss) orders ([OCO orders](#oco-orders))                | the alert id            |

**An acknowledgement is not an execution.** Each call resolves once TradeSmart's order system has
_accepted the request_. Whether the order is open, filled, cancelled or rejected by the exchange is
confirmed with `client.orderHistory(orderId)`, `client.orders()` or live order updates on the
[stream](stream.md).

Parameters go in one object (`placeOrder({ exchange, tradingsymbol, ... })`). Required values that
identify the order (`orderId`) stay positional; everything else is a property. **An option name the
SDK does not know throws a `TypeError` and nothing is sent**, so a typo such as `triggerprice` cannot
silently drop your stop price. Every method also takes a last `options` argument with
`signal?: AbortSignal` ([Cancelling a call](#cancelling-a-call-abortsignal)).

### Place

```ts
import { Exchange, OrderType, Product, TradeSmart, TransactionType, Validity } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  const orderId = await client.placeOrder({
    exchange: Exchange.NSE,
    tradingsymbol: "SBIN-EQ",
    quantity: 1, // trade units (NFO: units, not lots); a JavaScript number
    transactionType: TransactionType.BUY,
    product: Product.CNC,
    orderType: OrderType.LIMIT,
    price: "500.05", // text keeps its digits; Decimal and number also work (see Prices)
    validity: Validity.DAY, // default DAY
    tag: "mystrat-0001", // unique per order; see Recovery
  });
  console.log(orderId);
} finally {
  await client.close();
}
```

Enum arguments accept the constant (`Exchange.NSE`), the word in any case (`"nse"`, `"cnc"`,
`"buy"`) or the wire code (`"B"`). Optional parameters: `triggerPrice`, `disclosedQuantity`, `amo`,
`tag`, `bookLossPrice`, `bookProfitPrice`, `trailPrice`, `marketProtection`, `algoId`.

### Modify

`modifyOrder` sends the whole order again. `price` is required for `LMT` and `SL-LMT`; `null` for a
market type sends `0`.

```ts
import { Exchange, OrderType, Product, TradeSmart } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  await client.modifyOrder("THE_ORDER_ID", {
    exchange: Exchange.NSE,
    tradingsymbol: "SBIN-EQ",
    quantity: 2,
    price: "500.10",
    orderType: OrderType.LIMIT,
    product: Product.CNC,
  });
} finally {
  await client.close();
}
```

### Cancel and exit

```ts
import { Product, TradeSmart } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  await client.cancelOrder("THE_ORDER_ID");
  await client.exitOrder("THE_CO_OR_BO_ORDER_ID", Product.CO); // only for CO and BO orders
} finally {
  await client.close();
}
```

`orderId` must be a **string** (a `number` is refused: ids such as `"00022"` keep their zeros).

### Cover and bracket orders

A cover order (`Product.CO`) needs `bookLossPrice`; a bracket order (`Product.BO`) needs
`bookLossPrice` and `bookProfitPrice`; `trailPrice` is optional on both.

### After-market orders (AMO)

Pass `amo: true`. `amo` must be a boolean (a string is refused with a `RequestValidationError`); it is always sent (`Yes` or `No`).

### Margin before you order

```ts
import { Exchange, OrderType, Product, TradeSmart, TransactionType } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  const margin = await client.orderMargin({
    exchange: Exchange.NSE,
    tradingsymbol: "SBIN-EQ",
    quantity: 1,
    price: "500.05",
    product: Product.CNC,
    transactionType: TransactionType.BUY,
    orderType: OrderType.LIMIT,
  });
  console.log(`Order margin ${margin.ordermargin?.toFixed(2) ?? "n/a"}`);
} finally {
  await client.close();
}
```

## Prices and quantities

A price input is a `Decimal`, a decimal string or a finite `number`. What reaches the wire:

- **A string is sent exactly as written.** `"2001.00"` goes out as `2001.00`.
- **A `number` is sent as its shortest round-trip text.** `101.1` stays `101.1`, but
  `0.1 + 0.2` is `0.30000000000000004`, which is not on any tick grid and will be refused. Round
  computed prices with `roundToTick(price, tickSize)`, which returns the price as text.
- **A `Decimal` loses trailing zeros and the sign of a negative zero** (`new Decimal("2001.00")` is
  sent as `2001`). Use a string when the digits matter.
- The price grammar is stricter than a general decimal parser: ASCII digits, an optional fraction
  and an optional exponent within +/-1000. A thousands separator (`"2_000"`), non-ASCII digits,
  `NaN` and `Infinity` are refused.

`quantity` and `disclosedQuantity` must be **JavaScript numbers** (safe integers). A numeric string
such as `"5"` is refused with a `RequestValidationError` (the Python SDK accepts it): convert with
`Number()` first.

## Validation before sending

These mistakes throw **before anything is sent**. A wrong value is a `RequestValidationError` (its
`errors` list the wire key and a reason, never the value). That includes a `quantity` that is not a
whole JavaScript number (such as the string `"5"`) and an `amo` that is not a boolean. Only an
option name the SDK does not know, or a non-object argument, is a `TypeError`.

| Rule                                                                                             | Applies to                             |
| ------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `quantity` is an integer of at least 1; prices, trigger and leg prices are not negative          | place, modify, margin                  |
| `LIMIT` and `SL` need `price` greater than 0                                                     | place, modify                          |
| A market type without a price is sent with price `"0"`                                           | place, modify                          |
| `SL` and `SL-M` need `triggerPrice` greater than 0; `triggerPrice` is allowed on those two only  | place, modify                          |
| Cover order needs `bookLossPrice`; bracket order needs `bookLossPrice` and `bookProfitPrice`     | place                                  |
| `bookProfitPrice` only on bracket orders; `bookLossPrice` and `trailPrice` only on `CO` and `BO` | place, modify                          |
| `MTF` is not allowed on `MCX`                                                                    | place                                  |
| `disclosedQuantity` is between 0 and `quantity`                                                  | place                                  |
| `exchange`, `product`, `transactionType`, `orderType`, `validity` are valid values               | place, modify, margin                  |
| `orderId` is a non-empty string                                                                  | modify, cancel, exit, `orderHistory()` |
| The exit product is `CO` or `BO`                                                                 | exit                                   |

**MARKET orders are refused for API orders.** TradeSmart does not accept `MARKET` orders placed
through the API: `placeOrder` rejects with `OrderRejectedError` (a message such as
`MKT Order type not allowed for API order`) and nothing is placed. To buy or sell at the market,
send a `LIMIT` order at a price that trades now, rounded to the tick with `roundToTick()`. The SDK
itself does not block `MARKET`, so your code keeps working unchanged if TradeSmart allows it later.
Symbols containing `&`, `+` or `%` (for example `M&M-EQ`) are encoded for you: pass them unescaped.

## Order status lifecycle

Every order has a `status` (`OrderStatus`):

| Status            | Meaning                                                           | Final?  |
| ----------------- | ----------------------------------------------------------------- | ------- |
| `PENDING`         | Order accepted; awaiting further exchange events                  | no      |
| `OPEN`            | Open and working at the exchange                                  | no      |
| `TRIGGER_PENDING` | Waiting for its trigger (stop-loss orders)                        | no      |
| `COMPLETE`        | Fully executed                                                    | **yes** |
| `CANCELED`        | Cancelled                                                         | **yes** |
| `REJECTED`        | Rejected by risk checks or the exchange (`rejectReason` says why) | **yes** |

Treat only `COMPLETE`, `CANCELED` and `REJECTED` as final, and do not rely on a particular sequence
of states. A partly executed order is not final: read `filledQuantity` and `averagePrice`. `status`
is the known word when TradeSmart sends one and the raw text otherwise, so compare it with
`OrderStatus.OPEN` or `"OPEN"`.

`orderHistory(orderId)` returns one `OrderHistoryEntry` per state change (`[]` when TradeSmart does
not know the id yet). TradeSmart does not document their order. For the **current** status read the
order's row in `orders()`, which has exactly one row per order.

```ts
import { OrderStatus, TradeSmart, type Order } from "tradesmart";

const FINAL: readonly string[] = [OrderStatus.COMPLETE, OrderStatus.CANCELED, OrderStatus.REJECTED];
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitUntilFinal(
  client: TradeSmart,
  orderId: string,
  seconds = 30,
): Promise<Order | null> {
  let row: Order | null = null;
  for (let i = 0; i < seconds; i++) {
    row = (await client.orders()).find((o) => o.orderId === orderId) ?? row;
    if (row?.status != null && FINAL.includes(row.status)) break;
    await sleep(1000);
  }
  return row;
}

const client = TradeSmart.fromEnv();
try {
  console.log((await waitUntilFinal(client, "THE_ORDER_ID", 5))?.status ?? "unknown");
} finally {
  await client.close();
}
```

For a running strategy prefer live order updates (`subscribeOrders()` on the [stream](stream.md)) to
polling.

## Recovery: tag every order, never resend blindly

The SDK **never retries** a `PlaceOrder`, `PlaceMultiOrder`, `ModifyOrder`, `CancelOrder`,
`ExitSNOOrder`, GTT write (`PlaceGTTOrder`, `ModifyGTTOrder`, `CancelGTTOrder`), OCO write
(`PlaceOCOOrder`, `ModifyOCOOrder`, `CancelOCOOrder`) or iceberg write
(`PlaceIceBergOrder`, `ModifyIceBergOrder`, `CancelIceBergOrder`) request, and never follows an HTTP
redirect. When a request may have reached TradeSmart but no definitive answer came back (a read
timeout, a connection dropped after sending, a gateway error page, an unreadable answer, a TLS
failure after the connection opened) the call rejects with
**`OrderStatusUnknownError`**. The order may exist.

An **abort after the request was handed over** is not an SDK error: the call rejects with the
signal's own reason, logs the outcome `unknown` with a WARNING, and never resends the order. Handle
it exactly like `OrderStatusUnknownError`: check `orders()` (a GTT or OCO: `pendingGtts()`) before sending
anything again.

A failure that provably happened _before_ sending (cannot connect, connect timeout, no free
connection) rejects with `NetworkError` or `RequestTimeoutError` instead: nothing was sent, so trying
again is safe.

**Tag every order.** Pass a short `tag` that is unique per order. It is sent as TradeSmart's
`remarks` field and comes back as `Order.tag`, `OrderHistoryEntry.tag` and `OrderUpdate.tag`.

```ts
import { randomBytes } from "node:crypto";
import {
  Exchange,
  OrderRejectedError,
  OrderStatusUnknownError,
  OrderType,
  Product,
  TradeSmart,
  TransactionType,
} from "tradesmart";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const client = TradeSmart.fromEnv();
try {
  const tag = `mystrat-${randomBytes(3).toString("hex")}`;
  let orderId: string | null = null;
  try {
    orderId = await client.placeOrder({
      exchange: Exchange.NSE,
      tradingsymbol: "SBIN-EQ",
      quantity: 1,
      transactionType: TransactionType.BUY,
      product: Product.CNC,
      orderType: OrderType.LIMIT,
      price: "500.05",
      tag,
    });
  } catch (error) {
    if (error instanceof OrderRejectedError) {
      console.error(`Rejected: ${error.emsg ?? ""}`); // definite: nothing to reconcile
    } else if (error instanceof OrderStatusUnknownError) {
      for (let i = 0; i < 5 && orderId === null; i++) {
        // the order book can lag a little
        orderId = (await client.orders()).find((o) => o.tag === tag)?.orderId ?? null;
        if (orderId === null) await sleep(2000);
      }
      // Found: it exists, follow it and do NOT place it again. Not found: alert a human.
      console.error(
        orderId === null ? `Outcome unknown; ${tag} not found yet` : `Found ${orderId}`,
      );
    } else {
      throw error;
    }
  }
} finally {
  await client.close();
}
```

Rules that keep you out of duplicate orders:

1. Never wrap an order call in your own retry loop.
2. After `OrderStatusUnknownError`, look for the tag **before** deciding anything. Found: the order
   exists, follow it. Not found: look again a little later; place a new order only when you are sure
   the first one does not exist (and give it a **new** tag).
3. The same applies to modify and cancel: read `orderHistory()` to see whether the change happened.
4. After a stream reconnect, call `orders()` and `positions()`: updates sent while the stream was
   down are not replayed.

## Rate limits

TradeSmart documents `PlaceOrder` at 30 per second and 600 per minute, but most client accounts are
limited to **10 orders per second**; a higher rate needs an exchange-approved strategy with an algo
ID. The SDK enforces 10 per second by default, per client, so use one client per account and process.
The default per-minute cap is **200** per rolling 60 seconds (1 to 600, never below the per-second
rate). In the default `"wait"` mode an order waits for a free slot for at most
`orderRateLimitMaxWait` (1 second); if it would have to wait longer it rejects with `RateLimitError`
and is **not sent**, so a stale order is never placed late. With `rateLimitMode: "raise"` it rejects
at once. Modify, cancel and the other order calls have no rate limit. Details:
[Configuration](configuration.md#rate-limits-and-retries).

### Algo ID

An exchange-approved algo ID is set once in the configuration and sent on every `PlaceOrder` and
`ModifyOrder`; a call can override it with its own `algoId`. A rate above 10 per second needs one.

```ts
import { ClientConfig, TradeSmart } from "tradesmart";

const config = ClientConfig.create({ algoId: "YOUR_ALGO_ID", orderRateLimitPerSecond: 20 });
const client = TradeSmart.fromEnv({ config });
await client.close();
```

## Sliced orders

An order larger than the exchange's freeze quantity must be sent in slices. `placeSlicedOrder` takes
every `placeOrder` parameter plus `maxSliceQuantity` and `maxSlices` (default 25). `quantity` is in
trade units, a whole multiple of the lot size, on every exchange. It reads the lot size from the
script master and the freeze quantity from `securityInfo()`, plans the slices and sends them one
after another through the `placeOrder` path (never retried, paced by the order rate limit); a
quantity within one slice goes out as one order.

```ts
import {
  Exchange,
  OrderStatusUnknownError,
  OrderType,
  Product,
  TradeSmart,
  TransactionType,
} from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  const result = await client.placeSlicedOrder({
    exchange: Exchange.NFO,
    tradingsymbol: "NIFTY26NOVFUT",
    quantity: 3510,
    transactionType: TransactionType.BUY,
    product: Product.NRML,
    orderType: OrderType.LIMIT,
    price: "10000.00",
    tag: "slices-0001",
  });
  console.log(result.complete, result.orderIds, result.unsentQuantity);
  if (result.error !== null) console.error(result.error.message); // a definite stop
} catch (error) {
  if (error instanceof OrderStatusUnknownError) {
    // One slice is ambiguous: error.slicedResult lists the slices placed before it.
    // Read orders() for the tag before sending anything again.
    console.error(error.slicedResult?.orderIds);
  } else {
    throw error;
  }
} finally {
  await client.close();
}
```

Problems that can be found before anything is sent reject first: `RangeError` for the contract, lot
size, freeze quantity, quantity or slice limits; `RequestValidationError` for a bad order parameter;
`ConfigurationError` when the rate-limit settings would stop the order part-way; `RateLimitError`
when the current minute has no room for all the slices. Sending stops at the first failure. A
definite one comes back as `{ complete: false, error }` with the slices placed so far; an ambiguous
one rejects with `OrderStatusUnknownError` carrying `slicedResult`. An abort or any other interruption
stops further slices and rejects with the original value.

## GTT orders

A GTT (good till triggered) order is held on TradeSmart's server as an alert. When the value the
alert watches crosses the trigger value, the server places the order. **A GTT whose condition is
already true when it is placed fires at once** and places a real order, so check the last price
first.

| Call                         | What it does                                   | Resolves with       |
| ---------------------------- | ---------------------------------------------- | ------------------- |
| `placeGtt(params)`           | Place a GTT (`PlaceGTTOrder`)                  | the alert id        |
| `modifyGtt(alertId, params)` | Replace a pending GTT (send every field again) | the acknowledged id |
| `cancelGtt(alertId)`         | Cancel a pending GTT                           | the acknowledged id |
| `pendingGtts()`              | GTTs waiting for their trigger                 | `Gtt[]`             |
| `triggeredGtts()`            | GTTs that fired                                | `TriggeredGtt[]`    |
| `gttAlertTypes()`            | The enabled alert families, such as `LTP`      | `string[]`          |

```ts
import {
  Exchange,
  GttAlertType,
  GttValidity,
  OrderType,
  Product,
  TradeSmart,
  TransactionType,
} from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  const alertId = await client.placeGtt({
    exchange: Exchange.NSE,
    tradingsymbol: "ITC-EQ",
    alertType: GttAlertType.LTP_BELOW, // wire code LTP_B_O: fires when the last price is below
    triggerValue: "200.00",
    quantity: 1,
    transactionType: TransactionType.BUY,
    product: Product.CNC,
    orderType: OrderType.LIMIT,
    price: "200.00",
    tag: "gtt-0001", // required: finds the GTT again after an unknown outcome
    alertValidity: GttValidity.GTT, // default; DAY ends it with the trading day
  });
  console.log(alertId);
  for (const gtt of await client.pendingGtts()) console.log(gtt.alertId, gtt.tag);
  await client.cancelGtt(alertId);
} finally {
  await client.close();
}
```

A `GTT`-validity alert lasts until it triggers or is cancelled, at most 365 days or the contract
expiry. The 13 alert types are the `GttAlertType` constants (`LTP_ABOVE`, `LTP_BELOW`,
`CHANGE_PERCENT_ABOVE`, ...); a percentage-change trigger may be negative. A GTT order's product is
`CNC`, `NRML` or `CO`, on NSE, NFO, BSE, BFO or MCX. `modifyGtt` has no defaults for `validity` and
`alertValidity`: pass both, so nothing changes by accident. After an unknown outcome find the GTT by
its tag in `pendingGtts()` and never place it again.

`cancelGtt` succeeds on the reply `OI deleted`; an `Invalid Oi` reply to `modifyGtt` or `cancelGtt`
(observed for an alert that no longer exists, an already cancelled one) throws `OrderRejectedError`,
decided by that reply alone. What the server answers to `modifyGtt` or `cancelGtt` on an OCO's alert
id is not documented (the offline broker answers `GTT not found to Modify` / `GTT not found to
Cancel`, an `OrderRejectedError`): use the OCO calls below for OCOs.

## OCO orders

An OCO (one-cancels-other) order is a multi-day exit with a **target** and a **stop-loss**, held on
TradeSmart's server as one alert. When the last price reaches one trigger, the server places that
side's order and drops the other. Bracket orders are intraday only; an OCO can stay for days. **A
trigger that is already crossed when the OCO is placed may fire at once** and places a real order,
so check the last price first.

| Call                          | What it does                                           | Resolves with       |
| ----------------------------- | ------------------------------------------------------ | ------------------- |
| `placeOco(params)`            | Place an OCO (`PlaceOCOOrder`)                         | the alert id        |
| `modifyOco(alertId, params)`  | Replace a pending OCO (send every field again)         | the acknowledged id |
| `cancelOco(alertId)`          | Cancel a pending OCO (`CancelOCOOrder`)                | the acknowledged id |
| `isOco(gtt)`, `ocoSides(gtt)` | Read an OCO row of `pendingGtts()` / `triggeredGtts()` | see below           |

`stopLoss` and `target` are legs: `{ triggerValue, price, orderType, triggerPrice }`. `orderType` is
`LIMIT` (default), `MARKET`, `SL` or `SL_M`; `price` is required for `LIMIT` and `SL`;
`triggerPrice` is required for `SL` and `SL_M` and refused for the others. A `MARKET` leg may be
refused by TradeSmart for API orders. The shared fields are `exchange`, `tradingsymbol`,
`transactionType`, `quantity`, `product` (`CNC`, `NRML` or `CO`), an optional `tag`, `validity`
(the orders' validity, default `DAY`) and `alertValidity` (the OCO's own: `GTT`, the default, or
`DAY`).

**The side rule.** A `BUY` OCO closes a short position: the stop-loss trigger must be **above** the
target trigger. A `SELL` OCO closes a long position: the stop-loss trigger must be **below** the
target trigger. Equal triggers are refused before anything is sent. The SDK always sends the
stop-loss as slot `x` and the target as slot `y`, as TradeSmart's web terminal does.

```ts
import { Exchange, Product, TradeSmart, TransactionType } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  // Exit a long position: SELL, stop-loss below the target.
  const alertId = await client.placeOco({
    exchange: Exchange.NSE,
    tradingsymbol: "ITC-EQ",
    transactionType: TransactionType.SELL,
    quantity: 1,
    product: Product.CNC,
    stopLoss: { triggerValue: "380.00", price: "379.50" }, // LIMIT by default
    target: { triggerValue: "450.00", price: "450.00" },
    tag: "oco-0001", // may not be listed on OCO rows: match by symbol and triggers too
  });
  console.log(alertId);
  await client.cancelOco(alertId);
} finally {
  await client.close();
}
```

`modifyOco(alertId, params)` takes the same fields and needs `validity` and `alertValidity` (no
defaults), so nothing changes by accident. Like the GTT writes, the three OCO calls are never retried;
after an unknown outcome find the OCO in `pendingGtts()` (by its alert id, or by comparing its symbol,
quantity and triggers with what you sent: the `tag` may not be listed on OCO rows) and never place it
again. `Invalid Oi` on a modify or cancel (observed for an alert that no longer exists, an already
cancelled one; the answer for a fired OCO has not been observed) is an `OrderRejectedError`, decided
by that reply alone. A success needs the reply `OI created`, `OI replaced` or `OI deleted` with an
alert id; any other reply is `OrderStatusUnknownError`.

**Reading back.** An OCO is listed with the GTTs. `isOco(gtt)` is true for an alert type of
`GttAlertType.OCO_BUY` or `OCO_SELL`, and `ocoSides(gtt)` returns `{ stopLoss, target }` (each a
`{ leg, triggerValue }`), or `null` when the row is ambiguous. It works for OCOs placed by any front
end, because it decides by trigger value and the alert type, not by slot. A cancelled OCO is listed
by `triggeredGtts()` with `stat` `CANCELLED`. What a fired OCO looks like has not been observed yet
(a question open with TradeSmart): whether its order carries `parentId` equal to the alert id, as a
fired GTT's does, is not known.

```ts
import { TradeSmart, isOco, ocoSides } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  for (const gtt of await client.pendingGtts()) {
    if (!isOco(gtt)) continue;
    const sides = ocoSides(gtt);
    if (sides === null) continue;
    console.log(gtt.alertId, "stop-loss", String(sides.stopLoss.triggerValue));
    console.log(gtt.alertId, "target", String(sides.target.triggerValue));
  }
} finally {
  await client.close();
}
```

`cancelGtt` and `modifyGtt` are not for OCOs: they refuse an OCO alert type. A runnable version of
this section is `examples/oco-exit.ts` (offline).

## Order logging

Each order call writes one `info` line to the `tradesmart.orders` logger ([Logging](logging.md)):

```
PlaceOrder accepted order_id=26110700000001 in 42 ms
```

| Word       | Meaning                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `accepted` | TradeSmart acknowledged the request (not a fill; check `orders()`)                                                      |
| `rejected` | TradeSmart answered with an error                                                                                       |
| `unknown`  | The outcome is unknown; also one `warn` line ("check orders() before acting"; a GTT or OCO write names `pendingGtts()`) |
| `not_sent` | The request never reached TradeSmart: no or an expired token, the SDK's rate limit, a closed client, a connect failure  |

Invalid parameters (`RequestValidationError`, `TypeError`) are refused before an order call starts
and log no line, and neither does an abort before the request was handed over. Prices, payloads and
tokens are never logged.

## Cancelling a call (AbortSignal)

Every method accepts `{ signal }`. Aborted **before** the request was sent (validation, a rate-limit
wait, waiting for a connection), nothing is sent and the call rejects with the signal's reason.
Aborted **after** sending started on an order call, the outcome is unknown: the call logs `unknown`,
warns, and rejects with the abort reason; the order may have been executed and is never resent. On a
read the abort reason is thrown and nothing is retried.

```ts
import { TradeSmart } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  const orders = await client.orders({ signal: AbortSignal.timeout(5000) });
  console.log(orders.length);
} finally {
  await client.close();
}
```

## Multi-leg and basket orders

`PlaceMultiOrder` exists in the API, but TradeSmart has not documented its request and response
format, so the SDK has no typed method for it. It can be reached through the low-level `request()`
([Reference](reference.md#low-level-request)), which applies the same never-retry rule, rate limit
and error handling.
