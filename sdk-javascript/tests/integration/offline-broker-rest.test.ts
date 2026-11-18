// The offline broker's REST half (sdk-behaviour.md §16): a real `TradeSmart` talks to
// `OfflineBroker` through its in-memory undici dispatcher. No network, no socket.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import {
  APIError,
  AuthenticationError,
  ConfigurationError,
  NetworkError,
  OrderRejectedError,
  OrderStatusUnknownError,
  RateLimitError,
  ResponseParseError,
  ServerError,
  type TradeSmart,
} from "../../src/index.js";
import { OfflineBroker, drills } from "../../src/testing/index.js";
import { OfflineDispatcher } from "../../src/testing/rest.js";
import { BrokerState } from "../../src/testing/state.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../specifications/test-fixtures",
);

const OPTION = "NIFTY27NOV26C24000";
// Keys a real order row carries only when the order sent them (legs, trigger, algo id).
const SENT_ONLY = new Set(["trgprc", "blprc", "bpprc", "trailprc", "algo_id"]);
const brokers: OfflineBroker[] = [];
const clients: TradeSmart[] = [];

function setup(config: Parameters<OfflineBroker["client"]>[0] = {}): {
  broker: OfflineBroker;
  client: TradeSmart;
} {
  const broker = new OfflineBroker();
  brokers.push(broker);
  const client = broker.client(config);
  clients.push(client);
  return { broker, client };
}

afterEach(async () => {
  while (clients.length > 0) await clients.pop()?.close();
  while (brokers.length > 0) await brokers.pop()?.close();
});

function addNifty(broker: OfflineBroker): void {
  broker.addInstrument("NFO", "2003", OPTION, {
    lotSize: 75,
    tickSize: "0.05",
    instrument: "OPTIDX",
    expiry: { date: "2026-11-27" },
    strike: 24000,
    optionType: "CE",
    underlying: "NIFTY",
    extra: { frzqty: 1801 },
  });
  broker.addInstrument("NFO", "2004", "NIFTY27NOV26C23900", {
    lotSize: 75,
    instrument: "OPTIDX",
    expiry: { date: "2026-11-27" },
    strike: 23900,
    optionType: "CE",
    underlying: "NIFTY",
  });
  broker.addInstrument("NFO", "2005", "NIFTY27NOV26P24000", {
    lotSize: 75,
    instrument: "OPTIDX",
    expiry: { date: "2026-11-27" },
    strike: 24000,
    optionType: "PE",
    underlying: "NIFTY",
  });
  broker.addInstrument("NSE", "3045", "SBIN-EQ");
}

const LIMIT_BUY = {
  exchange: "NFO",
  tradingsymbol: OPTION,
  quantity: 75,
  transactionType: "B",
  product: "M",
  orderType: "LMT",
  price: "101.50",
} as const;

const MODIFY = {
  exchange: "NFO",
  tradingsymbol: OPTION,
  quantity: 150,
  price: "102.00",
  orderType: "LMT",
  product: "M",
} as const;

const GTT = {
  exchange: "NSE",
  tradingsymbol: "SBIN-EQ",
  alertType: "LTP_B_O",
  triggerValue: "800",
  alertValidity: "GTT",
  tag: "Buy SBIN below 800",
  transactionType: "B",
  orderType: "LMT",
  product: "C",
  validity: "DAY",
  quantity: 1,
  price: "800",
} as const;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

const parse = (text: string): Record<string, string> => JSON.parse(text) as Record<string, string>;
const endpoints = (broker: OfflineBroker): string[] => broker.requests.map((r) => r.endpoint);

describe("login", () => {
  it("client() is logged in for 24 hours (not the 06:00 IST expiry)", () => {
    const { client } = setup();
    const token = client.accessToken;
    expect(token).not.toBeNull();
    const expiresAt = (token as { expiresAt: Date }).expiresAt.getTime();
    const hours = (expiresAt - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
  });

  it("generateSession answers a synthetic token with the normal 06:00 IST expiry", async () => {
    const { broker, client } = setup();
    expect(client.loginUrl()).toContain("https://offline.tradesmart.invalid/authorize?");
    const token = await client.generateSession("offline-auth-code");
    expect(token.accessToken.reveal()).toMatch(/^offline-token-/);
    expect(token.userId).toBe("OFFLINE01");
    const istMinutes = (token.expiresAt.getTime() + 5.5 * 3_600_000) / 60_000;
    expect(istMinutes % 1440).toBe(360); // 06:00 IST
    expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const recorded = broker.requests.at(-1);
    expect(recorded?.endpoint).toBe("GenAcsTok");
    expect(JSON.stringify(recorded?.payload)).not.toContain("offline-auth-code");
    expect(recorded?.payload["checksum"]).toBe("***");
  });

  it("the client id is configurable", () => {
    const broker = new OfflineBroker({ clientId: "ASHA01" });
    brokers.push(broker);
    expect(broker.clientId).toBe("ASHA01");
    expect(broker.client().clientId).toBe("ASHA01");
    expect(String(broker)).toBe("OfflineBroker(clientId=ASHA01)");
  });
});

describe("account", () => {
  it("profile, margins, holdings and positions return what the test set", async () => {
    const { broker, client } = setup();
    broker.setUser({ uname: "Asha" });
    broker.setFunds({ cash: "100000.00" });
    broker.setHoldings([
      { exch_tsym: [{ exch: "NSE", tsym: "SBIN-EQ", token: "3045" }], holdqty: "10" },
    ]);
    broker.setPositions([
      { exch: "NSE", tsym: "SBIN-EQ", prd: "C", netqty: "10", netavgprc: "800" },
    ]);
    const profile = await client.profile();
    expect(profile.userId).toBe("OFFLINE01");
    expect(profile.uname).toBe("Asha");
    expect((await client.margins()).cash?.toString()).toBe("100000");
    const holdings = await client.holdings();
    expect(holdings).toHaveLength(1);
    expect(holdings[0]?.holdqty).toBe(10);
    const positions = await client.positions();
    expect(positions).toHaveLength(1);
    expect(positions[0]?.netQuantity).toBe(10);
  });

  it("empty books are empty lists", async () => {
    const { client } = setup();
    expect(await client.orders()).toEqual([]);
    expect(await client.trades()).toEqual([]);
    expect(await client.positions()).toEqual([]);
    expect(await client.holdings()).toEqual([]);
    expect(await client.orderHistory("999")).toEqual([]);
  });

  it("setPositions accepts product names and refuses an unknown one", async () => {
    const { broker, client } = setup();
    broker.setPositions([{ exch: "NSE", tsym: "SBIN-EQ", prd: "MIS", netqty: "-5" }]);
    const rows = await client.positions();
    expect(rows[0]?.product).toBe("I");
    expect(rows[0]?.netQuantity).toBe(-5);
    expect(() => {
      broker.setPositions([{ exch: "NSE", tsym: "X", prd: "NOSUCH" }]);
    }).toThrow(/unknown product/);
    expect(() => {
      broker.setPositions([{ exch: "NSE", tsym: "X", prd: "C", netqty: "1.5" }]);
    }).toThrow(/whole number/);
  });
});

describe("orders", () => {
  it("a new order is booked OPEN and read back from the book, history and trades", async () => {
    const { broker, client } = setup();
    addNifty(broker);
    const id = await client.placeOrder(LIMIT_BUY);
    expect(id).toBe(broker.orders[0]?.id);
    expect(broker.orders[0]?.status).toBe("OPEN");
    expect(broker.orders[0]?.price?.toString()).toBe("101.5");
    const book = await client.orders();
    expect(book).toHaveLength(1);
    expect(book[0]?.orderId).toBe(id);
    expect(book[0]?.status).toBe("OPEN");
    const history = await client.orderHistory(id);
    expect(history.map((h) => h.status)).toEqual(["OPEN", "PENDING"]); // newest first

    broker.fill(id, "101.50");
    const trades = await client.trades();
    expect(trades).toHaveLength(1);
    expect(trades[0]?.flqty).toBe(75);
    expect(trades[0]?.flprc?.toString()).toBe("101.5");
    const positions = await client.positions();
    expect(positions[0]?.netQuantity).toBe(75);
    expect((await client.orders())[0]?.status).toBe("COMPLETE");
  });

  it("partial fills accumulate to COMPLETE with a running average", async () => {
    const { broker, client } = setup();
    addNifty(broker);
    const id = await client.placeOrder(LIMIT_BUY);
    broker.fill(id, "100", 25);
    expect(broker.orders[0]?.status).toBe("OPEN");
    expect(broker.orders[0]?.filledQuantity).toBe(25);
    broker.fill(id, new Decimal("102"), 50);
    const order = broker.orders[0];
    expect(order?.status).toBe("COMPLETE");
    expect(order?.averagePrice?.toFixed(2)).toBe("101.33");
    expect((await client.orderHistory(id)).map((h) => h.status)).toEqual([
      "COMPLETE",
      "OPEN",
      "OPEN",
      "PENDING",
    ]);
    expect(await client.trades()).toHaveLength(2);
    const [position] = await client.positions();
    expect(position?.netQuantity).toBe(75);
  });

  it("fill, accept, trigger and cancel refuse a wrong state or amount at once", async () => {
    const { broker, client } = setup();
    const id = await client.placeOrder(LIMIT_BUY);
    expect(() => {
      broker.fill(id, "100", 76);
    }).toThrow(/fill quantity must be 1 to 75/);
    expect(() => {
      broker.fill(id, "abc");
    }).toThrow(/price must be a number/);
    expect(() => {
      broker.accept(id);
    }).toThrow(/cannot accept order/);
    expect(() => {
      broker.trigger(id);
    }).toThrow(/cannot trigger order/);
    expect(() => {
      broker.cancel("nosuch");
    }).toThrow(/no order with id/);
    broker.cancel(id);
    expect(() => {
      broker.reject(id, "late");
    }).toThrow(/cannot reject order/);
  });

  it("defaultPlace pending waits for accept; a stop order waits for trigger", async () => {
    const { broker, client } = setup();
    broker.defaultPlace = "pending";
    const id = await client.placeOrder(LIMIT_BUY);
    expect(broker.orders[0]?.status).toBe("PENDING");
    broker.accept(id);
    expect(broker.orders[0]?.status).toBe("OPEN");
    broker.defaultPlace = "open";
    const stop = await client.placeOrder({
      ...LIMIT_BUY,
      orderType: "SL-LMT",
      triggerPrice: "100",
    });
    expect(broker.orders[1]?.status).toBe("TRIGGER_PENDING");
    expect((await client.orders())[0]?.triggerPrice?.toString()).toBe("100");
    broker.trigger(stop);
    expect(broker.orders[1]?.status).toBe("OPEN");
    broker.defaultPlace = "pending";
    const pendingStop = await client.placeOrder({
      ...LIMIT_BUY,
      orderType: "SL-MKT",
      triggerPrice: "99",
      price: null,
    });
    broker.accept(pendingStop);
    expect(broker.orders[2]?.status).toBe("TRIGGER_PENDING");
  });

  it("defaultPlace reject books REJECTED with the reject message", async () => {
    const { broker, client } = setup();
    broker.defaultPlace = "reject";
    broker.defaultRejectMessage = "RMS:Margin Exceeds";
    expect(broker.defaultRejectMessage).toBe("RMS:Margin Exceeds");
    const id = await client.placeOrder(LIMIT_BUY);
    expect(broker.orders[0]?.status).toBe("REJECTED");
    expect(broker.orders[0]?.rejectReason).toBe("RMS:Margin Exceeds");
    const [row] = await client.orders();
    expect(row?.status).toBe("REJECTED");
    expect(row?.rejectReason).toBe("RMS:Margin Exceeds");
    expect(row?.orderId).toBe(id);
    expect(() => {
      broker.defaultPlace = "nosuch" as "open";
    }).toThrow(RangeError);
    expect(broker.defaultPlace).toBe("reject");
  });

  it("the test can reject an open order", async () => {
    const { broker, client } = setup();
    const id = await client.placeOrder(LIMIT_BUY);
    broker.reject(id, "Exchange said no");
    expect((await client.orders())[0]?.rejectReason).toBe("Exchange said no");
  });

  it("modifyOrder changes the book; a closed order is refused", async () => {
    const { broker, client } = setup();
    const id = await client.placeOrder(LIMIT_BUY);
    await expect(client.modifyOrder(id, MODIFY)).resolves.toBe(id);
    const order = broker.orders[0];
    expect(order?.price?.toString()).toBe("102");
    expect(order?.quantity).toBe(150);
    broker.cancel(id);
    const error = await rejection(client.modifyOrder(id, MODIFY));
    expect(error).toBeInstanceOf(OrderRejectedError);
    expect((error as OrderRejectedError).emsg).toBe("order is not open to modify");
    const unknown = await rejection(client.modifyOrder("nosuch", MODIFY));
    expect((unknown as OrderRejectedError).emsg).toBe("Order not found to Modify");
  });

  it("modifyOrder below the filled quantity is refused", async () => {
    const { broker, client } = setup();
    const id = await client.placeOrder(LIMIT_BUY);
    broker.fill(id, "100", 50);
    const error = await rejection(client.modifyOrder(id, { ...MODIFY, quantity: 50 }));
    expect((error as OrderRejectedError).emsg).toBe(
      "quantity must be more than the filled quantity 50",
    );
  });

  it("cancelOrder cancels once; the second cancel and an unknown order are refused", async () => {
    const { broker, client } = setup();
    const id = await client.placeOrder(LIMIT_BUY);
    await expect(client.cancelOrder(id)).resolves.toBe(id);
    expect(broker.orders[0]?.status).toBe("CANCELED");
    expect(((await rejection(client.cancelOrder(id))) as OrderRejectedError).emsg).toBe(
      "order is not open to cancel",
    );
    expect(((await rejection(client.cancelOrder("nosuch"))) as OrderRejectedError).emsg).toBe(
      "Order not found to Cancel",
    );
    expect((await client.orders())[0]?.cancelqty).toBe(75);
  });

  it("exitOrder cancels a cover order and refuses the others with the exact texts", async () => {
    const { broker, client } = setup();
    const cover = await client.placeOrder({ ...LIMIT_BUY, product: "H", bookLossPrice: "95.00" });
    await expect(client.exitOrder(cover, "H")).resolves.toBe(cover);
    expect(broker.orders[0]?.status).toBe("CANCELED");
    expect(((await rejection(client.exitOrder(cover, "H"))) as OrderRejectedError).emsg).toBe(
      "order is not open to exit",
    );
    const intraday = await client.placeOrder({ ...LIMIT_BUY, product: "I" });
    expect(((await rejection(client.exitOrder(intraday, "H"))) as OrderRejectedError).emsg).toBe(
      "order is not a cover or bracket order",
    );
    expect(broker.orders[1]?.status).toBe("OPEN");
    expect(((await rejection(client.exitOrder("nosuch", "B"))) as OrderRejectedError).emsg).toBe(
      "Order not found to Exit",
    );
  });

  it("an order for an unknown instrument is accepted", async () => {
    const { broker, client } = setup();
    await client.placeOrder({ ...LIMIT_BUY, exchange: "NSE", tradingsymbol: "NOSUCH-EQ" });
    expect(broker.orders).toHaveLength(1);
  });

  it("orders and requests are snapshots, orders are live", async () => {
    const { broker, client } = setup();
    await client.placeOrder(LIMIT_BUY);
    const first = broker.orders;
    const requests = broker.requests;
    await client.placeOrder(LIMIT_BUY);
    expect(first).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(broker.orders).toHaveLength(2);
    broker.cancel(first[0]?.id ?? "");
    expect(first[0]?.status).toBe("CANCELED");
  });

  it("an order the exchange never saw is not modelled by the SDK's multi-order endpoint", async () => {
    const { broker, client } = setup();
    const error = await rejection(
      client.request("PlaceMultiOrder", { exch: "NSE" }, { stateChanging: true }),
    );
    expect(error).toBeInstanceOf(OrderRejectedError);
    expect((error as OrderRejectedError).emsg).toBe(
      "OfflineBroker does not model PlaceMultiOrder; set a reply with broker.setReply(...)",
    );
    broker.setReply("PlaceMultiOrder", { stat: "Ok", values: [] });
    await expect(
      client.request("PlaceMultiOrder", { exch: "NSE" }, { stateChanging: true }),
    ).resolves.toEqual({ stat: "Ok", values: [] });
  });
});

describe("GTT", () => {
  it("place, modify and cancel answer the documented words and apply to the lists", async () => {
    const { broker, client } = setup();
    broker.addInstrument("NSE", "3045", "SBIN-EQ");
    expect(await client.gttAlertTypes()).toEqual(["ATP", "LTP"]);
    expect(await client.pendingGtts()).toEqual([]);
    const id = await client.placeGtt(GTT);
    expect(id).toMatch(/^\d{6}00000001$/);
    const [pending] = await client.pendingGtts();
    expect(pending?.alertId).toBe(id);
    expect(pending?.quantity).toBe(1);
    expect(pending?.tag).toBe("Buy SBIN below 800");
    await expect(client.modifyGtt(id, { ...GTT, triggerValue: "790", price: "790" })).resolves.toBe(
      id,
    );
    expect((await client.pendingGtts())[0]?.triggerValue?.toString()).toBe("790");
    await expect(client.cancelGtt(id)).resolves.toBe(id);
    expect(await client.pendingGtts()).toEqual([]);
    const words = broker.requests.filter((r) =>
      ["PlaceGTTOrder", "ModifyGTTOrder", "CancelGTTOrder"].includes(r.endpoint),
    ).length;
    expect(words).toBe(3);
  });

  it("an unknown alert id and an ai_t change are refused with the exact texts", async () => {
    const { client } = setup();
    expect(((await rejection(client.cancelGtt("nosuch"))) as OrderRejectedError).emsg).toBe(
      "GTT not found to Cancel",
    );
    expect(((await rejection(client.modifyGtt("nosuch", GTT))) as OrderRejectedError).emsg).toBe(
      "GTT not found to Modify",
    );
    const id = await client.placeGtt(GTT);
    const error = await rejection(client.modifyGtt(id, { ...GTT, alertType: "LTP_A_O" }));
    expect((error as OrderRejectedError).emsg).toBe("ai_t cannot be modified");
  });

  it("triggerGtt places an order with add_ord_id and lists the GTT as triggered", async () => {
    const { broker, client } = setup();
    expect(await client.triggeredGtts()).toEqual([]);
    const id = await client.placeGtt(GTT);
    const orderId = broker.triggerGtt(id);
    expect(broker.orders[0]?.id).toBe(orderId);
    expect(broker.orders[0]?.payload["add_ord_id"]).toBe(id);
    expect((await client.orders())[0]?.raw["add_ord_id"]).toBe(id);
    expect(await client.pendingGtts()).toEqual([]);
    const [triggered] = await client.triggeredGtts();
    expect(triggered?.alertId).toBe(id);
    expect(triggered?.norentm).toBeInstanceOf(Date);
    expect(((await rejection(client.cancelGtt(id))) as OrderRejectedError).emsg).toBe(
      "GTT not found to Cancel",
    );
    expect(() => broker.triggerGtt(id)).toThrow(/no pending GTT/);
  });
});

describe("market data", () => {
  it("quote, search, security info and the option chain come from the added instruments", async () => {
    const { broker, client } = setup();
    addNifty(broker);
    broker.setQuote("NFO", "2003", { lastPrice: "101.50", volume: 1000 });
    const quote = await client.quote("NFO", "2003");
    expect(quote.lastPrice?.toString()).toBe("101.5");
    expect(quote.tradingsymbol).toBe(OPTION);
    await expect(client.quote("NSE", "424242")).rejects.toBeInstanceOf(APIError);

    const matches = await client.searchInstruments("sbin");
    expect(matches.map((m) => m.tradingsymbol)).toEqual(["SBIN-EQ"]);
    expect(await client.searchInstruments("NOSUCH")).toEqual([]);

    const info = await client.securityInfo("NFO", "2003");
    expect(info.tradingsymbol).toBe(OPTION);
    expect(info.raw["frzqty"]).toBe("1801");
    const missing = await rejection(client.securityInfo("NSE", "424242"));
    expect((missing as APIError).httpStatus).toBe(400);

    const chain = await client.optionChain("NFO", OPTION, "24000", 1);
    expect(
      chain.map((c) => `${c.strikePrice?.toString() ?? ""}${c.optionType ?? ""}`).sort(),
    ).toEqual(["23900CE", "24000CE", "24000PE"]);
    await expect(client.optionChain("NFO", "NOSUCH", "24000", 1)).resolves.toEqual([]);
  });

  it("an instrument added later reaches the script master", async () => {
    const { broker, client } = setup();
    addNifty(broker);
    let rows = await client.instruments("NFO");
    expect(rows.map((r) => r["TradingSymbol"])).toContain(OPTION);
    expect(rows.find((r) => r["TradingSymbol"] === OPTION)?.["Expiry"]).toBe("27-NOV-2026");
    broker.addInstrument("NFO", "9001", "BANKNIFTY-FUT", { instrument: "FUTIDX", lotSize: 30 });
    rows = await client.instruments("NFO");
    expect(rows.map((r) => r["TradingSymbol"])).toContain("BANKNIFTY-FUT");
    broker.addInstrument("BFO", "7001", "SENSEX27NOV26C80000", {
      strike: 80000,
      optionType: "CE",
      instrument: "OPTIDX",
    });
    const bfo = await client.instruments("BFO");
    expect(bfo[0]?.["Strike"]).toBe("80000.00");
  });

  it("candles come newest first, range-filtered (TPSeries by st..et, EODChartData by IST day)", async () => {
    const { broker, client } = setup();
    addNifty(broker);
    const times = [15, 16, 17].map((m) => new Date(Date.UTC(2026, 10, 10, 3, m)));
    broker.setCandles(
      "NSE",
      "3045",
      times.map((time, i) => ({ time, close: 100 + i, open: 99, high: 103, low: 98 })),
    );
    const closes = async (from?: Date, to?: Date): Promise<string[]> =>
      (await client.historicalData("NSE", "3045", { fromDate: from, toDate: to })).map(
        (c) => c.intc?.toString() ?? "",
      );
    expect(await closes()).toEqual(["102", "101", "100"]);
    expect(await closes(times[1], times[2])).toEqual(["102", "101"]);
    const later = new Date((times[2]?.getTime() ?? 0) + 5 * 86_400_000);
    expect(await closes(new Date(later.getTime() + 5 * 86_400_000))).toEqual([]);
    expect(await closes()).toHaveLength(3);
    await expect(client.historicalData("NSE", "999")).resolves.toEqual([]);

    const days = ["2026-11-03", "2026-11-04", "2026-11-05"];
    broker.setCandles(
      "NSE",
      "3045",
      days.map((date, i) => ({ time: { date }, close: 800 + i })),
    );
    const daily = async (a: string, b: string): Promise<string[]> =>
      (await client.dailyHistory("NSE", "SBIN-EQ", { date: a }, { date: b })).map(
        (c) => c.intc?.toString() ?? "",
      );
    expect(await daily("2026-11-03", "2026-11-05")).toEqual(["802", "801", "800"]);
    expect(await daily("2026-11-04", "2026-11-05")).toEqual(["802", "801"]);
    expect(await daily("2026-11-20", "2026-11-20")).toEqual([]);
    await expect(
      client.dailyHistory("NSE", "NOSUCH-EQ", { date: "2026-11-01" }, { date: "2026-11-11" }),
    ).resolves.toEqual([]);
  });

  it("candles without a usable time are kept last; bad bounds are refused", async () => {
    const { broker, client } = setup();
    addNifty(broker);
    broker.setCandles("NSE", "3045", [
      { time: "no time", close: "1" },
      { time: "blank epoch", ssboe: "", close: "2" },
      { time: new Date(Date.UTC(2026, 10, 10, 3, 15)), close: "3" },
    ]);
    const closes = async (extra: Record<string, unknown> = {}): Promise<string[]> =>
      (
        (await client.request(
          "TPSeries",
          { exch: "NSE", token: "3045", ...extra },
          {
            stateChanging: false,
            expect: "list",
          },
        )) as Record<string, string>[]
      ).map((row) => String(row["intc"]));
    expect(await closes()).toEqual(["3", "1", "2"]);
    expect(await closes({ st: "1", et: "1" })).toEqual(["1", "2"]);
    const bad = await rejection(
      client.request(
        "TPSeries",
        { exch: "NSE", token: "3045", st: "today" },
        { stateChanging: false },
      ),
    );
    expect((bad as APIError).emsg).toContain("st and et");
    const badEod = await rejection(
      client.request(
        "EODChartData",
        { sym: "NSE:SBIN-EQ", from: "x", to: "1" },
        { stateChanging: false, expect: "list" },
      ),
    );
    expect((badEod as APIError).emsg).toContain("from and to");
  });

  it("quote, tick and candle setters reject unknown fields and non-numeric values at once", () => {
    const { broker } = setup();
    expect(() => {
      broker.setQuote("NSE", "3045", { lastPrize: "1" });
    }).toThrow(/unknown quote field 'lastPrize'/);
    expect(() => {
      broker.setQuote("NSE", "3045", { lastPrice: "abc" });
    }).toThrow(/lastPrice must be a number/);
    expect(() => {
      broker.setQuote("NSE", "3045", { lastPrice: Number.NaN });
    }).toThrow(/lastPrice must be a number/);
    expect(() => {
      broker.setQuote("NSE", "3045", { v: "1e3x" });
    }).toThrow(/v must be a number/);
    broker.setQuote("NSE", "3045", { lp: "1", lut: 1700000000 });
    expect(() => {
      broker.setCandles("NSE", "3045", [{ time: new Date(), colse: 1 }]);
    }).toThrow(/unknown candle field 'colse'/);
    expect(() => {
      broker.setCandles("NSE", "3045", [{ time: new Date(), close: "x" }]);
    }).toThrow(/close must be a number/);
    expect(() => {
      broker.setCandles("NSE", "3045", [{ time: 12 }]);
    }).toThrow(/candle time must be/);
    expect(() => {
      broker.setCandles("NSE", "3045", [{ time: { date: "2026-02-30" } }]);
    }).toThrow(RangeError);
  });
});

describe("not modelled", () => {
  it("an endpoint without a route answers Not_Ok with a hint; setReply wins over a model", async () => {
    const { broker, client } = setup();
    addNifty(broker);
    const error = await rejection(
      client.orderMargin({
        exchange: "NFO",
        tradingsymbol: OPTION,
        quantity: 75,
        price: "101.50",
        product: "M",
        transactionType: "B",
        orderType: "LMT",
      }),
    );
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).emsg).toBe(
      "OfflineBroker does not model GetOrderMargin; set a reply with broker.setReply(...)",
    );
    broker.setReply("Limits", { stat: "Ok", cash: "7.00" });
    expect((await client.margins()).cash?.toString()).toBe("7");
  });
});

describe("drills", () => {
  it("reject: Not_Ok with the message, nothing placed, fires once", async () => {
    const { broker, client } = setup();
    broker.failNext("PlaceOrder", drills.reject("RMS:Margin Exceeds"));
    const error = await rejection(client.placeOrder(LIMIT_BUY));
    expect(error).toBeInstanceOf(OrderRejectedError);
    expect((error as OrderRejectedError).emsg).toBe("RMS:Margin Exceeds");
    expect(broker.orders).toEqual([]);
    expect(endpoints(broker)).toEqual(["PlaceOrder"]);
    await client.placeOrder(LIMIT_BUY);
    expect(broker.orders).toHaveLength(1);
  });

  it("timeoutAfterSend: the order exists but the status is unknown", async () => {
    const { broker, client } = setup();
    broker.failNext("PlaceOrder", drills.timeoutAfterSend());
    await expect(client.placeOrder(LIMIT_BUY)).rejects.toBeInstanceOf(OrderStatusUnknownError);
    expect(broker.orders).toHaveLength(1);
    expect(broker.orders[0]?.status).toBe("OPEN");
    await client.placeOrder(LIMIT_BUY);
    expect(broker.orders).toHaveLength(2);
    expect(endpoints(broker)).toEqual(["PlaceOrder", "PlaceOrder"]);
  });

  it("connectError: NetworkError, nothing sent or recorded", async () => {
    const { broker, client } = setup();
    broker.failNext("PlaceOrder", drills.connectError());
    await expect(client.placeOrder(LIMIT_BUY)).rejects.toBeInstanceOf(NetworkError);
    expect(broker.orders).toEqual([]);
    expect(broker.requests).toEqual([]);
    await client.placeOrder(LIMIT_BUY);
    expect(broker.orders).toHaveLength(1);
  });

  it("rateLimit: HTTP 429 with Retry-After", async () => {
    const { broker, client } = setup();
    broker.failNext("PlaceOrder", drills.rateLimit(2));
    const error = await rejection(client.placeOrder(LIMIT_BUY));
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).httpStatus).toBe(429);
    expect((error as RateLimitError).retryAfter).toBe(2);
    expect(broker.orders).toEqual([]);
    broker.failNext("PlaceOrder", drills.rateLimit());
    await expect(client.placeOrder(LIMIT_BUY)).rejects.toBeInstanceOf(RateLimitError);
  });

  it.each([false, true])("serverError on a read is a ServerError (json %s)", async (json) => {
    const { broker, client } = setup({ maxRetries: 0 });
    broker.failNext("Limits", drills.serverError(502, { json }));
    const error = await rejection(client.margins());
    expect(error).toBeInstanceOf(ServerError);
    expect((error as ServerError).httpStatus).toBe(502);
    expect((await client.margins()).stat).toBe("Ok");
  });

  it("serverError on an order: HTML page is unknown, JSON body is a rejection", async () => {
    const { broker, client } = setup();
    broker.failNext("PlaceOrder", drills.serverError());
    const unknown = await rejection(client.placeOrder(LIMIT_BUY));
    expect(unknown).toBeInstanceOf(OrderStatusUnknownError);
    expect((unknown as OrderStatusUnknownError).httpStatus).toBe(503);
    broker.failNext("PlaceOrder", drills.serverError(503, { json: true }));
    const rejected = await rejection(client.placeOrder(LIMIT_BUY));
    expect(rejected).toBeInstanceOf(OrderRejectedError);
    expect(rejected).not.toBeInstanceOf(ServerError);
    expect(broker.orders).toEqual([]);
    expect(endpoints(broker)).toEqual(["PlaceOrder", "PlaceOrder"]);
  });

  it("badBody: ResponseParseError on a read, OrderStatusUnknownError on an order", async () => {
    const { broker, client } = setup({ maxRetries: 0 });
    broker.failNext("Limits", drills.badBody());
    await expect(client.margins()).rejects.toBeInstanceOf(ResponseParseError);
    broker.failNext("PlaceOrder", drills.badBody());
    await expect(client.placeOrder(LIMIT_BUY)).rejects.toBeInstanceOf(OrderStatusUnknownError);
    await client.placeOrder(LIMIT_BUY);
    expect(broker.orders).toHaveLength(1);
  });

  it("sessionExpired: AuthenticationError with the documented text", async () => {
    const { broker, client } = setup();
    broker.failNext("OrderBook", drills.sessionExpired());
    const error = await rejection(client.orders());
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).emsg).toBe("Session Expired :  Invalid Session Key");
    expect(await client.orders()).toEqual([]);
  });

  it.each([
    ["rateLimit", drills.rateLimit(5), 2],
    ["serverError", drills.serverError(), 2],
    ["connectError", drills.connectError(), 1],
  ])("a read drill (%s) is retried by the SDK without waiting", async (_name, drill, count) => {
    const { broker, client } = setup();
    broker.failNext("Limits", drill);
    const started = Date.now();
    expect((await client.margins()).stat).toBe("Ok");
    expect(Date.now() - started).toBeLessThan(4000); // Retry-After 5 s is clamped, not waited
    expect(endpoints(broker).filter((e) => e === "Limits")).toHaveLength(count);
  });

  it("maxRetries 0 surfaces the read drill", async () => {
    const { broker, client } = setup({ maxRetries: 0 });
    broker.failNext("Limits", drills.rateLimit(5));
    await expect(client.margins()).rejects.toBeInstanceOf(RateLimitError);
    expect(endpoints(broker)).toEqual(["Limits"]);
  });

  it("failNext refuses anything but a built drill", () => {
    const { broker } = setup();
    expect(() => {
      broker.failNext("Limits", drills.reject as unknown as ReturnType<typeof drills.reject>);
    }).toThrow(TypeError);
    expect(() => {
      broker.failNext("Limits", { kind: "reject" } as unknown as ReturnType<typeof drills.reject>);
    }).toThrow(/call the function/);
  });

  it("drills queue up per endpoint and fire in order", async () => {
    const { broker, client } = setup({ maxRetries: 0 });
    broker.failNext("Limits", drills.reject("one"));
    broker.failNext("Limits", drills.reject("two"));
    expect(((await rejection(client.margins())) as APIError).emsg).toBe("one");
    expect(((await rejection(client.margins())) as APIError).emsg).toBe("two");
    expect((await client.margins()).stat).toBe("Ok");
  });
});

describe("requests, config and rate limit", () => {
  it("requests are recorded in order with secrets masked", async () => {
    const { broker, client } = setup();
    await client.margins();
    await client.placeOrder({ ...LIMIT_BUY, tag: "my-tag" });
    await client.generateSession("auth-code-xyz");
    expect(endpoints(broker)).toEqual(["Limits", "PlaceOrder", "GenAcsTok"]);
    const place = broker.requests[1]?.payload;
    expect(place?.["tsym"]).toBe(OPTION);
    expect(place?.["remarks"]).toBe("my-tag");
    const login = JSON.stringify(broker.requests[2]?.payload);
    expect(login).not.toContain("auth-code-xyz");
    expect(login).toContain("***");
    const dump = JSON.stringify(broker.requests) + JSON.stringify(broker.orders);
    expect(dump).not.toContain("offline-token-");
    expect(dump).not.toContain("offline-secret-key");
  });

  it("the broker refuses the URL settings it owns and builds no client once closed", async () => {
    const broker = new OfflineBroker();
    for (const name of ["baseUrl", "wsUrl", "authorizeUrl", "scriptMasterBaseUrl"] as const) {
      expect(() => broker.client({ [name]: "https://elsewhere.invalid" })).toThrow(
        ConfigurationError,
      );
    }
    await broker.close();
    await broker.close(); // idempotent
    expect(() => broker.client()).toThrow(/closed/);
  });

  it("supports await using and removes its private script-master folder", async () => {
    const seen = { dir: "" };
    {
      await using broker = new OfflineBroker();
      broker.addInstrument("NSE", "3045", "SBIN-EQ");
      const client = broker.client();
      seen.dir = client.config.instrumentsDir ?? "";
      expect(await client.instruments("NSE")).toHaveLength(1);
      expect(seen.dir).toContain("tradesmart-offline-");
      await client.close();
    }
    const { existsSync } = await import("node:fs");
    expect(existsSync(seen.dir)).toBe(false);
  });

  it("keeps the production retry count with a 1 ms backoff", () => {
    const { client } = setup();
    expect(client.config.maxRetries).toBe(2);
    expect(client.config.backoffBase).toBe(0.001);
    expect(client.config.backoffCap).toBe(0.001);
    expect(client.config.baseUrl).toBe("https://offline.tradesmart.invalid/NorenWClientAPIv2");
    expect(client.config.orderRateLimitPerMinute).toBe(200);
  });

  it("the client-side order rate limit still applies (RateLimitError beyond 10 a second)", async () => {
    const { broker, client } = setup({ orderRateLimitMaxWait: 0 });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, () => client.placeOrder(LIMIT_BUY)),
    );
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(2);
    expect(broker.orders).toHaveLength(10);
  });
});

describe("the dispatcher and the handler", () => {
  async function call(
    dispatcher: OfflineDispatcher,
    method: "GET" | "POST",
    url: string,
    body?: string,
  ): Promise<{ status: number; text: string }> {
    const u = new URL(url);
    const res = await dispatcher.request({
      origin: u.origin,
      path: u.pathname,
      method,
      ...(body === undefined ? {} : { body }),
    });
    return { status: res.statusCode, text: await res.body.text() };
  }
  const BASE = "https://offline.tradesmart.invalid/NorenWClientAPIv2";

  it("answers 404 for an unknown path or host", async () => {
    const dispatcher = new OfflineDispatcher(new BrokerState());
    expect((await call(dispatcher, "GET", "https://offline.tradesmart.invalid/x")).status).toBe(
      404,
    );
    expect(
      (
        await call(
          dispatcher,
          "POST",
          "https://example.invalid/NorenWClientAPIv2/Limits",
          "jData={}",
        )
      ).status,
    ).toBe(404);
    expect(
      (await call(dispatcher, "GET", "https://offline.tradesmart.invalid/XYZ_symbols.txt.zip"))
        .status,
    ).toBe(404);
  });

  it("an undecodable request answers Not_Ok and leaves an armed drill armed", async () => {
    const state = new BrokerState();
    const dispatcher = new OfflineDispatcher(state);
    state.failNext("Limits", drills.reject("armed"));
    for (const body of ["nothing", "jData=%E0%A4%A", "jData=[1]", "jData=notjson"]) {
      const reply = await call(dispatcher, "POST", `${BASE}/Limits`, body);
      expect(parse(reply.text).emsg).toBe("Invalid Input : jData is not a JSON object");
    }
    const armed = await call(dispatcher, "POST", `${BASE}/Limits`, "jData={}");
    expect(parse(armed.text).emsg).toBe("armed");
    expect(parse((await call(dispatcher, "POST", `${BASE}/Limits`, "jData={}")).text).stat).toBe(
      "Ok",
    );
  });

  it("bad numbers in a request are an Invalid Input refusal, not a crash", async () => {
    const state = new BrokerState();
    const dispatcher = new OfflineDispatcher(state);
    const place = async (payload: object): Promise<{ emsg?: string; stat: string }> =>
      parse(
        (await call(dispatcher, "POST", `${BASE}/PlaceOrder`, `jData=${JSON.stringify(payload)}`))
          .text,
      ) as { emsg?: string; stat: string };
    expect((await place({ qty: "x", prctyp: "LMT" })).emsg).toBe(
      "Invalid Input : qty must be a number, got x",
    );
    expect((await place({ qty: "1.5", prctyp: "LMT" })).emsg).toContain("whole number");
    const modify = parse(
      (await call(dispatcher, "POST", `${BASE}/ModifyGTTOrder`, 'jData={"al_id":"1"}')).text,
    ) as { emsg: string };
    expect(modify.emsg).toMatch(/^Invalid Input : exch, tsym, ai_t/);
    const exploring = await call(
      dispatcher,
      "POST",
      `${BASE}/GetOptionChain`,
      'jData={"strprc":"x","cnt":"1"}',
    );
    expect(parse(exploring.text).emsg).toContain("strprc and cnt must be numbers");
  });

  it("an invalid defaultPlace raises instead of rejecting", async () => {
    const state = new BrokerState();
    state.defaultPlace = "bogus";
    const dispatcher = new OfflineDispatcher(state);
    await expect(
      call(dispatcher, "POST", `${BASE}/PlaceOrder`, 'jData={"qty":"1","prctyp":"LMT"}'),
    ).rejects.toThrow(/defaultPlace must be/);
  });

  it("an unknown drill kind is a clear error", async () => {
    const state = new BrokerState();
    const dispatcher = new OfflineDispatcher(state);
    const real = drills.reject("x");
    state.failNext("Limits", real);
    const stub = { ...real, kind: "nope" } as unknown as typeof real;
    // Built drills are tracked by identity: a copy is refused, so arm through the real one.
    expect(() => {
      state.failNext("Limits", stub);
    }).toThrow(TypeError);
    expect(parse((await call(dispatcher, "POST", `${BASE}/Limits`, "jData={}")).text).emsg).toBe(
      "x",
    );
  });

  it("close and destroy mark the dispatcher closed", async () => {
    const dispatcher = new OfflineDispatcher(new BrokerState());
    expect(dispatcher.closed).toBe(false);
    await dispatcher.close();
    expect(dispatcher.closed).toBe(true);
    expect(dispatcher.destroyed).toBe(true);
    await new Promise<void>((resolve) => {
      dispatcher.close(resolve);
    });
    await new Promise<void>((resolve) => {
      dispatcher.destroy(resolve);
    });
    await dispatcher.destroy();
    await dispatcher.destroy(null);
    await new Promise<void>((resolve) => {
      dispatcher.destroy(null, resolve);
    });
  });

  it("a request can be aborted", async () => {
    const dispatcher = new OfflineDispatcher(new BrokerState());
    const abort = new AbortController();
    const pending = dispatcher.request({
      origin: "https://offline.tradesmart.invalid",
      path: "/NorenWClientAPIv2/Limits",
      method: "POST",
      body: "jData={}",
      signal: abort.signal,
    });
    abort.abort();
    await expect(pending).rejects.toBeDefined();
  });

  it("every reply parses with the SDK models and the shared fixtures' key sets", async () => {
    const { broker, client } = setup();
    addNifty(broker);
    broker.setQuote("NFO", "2003", { lastPrice: "1" });
    const id = await client.placeOrder(LIMIT_BUY);
    broker.fill(id, "100");
    const gtt = await client.placeGtt(GTT);
    const keysOf = (name: string): string[] => {
      const parsed = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as unknown;
      const first = Array.isArray(parsed) ? (parsed as unknown[])[0] : parsed;
      return Object.keys(first as object);
    };
    const wire = async (endpoint: string, payload: Record<string, string> = {}): Promise<unknown> =>
      client
        .request(endpoint, payload, { stateChanging: false, expect: "object" })
        .catch(async () =>
          client.request(endpoint, payload, { stateChanging: false, expect: "list" }),
        );
    const rowOf = (value: unknown): Record<string, unknown> =>
      (Array.isArray(value) ? value[0] : value) as Record<string, unknown>;
    const cases: [string, string, Record<string, string>][] = [
      ["order_book_success.json", "OrderBook", {}],
      ["trade_book_success.json", "TradeBook", {}],
      ["single_ord_hist_success.json", "SingleOrdHist", { norenordno: id }],
      ["position_book_success.json", "PositionBook", {}],
      ["limits_success.json", "Limits", {}],
      ["user_details_success.json", "UserDetails", {}],
      ["pending_gtts_success.json", "GetPendingGTTOrder", {}],
      ["get_quotes_success.json", "GetQuotes", { exch: "NFO", token: "2003" }],
    ];
    for (const [fixture, endpoint, payload] of cases) {
      const row = rowOf(await wire(endpoint, payload));
      const missing = keysOf(fixture).filter((key) => !(key in row) && !SENT_ONLY.has(key));
      expect(missing, `${endpoint} lacks ${missing.join(",")}`).toEqual([]);
    }
    expect(gtt).toBeTruthy();
  });
});
