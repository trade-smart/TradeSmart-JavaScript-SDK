// Test a strategy offline with the offline broker: no account, no keys, no network. It is a plain
// script that exits non-zero when a check fails, so it also works as a test in any runner.
//
//   node examples/offline-broker-test.ts
//
// The strategy places a LIMIT buy when the price is at or below 100. Nothing here touches a real
// account: the broker is a local fake and the test decides every price and fill.
import assert from "node:assert/strict";
import { OrderStatus, OrderStatusUnknownError, TradeSmart } from "tradesmart";
import { OfflineBroker, drills } from "tradesmart/testing";

async function myStrategy(client: TradeSmart): Promise<void> {
  const quote = await client.quote("NSE", "22");
  if (quote.lastPrice !== null && quote.lastPrice.lte(100)) {
    await client.placeOrder({
      exchange: "NSE",
      tradingsymbol: "ACC-EQ",
      quantity: 10,
      transactionType: "B",
      product: "I",
      orderType: "LMT",
      price: "100",
      tag: "dip-buy-0001",
    });
  }
}

// 1. The strategy buys on the dip and the test fills the order.
{
  await using broker = new OfflineBroker();
  broker.addInstrument("NSE", "22", "ACC-EQ");
  broker.setQuote("NSE", "22", { lastPrice: "99.50" });
  const client = broker.client();

  await myStrategy(client);
  const order = broker.orders.at(-1);
  assert.ok(order);
  assert.equal(order.side, "B");
  assert.equal(order.quantity, 10);

  broker.fill(order.id, "100");
  assert.equal((await client.orders())[0]?.status, OrderStatus.COMPLETE);
}

// 2. It does nothing when the price is above the limit.
{
  await using broker = new OfflineBroker();
  broker.addInstrument("NSE", "22", "ACC-EQ");
  broker.setQuote("NSE", "22", { lastPrice: "101" });
  await myStrategy(broker.client());
  assert.equal(broker.orders.length, 0);
}

// 3. A lost reply on PlaceOrder: the order IS booked, the call reports an unknown outcome, and
// the strategy must look the tag up instead of sending the order again.
{
  await using broker = new OfflineBroker();
  broker.addInstrument("NSE", "22", "ACC-EQ");
  broker.setQuote("NSE", "22", { lastPrice: "99.50" });
  broker.failNext("PlaceOrder", drills.timeoutAfterSend());

  await assert.rejects(myStrategy(broker.client({ maxRetries: 0 })), OrderStatusUnknownError);
  assert.equal(broker.orders.length, 1); // booked once, never resent
}

console.log("offline broker example: all checks passed");
