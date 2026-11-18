# Instruments and market data

Identify an instrument, read the script master (every instrument of an exchange), and get quotes,
candles and option chains. All calls here are read-only.

## Identify an instrument

An instrument has an **exchange** (`NSE`, `BSE`, `NFO`, `BFO`, `CDS`, `BCD`, `MCX`; the `Exchange`
constants), a **trading symbol** (`SBIN-EQ`) and a **token** (a string, `"3045"`). Orders use the
trading symbol; quotes, candles and the stream use the token. **A token is always a string**, never a
number.

### Search

```ts
import { TradeSmart } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  for (const m of await client.searchInstruments("SBIN")) {
    console.log(m.exchange, m.tradingsymbol, m.token, m.tickSize?.toString(), m.lotSize);
  }
} finally {
  await client.close();
}
```

`searchInstruments(text)` returns `[]` when nothing matches. Each `ScripMatch` carries the tick size
(a `Decimal`) and lot size; use them to round prices with `roundToTick`.

## Script master

TradeSmart publishes one instrument file per exchange (the _script master_).

```ts
import { Exchange, TradeSmart } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  const rows = await client.instruments(Exchange.NFO); // readonly Record<string, string>[]
  console.log(Object.keys(rows[0] ?? {})); // the file's own column names
  const path = await client.downloadInstruments(Exchange.NFO, { destDir: "./data" });
  console.log(path); // ./data/NFO_symbols.txt
} finally {
  await client.close();
}
```

- **The column layout is not documented by TradeSmart**, so a row is a plain object of strings keyed
  by the file's own header row. Look at the keys once and filter with ordinary array methods.
- **Freshness.** `instruments(exchange)` downloads the file into a per-user cache folder
  (`$XDG_CACHE_HOME/tradesmart` or `~/.cache/tradesmart` on Linux and macOS,
  `%LOCALAPPDATA%\tradesmart\Cache` on Windows; set `instrumentsDir` in the configuration to use
  another folder, a leading `~` is expanded) and reuses it until TradeSmart's next daily refresh: a
  cached file is fresh if it was written at or after the most recent refresh time
  (`scriptMasterRefreshTime`, 07:00 IST by default). No request is made while the file is fresh.
- **A file the server has not regenerated yet** (weekends, holidays, a late refresh) is not downloaded
  on every call: at most every `scriptMasterRecheckMinutes` (15) the SDK asks the server whether a
  newer file exists and keeps the cached file if not.
- **During a TradeSmart outage** such a re-check fails; the SDK returns the cached file and logs one
  warning per failed re-check. A first download, or `force: true`, still rejects.
- **A script-master download is a single attempt.** It is never retried, whatever the failure.
- `downloadInstruments(exchange, { destDir, force })` only downloads and resolves with the file's
  path.
- A cached file that is not valid UTF-8 text or CSV (for example a damaged download) rejects with
  `ResponseParseError`; delete it and call again.
- **Parsing runs on the main thread.** A large file blocks the event loop briefly, and the rows are
  parsed again on every `instruments()` call. Keep the array if you need it repeatedly, and build your
  symbol-to-token map once a day before the market opens, not inside your trading loop.
- An unknown exchange is a `RangeError`.

## Quotes and security information

```ts
import { Exchange, TradeSmart } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  const quote = await client.quote(Exchange.NSE, "3045");
  console.log(quote.lastPrice?.toFixed(2), quote.volume?.toString(), quote.bp1?.toString());
  const info = await client.securityInfo(Exchange.NSE, "3045");
  console.log(info.tickSize?.toString(), info.lotSize, info.frzqty);
} finally {
  await client.close();
}
```

`quote()` returns the touchline and five levels of depth; every price is a `Decimal` and a value
TradeSmart did not send is `null`. `securityInfo()` adds limits, margins and the freeze quantity
(`frzqty`). The quote calls are limited to 100 per second and 1,000 per minute by the SDK.

## Candles

```ts
import { Exchange, TradeSmart, istDate } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  const candles = await client.historicalData(Exchange.NSE, "3045", {
    fromDate: new Date(Date.now() - 3 * 60 * 60 * 1000),
    toDate: new Date(),
    interval: 5,
  });
  for (const c of candles.slice(0, 3)) {
    console.log(c.time?.toISOString(), c.into?.toString(), c.inth?.toString(), c.intc?.toString());
  }
  const daily = await client.dailyHistory(
    Exchange.NSE,
    "SBIN-EQ",
    istDate("2026-01-01"),
    istDate("2026-11-13"),
  );
  console.log(daily.length);
} finally {
  await client.close();
}
```

- `historicalData(exchange, token, { fromDate, toDate, interval })`: intraday candles; `interval` is in
  minutes: 1, 3, 5, 10, 15, 30, 60, 120 or 240 (TradeSmart's default is 1). `into`, `inth`, `intl`,
  `intc` and `intv` are open, high, low, close and volume.
- `dailyHistory(exchange, tradingsymbol, fromDate, toDate)`: daily candles; both dates are required.
- **Time inputs** take three forms: a `Date` (an instant), an integer `number` of epoch seconds, or a
  calendar date as `{ date: "YYYY-MM-DD" }` (build it with `istDate("2026-11-10")`), which means
  **00:00 IST** that day. So `toDate: istDate(today)` ends at midnight and excludes today's session;
  pass `new Date()` to include it. A string, a fraction, a boolean, `null` where a time is required or
  an invalid `Date` is a `RequestValidationError` for the field `time`.
- TradeSmart's history windows: NSE and BSE 360 days, MCX 70 days, NFO, BFO, CDS and BCD 65 days.

## Option chain

```ts
import { Exchange, TradeSmart } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  // The symbol is a placeholder: take a real one from search or the script master.
  const chain = await client.optionChain(Exchange.NFO, "YOUR_NFO_SYMBOL", 24000, 5);
  for (const c of chain)
    console.log(c.tradingsymbol, c.optionType, c.strikePrice?.toString(), c.token);
} finally {
  await client.close();
}
```

`count` (at least 1) strikes either side of `strikePrice`, calls and puts, in the order TradeSmart
sends them. `strikePrice` is a price input: a string, a `Decimal` or a finite number.

## Account and portfolio reads

`profile()`, `margins()`, `positions()` (one flat `Position` per instrument and product), `holdings()`
(`{ product }`, default `CNC`), `orders()` and `trades()` need no parameters; each list call resolves
with `[]` when there is nothing to show.
