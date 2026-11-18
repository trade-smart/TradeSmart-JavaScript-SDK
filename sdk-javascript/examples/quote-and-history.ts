// Market data: find an instrument, read its quote, intraday candles and daily candles. Read-only.
//
// The instrument is identified by its exchange and its token (a string such as "3045"); search
// by text to find the token.
import { Exchange, TradeSmart, istDate } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  const matches = await client.searchInstruments("SBIN");
  const match = matches.find(
    (m) => m.exchange === Exchange.NSE && m.tradingsymbol === "SBIN-EQ" && m.token !== null,
  );
  if (match?.token == null || match.tradingsymbol === null) {
    throw new Error("SBIN-EQ was not found on NSE");
  }
  console.log(
    `${match.tradingsymbol}: token ${match.token}, tick ${match.tickSize?.toString() ?? "?"}`,
  );

  const quote = await client.quote(Exchange.NSE, match.token);
  console.log(
    `Last price ${quote.lastPrice?.toFixed(2) ?? "n/a"}, volume ${quote.volume?.toString() ?? "n/a"}`,
  );

  // Five-minute candles of the last day (a `Date`, epoch seconds or `istDate("YYYY-MM-DD")`).
  const candles = await client.historicalData(Exchange.NSE, match.token, {
    fromDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    toDate: new Date(),
    interval: 5,
  });
  console.log(`Intraday candles: ${String(candles.length)}`);

  // Daily candles between two calendar dates (00:00 IST of each day).
  const daily = await client.dailyHistory(
    Exchange.NSE,
    match.tradingsymbol,
    istDate("2026-11-02"),
    istDate("2026-11-13"),
  );
  for (const candle of daily) {
    console.log(`  ${candle.time?.toISOString() ?? "?"} close ${candle.intc?.toFixed(2) ?? "n/a"}`);
  }
} finally {
  await client.close();
}
