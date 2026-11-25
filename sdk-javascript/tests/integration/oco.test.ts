// The OCO write methods on the real client with scripted replies (sdk-behaviour.md §2.9, §4.2.1,
// §5.2-5.6): success words, `Invalid Oi`, a single request, never retried after a timeout.
import { afterEach, describe, expect, it } from "vitest";
import {
  OrderRejectedError,
  OrderStatusUnknownError,
  RequestValidationError,
} from "../../src/errors.js";
import { GttAlertType } from "../../src/enums.js";
import { scriptedClient, type Reply, type Scripted } from "../helpers/scripted-client.js";
import type { ModifyOcoParams, PlaceOcoParams } from "../../src/client.js";

const ALERT_ID = "26111800000001";
const OCO: PlaceOcoParams = {
  exchange: "NSE",
  tradingsymbol: "RELIANCE-EQ",
  transactionType: "BUY",
  quantity: 1,
  product: "CNC",
  stopLoss: { triggerValue: "1430", price: "1440" },
  target: { triggerValue: "1170", price: "1160" },
};
const MODIFY_OCO: ModifyOcoParams = { ...OCO, validity: "DAY", alertValidity: "GTT" };

const open: Scripted[] = [];
function scripted(replies: Reply[] | string): Scripted {
  const s = scriptedClient(typeof replies === "string" ? [{ body: replies }] : replies);
  open.push(s);
  return s;
}
afterEach(async () => {
  while (open.length > 0) await open.pop()?.agent.close();
});

const ack = (stat: string): string => `{"stat":"${stat}","al_id":"${ALERT_ID}"}`;

function infoLines(s: Scripted): string[] {
  return s.lines
    .filter((l) => l.ctx?.logger === "tradesmart.orders" && l.level === "info")
    .map((l) => l.msg.replace(/ in \d+ ms$/, ""));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

describe("OCO writes", () => {
  it("the three methods return the al_id on their words (any case) and log al_id=", async () => {
    const s = scripted([
      { body: ack("OI created") },
      { body: ack("oi replaced") },
      { body: ack("OI DELETED") },
    ]);
    await expect(s.client.placeOco(OCO)).resolves.toBe(ALERT_ID);
    await expect(s.client.modifyOco(ALERT_ID, MODIFY_OCO)).resolves.toBe(ALERT_ID);
    await expect(s.client.cancelOco(ALERT_ID)).resolves.toBe(ALERT_ID);
    expect(infoLines(s)).toEqual([
      `PlaceOCOOrder accepted al_id=${ALERT_ID}`,
      `ModifyOCOOrder accepted al_id=${ALERT_ID}`,
      `CancelOCOOrder accepted al_id=${ALERT_ID}`,
    ]);
  });

  it("modifyOco and cancelOco return the ack's al_id as sent, with one DEBUG line when it differs", async () => {
    const s = scripted(`{"stat":"OI replaced","al_id":" 26111800000002"}`);
    await expect(s.client.modifyOco(ALERT_ID, MODIFY_OCO)).resolves.toBe(" 26111800000002");
    const debug = s.lines
      .filter((l) => l.level === "debug" && l.ctx?.logger === "tradesmart")
      .map((l) => l.msg);
    expect(debug).toEqual(["ModifyOCOOrder: the acknowledged alert id differs from the one sent"]);
  });

  it.each(["Invalid Oi", "INVALID OI"])(
    "modifyOco and cancelOco answering %s are OrderRejectedError, never retried",
    async (stat) => {
      const cancel = scripted(ack(stat));
      const error = await rejection(cancel.client.cancelOco(ALERT_ID));
      expect(error).toBeInstanceOf(OrderRejectedError);
      expect((error as Error).message).toBe("Invalid Oi");
      expect(cancel.sends).toBe(1);
      const modify = scripted(ack(stat));
      expect(await rejection(modify.client.modifyOco(ALERT_ID, MODIFY_OCO))).toBeInstanceOf(
        OrderRejectedError,
      );
      expect(modify.sends).toBe(1);
    },
  );

  it.each([
    ack("Ok"),
    ack("Oi delete success"),
    `{"stat":"OI created"}`,
    `{"stat":"OI created","al_id":"  "}`,
    ack("Invalid Oi"),
  ])("%s on placeOco is OrderStatusUnknownError naming pending_gtts()", async (body) => {
    const s = scripted(body);
    const error = await rejection(s.client.placeOco(OCO));
    expect(error).toBeInstanceOf(OrderStatusUnknownError);
    expect((error as Error).message).toContain("pending_gtts()");
    expect(s.sends).toBe(1);
  });

  it("a timeout is OrderStatusUnknownError and exactly one request is sent", async () => {
    const s = scripted([{ failure: "read_timeout" }, { body: ack("OI created") }]);
    const error = await rejection(s.client.placeOco(OCO));
    expect(error).toBeInstanceOf(OrderStatusUnknownError);
    expect(s.sends).toBe(1);
    expect((error as Error).message).toContain("pending_gtts()");
  });

  it("a connection reset on cancelOco is not retried", async () => {
    const s = scripted([{ failure: "connection_reset" }, { body: ack("OI deleted") }]);
    expect(await rejection(s.client.cancelOco(ALERT_ID))).toBeInstanceOf(OrderStatusUnknownError);
    expect(s.sends).toBe(1);
  });

  it("a refused argument sends nothing", async () => {
    const s = scripted(ack("OI created"));
    const error = await rejection(s.client.placeOco({ ...OCO, quantity: 0 }));
    expect(error).toBeInstanceOf(RequestValidationError);
    expect(s.sends).toBe(0);
  });

  it("modifyOco without validity or alertValidity is refused (no defaults)", async () => {
    const s = scripted(ack("OI replaced"));
    const error = await rejection(s.client.modifyOco(ALERT_ID, OCO as never));
    const locs = (error as RequestValidationError).errors.map((i) => i.loc.join("."));
    expect([...locs].sort()).toEqual(["ret", "validity"]);
    expect(s.sends).toBe(0);
  });

  it("an unknown parameter is a TypeError", async () => {
    const s = scripted(ack("OI created"));
    expect(await rejection(s.client.placeOco({ ...OCO, tagg: "x" } as never))).toBeInstanceOf(
      TypeError,
    );
    expect(s.sends).toBe(0);
  });

  it("an unknown leg parameter names the method that got it", async () => {
    const s = scripted(ack("OI created"));
    const leg = { ...OCO.stopLoss, prise: "1" };
    const placed = await rejection(s.client.placeOco({ ...OCO, stopLoss: leg }));
    expect((placed as Error).message).toBe("placeOco leg() got an unknown parameter 'prise'");
    const modify = { ...OCO, validity: "DAY", alertValidity: "GTT", target: leg };
    const modified = await rejection(s.client.modifyOco(ALERT_ID, modify));
    expect(modified).toBeInstanceOf(TypeError);
    expect((modified as Error).message).toBe("modifyOco leg() got an unknown parameter 'prise'");
    expect(s.sends).toBe(0);
  });
});

describe("GTT writes refuse the OCO alert types", () => {
  it("GttAlertType has OCO_BUY and OCO_SELL", () => {
    expect(GttAlertType.OCO_BUY).toBe("LMT_BOS_O");
    expect(GttAlertType.OCO_SELL).toBe("LMT_SOB_O");
  });

  it.each(["LMT_BOS_O", "LMT_SOB_O", "OCO_BUY"])(
    "placeGtt and modifyGtt refuse %s on ai_t naming placeOco / modifyOco",
    async (alertType) => {
      const s = scripted(ack("OI created"));
      const gtt = {
        exchange: "NSE",
        tradingsymbol: "INFY-EQ",
        alertType,
        triggerValue: "1500",
        tag: "t",
        transactionType: "B",
        orderType: "LMT",
        product: "C",
        quantity: 1,
        price: "1500",
      };
      const place = await rejection(s.client.placeGtt(gtt));
      expect(place).toBeInstanceOf(RequestValidationError);
      expect((place as RequestValidationError).errors.map((i) => [...i.loc])).toEqual([["ai_t"]]);
      expect((place as RequestValidationError).errors[0]?.msg).toContain("placeOco");
      const modify = await rejection(
        s.client.modifyGtt(ALERT_ID, { ...gtt, validity: "DAY", alertValidity: "GTT" }),
      );
      expect((modify as RequestValidationError).errors[0]?.msg).toContain("modifyOco");
      expect(s.sends).toBe(0);
    },
  );
});
