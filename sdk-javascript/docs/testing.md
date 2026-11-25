# Testing your code

How to test code that uses the SDK without an account, a network or a market, and how the SDK's own
tests are run.

`tradesmart/testing` provides `OfflineBroker`, a local TradeSmart that runs inside your test. Your code
uses the real `TradeSmart` client and the real `TradeSmartStream`; only the server is local. You need no
account, keys, network, static IP or open market. The broker never decides a price or a fill: your test
does. The later sections show lower-level building blocks (a scripted REST dispatcher, your own stream
server) for cases the broker does not model.

## The offline broker

A complete test (any runner): set the market, create the client, run your code, fill the order.

```ts
import { OfflineBroker } from "tradesmart/testing";
import { OrderStatus, OrderType, Product, TransactionType, type TradeSmart } from "tradesmart";

async function myStrategy(client: TradeSmart): Promise<void> {
  // your code: buy ACC-EQ when it is at or below 100
  const quote = await client.quote("NSE", "22");
  if (quote.lastPrice !== null && quote.lastPrice.lte(100)) {
    await client.placeOrder({
      exchange: "NSE",
      tradingsymbol: "ACC-EQ",
      quantity: 10,
      transactionType: TransactionType.BUY,
      product: Product.MIS,
      orderType: OrderType.LIMIT,
      price: "100",
    });
  }
}

await using broker = new OfflineBroker();
broker.addInstrument("NSE", "22", "ACC-EQ"); // 1. set the market
broker.setQuote("NSE", "22", { lastPrice: "99.50" });
const client = broker.client(); //              2. a real client, already logged in
await myStrategy(client); //                    3. run your code
const order = broker.orders.at(-1); //          4. check what it sent
console.log(order?.side, order?.quantity); // B 10
broker.fill(order?.id ?? "", "100"); //         5. fill it
console.log((await client.orders())[0]?.status === OrderStatus.COMPLETE); // true
```

`import "tradesmart"` never loads the broker. Use `await using` (or `await broker.close()`): it stops the
streams and the server and deletes the broker's private script-master folder. A client or stream the
broker built keeps it alive, so a helper may return only `broker.client()`.

| Method                                                                                                                     | What it sets or does                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `addInstrument(exchange, token, symbol, { lotSize, tickSize, instrument, expiry, strike, optionType, underlying, extra })` | An instrument: search, `instruments()`, the script master, option chains and Greeks all use it                                         |
| `setQuote(exchange, token, fields)`                                                                                        | `lastPrice`, `open`, `high`, `low`, `close`, `volume`, `oi`, `changePercent`, `bid`, `ask`, `bidQty`, `askQty` (or the API's own keys) |
| `tick(exchange, token, fields)`                                                                                            | Like `setQuote`, and pushes the change to subscribed streams                                                                           |
| `setCandles(exchange, token, candles)`                                                                                     | The candles `historicalData()` and `dailyHistory()` return                                                                             |
| `setFunds(wire)`, `setUser(wire)`                                                                                          | `margins()` and `profile()`, with the API's keys                                                                                       |
| `setHoldings(rows)`, `setPositions(rows)`                                                                                  | `holdings()` and the starting `positions()`                                                                                            |
| `setReply(endpoint, body)`                                                                                                 | A fixed reply for one endpoint the broker does not model                                                                               |
| `accept(id)`, `reject(id, message)`, `fill(id, price, quantity?)`, `cancel(id)`, `trigger(id)`                             | Move an order through its lifecycle                                                                                                    |
| `triggerGtt(alertId)`                                                                                                      | Fire a pending GTT: its order is placed and the GTT becomes a triggered one                                                            |
| (no OCO triggering)                                                                                                        | An OCO is placed, listed, modified and cancelled, but never fired: `triggerGtt` on an OCO throws, as no fired OCO has been observed    |
| `defaultPlace`                                                                                                             | How a new order is booked: `"open"` (default), `"pending"` or `"reject"`                                                               |
| `orders`, `requests`, `clientId`                                                                                           | What your code sent: the orders, every REST call (secrets masked) and the account id                                                   |

`quote()` of an instrument with no `setQuote` is an `APIError` ("no data"); quote fields you do not set
are zero. A value that is not a number, or an unknown field name, throws a `RangeError`.

### Failure drills

`broker.failNext(endpoint, drill)` arms one failure for the next call of that endpoint. It fires once and
at once (no test waits for a real timeout). Build drills with `drills`:

```ts
import { OfflineBroker, drills } from "tradesmart/testing";
import { OrderStatusUnknownError } from "tradesmart";

await using broker = new OfflineBroker();
broker.addInstrument("NSE", "22", "ACC-EQ");
const client = broker.client({ maxRetries: 0 });

broker.failNext("PlaceOrder", drills.timeoutAfterSend()); // the order IS booked, the reply is lost
try {
  await client.placeOrder({
    exchange: "NSE",
    tradingsymbol: "ACC-EQ",
    quantity: 1,
    transactionType: "B",
    product: "I",
    orderType: "LMT",
    price: "100",
    tag: "test-0001",
  });
} catch (error) {
  console.log(error instanceof OrderStatusUnknownError); // true: look the tag up, never resend
  console.log(broker.orders.length); // 1
}
```

| Drill                                   | The next call of the endpoint                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `drills.reject(message)`                | is answered `Not_Ok` with that `emsg`                                                                  |
| `drills.timeoutAfterSend()`             | takes effect but the client gets a read timeout (an order: `OrderStatusUnknownError`)                  |
| `drills.connectError()`                 | fails before anything is sent; nothing takes effect                                                    |
| `drills.rateLimit(retryAfter?)`         | is answered HTTP 429, with `Retry-After` when given                                                    |
| `drills.serverError(status?, { json })` | is an HTTP 5xx: an HTML page by default (an order: unknown outcome), a JSON `Not_Ok` with `json: true` |
| `drills.badBody()`                      | gets a reply that is not JSON                                                                          |
| `drills.sessionExpired()`               | is answered `Not_Ok` "Session Expired"                                                                 |

Pass `{ maxRetries: 0 }` to `client()` to see a read drill's error instead of the SDK's own retry. A write
is never retried.

### Greeks and analytics offline

Options added with `addInstrument` (with `instrument`, `expiry`, `strike`, `optionType` and `underlying`)
feed the script master and option chains, so `optionGreeks`, `optionChainSnapshot` and `buildup` run
against the broker too. The
[offline example](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/examples/offline-broker-test.ts)
does this end to end.

## Answer the REST calls yourself

The client accepts any undici `Dispatcher` as `httpDispatcher`. undici's `MockAgent` answers
requests from a script, so no request leaves your machine. Install `undici` in your project's dev
dependencies for this.

```ts
import { MockAgent } from "undici";
import { TradeSmart } from "tradesmart";

const agent = new MockAgent();
agent.disableNetConnect(); // any unscripted request fails

agent
  .get("https://v2api.tradesmartonline.in")
  .intercept({ path: "/NorenWClientAPIv2/UserDetails", method: "POST" })
  .reply(200, JSON.stringify({ stat: "Ok", uid: "TEST01", uname: "Test User" }));

const client = new TradeSmart("TEST01", {
  accessToken: "a-synthetic-token", // never a real token in a test
  httpDispatcher: agent,
});
const profile = await client.profile();
console.log(profile.uname); // Test User
await client.close();
await agent.close();
```

The same technique drives the failure drills that matter most for order code. Script a read timeout
or a dropped connection for `PlaceOrder` and check that your code handles `OrderStatusUnknownError`
by looking up the tag, never by resending:

```ts
import { MockAgent } from "undici";
import {
  Exchange,
  OrderStatusUnknownError,
  OrderType,
  Product,
  TradeSmart,
  TransactionType,
} from "tradesmart";

const agent = new MockAgent();
agent.disableNetConnect();
agent
  .get("https://v2api.tradesmartonline.in")
  .intercept({ path: "/NorenWClientAPIv2/PlaceOrder", method: "POST" })
  .replyWithError(new Error("socket hang up")); // the reply is lost after sending

const client = new TradeSmart("TEST01", {
  accessToken: "a-synthetic-token",
  httpDispatcher: agent,
});
try {
  await client.placeOrder({
    exchange: Exchange.NSE,
    tradingsymbol: "SBIN-EQ",
    quantity: 1,
    transactionType: TransactionType.BUY,
    product: Product.CNC,
    orderType: OrderType.LIMIT,
    price: "500.05",
    tag: "test-0001",
  });
} catch (error) {
  console.log(error instanceof OrderStatusUnknownError); // true: and no retry was sent
}
await client.close();
await agent.close();
```

Use a base URL of your own (`ClientConfig.create({ baseUrl })`) when your test server is not on the
default host. Use synthetic values only: no real token, key or account id belongs in a test or a
fixture.

## The offline broker's stream

`broker.stream(callbacks?)` gives a real `TradeSmartStream` (not yet connected; call `connect()`)
wired to the offline broker's WebSocket server on `127.0.0.1`. Streams reconnect after about 1 ms
and send a heartbeat every 0.5 s, so no reconnect waits in real time.
`TradeSmartStream.fromClient(broker.client())` works too; close that stream yourself.

```ts
import { OfflineBroker } from "tradesmart/testing";

await using broker = new OfflineBroker();
broker.addInstrument("NSE", "22", "ACC-EQ");
const ticks: unknown[] = [];
const stream = broker.stream({ onTouchline: (message) => void ticks.push(message.raw) });
await stream.connect();
await stream.subscribeTouchline(["NSE|22"]); // its `tk` reply arrives in `ticks`
broker.tick("NSE", "22", { lastPrice: "99.90" }); // then a `tf` message
```

`broker.tick(exchange, token, fields)` takes the fields of `setQuote` and sends a touchline (`tf`)
and depth (`df`) message to the streams subscribed to that instrument. Order changes reach streams
subscribed with `subscribeOrders()` as `om` messages and fills reach `subscribePositions()` as
`pm` messages, in the order they happened.

An order subscription has no reply (the API documents none). To know it is active, subscribe to
something with a reply after it, for example `subscribePositions()`, and wait for its message.

| Stream drill                                       | What happens                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `broker.dropStream()`                              | Cuts every stream connection; the real client reconnects and subscribes again                     |
| `broker.refuseStreamLogin()`                       | The next stream login is refused (`AuthenticationError`)                                          |
| `broker.silenceStream()` / `broker.resumeStream()` | Stops / restarts answering heartbeats; the client notices the silence in about 1 s and reconnects |

`await broker.close()` stops the streams built by `broker.stream()`, the server, and deletes the
private script-master folder (`await using` does the same at the end of the block). A broker you
never close is cleaned up once it and every client and stream built from it are garbage collected;
each of them keeps the broker alive meanwhile.

Importing `tradesmart/testing` binds one loopback port (127.0.0.1, unreferenced, so it never keeps
your process alive). All offline brokers in the process share it; each has its own unguessable URL
path, and a connection to any other path is refused. The module uses top-level `await`, so it is
ESM-only: load it with `import` or `await import()`. `require()` and Jest in CommonJS mode cannot
load it. If the port cannot be bound, the import rejects with an error naming the cause.

## Test the stream

The stream connects to `config.wsUrl`. Point it at a local `ws` server in your test
(`ClientConfig.create({ wsUrl: "ws://127.0.0.1:PORT" })`), answer the connect request with the
documented reply and send the frames you want to test. The SDK's own tests do this; see
`tests/integration/ws-server.ts` in the repository for a small helper.

## Keep the saved login out of tests

`fromEnv()` reads the saved login. A test that builds a client with `fromEnv()` should point
`TRADESMART_TOKEN_FILE` at an empty temporary folder, or build the client explicitly with
`new TradeSmart(clientId, { accessToken })` as above.

## The SDK's own test suite

Everything runs in Docker from `sdk-javascript/`, never on your host
([CONTRIBUTING.md](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/CONTRIBUTING.md)):

```bash
docker compose run --rm dev npm test            # unit, conformance and mocked integration tests
docker compose run --rm dev npm run test:cov    # with the coverage floor
```

The default run allows no network except loopback and uses an empty temporary folder for the saved
login. A live suite is opt-in (`TRADESMART_LIVE_TESTS=1`) and read-only. Live order tests are a
separate opt-in on a designated test account, are never part of a default run and never run on a
funded account without their own gates. They are driven from the shared live-order matrix in a later
release; they are not described further here because a user's own code should not place orders in
tests.
