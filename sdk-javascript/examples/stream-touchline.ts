// Live prices: subscribe to the touchline of one instrument and print ticks for a short time.
// Read-only. Prices arrive as `Decimal` values.
//
// The instrument key is "EXCHANGE|TOKEN" (here NSE token 3045, SBIN-EQ). Find tokens with
// `client.searchInstruments()`. The stream reconnects and resubscribes by itself.
import { StreamState, TradeSmartStream } from "tradesmart";

const stream = TradeSmartStream.fromEnv({
  onTouchline: (tick) => {
    console.log(
      `${tick.tradingsymbol ?? tick.token ?? "?"} last ${tick.lastPrice?.toFixed(2) ?? "n/a"}`,
    );
  },
  onStateChange: (state) => {
    console.log(`state: ${state}`);
  },
  onError: (error) => {
    console.error(`stream error: ${error.message}`);
  },
});

try {
  await stream.connect();
  await stream.subscribeTouchline("NSE|3045");
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  const latest = stream.snapshot("NSE|3045");
  console.log(
    `Latest merged fields: ${latest === null ? "none yet" : Object.keys(latest).join(", ")}`,
  );
  console.log(
    `Reconnects: ${String(stream.reconnectCount)}, final state before close: ${stream.state}`,
  );
} finally {
  await stream.close();
  console.log(`Stream state after close: ${stream.state} (${StreamState.CLOSED} expected)`);
}
