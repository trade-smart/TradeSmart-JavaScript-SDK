# Option analytics

Read-only helpers for option traders. None of them places or changes an order.

| Method                                                                                 | What you get                                                                       |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `client.optionChainSnapshot(exchange, tradingsymbol, strikePrice, { count })`          | Quotes for the contracts around a strike, with PCR and max pain                    |
| `client.buildup(exchange, token)`                                                      | Long or short buildup, unwinding or covering, from price and open-interest changes |
| `pcr`, `maxPain`, `classifyBuildup`, `buildupFromSnapshot` from `tradesmart/analytics` | The same arithmetic as pure functions, on data you already hold                    |

Every value is exact: put-call ratio, payouts and strikes are `Decimal` values, never floats.

> Max pain, PCR and buildup are indicators, not signals to trade.

## Chain snapshot, PCR and max pain

`optionChainSnapshot` calls `optionChain()` and then one `quote()` per contract (at most 10 in flight).
`count` is the number of strikes either side of the strike price (default 25). Symbols below are
placeholders.

```ts
import { Exchange, TradeSmart } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  const snapshot = await client.optionChainSnapshot(
    Exchange.NFO,
    "YOUR_NFO_OPTION_SYMBOL",
    "24000",
    {
      count: 10,
    },
  );
  console.log(snapshot.rows.length, "contracts; unquoted:", snapshot.missing);

  console.log("PCR by open interest:", snapshot.pcr()?.toFixed(2) ?? "n/a");
  console.log("PCR by volume:", snapshot.pcr({ by: "volume" })?.toFixed(2) ?? "n/a");

  const pain = snapshot.maxPain();
  if (pain !== null) {
    console.log("max pain strike:", pain.strike.toFixed());
    for (const [strike, payout] of pain.payouts) console.log(strike, payout.toFixed());
  }
} finally {
  await client.close();
}
```

- `rows` are sorted by strike, then CE before PE. Each row has `strike`, `optionType`,
  `tradingsymbol`, `token`, and `lastPrice`, `openInterest`, `volume`, `close` (all `Decimal` or `null`).
- A contract whose quote fails for that contract alone is listed in `missing`, not in `rows`; any other
  error (a rate limit, a lost session) is raised.
- **PCR** is the sum of put over the sum of call open interest (or volume); `null` when the call
  total is zero. Only the exact upper-case option types `"CE"` and `"PE"` count.
- **Max pain** is the strike that minimises the total payout to option buyers; a tie goes to the lowest
  strike. `payouts` maps each candidate strike's decimal text to its total. `null` when no row has an
  open-interest value.

> **The snapshot is a class instance.** `pcr()` and `maxPain()` are its methods. Spreading it
> (`{ ...snapshot }`) or `structuredClone(snapshot)` keeps the data fields but loses the methods; call
> them first, or use the functions below, which take anything with a `rows` array.

## Pure functions: `tradesmart/analytics`

```ts
import { Buildup, buildupFromSnapshot, classifyBuildup, maxPain, pcr } from "tradesmart/analytics";
import { Decimal } from "tradesmart";

const rows = [
  {
    strike: new Decimal("100"),
    optionType: "CE",
    tradingsymbol: "X100CE",
    token: "1",
    lastPrice: null,
    openInterest: new Decimal("200"),
    volume: new Decimal("5"),
    close: null,
  },
  {
    strike: new Decimal("100"),
    optionType: "PE",
    tradingsymbol: "X100PE",
    token: "2",
    lastPrice: null,
    openInterest: new Decimal("300"),
    volume: new Decimal("7"),
    close: null,
  },
] as const;

console.log(pcr({ rows })?.toFixed(2)); // 1.50
console.log(maxPain({ rows })?.strike.toFixed()); // 100

console.log(classifyBuildup(1.5, 200) === Buildup.LONG_BUILDUP); // price up, open interest up

// From a stream snapshot() (wire keys lp, c, oi, poi)
const reading = buildupFromSnapshot({ lp: "101.5", c: "100", oi: "1200", poi: "1000" });
console.log(reading.state, reading.priceChange?.toFixed(), reading.oiChange?.toFixed());
```

## Buildup

`client.buildup(exchange, token)` makes two calls, `quote()` and `historicalData()` for today in IST, and classifies the move:

| Price change                         | Open-interest change | `state`          |
| ------------------------------------ | -------------------- | ---------------- |
| up                                   | up                   | `LONG_BUILDUP`   |
| up                                   | down                 | `SHORT_COVERING` |
| down                                 | up                   | `SHORT_BUILDUP`  |
| down                                 | down                 | `LONG_UNWINDING` |
| zero, missing or not a finite number | any                  | `NEUTRAL`        |

The result is a `BuildupReading` with `state`, `priceChange` (the last price minus the previous close, `lp − c`), `oiChange` (the sum of the day's minute-candle `intoi` values, the change since the open) and `basis` (`"since_open"`; `buildupFromSnapshot` reports `"previous_close_and_previous_oi"`).

```ts
import { Exchange, TradeSmart } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  const reading = await client.buildup(Exchange.NFO, "YOUR_TOKEN");
  console.log(reading.state, reading.priceChange?.toFixed(2), reading.oiChange?.toFixed());
} finally {
  await client.close();
}
```

## Decimal inputs

Analytics read decimal text with the same strict grammar as prices ([Reference](reference.md#prices-and-quantities)):
no `_` digit separators and no non-ASCII digits. A value that does not parse counts as missing.
