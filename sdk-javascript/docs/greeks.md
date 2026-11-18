# Option Greeks

Two ways to get implied volatility (IV), delta, gamma, theta, vega and rho:

| What                                                              | Where                                 | Network                            |
| ----------------------------------------------------------------- | ------------------------------------- | ---------------------------------- |
| `client.optionGreeks(exchange, tradingsymbol, options)`           | the client                            | reads the script master and quotes |
| `black76`, `blackScholes`, `impliedVolatility`, `greeksFromPrice` | `import ... from "tradesmart/greeks"` | none: pure functions               |

Neither places or changes an order.

> **The Greeks are estimates.** The SDK computes them with standard option-pricing models from the
> prices TradeSmart gives you. They are **not** exchange values, they can differ from the numbers other
> platforms show (a different rate, dividend, expiry time or future), and they must not be the only
> basis for a risk decision.

## `optionGreeks()`

Symbols below are placeholders; copy a real option `tradingsymbol` from `client.searchInstruments()`
or the script master.

```ts
import { Exchange, TradeSmart } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  const g = await client.optionGreeks(Exchange.NFO, "YOUR_NFO_OPTION_SYMBOL");
  console.log(g.status, g.iv, g.delta, g.gamma, g.theta, g.vega, g.rho);
  console.log(g.model, g.underlyingTradingsymbol, g.forward, g.yearsToExpiry);
} finally {
  await client.close();
}
```

The result (`OptionGreeks`) holds the Greeks and every input the SDK used (the option price, the
underlying price, `forward`, the rate, the expiry instant), so a number can be explained. The SDK
fetches what you do not supply: the instrument list (kept on the client, one parsed copy per exchange,
read again only when the script-master file changes) and at most two `quote()` calls (the option and its
future). Every argument is checked before any request is sent.

### Rate and dividend yield

| Option          | Default                | Used by                                                                               |
| --------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| `rate`          | `0.065` (6.5 % a year) | both models, and the carry below                                                      |
| `dividendYield` | `0`                    | the spot model (`spotPrice`) and the carry for a future of another expiry (see below) |

Both are annual, continuously compounded numbers (`0.065` is 6.5 %). Pass them on each call; nothing is
stored on the client. A value that is not a finite number throws a `RangeError` naming the option. The
defaults are exported as `DEFAULT_RATE` and `DEFAULT_DIVIDEND_YIELD` from `tradesmart/greeks`.

```ts
import { Exchange, TradeSmart } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  const g = await client.optionGreeks(Exchange.NFO, "YOUR_NFO_OPTION_SYMBOL", {
    rate: 0.07,
    dividendYield: 0.012,
    spotPrice: 24500, // Black-Scholes-Merton on this spot price
  });
  console.log(g.model, g.iv);
} finally {
  await client.close();
}
```

### Which model and which underlying

- **Default: Black-76 on the underlying future.** The SDK finds the future in the instrument list and
  quotes it. It prefers the future with the same expiry as the option, else the nearest later one, else
  the nearest earlier one. On NFO, BFO, CDS and BCD a future of a different expiry is brought to the
  option's expiry with `forward = F × e^(−(rate − dividendYield) × (Tf − To))`; the result's `forward` is
  that adjusted price and `sameExpiryFuture` is `false`. **Set `dividendYield` for these options** (for an
  index option, the index's dividend yield; for a currency option, the foreign currency's interest
  rate), or pass `underlyingPrice` with your own forward for the option's expiry.
- **MCX: no carry.** An MCX option is on the future itself, so `forward` is that future's quoted price.
- **`underlyingPrice`:** you give the future's price; no future is selected and no carry applied
  (`sameExpiryFuture` is `null`).
- **`spotPrice`:** Black-Scholes-Merton on that spot price. Passing both `spotPrice` and
  `underlyingPrice` throws a `RangeError`.
- **`optionPrice`:** overrides the option's last traded price (otherwise fetched with `quote()`).

### Expiry time and units

Time to expiry runs to the exchange's closing instant on the expiry date, in IST: NFO and BFO 15:30,
CDS and BCD 12:30, MCX 23:30. Pass `expiryTime: "17:00"` (`HH:MM` or `HH:MM:SS`, read as IST) to use
another time, and for any exchange not in that list. Time is calendar time in years of 365 days.

| Value            | Unit                                                       |
| ---------------- | ---------------------------------------------------------- |
| `iv`             | a fraction (`0.18` is 18 %)                                |
| `theta`          | price change per calendar day                              |
| `vega`           | price change per 0.01 of volatility (one volatility point) |
| `rho`            | price change per 0.01 of the rate (one percent)            |
| `delta`, `gamma` | per unit move of the underlying price                      |

The results never hold `NaN` or an infinity: a value that cannot be computed is `null`.

### `status`

`status` is always set, and so is `yearsToExpiry`. Check it before using the numbers.

| `status`                        | Meaning                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"ok"`                          | Normal result.                                                                                                                                                |
| `"near_expiry"`                 | Under 30 minutes to expiry: valid but unstable.                                                                                                               |
| `"expired"`                     | The expiry instant has passed. Not an error: `price` is the intrinsic value, `iv` is `null`, `delta` is the at-expiry delta and the other Greeks are `0`.     |
| `"price_at_or_below_intrinsic"` | The price is at or below intrinsic value (within half a tick), or no volatility up to 500 % reproduces it. `iv` is `null`; the Greeks are the at-expiry ones. |
| `"no_price"`                    | The option or its underlying has no last price. Every value is `null`. Retry when the market is open, or pass `optionPrice` / `underlyingPrice`.              |

## Pure functions: `tradesmart/greeks`

These take and return JavaScript `number` values (a Greeks result is not a price on the wire, so the
SDK's `Decimal` rule does not apply here) and make no request. An invalid input (a non-positive
price or volatility, a non-finite number, an unknown `optionType`) throws a `RangeError`; so does a
`bigint`, boolean, string or object where a number is required.

```ts
import { black76, greeksFromPrice, impliedVolatility } from "tradesmart/greeks";

// Price and Greeks of a call on a future at 24000, strike 24000, 30 days, 6.5 % rate, 18 % volatility.
const g = black76(24000, 24000, 30 / 365, 0.065, 0.18, "CE");
console.log(g.price, g.delta, g.status);

// The volatility that reproduces a traded price (null when there is none).
const iv = impliedVolatility(g.price ?? 0, 24000, 24000, 30 / 365, 0.065, "CE");
console.log(iv);

// Everything from a traded price, with the expiry-day rules and a status.
const r = greeksFromPrice(310.5, 24000, 24000, 30 / 365, 0.065, "CE", { tickSize: 0.05 });
console.log(r.status, r.iv);
```

| Function                                                                                                  | Returns                                                       |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `black76(forward, strike, years, rate, volatility, optionType)`                                           | Price and Greeks on a future's price                          |
| `blackScholes(spot, strike, years, rate, volatility, optionType, { dividendYield })`                      | Black-Scholes-Merton on spot with a continuous dividend yield |
| `impliedVolatility(price, underlying, strike, years, rate, optionType, { model, dividendYield })`         | The volatility (0.01 % to 500 %) or `null`                    |
| `greeksFromPrice(price, underlying, strike, years, rate, optionType, { model, dividendYield, tickSize })` | The `status` rules of the table above                         |

`optionType` is `"CE"`/`"CALL"` or `"PE"`/`"PUT"` (case ignored); `model` is `"black76"` (default) or
`"bsm"`. `years <= 0` gives the at-expiry result. Inside the formulas the time to expiry is floored at one
minute; `yearsToExpiry` reports the real value.

The numbers agree with the Python SDK's within the shared vectors' tolerances, not bit for bit: the
standard normal functions are computed independently.
