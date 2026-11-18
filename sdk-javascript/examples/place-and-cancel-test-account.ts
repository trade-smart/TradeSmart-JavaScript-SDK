// PLACE, CHECK AND CANCEL ONE ORDER: FOR A TEST ACCOUNT.
//
// Without `--i-understand-this-places-a-real-order` this script is a DRY RUN: it reads the market,
// works out the order and prints it; nothing is placed. With the flag it places one real LIMIT
// order on the account you are logged in to, so use a test account (or an account you accept the
// risk on) and read docs/orders.md first.
//
// The order is a one-share LIMIT buy priced at half the last price, far from the market, so it
// should rest unfilled until the script cancels it. (TradeSmart refuses MARKET orders from the API
// anyway.)
//
//   node place-and-cancel-test-account.ts                                      # dry run
//   node place-and-cancel-test-account.ts --i-understand-this-places-a-real-order
import { randomBytes } from "node:crypto";
import {
  Exchange,
  OrderRejectedError,
  OrderStatus,
  OrderStatusUnknownError,
  OrderType,
  Product,
  TradeSmart,
  TransactionType,
  roundToTick,
  type Order,
} from "tradesmart";

const LIVE_FLAG = "--i-understand-this-places-a-real-order";
const live = process.argv.includes(LIVE_FLAG);
const SYMBOL = "SBIN-EQ";
const FINAL: readonly string[] = [OrderStatus.COMPLETE, OrderStatus.CANCELED, OrderStatus.REJECTED];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const client = TradeSmart.fromEnv();
try {
  // 1. Read the market: the token, the tick size and the last price.
  const matches = await client.searchInstruments("SBIN");
  const match = matches.find((m) => m.exchange === Exchange.NSE && m.tradingsymbol === SYMBOL);
  if (match?.token == null) throw new Error(`${SYMBOL} was not found on NSE`);
  const quote = await client.quote(Exchange.NSE, match.token);
  if (quote.lastPrice === null) throw new Error("The quote has no last price; stopping");

  // 2. A price far below the market, on the tick grid. `roundToTick` returns the price text.
  const price = roundToTick(quote.lastPrice.mul("0.5"), match.tickSize ?? "0.05");
  const tag = `example-${randomBytes(3).toString("hex")}`; // unique: finds the order again
  console.log(`Order: BUY 1 ${SYMBOL} LIMIT @ ${price} CNC, tag ${tag}`);
  if (!live) {
    console.log(`Dry run: nothing was placed. Add ${LIVE_FLAG} to place it.`);
  } else {
    // 3. Place it. An acknowledgement is not an execution.
    let orderId: string | null = null;
    try {
      orderId = await client.placeOrder({
        exchange: Exchange.NSE,
        tradingsymbol: SYMBOL,
        quantity: 1,
        transactionType: TransactionType.BUY,
        product: Product.CNC,
        orderType: OrderType.LIMIT,
        price,
        tag,
      });
    } catch (error) {
      if (error instanceof OrderRejectedError) {
        console.error(`Rejected: ${error.emsg ?? error.message}`); // definite: nothing to undo
      } else if (error instanceof OrderStatusUnknownError) {
        // It may exist. Look for the tag; NEVER send the order a second time.
        await sleep(2000);
        const found = (await client.orders()).find((o: Order) => o.tag === tag);
        orderId = found?.orderId ?? null;
        console.error(
          orderId === null
            ? `Outcome unknown and tag ${tag} not found yet: check orders() later.`
            : `Outcome was unknown; the order exists: ${orderId}`,
        );
      } else {
        throw error;
      }
    }

    // 4. Check its status, then cancel it if it is still working.
    if (orderId !== null) {
      await sleep(1000);
      const row = (await client.orders()).find((o) => o.orderId === orderId);
      console.log(`Status: ${row?.status ?? "not in the order book yet"}`);
      if (row?.status == null || !FINAL.includes(row.status)) {
        await client.cancelOrder(orderId);
        console.log(`Cancel requested for ${orderId}; confirm it in orders().`);
      }
    }
  }
} finally {
  await client.close();
}
