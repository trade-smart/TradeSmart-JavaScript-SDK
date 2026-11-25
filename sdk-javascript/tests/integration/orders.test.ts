// The order and GTT write methods (and orderMargin) on the real client against the shared
// fixtures and scripted replies (sdk-behaviour.md §2.3, §2.4, §2.8, §4.2.1, §5.2–5.6).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import {
  OrderRejectedError,
  OrderStatusUnknownError,
  RequestValidationError,
} from "../../src/errors.js";
import { executeCall } from "../../src/lib/call.js";
import type { ClientConfigInit } from "../../src/config.js";
import { scriptedClient, type Reply, type Scripted } from "../helpers/scripted-client.js";
import type { PlaceGttParams, PlaceOrderParams } from "../../src/client.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../specifications/test-fixtures",
);
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf8");

const ORDER_ID = "26111000000001";
const ALERT_ID = "26111200000010";

const LIMIT_BUY: PlaceOrderParams = {
  exchange: "NSE",
  tradingsymbol: "ACC-EQ",
  quantity: 1,
  transactionType: "BUY",
  product: "CNC",
  orderType: "LIMIT",
  price: "2000.05",
};
const MODIFY = {
  exchange: "NSE",
  tradingsymbol: "ACC-EQ",
  quantity: 1,
  price: "2001.00",
  orderType: "LIMIT",
  product: "CNC",
} as const;
const GTT: PlaceGttParams = {
  exchange: "NSE",
  tradingsymbol: "INFY-EQ",
  alertType: "LTP_B_O",
  triggerValue: "1500",
  alertValidity: "GTT",
  tag: "Buy INFY below 1500",
  transactionType: "B",
  orderType: "LMT",
  product: "C",
  validity: "DAY",
  quantity: 1,
  price: "1500",
};
const MODIFY_GTT = { ...GTT, validity: "DAY", alertValidity: "GTT" } as const;

const open: Scripted[] = [];
function scripted(replies: Reply[] | string, config: ClientConfigInit = {}): Scripted {
  const s = scriptedClient(typeof replies === "string" ? [{ body: replies }] : replies, {
    config,
  });
  open.push(s);
  return s;
}
afterEach(async () => {
  while (open.length > 0) await open.pop()?.agent.close();
});

const OK_ACK = `{"stat":"Ok","norenordno":"${ORDER_ID}"}`;

function infoLines(s: Scripted): string[] {
  return s.lines
    .filter((l) => l.ctx?.logger === "tradesmart.orders" && l.level === "info")
    .map((l) => l.msg.replace(/ in \d+ ms$/, ""));
}

/** The JSON object inside the one recorded `jData=` body. */
function sentBody(s: Scripted, index = 0): Record<string, string> {
  const body = s.bodies[index] ?? "";
  return JSON.parse(decodeURIComponent(body.slice("jData=".length))) as Record<string, string>;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

describe("placeOrder", () => {
  it("returns the order id of place_order_success.json and logs it as accepted", async () => {
    const s = scripted(fixture("place_order_success.json"));
    await expect(s.client.placeOrder(LIMIT_BUY)).resolves.toBe("26110700000001");
    expect(infoLines(s)).toEqual(["PlaceOrder accepted order_id=26110700000001"]);
    expect(s.sends).toBe(1);
  });

  it("returns the order id as received (not trimmed)", async () => {
    const s = scripted('{"stat":"Ok","norenordno":" 26110700000001 "}');
    await expect(s.client.placeOrder(LIMIT_BUY)).resolves.toBe(" 26110700000001 ");
  });

  it("a Not_Ok reply is OrderRejectedError (one request, logged rejected)", async () => {
    const s = scripted('{"stat":"Not_Ok","emsg":"Insufficient funds"}');
    const error = await rejection(s.client.placeOrder(LIMIT_BUY));
    expect(error).toBeInstanceOf(OrderRejectedError);
    expect(s.sends).toBe(1);
    expect(infoLines(s)).toEqual(["PlaceOrder rejected order_id=-"]);
  });

  it("a 502 HTML body is OrderStatusUnknownError after exactly one request", async () => {
    const s = scripted([{ status: 502, body: "<html><body>Bad Gateway</body></html>" }]);
    const error = await rejection(s.client.placeOrder(LIMIT_BUY));
    expect(error).toBeInstanceOf(OrderStatusUnknownError);
    expect(s.sends).toBe(1);
    expect(infoLines(s)).toEqual(["PlaceOrder unknown order_id=-"]);
  });

  it.each([
    ['{"stat":"Ok"}', "no order number"],
    ['{"stat":"Ok","norenordno":"   "}', "a blank order number"],
    ['{"stat":"Ok","norenordno":{"x":1}}', "an unparseable order number"],
  ])("an Ok ack %s (%s) is OrderStatusUnknownError", async (body) => {
    const s = scripted(body);
    const error = await rejection(s.client.placeOrder(LIMIT_BUY));
    expect(error).toBeInstanceOf(OrderStatusUnknownError);
    expect((error as Error).message).toContain("orders()");
    expect(s.sends).toBe(1);
  });

  it("a numeric order id is returned as its text", async () => {
    const s = scripted('{"stat":"Ok","norenordno":26110700000001}');
    await expect(s.client.placeOrder(LIMIT_BUY)).resolves.toBe("26110700000001");
  });

  it("price 0.1 + 0.2 is sent as its shortest text", async () => {
    const s = scripted(OK_ACK);
    await s.client.placeOrder({ ...LIMIT_BUY, price: 0.1 + 0.2 });
    expect(s.bodies[0]).toContain('"prc":"0.30000000000000004"');
  });

  it("always sends amo (No by default, Yes when set) and ordersource API", async () => {
    const s = scripted(OK_ACK);
    await s.client.placeOrder(LIMIT_BUY);
    await s.client.placeOrder({ ...LIMIT_BUY, amo: true });
    expect(sentBody(s, 0)["amo"]).toBe("No");
    expect(sentBody(s, 1)["amo"]).toBe("Yes");
    expect(sentBody(s, 0)["ordersource"]).toBe("API");
  });
});

describe("price parameters (ruling 1: Python's Decimal(text) formatting)", () => {
  // A typed string keeps its own digits (trailing zeros included), as format(Decimal(text), "f").
  it.each([
    ["2001.00", "2001.00"],
    [" 2001.00 ", "2001.00"],
    ["\t7\n", "7"],
    ["+2001.00", "2001.00"],
    ["1e2", "100"],
    ["1E+2", "100"],
    ["1.0e2", "100"],
    ["1.23E+5", "123000"],
    ["1.50e-1", "0.150"],
    ["1e-7", "0.0000001"],
    ["9.9e-30", "0.0000000000000000000000000000099"],
    [".5", "0.5"],
    ["5.", "5"],
    ["0005.10", "5.10"],
    [
      "12345678901234567890.123456789012345678901234567890",
      "12345678901234567890.123456789012345678901234567890",
    ],
  ])("string %j is sent as %j", async (price, wire) => {
    const s = scripted(OK_ACK);
    await s.client.placeOrder({ ...LIMIT_BUY, price });
    expect(sentBody(s)["prc"]).toBe(wire);
  });

  it.each([
    [2000, "2000"],
    [2000.05, "2000.05"],
    [1e-7, "0.0000001"],
    [1e21, "1000000000000000000000"],
    [100.0, "100"],
  ])("number %s is sent as %j (its shortest text)", async (price, wire) => {
    const s = scripted(OK_ACK);
    await s.client.placeOrder({ ...LIMIT_BUY, price });
    expect(sentBody(s)["prc"]).toBe(wire);
  });

  it.each([
    [new Decimal("2001.00"), "2001"],
    [new Decimal("1e-7"), "0.0000001"],
    [new Decimal("2000.05"), "2000.05"],
  ])("Decimal %s is sent as decimal.js text %j (trailing zeros lost)", async (price, wire) => {
    const s = scripted(OK_ACK);
    await s.client.placeOrder({ ...LIMIT_BUY, price });
    expect(sentBody(s)["prc"]).toBe(wire);
  });

  it.each([
    ["0", "0"],
    ["-0", "-0"],
    ["-0.0", "-0.0"],
    ["0e5", "0"],
    ["0e-3", "0.000"],
    ["00.000", "0.000"],
  ])("a market order's zero price %j is sent as %j", async (price, wire) => {
    const s = scripted(OK_ACK);
    await s.client.placeOrder({ ...LIMIT_BUY, orderType: "MARKET", price });
    expect(sentBody(s)["prc"]).toBe(wire);
  });

  it.each([
    ["abc", "abc"],
    ["empty text", ""],
    ["blank text", "   "],
    ["1e", "1e"],
    ["e5", "e5"],
    [".", "."],
    ["1.2.3", "1.2.3"],
    ["nan", "nan"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["-inf", "-inf"],
    ["0x10", "0x10"],
    // Stricter than Python's Decimal(text): no `_` separators, no non-ASCII digits, |exp| <= 1000.
    ["2_000", "2_000"],
    ["Arabic-Indic digits", "١٢"],
    ["1e1001", "1e1001"],
    ["true", true],
    ["NaN (number)", Number.NaN],
    ["Infinity (number)", Number.POSITIVE_INFINITY],
    ["Decimal NaN", new Decimal(Number.NaN)],
    ["an object", {}],
    ["a bigint", 10n],
  ])("%s is not a price: RequestValidationError prc, nothing sent", async (_label, price) => {
    const s = scripted(OK_ACK);
    const error = await rejection(s.client.placeOrder({ ...LIMIT_BUY, price: price as never }));
    expect(error).toBeInstanceOf(RequestValidationError);
    expect((error as RequestValidationError).errors.map((i) => i.loc)).toEqual([["prc"]]);
    expect(s.sends).toBe(0);
  });

  it("a negative price is greater_than_equal on its wire key", async () => {
    const s = scripted(OK_ACK);
    const error = await rejection(s.client.placeOrder({ ...LIMIT_BUY, triggerPrice: "-0.05" }));
    expect((error as RequestValidationError).errors).toContainEqual(
      expect.objectContaining({ loc: ["trgprc"], type: "greater_than_equal" }),
    );
  });

  it("the trigger value of a GTT keeps its text too and may be negative", async () => {
    const s = scripted(fixture("place_gtt_success.json"));
    await s.client.placeGtt({ ...GTT, alertType: "CH_PER_B_O", triggerValue: "-5.50" });
    expect(sentBody(s)["d"]).toBe("-5.50");
  });
});

describe("validation collects every failed check (ruling 4)", () => {
  it("one RequestValidationError with one issue per failed field, nothing sent", async () => {
    const s = scripted(OK_ACK);
    const error = await rejection(
      s.client.placeOrder({
        ...LIMIT_BUY,
        exchange: "XYZ",
        tradingsymbol: 5 as never,
        quantity: 0,
        price: "abc",
        product: "DELIVERY",
        algoId: " ",
        amo: "yes" as never,
      }),
    );
    expect(error).toBeInstanceOf(RequestValidationError);
    const locs = (error as RequestValidationError).errors.map((i) => i.loc.join("."));
    expect([...locs].sort()).toEqual(["algo_id", "amo", "exch", "prc", "prd", "qty", "tsym"]);
    expect((error as Error).message).toMatch(/^Invalid request parameters: /);
    expect(s.sends).toBe(0);
    expect(infoLines(s)).toEqual([]);
  });

  it("cross-field rules have an empty loc and are named by their message", async () => {
    const s = scripted(OK_ACK);
    const error = await rejection(
      s.client.placeOrder({
        ...LIMIT_BUY,
        exchange: "MCX",
        product: "MTF",
        price: "0",
        disclosedQuantity: 2,
      }),
    );
    const issues = (error as RequestValidationError).errors;
    expect(issues.length).toBe(3);
    for (const issue of issues) expect(issue.loc).toEqual([]);
    for (const issue of issues) expect((error as Error).message).toContain(issue.msg);
    expect(s.sends).toBe(0);
  });

  it("a cross-field rule is not checked on a field that already failed", async () => {
    const s = scripted(OK_ACK);
    const error = await rejection(s.client.placeOrder({ ...LIMIT_BUY, price: "-1" }));
    expect((error as RequestValidationError).errors.map((i) => i.loc)).toEqual([["prc"]]);
  });

  it("an unknown parameter name is a TypeError and nothing is sent", async () => {
    const s = scripted(OK_ACK);
    const error = await rejection(
      s.client.placeOrder({ ...LIMIT_BUY, triggerprice: "1" } as unknown as PlaceOrderParams),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain("triggerprice");
    expect(s.sends).toBe(0);
  });

  it("parameters that are not an object are a TypeError", async () => {
    const s = scripted(OK_ACK);
    expect(await rejection(s.client.placeOrder(undefined as never))).toBeInstanceOf(TypeError);
    expect(await rejection(s.client.placeGtt(null as never))).toBeInstanceOf(TypeError);
    expect(s.sends).toBe(0);
  });
});

describe("algo_id (F29)", () => {
  it("the config's algoId is sent last on PlaceOrder and ModifyOrder", async () => {
    const s = scripted(OK_ACK, { algoId: "777" });
    await s.client.placeOrder(LIMIT_BUY);
    await s.client.modifyOrder(ORDER_ID, MODIFY);
    for (const i of [0, 1]) {
      const keys = Object.keys(sentBody(s, i));
      expect(keys[keys.length - 1]).toBe("algo_id");
      expect(sentBody(s, i)["algo_id"]).toBe("777");
    }
  });

  it("the per-call algoId overrides the config's; null or undefined falls back to it", async () => {
    const s = scripted(OK_ACK, { algoId: "777" });
    await s.client.placeOrder({ ...LIMIT_BUY, algoId: "153763" });
    await s.client.placeOrder({ ...LIMIT_BUY, algoId: null });
    await s.client.modifyOrder(ORDER_ID, { ...MODIFY, algoId: "153763" });
    expect(sentBody(s, 0)["algo_id"]).toBe("153763");
    expect(sentBody(s, 1)["algo_id"]).toBe("777");
    expect(sentBody(s, 2)["algo_id"]).toBe("153763");
  });

  it("never sent on cancel, exit, order margin or the GTT writes", async () => {
    const s = scripted(
      [
        { body: OK_ACK },
        { body: OK_ACK },
        { body: fixture("order_margin_success.json") },
        { body: fixture("place_gtt_success.json") },
        { body: fixture("modify_gtt_success.json") },
        { body: fixture("cancel_gtt_success.json") },
      ],
      { algoId: "777" },
    );
    await s.client.cancelOrder(ORDER_ID);
    await s.client.exitOrder(ORDER_ID, "BO");
    await s.client.orderMargin({ ...LIMIT_BUY, price: "2000.05" });
    await s.client.placeGtt(GTT);
    await s.client.modifyGtt(ALERT_ID, MODIFY_GTT);
    await s.client.cancelGtt(ALERT_ID);
    expect(s.bodies.length).toBe(6);
    for (const body of s.bodies) expect(body).not.toContain("algo_id");
  });
});

describe("modifyOrder", () => {
  // The outcome line names the ack's norenordno, else the payload's (§5.6), not `result`.
  it.each([
    ['{"stat":"Ok","norenordno":" 26111000000002 "}', "26111000000002", "26111000000002"],
    ['{"stat":"Ok","result":"26111000000003"}', "26111000000003", ORDER_ID],
    ['{"stat":"Ok","result":26111000000004}', "26111000000004", ORDER_ID],
    ['{"stat":"Ok","norenordno":" ","result":" "}', ORDER_ID, ORDER_ID],
    ['{"stat":"Ok","result":true}', ORDER_ID, ORDER_ID],
    ['{"stat":"Ok","result":1.5}', ORDER_ID, ORDER_ID],
    ['{"stat":"Ok"}', ORDER_ID, ORDER_ID],
  ])("ack %s returns %j", async (body, id, logged) => {
    const s = scripted(body);
    await expect(s.client.modifyOrder(ORDER_ID, MODIFY)).resolves.toBe(id);
    expect(infoLines(s)).toEqual([`ModifyOrder accepted order_id=${logged}`]);
  });

  it("an unparseable Ok ack is OrderStatusUnknownError", async () => {
    const s = scripted('{"stat":"Ok","norenordno":{"x":1}}');
    expect(await rejection(s.client.modifyOrder(ORDER_ID, MODIFY))).toBeInstanceOf(
      OrderStatusUnknownError,
    );
  });

  it("sends no amo and ret only when validity is given", async () => {
    const s = scripted(OK_ACK);
    await s.client.modifyOrder(ORDER_ID, MODIFY);
    await s.client.modifyOrder(ORDER_ID, { ...MODIFY, validity: "IOC" });
    expect(sentBody(s, 0)).not.toHaveProperty("amo");
    expect(sentBody(s, 0)).not.toHaveProperty("ret");
    expect(sentBody(s, 1)["ret"]).toBe("IOC");
  });
});

describe("cancelOrder and exitOrder", () => {
  it.each([["cancel_order_success.json"], ["cancel_order_ack_live_shape.json"]])(
    "cancelOrder against %s returns the order id",
    async (name) => {
      const s = scripted(fixture(name));
      await expect(s.client.cancelOrder(ORDER_ID)).resolves.toBe(ORDER_ID);
      expect(infoLines(s)).toEqual([`CancelOrder accepted order_id=${ORDER_ID}`]);
    },
  );

  it("exitOrder sends prd H or B and returns the order id", async () => {
    const s = scripted(OK_ACK);
    await expect(s.client.exitOrder(ORDER_ID, "co")).resolves.toBe(ORDER_ID);
    expect(sentBody(s)).toEqual({ uid: "TEST123", norenordno: ORDER_ID, prd: "H" });
  });

  it("an integer or empty order id is rejected, nothing sent", async () => {
    const s = scripted(OK_ACK);
    for (const id of [26111000000001, ""]) {
      const error = await rejection(s.client.cancelOrder(id as never));
      expect((error as RequestValidationError).errors.map((i) => i.loc)).toEqual([["norenordno"]]);
    }
    expect(s.sends).toBe(0);
  });
});

describe("orderMargin", () => {
  it("returns the OrderMargin of order_margin_success.json", async () => {
    const s = scripted(fixture("order_margin_success.json"));
    const margin = await s.client.orderMargin({ ...LIMIT_BUY, price: "2000.05" });
    expect(margin.ordermargin?.toString()).toBe("1598");
    expect(margin.remarks).toBe("Insufficient Balance");
  });

  it("is a read: retried after a 502 and logs no outcome line", async () => {
    const s = scripted([
      { status: 502, body: "<html></html>" },
      { body: fixture("order_margin_success.json") },
    ]);
    await s.client.orderMargin({ ...LIMIT_BUY, price: "2000.05" });
    expect(s.sends).toBe(2);
    expect(infoLines(s)).toEqual([]);
  });

  it("sends the optional keys in order when given", async () => {
    const s = scripted(fixture("order_margin_success.json"));
    await s.client.orderMargin({
      ...LIMIT_BUY,
      price: "2000",
      orderType: "SL",
      triggerPrice: "1999.5",
      bookLossPrice: "10",
      orderId: ORDER_ID,
      snoNumber: "7",
    });
    expect(Object.keys(sentBody(s))).toEqual([
      "uid",
      "actid",
      "exch",
      "tsym",
      "qty",
      "prc",
      "prd",
      "trantype",
      "prctyp",
      "trgprc",
      "blprc",
      "norenordno",
      "snonum",
    ]);
  });
});

describe("GTT writes", () => {
  it("placeGtt returns the al_id of place_gtt_success.json and logs al_id=", async () => {
    const s = scripted(fixture("place_gtt_success.json"));
    await expect(s.client.placeGtt(GTT)).resolves.toBe(ALERT_ID);
    expect(infoLines(s)).toEqual([`PlaceGTTOrder accepted al_id=${ALERT_ID}`]);
  });

  it("modifyGtt and cancelGtt return the al_id of their fixtures", async () => {
    const s = scripted([
      { body: fixture("modify_gtt_success.json") },
      { body: fixture("cancel_gtt_success.json") },
    ]);
    await expect(s.client.modifyGtt(ALERT_ID, MODIFY_GTT)).resolves.toBe(ALERT_ID);
    await expect(s.client.cancelGtt(ALERT_ID)).resolves.toBe(ALERT_ID);
    expect(infoLines(s)).toEqual([
      `ModifyGTTOrder accepted al_id=${ALERT_ID}`,
      `CancelGTTOrder accepted al_id=${ALERT_ID}`,
    ]);
    const debug = s.lines.filter((l) => l.level === "debug" && l.ctx?.logger === "tradesmart");
    expect(debug).toEqual([]);
  });

  it("returns the ack's al_id exactly as sent and logs one DEBUG line when it differs", async () => {
    const s = scripted('{"stat":"Oi replaced","al_id":" 26111200000011"}');
    await expect(s.client.modifyGtt(ALERT_ID, MODIFY_GTT)).resolves.toBe(" 26111200000011");
    const debug = s.lines
      .filter((l) => l.level === "debug" && l.ctx?.logger === "tradesmart")
      .map((l) => l.msg);
    expect(debug).toEqual(["ModifyGTTOrder: the acknowledged alert id differs from the one sent"]);
  });

  it("cancelGtt succeeds on OI deleted and returns the al_id", async () => {
    const s = scripted('{"stat":"OI deleted","al_id":"26111200000010"}');
    await expect(s.client.cancelGtt(ALERT_ID)).resolves.toBe(ALERT_ID);
  });

  it("the documented Oi delete success is no longer a cancel success", async () => {
    const s = scripted('{"stat":"Oi delete success","al_id":"26111200000010"}');
    const error = await rejection(s.client.cancelGtt(ALERT_ID));
    expect(error).toBeInstanceOf(OrderStatusUnknownError);
    expect((error as Error).message).toContain("pending_gtts()");
  });

  it.each(["Invalid Oi", "INVALID OI", "invalid oi"])(
    "cancelGtt and modifyGtt answering %s are OrderRejectedError, never retried",
    async (stat) => {
      const body = `{"stat":"${stat}","al_id":"26111200000010"}`;
      const cancel = scripted(body);
      const error = await rejection(cancel.client.cancelGtt(ALERT_ID));
      expect(error).toBeInstanceOf(OrderRejectedError);
      expect((error as OrderRejectedError).message).toBe("Invalid Oi");
      expect((error as OrderRejectedError).emsg).toBe(stat);
      expect(cancel.sends).toBe(1);
      const modify = scripted(body);
      expect(await rejection(modify.client.modifyGtt(ALERT_ID, MODIFY_GTT))).toBeInstanceOf(
        OrderRejectedError,
      );
      expect(modify.sends).toBe(1);
    },
  );

  it("an untrimmed Invalid Oi, and Invalid Oi on PlaceGTTOrder, are OrderStatusUnknownError", async () => {
    const untrimmed = scripted('{"stat":" Invalid Oi","al_id":"26111200000010"}');
    expect(await rejection(untrimmed.client.cancelGtt(ALERT_ID))).toBeInstanceOf(
      OrderStatusUnknownError,
    );
    const place = scripted('{"stat":"Invalid Oi","al_id":"26111200000010"}');
    expect(await rejection(place.client.placeGtt(GTT))).toBeInstanceOf(OrderStatusUnknownError);
  });

  it("the GTT word compares ignoring letter case only", async () => {
    const s = scripted('{"stat":"OI created","al_id":"26111200000010"}');
    await expect(s.client.placeGtt(GTT)).resolves.toBe(ALERT_ID);
  });

  it.each([
    '{"stat":"Ok","al_id":"26111200000010"}',
    '{"stat":"Oi created"}',
    '{"stat":"Oi created","al_id":"  "}',
    '{"stat":"Oi created","al_id":26111200000010}',
    '{"stat":"OI deleted","al_id":"26111200000010"}',
    '{"stat":"Oi delete success","al_id":"26111200000010"}',
  ])("%s is OrderStatusUnknownError naming pending_gtts()", async (body) => {
    const s = scripted(body);
    const error = await rejection(s.client.placeGtt(GTT));
    expect(error).toBeInstanceOf(OrderStatusUnknownError);
    expect((error as Error).message).toContain("pending_gtts()");
    expect(s.sends).toBe(1);
  });

  it("sends no ordersource, amo or algo_id; trgprc and dscqty only when given", async () => {
    const s = scripted(fixture("place_gtt_success.json"));
    await s.client.placeGtt(GTT);
    expect(Object.keys(sentBody(s))).toEqual([
      "uid",
      "actid",
      "exch",
      "tsym",
      "ai_t",
      "d",
      "validity",
      "remarks",
      "trantype",
      "prctyp",
      "prd",
      "ret",
      "qty",
      "prc",
    ]);
  });

  it("modifyGtt without validity or alertValidity is rejected (no defaults), nothing sent", async () => {
    const s = scripted(fixture("modify_gtt_success.json"));
    const rest: Record<string, unknown> = { ...MODIFY_GTT };
    delete rest["validity"];
    delete rest["alertValidity"];
    const error = await rejection(s.client.modifyGtt(ALERT_ID, rest as never));
    const locs = (error as RequestValidationError).errors.map((i) => i.loc.join("."));
    expect([...locs].sort()).toEqual(["ret", "validity"]);
    expect(s.sends).toBe(0);
  });

  it("placeGtt defaults validity DAY and alert validity GTT", async () => {
    const s = scripted(fixture("place_gtt_success.json"));
    const rest: PlaceGttParams = { ...GTT };
    delete rest.validity;
    delete rest.alertValidity;
    await s.client.placeGtt(rest);
    expect(sentBody(s)["ret"]).toBe("DAY");
    expect(sentBody(s)["validity"]).toBe("GTT");
  });
});

describe("the outcome line's id is computed inside a guard (ruling 2)", () => {
  it("an ack id that throws still logs accepted (id -) and returns the result", async () => {
    const s = scripted(OK_ACK);
    const result = await executeCall(s.ctx, {
      endpoint: "PlaceOrder",
      payload: [["uid", "TEST123"]],
      stateChanging: true,
      expect: "object",
      allowEmpty: false,
      rateGroup: "orders",
      decode: () => "accepted-result",
      ackId: () => {
        throw new Error("boom");
      },
    });
    expect(result).toBe("accepted-result");
    expect(infoLines(s)).toEqual(["PlaceOrder accepted order_id=-"]);
  });
});
