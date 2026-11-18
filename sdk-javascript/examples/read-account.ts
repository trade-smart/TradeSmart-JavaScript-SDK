// Read your account: positions, holdings, today's orders and trades. Read-only.
//
// Every list call returns `[]` when there is nothing to show. Prices are `Decimal` values, never
// floats; print them with `.toFixed()` or `.toString()`.
import { TradeSmart } from "tradesmart";

const client = TradeSmart.fromEnv();
try {
  const [positions, holdings, orders, trades] = await Promise.all([
    client.positions(),
    client.holdings(),
    client.orders(),
    client.trades(),
  ]);

  console.log(`Positions: ${String(positions.length)}`);
  for (const position of positions) {
    console.log(
      `  ${position.tradingsymbol ?? "?"} ${position.product ?? "?"} ` +
        `net ${String(position.netQuantity ?? 0)} ` +
        `realised P&L ${position.realizedPnl?.toFixed(2) ?? "n/a"}`,
    );
  }

  console.log(`Holdings (CNC): ${String(holdings.length)}`);
  console.log(`Orders today: ${String(orders.length)}`);
  for (const order of orders) {
    console.log(
      `  ${order.orderId ?? "?"} ${order.tradingsymbol ?? "?"} ${order.status ?? "?"} ` +
        `filled ${String(order.filledQuantity ?? 0)} of ${String(order.quantity ?? 0)}`,
    );
  }
  console.log(`Trades today: ${String(trades.length)}`);
} finally {
  await client.close();
}
