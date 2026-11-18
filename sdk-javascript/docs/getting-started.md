# Your first order in 10 minutes

A step-by-step path with the TradeSmart SDK for JavaScript and TypeScript: get API access, install,
log in, make a first call, find an instrument, and place, check, modify and cancel one order.

Trading involves real money. Every code block that places, modifies or cancels an order changes
your real account: run those only on a test account, or with prices far from the market as shown
here. Blocks that only read are marked "read-only". Every `ts` block on this page is complete: copy
it into a `.ts` file next to your project and run it (Node 22.18 or newer runs `.ts` files
directly with `node file.ts`; older Node 22 releases need a TypeScript runner such as `tsx`).

## 1. Get API access

No TradeSmart account yet? [Open one online](https://signup.tradesmartonline.in/?utm_source=TypeScriptSDK&utm_medium=Organic&utm_campaign=SDK_Open_Demat&utm_content=getting_started&channel=Organic&platform=web) first.

You need a TradeSmart trading account and an **API application** that you create yourself on the
TradeSmart web platform. For personal use this is self-service, free and immediate. It is a one-time
step in your browser, not in code.

1. Log in at <https://web.tradesmartonline.in> with your user ID, password and two-factor code, then
   open the **API Dashboard** (profile menu, **Tools**, **API**, or <https://web.tradesmartonline.in/api>).
2. Fill in **Generate New API Key**: a **Name** for your app, the **Primary IP Address** (the public
   static IP of the machine that will run your code), an optional secondary IP, and the **Redirect
   URL**. For the command-line login on your own computer use `http://127.0.0.1:8080/callback`.
   Tick the API terms and press **Generate API Key**.
3. TradeSmart requires a registered static IP. A server with a fixed IP is best; home connections
   often change theirs. Requests from other IPs may be refused.
4. The dashboard then lists **App ID** and **Secret Key** under **Active Credentials**.

| Credential     | What it is                                                                                                       | Keep it                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Client ID**  | Your TradeSmart trading account id                                                                               | Not secret                                   |
| **App Key**    | Identifies your app on the login page. The dashboard calls it "App ID"; the API and this SDK call it the App Key | Private: do not publish it                   |
| **Secret Key** | Proves that the token request comes from you                                                                     | Secret: never share it, never put it in code |

If a key leaks, remove the app on the API Dashboard and create a new one.

## 2. Install the SDK

You need **Node.js 22.12 or newer** (22, 24 and 26 are tested). The package is ESM-only; it can
also be loaded from CommonJS with `require("tradesmart")` (Node 22.12 and later), see
[`examples/commonjs-require.cjs`](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/examples/commonjs-require.cjs).

```bash
npm install tradesmart
```

The SDK has four runtime dependencies (`decimal.js`, `undici`, `ws`, `fflate`). Check the install:

```ts
import { VERSION } from "tradesmart";

console.log(VERSION); // 2.0.0
```

## 3. Log in once a day

TradeSmart access tokens are valid until the **next 06:00 IST**, so you log in once per trading
day, on the machine that will trade.

The package ships a login command (`npx tradesmart login`, or `tradesmart login` once the package
is installed). It saves the same login file the Python SDK's `python -m tradesmart login` writes,
so one login serves both SDKs:

```bash
npx tradesmart login
```

It asks for your Client ID, App Key and Secret Key (the Secret Key without echo; the keys are saved
for the next login, `--no-save-keys` skips that), opens the TradeSmart login page and waits for
the redirect to `http://127.0.0.1:8080/callback`. If no browser can be opened, the port is busy or
you pass `--no-browser`, it prints the URL and asks you to paste the code or the whole redirect
URL. `npx tradesmart token-path` prints the token file and `npx tradesmart logout` removes it
(`--forget-keys` also removes the saved keys). With Docker, from a clone of the repository's
`sdk-javascript` folder:

```bash
docker compose run --rm --service-ports login --client-id YOUR_CLIENT_ID
```

The token is saved in a file only your user can read (`%APPDATA%\tradesmart\token.json` on Windows,
`~/.config/tradesmart/token.json` on Linux and macOS, or the path in `TRADESMART_TOKEN_FILE`). The
JavaScript SDK finds it with `TradeSmart.fromEnv()`. Other ways to supply credentials:

- Set `TRADESMART_CLIENT_ID` and `TRADESMART_ACCESS_TOKEN` in the environment (both are needed).
- Log in from your own code with the App Key, Secret Key and the one-time code
  ([Your own login flow](#your-own-login-flow)).

### Your own login flow

A web application that other people log into sends the browser to `loginUrl()`; TradeSmart then
redirects to your Redirect URL with a single-use `code`, which `generateSession()` exchanges for a
token (never retried; the code is spent after one try).

```ts
import { TradeSmart } from "tradesmart";

const client = new TradeSmart("YOUR_CLIENT_ID", {
  appKey: "YOUR_APP_KEY",
  secretKey: process.env["TRADESMART_SECRET_KEY"] ?? "",
});

console.log(`Open this address in a browser: ${client.loginUrl()}`);
// ... the user logs in; your Redirect URL handler receives ?code=... ...
const code = "THE_CODE_FROM_THE_REDIRECT";
const token = await client.generateSession(code); // stored on the client; also returned
console.log(token.toString()); // the token itself is masked: AccessToken(..., access_token=***)
await client.close();
```

The tokens are masked everywhere they could be printed (`toString`, `console.log`, JSON, errors and
logs). Never commit them.

## 4. Your first call

Read-only:

```ts
import { TradeSmart } from "tradesmart";

const client = TradeSmart.fromEnv(); // the saved login, or TRADESMART_* variables
try {
  const profile = await client.profile();
  console.log(`Logged in as ${profile.uname ?? "?"} (${profile.userId ?? "?"})`);
  const margins = await client.margins();
  console.log(`Cash: ${margins.cash?.toFixed(2) ?? "n/a"}`);
} finally {
  await client.close(); // releases the connections
}
```

Every method returns a `Promise`. Prices and money are `Decimal` values (from `decimal.js`, exported
by the package), never `number`s: print them with `.toFixed(2)` or `.toString()`. Fields TradeSmart
did not send are `null`. The client also has `Symbol.asyncDispose`: with TypeScript 5.2 or newer,
`await using client = TradeSmart.fromEnv();` closes it at the end of the block (Node 24 and later run
that syntax natively; `tsc` compiles it for older Node).

## 5. Find an instrument

An instrument is identified by its exchange and its **token** (a string such as `"3045"`). Search by
text, or read the whole script master ([Instruments](instruments.md)). Read-only:

```ts
import { Exchange, TradeSmart } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  const matches = await client.searchInstruments("SBIN");
  for (const m of matches.slice(0, 5)) {
    console.log(`${m.exchange ?? "?"} ${m.tradingsymbol ?? "?"} token ${m.token ?? "?"}`);
  }
  const sbin = matches.find((m) => m.exchange === Exchange.NSE && m.tradingsymbol === "SBIN-EQ");
  if (sbin?.token != null) {
    const quote = await client.quote(Exchange.NSE, sbin.token);
    console.log(
      `Last price ${quote.lastPrice?.toFixed(2) ?? "n/a"}, tick ${sbin.tickSize?.toString() ?? "?"}`,
    );
  }
} finally {
  await client.close();
}
```

## 6. Place your first order, safely

**This places a real order.** Use a test account. The order below is a one-share LIMIT buy at a price
far below the market, so it should rest unfilled. TradeSmart does not accept MARKET orders from the
API. Prices must be on the instrument's tick grid: `roundToTick` returns the price as text.

```ts
import {
  Exchange,
  OrderRejectedError,
  OrderStatusUnknownError,
  OrderType,
  Product,
  TradeSmart,
  TransactionType,
  roundToTick,
} from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  const price = roundToTick("250.03", "0.05"); // "250.05"; use a price far from the market
  const tag = "first-order-0001"; // unique per order; sent as `remarks`, returned on the order
  try {
    const orderId = await client.placeOrder({
      exchange: Exchange.NSE,
      tradingsymbol: "SBIN-EQ",
      quantity: 1,
      transactionType: TransactionType.BUY,
      product: Product.CNC,
      orderType: OrderType.LIMIT,
      price,
      tag,
    });
    console.log(`Accepted: order id ${orderId} (accepted is not filled)`);
  } catch (error) {
    if (error instanceof OrderRejectedError) {
      console.error(`Rejected: ${error.emsg ?? error.message}`); // definite: nothing was placed
    } else if (error instanceof OrderStatusUnknownError) {
      // It may exist. Look for the tag in orders(); never send the order again.
      const found = (await client.orders()).filter((o) => o.tag === tag);
      console.error(`Outcome unknown; orders with this tag: ${String(found.length)}`);
    } else {
      throw error;
    }
  }
} finally {
  await client.close();
}
```

`placeOrder` resolves with the order id only when TradeSmart accepted the request. It is never
retried, and an unclear outcome (a timeout after sending, a dropped connection, an unreadable answer)
rejects with `OrderStatusUnknownError`: see [Orders](orders.md#recovery-tag-every-order-never-resend-blindly).

## 7. Check the status

The order's row in today's order book (`orders()`, one row per order) holds its current status:

```ts
import { OrderStatus, TradeSmart } from "tradesmart";

const FINAL: readonly string[] = [OrderStatus.COMPLETE, OrderStatus.CANCELED, OrderStatus.REJECTED];
const client = TradeSmart.fromEnv();
try {
  const orderId = "THE_ORDER_ID";
  const row = (await client.orders()).find((o) => o.orderId === orderId);
  if (row === undefined) {
    console.log("Not in the order book yet; look again in a moment");
  } else {
    const done = row.status !== null && FINAL.includes(row.status);
    console.log(
      `${row.status ?? "?"}${done ? " (final)" : ""}, filled ${String(row.filledQuantity ?? 0)}`,
    );
  }
  for (const entry of await client.orderHistory(orderId)) {
    console.log(`  history: ${entry.status ?? "?"} ${entry.rejectReason ?? ""}`);
  }
} finally {
  await client.close();
}
```

## 8. Modify, then cancel

`modifyOrder` needs the order's exchange, symbol, quantity, price, type and product again. **This
changes a real order.**

```ts
import { Exchange, OrderType, Product, TradeSmart } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  const orderId = "THE_ORDER_ID";
  await client.modifyOrder(orderId, {
    exchange: Exchange.NSE,
    tradingsymbol: "SBIN-EQ",
    quantity: 1,
    price: "250.10",
    orderType: OrderType.LIMIT,
    product: Product.CNC,
  });
  await client.cancelOrder(orderId); // cancel it by id
} finally {
  await client.close();
}
```

## 9. Watch order updates live

Instead of polling `orders()`, subscribe to order updates on the stream ([Streaming](stream.md)):

```ts
import { TradeSmartStream } from "tradesmart";

const stream = TradeSmartStream.fromEnv({
  onOrderUpdate: (update) => {
    console.log(`${update.orderId ?? "?"} ${update.status ?? "?"} ${update.tag ?? ""}`);
  },
});
await stream.connect();
await stream.subscribeOrders();
await new Promise((resolve) => setTimeout(resolve, 30_000));
await stream.close();
```

## 10. If something goes wrong

| What you see                                         | What it means and what to do                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ConfigurationError` mentioning a login              | No saved login and no token in the environment: log in (step 3)                              |
| `AuthenticationError`                                | The token is missing, expired (tokens end at 06:00 IST) or refused: log in again             |
| `RequestValidationError`                             | A parameter is wrong; nothing was sent. `error.errors` lists the wire keys, never the values |
| `OrderRejectedError`                                 | TradeSmart refused the order; `error.emsg` says why. Definite: nothing was placed            |
| `OrderStatusUnknownError`                            | The order may exist. Find it by its tag in `orders()`; do not resend                         |
| `NetworkError`, `RequestTimeoutError` before sending | Nothing was sent; reads are retried for you, a write may be tried again by you               |
| Refused from an IP address                           | The static IP registered on the API Dashboard differs from the machine's public IP           |

More: [Errors](errors.md).

## Next steps

- [Orders](orders.md): every order call, validation, GTT, sliced orders, recovery.
- [Streaming](stream.md): live prices and order updates.
- [Instruments](instruments.md): the script master.
- [Configuration](configuration.md): settings, environment variables, rate limits and retries.
- [Examples](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/tree/main/sdk-javascript/examples).
