// A GTT (good till triggered) order: FOR A TEST ACCOUNT.
//
// A GTT is held on TradeSmart's server as an alert: when the value it watches crosses the trigger
// value, the server places the order. A GTT whose condition is already true when it is placed
// fires at once and places a REAL order, so this script prices the trigger at half the last price
// (the last price is not below it, so it does not fire), then reads it back and cancels it.
//
// Without `--i-understand-this-places-a-real-gtt` this script is a DRY RUN: nothing is placed.
// Use a test account and read docs/orders.md ("GTT orders") first.
//
//   node gtt.ts                                      # dry run
//   node gtt.ts --i-understand-this-places-a-real-gtt
import { randomBytes } from "node:crypto";
import {
  Exchange,
  GttAlertType,
  OrderStatusUnknownError,
  OrderType,
  Product,
  TradeSmart,
  TransactionType,
  roundToTick,
} from "tradesmart";

const LIVE_FLAG = "--i-understand-this-places-a-real-gtt";
const live = process.argv.includes(LIVE_FLAG);
const SYMBOL = "ITC-EQ";

const client = TradeSmart.fromEnv();
try {
  const match = (await client.searchInstruments("ITC")).find(
    (m) => m.exchange === Exchange.NSE && m.tradingsymbol === SYMBOL,
  );
  if (match?.token == null) throw new Error(`${SYMBOL} was not found on NSE`);
  const quote = await client.quote(Exchange.NSE, match.token);
  if (quote.lastPrice === null) throw new Error("The quote has no last price; stopping");
  const trigger = roundToTick(quote.lastPrice.mul("0.5"), match.tickSize ?? "0.05");
  const tag = `gtt-${randomBytes(3).toString("hex")}`; // required on a GTT; finds it again
  console.log(
    `GTT: when ${SYMBOL} trades below ${trigger}, BUY 1 LIMIT @ ${trigger} CNC, tag ${tag}`,
  );

  if (!live) {
    console.log(`Dry run: nothing was placed. Add ${LIVE_FLAG} to place it.`);
  } else {
    let alertId: string | null = null;
    try {
      alertId = await client.placeGtt({
        exchange: Exchange.NSE,
        tradingsymbol: SYMBOL,
        alertType: GttAlertType.LTP_BELOW,
        triggerValue: trigger,
        quantity: 1,
        transactionType: TransactionType.BUY,
        product: Product.CNC,
        orderType: OrderType.LIMIT,
        price: trigger,
        tag,
      });
    } catch (error) {
      if (!(error instanceof OrderStatusUnknownError)) throw error;
      // It may exist. Look for the tag in the pending GTTs; never place it a second time.
      alertId = (await client.pendingGtts()).find((g) => g.tag === tag)?.alertId ?? null;
      console.error(
        alertId === null
          ? `Outcome unknown and tag ${tag} not found yet: check pendingGtts() later.`
          : `Outcome was unknown; the GTT exists: ${alertId}`,
      );
    }
    if (alertId !== null) {
      const pending = (await client.pendingGtts()).find((g) => g.alertId === alertId);
      console.log(
        `Pending: ${pending === undefined ? "not listed yet" : String(pending.alertType)}`,
      );
      await client.cancelGtt(alertId);
      console.log(`Cancelled GTT ${alertId}.`);
    }
  }
} finally {
  await client.close();
}
