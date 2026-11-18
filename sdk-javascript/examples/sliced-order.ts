// SEND ONE LARGE ORDER AS SLICES: FOR A TEST ACCOUNT.
//
// An order above the exchange's freeze quantity must be sent in pieces. `placeSlicedOrder` reads
// the lot size and freeze quantity, plans the slices and sends them one after another. Every slice
// is a real order on the account you are logged in to, so use a test account and read
// docs/orders.md ("Sliced orders") first. Without `--i-understand-this-places-a-real-order` this
// script is a DRY RUN: it reads the contract and the market and prints the order; nothing is placed.
//
// The order is a LIMIT buy priced at half the last price, far from the market, and the script
// cancels every slice it placed.
//
//   node sliced-order.ts NIFTY26NOVFUT 3510                                   # dry run
//   node sliced-order.ts NIFTY26NOVFUT 3510 --i-understand-this-places-a-real-order
//
// The quantity is in trade units (a whole number of lots). Find a contract's trading symbol with
// `client.searchInstruments()`; the contract name above is only an illustration.
import { randomBytes } from "node:crypto";
import {
  Exchange,
  OrderStatusUnknownError,
  OrderType,
  Product,
  TradeSmart,
  TransactionType,
  roundToTick,
} from "tradesmart";

const LIVE_FLAG = "--i-understand-this-places-a-real-order";
const args = process.argv.slice(2).filter((a) => a !== LIVE_FLAG);
const live = process.argv.includes(LIVE_FLAG);
const symbol = args[0];
const quantity = Number(args[1]);
if (symbol === undefined || !Number.isSafeInteger(quantity) || quantity < 1) {
  console.error("usage: node sliced-order.ts <trading symbol> <quantity> [flag]");
  process.exit(2);
}

const client = TradeSmart.fromEnv();
try {
  const match = (await client.searchInstruments(symbol)).find(
    (m) => m.exchange === Exchange.NFO && m.tradingsymbol === symbol,
  );
  if (match?.token == null) throw new Error(`${symbol} was not found on NFO`);
  const info = await client.securityInfo(Exchange.NFO, match.token);
  const quote = await client.quote(Exchange.NFO, match.token);
  if (quote.lastPrice === null) throw new Error("The quote has no last price; stopping");
  const price = roundToTick(quote.lastPrice.mul("0.5"), match.tickSize ?? "0.05");
  const tag = `slice-${randomBytes(3).toString("hex")}`;
  console.log(
    `${symbol}: lot ${String(info.lotSize ?? "?")}, freeze quantity ${String(info.frzqty ?? "?")}; ` +
      `BUY ${String(quantity)} LIMIT @ ${price} NRML, tag ${tag}`,
  );

  if (!live) {
    console.log(`Dry run: nothing was placed. Add ${LIVE_FLAG} to place it.`);
  } else {
    try {
      const result = await client.placeSlicedOrder({
        exchange: Exchange.NFO,
        tradingsymbol: symbol,
        quantity,
        transactionType: TransactionType.BUY,
        product: Product.NRML,
        orderType: OrderType.LIMIT,
        price,
        tag,
      });
      console.log(
        `Placed ${String(result.placedQuantity)} of ${String(result.requestedQuantity)} in ` +
          `${String(result.orderIds.length)} order(s); never sent: ${String(result.unsentQuantity)}`,
      );
      if (result.error !== null) console.error(`Stopped by: ${result.error.message}`);
      for (const id of result.orderIds) await client.cancelOrder(id);
    } catch (error) {
      if (!(error instanceof OrderStatusUnknownError)) throw error;
      // One slice's outcome is unknown. Never resend: read the order book for the tag instead.
      const result = error.slicedResult;
      console.error(`Outcome unknown after ${String(result?.orderIds.length ?? 0)} slice(s).`);
      const found = (await client.orders()).filter((o) => o.tag === tag);
      console.error(`Orders carrying tag ${tag}: ${found.map((o) => o.orderId ?? "?").join(", ")}`);
    }
  }
} finally {
  await client.close();
}
