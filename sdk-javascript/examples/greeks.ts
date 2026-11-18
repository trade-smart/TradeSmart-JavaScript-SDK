// Option Greeks: the pure functions (no account, no network), then the Greeks of a real option.
// Read-only. The Greeks are model estimates, not exchange values.
//
// Run the second part with the option's exchange and tradingsymbol (copy a real one from
// `client.searchInstruments()`):
//   node examples/greeks.ts NFO YOUR_NFO_OPTION_SYMBOL
import { TradeSmart } from "tradesmart";
import { black76, greeksFromPrice, impliedVolatility } from "tradesmart/greeks";

// 1. Pure functions: a call on a future at 24000, strike 24000, 30 days, 6.5 % rate, 18 % volatility.
const years = 30 / 365;
const model = black76(24000, 24000, years, 0.065, 0.18, "CE");
console.log(`price ${String(model.price)}, delta ${String(model.delta)}, ${model.status}`);

// The volatility that reproduces that price comes back (null when no volatility does).
console.log(
  "implied volatility:",
  impliedVolatility(model.price ?? 0, 24000, 24000, years, 0.065, "CE"),
);

// From a traded price, with the expiry-day rules: check `status` before using the numbers.
const fromPrice = greeksFromPrice(310.5, 24000, 24000, years, 0.065, "CE", { tickSize: 0.05 });
console.log(`from a traded price: ${fromPrice.status}, iv ${String(fromPrice.iv)}`);

// 2. A real option, when you give its symbol.
const [exchange, tradingsymbol] = process.argv.slice(2);
if (exchange !== undefined && tradingsymbol !== undefined) {
  const client = TradeSmart.fromEnv();
  try {
    // Black-76 on the underlying future; pass { spotPrice } for Black-Scholes-Merton instead.
    const g = await client.optionGreeks(exchange, tradingsymbol, { rate: 0.065 });
    console.log(`${tradingsymbol}: ${g.status}, model ${g.model}`);
    console.log(`  iv ${String(g.iv)}, delta ${String(g.delta)}, gamma ${String(g.gamma)}`);
    console.log(`  theta ${String(g.theta)}, vega ${String(g.vega)}, rho ${String(g.rho)}`);
    console.log(`  years to expiry ${g.yearsToExpiry.toFixed(4)}, forward ${String(g.forward)}`);
  } finally {
    await client.close();
  }
} else {
  console.log("Pass an exchange and an option tradingsymbol to read a real option's Greeks.");
}
