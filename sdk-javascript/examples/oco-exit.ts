// An OCO (one-cancels-other) exit: a target and a stop-loss held as one alert on a long position.
//
// An OCO is a multi-day exit (bracket orders are intraday only): when the last price reaches the
// target trigger or the stop-loss trigger, the server places that side's order and drops the other.
// This script runs against the offline broker, so it needs no account, keys or network and places
// nothing real. With a real client (`TradeSmart.fromEnv()`) use a TEST ACCOUNT, and read
// docs/orders.md ("OCO orders") first: a trigger that is already crossed fires at once and places a
// real order.
//
//   node oco-exit.ts
import assert from "node:assert/strict";
import { GttAlertType, OrderType, Product, TransactionType, isOco, ocoSides } from "tradesmart";
import { OfflineBroker } from "tradesmart/testing";

await using broker = new OfflineBroker();
broker.addInstrument("NSE", "22", "ACC-EQ");
broker.setQuote("NSE", "22", { lastPrice: "100.00" });
const client = broker.client();

// Exit a long position: SELL. For a SELL the stop-loss trigger is below the target trigger.
const alertId = await client.placeOco({
  exchange: "NSE",
  tradingsymbol: "ACC-EQ",
  transactionType: TransactionType.SELL,
  quantity: 10,
  product: Product.CNC,
  stopLoss: { triggerValue: "95.00", price: "94.50", orderType: OrderType.LIMIT },
  target: { triggerValue: "110.00", price: "110.00", orderType: OrderType.LIMIT },
  tag: "oco-exit-0001", // finds the OCO again after an unknown outcome
});
console.log(`Placed OCO ${alertId}`);

// Read it back: any OCO row, whichever front end placed it, tells its stop-loss from its target.
const row = (await client.pendingGtts()).find((g) => g.alertId === alertId);
assert.ok(row);
assert.ok(isOco(row));
assert.equal(row.alertType, GttAlertType.OCO_SELL);
const sides = ocoSides(row);
assert.ok(sides); // null only when the row is ambiguous
console.log(
  `Stop-loss at ${String(sides.stopLoss.triggerValue)}, target at ${String(sides.target.triggerValue)}`,
);

// Cancel it with cancelOco (cancelGtt and modifyGtt refuse an OCO).
await client.cancelOco(alertId);
const cancelled = (await client.triggeredGtts()).find((g) => g.alertId === alertId);
console.log(`After cancelling: ${String(cancelled?.stat)}`); // CANCELLED
