# Errors and troubleshooting

Every error the SDK throws is a `TradeSmartError` (a subclass of `Error`). The fields are camelCase.
Match on the class with `instanceof`; the `name` property is the class name.

```
TradeSmartError
├── ConfigurationError            bad settings, no token, a closed client, a bad request() name
├── RequestValidationError        a parameter failed a client-side check (`errors`)
├── SubscriptionLimitError        more than 1,000 stream subscriptions
├── TransportError
│   ├── NetworkError              the connection could not be opened or was lost
│   └── RequestTimeoutError       a timeout
├── OrderStatusUnknownError       a write may or may not have been executed
├── ResponseParseError            the body was not the expected JSON, or a record would not parse
└── APIError                      the API answered with an error
    ├── AuthenticationError       missing, invalid or expired credentials
    ├── RateLimitError            server 429 or the SDK's own limiter (`retryAfter`)
    ├── NotFoundError             HTTP 404
    ├── ServerError               HTTP 5xx on a read
    └── OrderRejectedError        Not_Ok on a write: the request was not accepted
```

A bad argument that is a programming error rather than a data problem, such as an option name the
SDK does not know, is a plain `TypeError`, and nothing is sent. An abort rejects with the signal's own
reason (usually an `AbortError`), never an SDK error.

## Handling errors

```ts
import {
  APIError,
  AuthenticationError,
  OrderRejectedError,
  OrderStatusUnknownError,
  RateLimitError,
  RequestValidationError,
  TradeSmart,
  TradeSmartError,
  TransportError,
} from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  console.log((await client.margins()).cash?.toFixed(2));
} catch (error) {
  if (error instanceof RequestValidationError) {
    for (const issue of error.errors) console.error(issue.loc.join("."), issue.type, issue.msg);
  } else if (error instanceof AuthenticationError) {
    console.error("Log in again"); // checked before RateLimitError and APIError: it is a subclass
  } else if (error instanceof RateLimitError) {
    console.error(`Wait ${String(error.retryAfter ?? "a moment")} seconds`);
  } else if (error instanceof OrderRejectedError) {
    console.error(error.emsg); // a definite refusal of a write
  } else if (error instanceof OrderStatusUnknownError) {
    console.error(error.endpoint, error.httpStatus); // do not resend: see Orders
  } else if (error instanceof APIError) {
    console.error(error.endpoint, error.httpStatus, error.emsg);
  } else if (error instanceof TransportError) {
    console.error("Network problem:", error.message);
  } else if (error instanceof TradeSmartError) {
    console.error(error.message);
  } else {
    throw error;
  }
} finally {
  await client.close();
}
```

## What each error carries

| Error                     | Fields                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `RequestValidationError`  | `errors`: a list of `{ type, loc, msg }`; `loc` is the wire key (for example `["qty"]`), `msg` never holds the value |
| `APIError` and subclasses | `endpoint`, `httpStatus` (`null` for the SDK's own checks), `emsg`, `requestTime`, `raw`                             |
| `RateLimitError`          | the `APIError` fields and `retryAfter` (seconds, or `null`)                                                          |
| `OrderStatusUnknownError` | `endpoint`, `httpStatus`, `body` (redacted, at most 2,000 characters), `slicedResult`                                |
| `ResponseParseError`      | `endpoint`, `httpStatus`, `body`, `model`, `fields` (wire keys, never values), `protectedKey`                        |

Errors on the REST path chain no `cause`: a cause could hold raw values or request headers.

### Reading `APIError.raw`

`raw` is the response body as received, redacted. **JSON numbers inside it are kept losslessly as
exact text values, not floats**: a quantity of `9007199254740993` or a price of `101.10` keeps every
digit. Each such value is an object whose `String(value)` is the number's exact text. Convert with
`Decimal` when you need arithmetic.

```ts
import { APIError, Decimal } from "tradesmart";

function numberFrom(error: APIError, key: string): Decimal | null {
  const raw = error.raw;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value: unknown = (raw as Record<string, unknown>)[key];
  return value === undefined || value === null ? null : new Decimal(String(value));
}

export { numberFrom };
```

### `emsg` is redacted

The `emsg` attribute, like `raw`, `body` and every log line, has secrets masked (tokens, secret keys,
checksums, codes): a server message that echoes one shows `***` instead. Masking is by key name and
pattern; values you put into your own messages under other names are not masked.

## What counts as "unknown" on a write

A state-changing call rejects with `OrderStatusUnknownError` when the request may have reached
TradeSmart and no definitive answer came back: a timeout after sending, a dropped or reset
connection, a gateway error page, a body that cannot be read, a body that is not JSON (including one
containing `NaN` or `Infinity`, which JSON does not allow), a success that lacks the documented
`stat` word, and **a non-certificate TLS error after the connection opened**. An abort after the
request was handed over is not an SDK error: the call rejects with the signal's own reason, logs
`unknown` with a WARNING and never resends; handle it like `OrderStatusUnknownError` (check
`orders()`, a GTT: `pendingGtts()`, before sending anything again). A certificate failure, a refused connection, a connect timeout or no free
connection provably sent nothing and reject with `NetworkError` or `RequestTimeoutError` instead.
For a **read**, a body with `NaN` or `Infinity` is a `ResponseParseError`.

The SDK never retries a write, whatever the failure. See
[Orders: recovery](orders.md#recovery-tag-every-order-never-resend-blindly).

## `request()` values

The low-level `request()` converts payload values to wire text. A `null` or `undefined` value, or a
non-finite number (`NaN`, `Infinity`), throws a `TypeError` before anything is sent. A string is sent
as is, a boolean as `Yes` or `No`, a finite number or `Decimal` as plain decimal text, a `bigint` as
its digits.

## Troubleshooting

### Login and access

| Symptom                                                                              | Cause and fix                                                                                                                                                                             |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConfigurationError` naming a login, from `fromEnv()`                                | No usable saved login: never logged in, a login for another client id, or an unsafe token file (on Linux and macOS it must be readable only by you). The message says which. Log in again |
| `ConfigurationError: TRADESMART_ACCESS_TOKEN is set but TRADESMART_CLIENT_ID is not` | A token from the environment is never paired with the saved login's client id. Set both, or unset the token to use the saved login                                                        |
| `ConfigurationError` about a closed client                                           | The client was closed; nothing was sent. Create a new client                                                                                                                              |
| `AuthenticationError: No usable access token` or `Access token expired`              | TradeSmart tokens end at the next 06:00 IST. Log in again and create a new client. If the machine's clock is wrong, fix it (`checkTokenExpiry: false` lets the server decide)             |
| `AuthenticationError` on every call although the token is fresh                      | Compare the machine's public IP with the **Primary** and **Secondary Static IP** of your app on the API Dashboard. The registered IP can be changed at most 2 times per day               |
| `GenAcsTok` failed, "authorisation code is single-use"                               | The one-time code was used, expired, or its outcome is unknown. Restart the login: a code never works twice                                                                               |

### Orders

| Symptom                                                        | Cause and fix                                                                                                                                                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RequestValidationError`                                       | The order broke a rule; nothing was sent. `error.errors` lists the wire keys. See [validation](orders.md#validation-before-sending)                                                      |
| `TypeError` about an unknown option                            | A property name the SDK does not know (a typo). Nothing was sent                                                                                                                         |
| `OrderRejectedError`                                           | TradeSmart or the exchange refused the request; read `error.emsg` (insufficient funds, price outside the band, market closed, MARKET not allowed for API orders). Retrying will not help |
| `OrderStatusUnknownError`                                      | The request may or may not have reached the exchange. **Do not resend.** Find the order by its tag in `orders()`                                                                         |
| `RateLimitError` with `httpStatus` `null`                      | The SDK's own limiter: an order would have waited more than 1 s, or `rateLimitMode` is `"raise"`. Nothing was sent; wait `retryAfter` seconds                                            |
| The order is `REJECTED` although `placeOrder()` returned an id | `placeOrder()` only confirms that TradeSmart accepted the request; the exchange or risk checks can still reject it. Read `rejectReason`                                                  |
| A symbol such as `M&M-EQ`                                      | Pass it unescaped; the SDK encodes `&`, `+` and `%`                                                                                                                                      |

### Market data

| Symptom                                       | Cause and fix                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Candles miss today                            | `istDate(...)` means 00:00 IST, so a date ends at midnight. Pass `new Date()` to include today             |
| `RequestValidationError` for the field `time` | Use a `Date`, integer epoch seconds or `istDate("YYYY-MM-DD")`                                             |
| `RangeError` about an exchange                | Use `NSE`, `BSE`, `NFO`, `BFO`, `CDS`, `BCD` or `MCX`                                                      |
| `ResponseParseError` about the script master  | The cached instrument file is damaged. Delete the file named in the message and call `instruments()` again |

### Streaming

| Symptom                                              | Cause and fix                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `AuthenticationError` from `connect()`               | Wrong client id or an expired token. Terminal: log in again and create a new stream               |
| `NetworkError: reconnect attempts exhausted`         | The connection kept failing. Check connectivity and the static IP; raise `reconnectMaxAttempts`   |
| Warning "falling behind"                             | Your callbacks are slower than the feed; price updates are being merged (order updates never are) |
| `SubscriptionLimitError`                             | More than 1,000 touchline and depth subscriptions on one stream. Unsubscribe some                 |
| `TradeSmartError: connect() can only be called once` | Streams are single-use. Create a new one                                                          |

### Unexpected data

A `ResponseParseError` means TradeSmart sent something the SDK would not guess at: `error.body` holds
the redacted response, `error.fields` the wire keys that failed. Please report it with the body.
