// Edge cases of the offline broker's setup values, positions, modify, candles, GTT and listeners
// (sdk-behaviour.md §16), through a real client and the in-memory dispatcher.
import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { APIError, OrderRejectedError, ServerError, type TradeSmart } from "../../src/index.js";
import { OfflineBroker, drills } from "../../src/testing/index.js";
import { OfflineDispatcher } from "../../src/testing/rest.js";
import { BrokerState } from "../../src/testing/state.js";

const OPTION = "NIFTY27NOV26C24000";
const brokers: OfflineBroker[] = [];
const clients: TradeSmart[] = [];

function setup(): { broker: OfflineBroker; client: TradeSmart } {
  const broker = new OfflineBroker();
  brokers.push(broker);
  const client = broker.client();
  clients.push(client);
  return { broker, client };
}

afterEach(async () => {
  while (clients.length > 0) await clients.pop()?.close();
  while (brokers.length > 0) await brokers.pop()?.close();
});

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

function addNifty(broker: OfflineBroker): void {
  for (const [token, symbol, strike, type] of [
    ["2003", "NIFTY27NOV26C24000", 24000, "CE"],
    ["2004", "NIFTY27NOV26C23900", 23900, "CE"],
    ["2005", "NIFTY27NOV26P24000", 24000, "PE"],
    ["2006", "NIFTY27NOV26P23900", 23900, "PE"],
  ] as const) {
    broker.addInstrument("NFO", token, symbol, {
      lotSize: 75,
      instrument: "OPTIDX",
      expiry: { date: "2026-11-27" },
      strike,
      optionType: type,
      underlying: "NIFTY",
    });
  }
  broker.addInstrument("NSE", "3045", "SBIN-EQ");
}

const parse = (text: string): Record<string, string> => JSON.parse(text) as Record<string, string>;

describe("setup values", () => {
  it("instruments take Date or day expiries, futures, decimals and refuse bad numbers", async () => {
    const { broker, client } = setup();
    broker.addInstrument("NFO", "1", "NIFTY-FUT", {
      instrument: "FUTIDX",
      expiry: new Date(Date.UTC(2026, 10, 26, 12)),
      tickSize: new Decimal("0.0500"),
      lotSize: 75,
    });
    broker.addInstrument("NFO", "2", "NIFTY-OPT", {
      optionType: "PE",
      strike: new Decimal("24000.5"),
      tickSize: 5,
      extra: { note: "x", list: ["a"] },
    });
    const rows = await client.instruments("NFO");
    const fut = rows.find((r) => r["TradingSymbol"] === "NIFTY-FUT");
    expect(fut?.["OptionType"]).toBe("XX");
    expect(fut?.["Expiry"]).toBe("26-NOV-2026");
    expect(fut?.["TickSize"]).toBe("0.05");
    expect(rows.find((r) => r["TradingSymbol"] === "NIFTY-OPT")?.["StrikePrice"]).toBe("24000.50");
    expect(() => {
      broker.addInstrument("NSE", "3", "X", { tickSize: "abc" });
    }).toThrow(/tickSize must be a number/);
    expect(() => {
      broker.addInstrument("NSE", "3", "X", { strike: "abc" });
    }).toThrow(/strike must be a number/);
    expect(() => {
      broker.addInstrument("NSE", "3", "X", { expiry: { date: "2026-13-40" } });
    }).toThrow(/a day must be/);
    expect(() => {
      broker.addInstrument("NSE", "3", "X", { expiry: new Date(Number.NaN) });
    }).toThrow(/valid Date/);
    broker.addInstrument("ZZZ", "4", "X"); // an unknown exchange has no script master
  });

  it("funds, holdings, user and quote values take numbers, Decimals, bigints and lists", async () => {
    const { broker, client } = setup();
    broker.setFunds({ cash: 100.5, payin: new Decimal("7"), payout: 3n, remarks_text: null });
    broker.setUser({ uname: 5, access_type: ["API", "X"], flag: true, nested: { a: 1 } });
    broker.setHoldings([{ holdqty: 5, upldprc: new Decimal("1.5") }]);
    broker.setQuote("NSE", "9", { lastPrice: new Decimal("2.5"), volume: 3n, oi: "" });
    const limits = await client.margins();
    expect(limits.cash?.toString()).toBe("100.5");
    expect(limits.payin?.toString()).toBe("7");
    expect((await client.profile()).raw["flag"]).toBe("true");
    expect((await client.holdings())[0]?.holdqty).toBe(5);
    expect((await client.quote("NSE", "9")).lastPrice?.toString()).toBe("2.5");
  });
});

describe("positions and fills", () => {
  it("a sell fill nets a position short; further fills update the same row", async () => {
    const { broker, client } = setup();
    addNifty(broker);
    const sell = await client.placeOrder({ ...LIMIT_BUY, transactionType: "S" });
    broker.fill(sell, "110", 25);
    broker.fill(sell, "120", 50);
    const rows = await client.positions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.netQuantity).toBe(-75);
    const buy = await client.placeOrder(LIMIT_BUY);
    broker.fill(buy, "100", 75);
    const after = await client.positions();
    expect(after).toHaveLength(1);
    expect(after[0]?.netQuantity).toBe(0);
    // The reference shows the realised profit unrounded (28-digit Decimal arithmetic).
    expect(after[0]?.raw["rpnl"]).toBe("1250.000000000000000000000002");
  });

  it("starting positions carry forward a net quantity as a buy or sell", async () => {
    const { broker, client } = setup();
    broker.setPositions([
      { exch: "NSE", tsym: "A-EQ", prd: "C", netqty: "10", netavgprc: "50.5" },
      { exch: "NSE", tsym: "B-EQ", prd: "C", netqty: "-4", netavgprc: "20" },
      { exch: "NSE", tsym: "C-EQ", prd: "C", cfbuyqty: 3, cfbuyamt: "30" },
    ]);
    const rows = await client.positions();
    expect(rows.map((r) => r.netQuantity)).toEqual([10, -4, 3]);
    expect(rows[0]?.raw["cfbuyamt"]).toBe("505.00");
    expect(rows[1]?.raw["cfsellqty"]).toBe("4");
    expect(() => {
      broker.setPositions([{ exch: "NSE", tsym: "A-EQ", prd: "C", netavgprc: "x" }]);
    }).toThrow(/netavgprc must be a number/);
    expect(await client.positions()).toHaveLength(3); // a refused set changes nothing
  });
});

describe("order edits", () => {
  it("modify can switch the order type, price and trigger", async () => {
    const { broker, client } = setup();
    const id = await client.placeOrder(LIMIT_BUY);
    await client.modifyOrder(id, { ...MODIFY, orderType: "MKT", price: null });
    expect(broker.orders[0]?.price).toBeNull();
    await client.modifyOrder(id, {
      ...MODIFY,
      orderType: "SL-LMT",
      triggerPrice: "99.50",
      price: "100",
    });
    expect(broker.orders[0]?.status).toBe("TRIGGER_PENDING");
    expect(broker.orders[0]?.triggerPrice?.toString()).toBe("99.5");
    await client.modifyOrder(id, { ...MODIFY, orderType: "LMT" });
    expect(broker.orders[0]?.triggerPrice).toBeNull();
    expect(broker.orders[0]?.status).toBe("OPEN");
    broker.defaultPlace = "pending";
    const pending = await client.placeOrder(LIMIT_BUY);
    await client.modifyOrder(pending, { ...MODIFY, orderType: "SL-LMT", triggerPrice: "98" });
    expect(broker.orders[1]?.status).toBe("PENDING");
    expect((await client.orderHistory(id))[0]?.status).toBe("OPEN");
  });

  it("bracket legs and a disclosed quantity are echoed in the order book", async () => {
    const { client } = setup();
    await client.placeOrder({
      ...LIMIT_BUY,
      product: "B",
      bookLossPrice: "95",
      bookProfitPrice: "110",
      trailPrice: "1",
      disclosedQuantity: 10,
      tag: "bo",
    });
    const [row] = await client.orders();
    expect(row?.bookLossPrice?.toString()).toBe("95");
    expect(row?.bookProfitPrice?.toString()).toBe("110");
    expect(row?.trailPrice?.toString()).toBe("1");
    expect(row?.disclosedQuantity).toBe(10);
  });
});

describe("candles, GTT, chain and listeners", () => {
  it("candles accept wire keys, Dates for a daily candle and text times", async () => {
    const { broker, client } = setup();
    addNifty(broker);
    broker.setCandles("NSE", "3045", [
      { time: new Date(Date.UTC(2026, 10, 4, 3)), intc: "5", ssboe: "0" },
      { time: new Date(Date.UTC(2026, 10, 5, 3)), close: new Decimal("6"), volume: 7n },
      { close: "8" },
      { time: { date: "2026-11-06" }, close: "9" },
      { time: "2026-11-07", close: "10" },
    ]);
    const daily = await client.dailyHistory(
      "NSE",
      "SBIN-EQ",
      { date: "2026-11-01" },
      { date: "2026-11-30" },
    );
    expect(daily.map((c) => c.intc?.toString())).toEqual(["9", "6", "5", "8", "10"]);
    expect(await client.historicalData("NSE", "3045")).toHaveLength(5);
  });

  it("GTT fields are checked and a trigger price is listed", async () => {
    const { broker, client } = setup();
    const id = await client.placeGtt({ ...GTT, orderType: "SL-LMT", triggerPrice: "799" });
    expect((await client.pendingGtts())[0]?.triggerPrice?.toString()).toBe("799");
    const empty = await client
      .request("PlaceGTTOrder", { exch: "NSE" }, { stateChanging: true })
      .catch((e: unknown) => e);
    expect((empty as OrderRejectedError).emsg).toMatch(/^Invalid Input : tsym, ai_t/);
    const orderId = broker.triggerGtt(id);
    expect((await client.orders())[0]?.orderId).toBe(orderId);
    expect(broker.orders[0]?.status).toBe("TRIGGER_PENDING");
  });

  it("the option chain honours the count and orders strikes, CE before PE", async () => {
    const { broker, client } = setup();
    addNifty(broker);
    const chain = await client.optionChain("NFO", OPTION, "24000", 1);
    expect(chain.map((c) => `${c.strikePrice?.toString() ?? ""}${c.optionType ?? ""}`)).toEqual([
      "23900CE",
      "23900PE",
      "24000CE",
      "24000PE",
    ]);
    expect(await client.optionChain("NFO", OPTION, "30000", 1)).toHaveLength(2);
    expect(await client.optionChain("NFO", OPTION, "30000", 5)).toHaveLength(4);
  });

  it("listeners receive om and pm in order; a failing listener stops nothing", () => {
    const state = new BrokerState();
    const seen: string[] = [];
    state.addListener(() => {
      throw new Error("boom");
    });
    state.addListener((m) => {
      const t = m["t"] as string;
      seen.push(`${t}:${(m["status"] ?? m["netqty"]) as string}`);
    });
    const order = state.place({
      exch: "NSE",
      tsym: "X",
      trantype: "B",
      prctyp: "LMT",
      prc: "1",
      qty: "2",
      prd: "C",
    });
    state.fill(order.id, "1", 2);
    expect(seen).toEqual(["om:PENDING", "om:OPEN", "om:COMPLETE", "pm:2"]);
  });

  it("a listener that changes the broker is delivered after the events already queued", () => {
    const state = new BrokerState();
    const seen: string[] = [];
    state.addListener((m) => {
      seen.push(`${m["t"] as string}:${m["status"] as string}`);
      if (m["status"] === "PENDING") state.cancel(m["norenordno"] as string);
    });
    state.place({
      exch: "NSE",
      tsym: "X",
      trantype: "B",
      prctyp: "LMT",
      prc: "1",
      qty: "2",
      prd: "C",
    });
    expect(seen).toEqual(["om:PENDING", "om:OPEN", "om:CANCELED"]);
  });
});

describe("remaining branches", () => {
  const read = { stateChanging: false } as const;

  it("open bounds, a symbol without an exchange, csv quoting and an empty chain selection", async () => {
    const { broker, client } = setup();
    addNifty(broker);
    broker.addInstrument("NSE", "77", "A,B-EQ");
    broker.addInstrument("NFO", "88", "NIFTY27NOV26C99999", {
      expiry: { date: "2026-11-27" },
      optionType: "CE",
      underlying: "NIFTY",
    }); // an option without a strike is never picked
    broker.setCandles("NSE", "3045", [{ time: { date: "2026-11-03" }, close: "800" }]);
    const rows = (await client.request(
      "EODChartData",
      { sym: "NSE:SBIN-EQ" },
      { ...read, expect: "list" },
    )) as unknown[];
    expect(rows).toHaveLength(1);
    expect(
      await client.request("EODChartData", { sym: "NOCOLON" }, { ...read, expect: "list" }),
    ).toEqual([]);
    const tp = (await client.request(
      "TPSeries",
      { exch: "NSE", token: "3045", st: " ", et: "" },
      { ...read, expect: "list" },
    )) as unknown[];
    expect(tp).toHaveLength(1);
    const names = (await client.instruments("NSE")).map((r) => r["TradingSymbol"]);
    expect(names).toContain("A,B-EQ");
    const none = client.request(
      "GetOptionChain",
      { exch: "NFO", tsym: OPTION, strprc: "24000", cnt: "0" },
      { ...read, expect: "list" },
    );
    await expect(none).rejects.toBeInstanceOf(APIError);
    expect(await client.optionChain("NFO", OPTION, "24000", 1)).toHaveLength(4);
  });

  it("quote fields that are text, a NaN Decimal and a fill without a price", async () => {
    const { broker, client } = setup();
    broker.setQuote("NSE", "5", { ltt: "10:00:00", lastPrice: 1.5 });
    expect((await client.quote("NSE", "5")).raw["ltt"]).toBe("10:00:00");
    expect(() => {
      broker.setQuote("NSE", "5", { lastPrice: new Decimal(Number.NaN) });
    }).toThrow(/must be a number/);
    broker.setFunds({ cash: Number.NaN, payin: new Decimal(Number.NaN) });
    const id = "x";
    expect(() => {
      broker.fill(id, "");
    }).toThrow(/no order with id/);
    expect(() => {
      broker.setCandles("NSE", "5", [{ time: { date: 5 as unknown as string } }]);
    }).toThrow(/a day must be/);
  });

  it("a fill without a price and a three-decimal price", async () => {
    const { broker, client } = setup();
    const id = await client.placeOrder(LIMIT_BUY);
    expect(() => {
      broker.fill(id, "");
    }).toThrow(/fill needs a price/);
    broker.fill(id, "101.505", 10);
    expect((await client.trades())[0]?.flprc?.toString()).toBe("101.505");
  });

  it("requests without optional keys, positions without a product and refusals of unknown input", async () => {
    const { broker, client } = setup();
    const id = await client.placeOrder(LIMIT_BUY);
    const write = { stateChanging: true } as const;
    await client.request("ModifyOrder", { norenordno: id, prctyp: "LMT", prc: "103" }, write);
    expect(broker.orders[0]?.price?.toString()).toBe("103");
    await client.request("ModifyOrder", { norenordno: id, prctyp: "MKT" }, write);
    expect(broker.orders[0]?.price).toBeNull();
    await client
      .request("ModifyOrder", { norenordno: id, qty: "75", trgprc: "5", prctyp: "SL-MKT" }, write)
      .catch((e: unknown) => e);
    broker.setPositions([{ exch: "NSE", tsym: "Q-EQ" }]);
    expect(await client.positions()).toHaveLength(1);
    const bad = await client
      .request("ModifyOrder", { norenordno: id, qty: "x" }, write)
      .catch((e: unknown) => e);
    expect((bad as OrderRejectedError).emsg).toContain("Invalid Input");
  });

  it("a server error with an unusual status and an already aborted request", async () => {
    const { broker } = setup();
    const client = broker.client({ maxRetries: 0 });
    clients.push(client);
    broker.failNext("Limits", drills.serverError(599));
    const error = await client.margins().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerError);
    const dispatcher = new OfflineDispatcher(new BrokerState());
    const abort = new AbortController();
    abort.abort();
    await expect(
      dispatcher.request({
        origin: "https://offline.tradesmart.invalid",
        path: "/NorenWClientAPIv2/Limits",
        method: "POST",
        body: "jData={}",
        signal: abort.signal,
      }),
    ).rejects.toBeDefined();
  });
});

describe("dispatcher body handling", () => {
  it("refuses a body that is not text or bytes and answers a missing body Not_Ok", async () => {
    const dispatcher = new OfflineDispatcher(new BrokerState());
    const base = {
      origin: "https://offline.tradesmart.invalid",
      path: "/NorenWClientAPIv2/Limits",
      method: "POST",
    } as const;
    await expect(
      dispatcher.request({ ...base, body: 5 as unknown as string }),
    ).rejects.toBeInstanceOf(TypeError);
    const reply = await dispatcher.request(base);
    expect(parse(await reply.body.text())["emsg"]).toBe(
      "Invalid Input : jData is not a JSON object",
    );
    const bytes = await dispatcher.request({ ...base, body: new TextEncoder().encode("jData={}") });
    expect(parse(await bytes.body.text())["stat"]).toBe("Ok");
  });
});
