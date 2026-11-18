// Option analytics: a chain snapshot with put-call ratio and max pain, and the buildup of one
// instrument. Read-only; indicators, not signals to trade.
//
//   node examples/analytics.ts NFO YOUR_NFO_OPTION_SYMBOL 24000 [TOKEN]
//
// The symbol is any option of the chain (copy one from `client.searchInstruments()`), the third
// argument is the strike to centre on, and the optional token is the instrument to classify.
import { TradeSmart } from "tradesmart";

const [exchange, tradingsymbol, strike, token] = process.argv.slice(2);
if (exchange === undefined || tradingsymbol === undefined || strike === undefined) {
  console.log("Usage: node examples/analytics.ts EXCHANGE OPTION_SYMBOL STRIKE [TOKEN]");
  process.exit(2);
}

const client = TradeSmart.fromEnv();
try {
  // The snapshot is a class instance: call pcr() and maxPain() on it (a spread copy loses them).
  const snapshot = await client.optionChainSnapshot(exchange, tradingsymbol, strike, {
    count: 5,
  });
  console.log(
    `${String(snapshot.rows.length)} contracts, ${String(snapshot.missing.length)} unquoted`,
  );
  console.log("PCR (open interest):", snapshot.pcr()?.toFixed(2) ?? "n/a");

  const pain = snapshot.maxPain();
  console.log("max pain strike:", pain?.strike.toFixed() ?? "n/a");

  if (token !== undefined) {
    const reading = await client.buildup(exchange, token);
    console.log(
      `buildup: ${reading.state} (price ${reading.priceChange?.toFixed(2) ?? "n/a"}, ` +
        `open interest ${reading.oiChange?.toFixed() ?? "n/a"})`,
    );
  }
} finally {
  await client.close();
}
