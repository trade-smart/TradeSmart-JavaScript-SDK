// placeSlicedOrder on the real client (sdk-behaviour.md §5.7): the contract comes from a seeded
// script-master file and GetSecurityInfo, every slice is an ordinary PlaceOrder. Replies answer in
// turn: the first is GetSecurityInfo, the rest are PlaceOrder acknowledgements.
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlaceSlicedOrderParams } from "../../src/client.js";
import type { SlicedOrderResult } from "../../src/index.js";
import type { ClientConfigInit } from "../../src/config.js";
import {
  ConfigurationError,
  OrderRejectedError,
  OrderStatusUnknownError,
  RateLimitError,
  RequestValidationError,
} from "../../src/errors.js";
import { instrumentsContext } from "../../src/instruments/download.js";
import {
  recordingLogger,
  scriptedClient,
  type LogLine,
  type Reply,
  type Scripted,
} from "../helpers/scripted-client.js";

const MASTER = [
  "Exchange,Token,LotSize,Symbol,TradingSymbol,Instrument,TickSize,",
  "NFO,3,65,NIFTY,NIFTY26NOV24000CE,OPTIDX,0.05,",
  "NFO,4,0,NIFTY,NOLOT,OPTIDX,0.05,",
  "NFO,5,65,NIFTY,NIFTY26NOVFUT,FUTIDX,0.05,",
  "",
].join("\n");

const info = (ls: string, frzqty: string | null): Reply => ({
  body: JSON.stringify({
    stat: "Ok",
    exch: "NFO",
    tsym: "NIFTY26NOV24000CE",
    token: "3",
    ls,
    ...(frzqty === null ? {} : { frzqty }),
  }),
});
const ack = (n: number): Reply => ({
  body: `{"stat":"Ok","norenordno":"2611150000000${String(n)}"}`,
});
const NIFTY_INFO = info("65", "1801");

const ORDER: PlaceSlicedOrderParams = {
  exchange: "NFO",
  tradingsymbol: "NIFTY26NOV24000CE",
  quantity: 3965,
  transactionType: "BUY",
  product: "MIS",
  orderType: "LIMIT",
  price: "101.05",
  tag: "slice-test",
};

const open: { s: Scripted; dir: string }[] = [];
afterEach(async () => {
  while (open.length > 0) {
    const o = open.pop();
    await o?.s.agent.close();
    if (o !== undefined) rmSync(o.dir, { recursive: true, force: true });
  }
});

function sliced(
  replies: Reply[],
  config: ClientConfigInit = {},
  master = MASTER,
): Scripted & { dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "tradesmart-slice-"));
  const file = path.join(dir, "NFO_symbols.txt");
  writeFileSync(file, master);
  const stamp = new Date("2026-11-10T08:00:00+05:30");
  utimesSync(file, stamp, stamp);
  const s = scriptedClient(replies, { config: { instrumentsDir: dir, ...config } });
  instrumentsContext(s.client).now = () => new Date("2026-11-10T10:00:00+05:30");
  open.push({ s, dir });
  return Object.assign(s, { dir });
}

const body = (s: Scripted, i: number): Record<string, string> =>
  JSON.parse(decodeURIComponent((s.bodies[i] ?? "").slice("jData=".length))) as Record<
    string,
    string
  >;
const orderBodies = (s: Scripted): Record<string, string>[] =>
  s.paths.flatMap((p, i) => (p.endsWith("/PlaceOrder") ? [body(s, i)] : []));
const placeCount = (s: Scripted): number => s.paths.filter((p) => p.endsWith("/PlaceOrder")).length;
const summary = (lines: LogLine[]): LogLine[] =>
  lines.filter((l) => l.msg.startsWith("place_sliced_order"));
async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

describe("placeSlicedOrder: sending", () => {
  it("a 3-slice order reads the contract, then sends 3 PlaceOrder bodies in order", async () => {
    const s = sliced([NIFTY_INFO, ack(1), ack(2), ack(3)]);
    const result = await s.client.placeSlicedOrder(ORDER);
    expect(s.paths.map((p) => p.split("/").pop())).toEqual([
      "GetSecurityInfo",
      "PlaceOrder",
      "PlaceOrder",
      "PlaceOrder",
    ]);
    expect(body(s, 0)).toMatchObject({ exch: "NFO", token: "3" });
    expect(orderBodies(s).map((b) => b["qty"])).toEqual(["1755", "1755", "455"]);
    for (const b of orderBodies(s)) {
      expect(b).toMatchObject({ prc: "101.05", remarks: "slice-test", tsym: "NIFTY26NOV24000CE" });
    }
    expect(result).toEqual({
      requestedQuantity: 3965,
      sliceQuantities: [1755, 1755, 455],
      orderIds: ["26111500000001", "26111500000002", "26111500000003"],
      placedQuantity: 3965,
      unsentQuantity: 0,
      complete: true,
      error: null,
    });
    const orderLines = s.lines.filter((l) => l.ctx?.logger === "tradesmart.orders");
    expect(orderLines.map((l) => l.msg.replace(/ in \d+ ms$/, ""))).toEqual([
      "PlaceOrder accepted order_id=26111500000001",
      "PlaceOrder accepted order_id=26111500000002",
      "PlaceOrder accepted order_id=26111500000003",
      "place_sliced_order complete: 3/3 slices placed, quantity 3965 placed, 0 unsent",
    ]);
    expect(summary(s.lines)[0]?.level).toBe("info");
    expect(summary(s.lines)[0]?.ctx?.logger).toBe("tradesmart.orders");
  });

  it("a quantity within one slice goes out as one order", async () => {
    const s = sliced([NIFTY_INFO, ack(1)]);
    const result = await s.client.placeSlicedOrder({ ...ORDER, quantity: 130 });
    expect(orderBodies(s).map((b) => b["qty"])).toEqual(["130"]);
    expect(result.sliceQuantities).toEqual([130]);
    expect(result.complete).toBe(true);
  });

  it("sends a number price with the digits placeOrder sends, never as a float artefact", async () => {
    const s = sliced([NIFTY_INFO, ack(1)]);
    await s.client.placeSlicedOrder({ ...ORDER, quantity: 65, price: 101.05 });
    expect(orderBodies(s)[0]?.["prc"]).toBe("101.05");
  });

  it("max_slice_quantity lowers the slice size", async () => {
    const s = sliced([NIFTY_INFO, ack(1), ack(2)]);
    const result = await s.client.placeSlicedOrder({
      ...ORDER,
      quantity: 260,
      maxSliceQuantity: 130,
    });
    expect(result.sliceQuantities).toEqual([130, 130]);
  });
});

describe("placeSlicedOrder: stop rules", () => {
  it("a definite failure on slice 2 stops, returns the partial result and logs a WARNING", async () => {
    const s = sliced([
      NIFTY_INFO,
      ack(1),
      { body: '{"stat":"Not_Ok","emsg":"Insufficient funds"}' },
      ack(3),
    ]);
    const result = await s.client.placeSlicedOrder(ORDER);
    expect(placeCount(s)).toBe(2);
    expect(result.complete).toBe(false);
    expect(result.orderIds).toEqual(["26111500000001"]);
    expect(result.placedQuantity).toBe(1755);
    expect(result.unsentQuantity).toBe(3965 - 1755);
    expect(result.sliceQuantities).toEqual([1755, 1755, 455]);
    expect(result.error).toBeInstanceOf(OrderRejectedError);
    const line = summary(s.lines)[0];
    expect(line?.level).toBe("warn");
    expect(line?.msg).toBe(
      "place_sliced_order stopped (OrderRejectedError): 1/3 slices placed, quantity 1755 placed, 2210 unsent",
    );
  });

  it("an ambiguous outcome on slice 2 raises OrderStatusUnknownError carrying the partial result", async () => {
    const s = sliced([
      NIFTY_INFO,
      ack(1),
      { status: 502, body: "<html>Bad Gateway</html>" },
      ack(3),
    ]);
    const error = await failure(s.client.placeSlicedOrder(ORDER));
    expect(error).toBeInstanceOf(OrderStatusUnknownError);
    expect(placeCount(s)).toBe(2);
    const partial = (error as OrderStatusUnknownError).slicedResult;
    expect(partial).toEqual({
      requestedQuantity: 3965,
      sliceQuantities: [1755, 1755, 455],
      orderIds: ["26111500000001"],
      placedQuantity: 1755,
      unsentQuantity: 2210,
      complete: false,
      error: null,
    });
    expect((error as Error).message).toContain("check orders()");
    const line = summary(s.lines)[0];
    expect(line?.level).toBe("warn");
    expect(line?.msg).toBe(
      "place_sliced_order unknown: 1/3 slices placed, quantity 1755 placed, 2210 unsent",
    );
  });

  it("a failure on slice 1 returns an empty partial result", async () => {
    const s = sliced([NIFTY_INFO, { body: '{"stat":"Not_Ok","emsg":"No"}' }]);
    const result = await s.client.placeSlicedOrder(ORDER);
    expect(result.orderIds).toEqual([]);
    expect(result.placedQuantity).toBe(0);
    expect(result.unsentQuantity).toBe(3965);
    expect(result.complete).toBe(false);
    expect(placeCount(s)).toBe(1);
  });

  it("a race that fills the limiter after the up-front check returns the RateLimitError", async () => {
    const s = sliced([NIFTY_INFO, ack(1), ack(2), ack(3)], { orderRateLimitMaxWait: 1 });
    const real = s.ctx.limiter.acquire.bind(s.ctx.limiter);
    let calls = 0;
    s.ctx.limiter.acquire = (group, endpoint, signal) => {
      if (group === "orders") calls += 1;
      if (calls === 2) {
        return Promise.reject(
          new RateLimitError("client-side rate limit for place_order (10 per second)", {
            endpoint: "PlaceOrder",
            httpStatus: null,
            retryAfter: 2,
          }),
        );
      }
      return real(group, endpoint, signal);
    };
    const result = await s.client.placeSlicedOrder(ORDER);
    expect(result.error).toBeInstanceOf(RateLimitError);
    expect(result.orderIds).toEqual(["26111500000001"]);
    expect(placeCount(s)).toBe(1);
  });
});

describe("placeSlicedOrder: abort", () => {
  it("an abort after slice 1 stops further slices and attaches the partial result", async () => {
    const controller = new AbortController();
    const lines: LogLine[] = [];
    const base = recordingLogger(lines);
    const s = sliced([NIFTY_INFO, ack(1), ack(2), ack(3)], {
      logger: {
        ...base,
        info: (msg, ctx) => {
          base.info(msg, ctx);
          if (msg.startsWith("PlaceOrder accepted")) controller.abort(new Error("stop"));
        },
      },
    });
    const error = await failure(s.client.placeSlicedOrder(ORDER, { signal: controller.signal }));
    const note =
      "placeSlicedOrder interrupted (Error): 1 slice(s) placed (order ids: 26111500000001), quantity 1755 of 3965 placed, 2210 unsent; slice 2 of 3 may have been sent; nothing more was sent. Check orders() before sending anything again.";
    expect((error as Error).message).toBe(`stop\n${note}`);
    expect((error as Error).stack).toContain(`Error: stop\n${note}`);
    expect(placeCount(s)).toBe(1);
    const partial = (error as { slicedResult?: unknown }).slicedResult;
    expect(partial).toMatchObject({
      orderIds: ["26111500000001"],
      placedQuantity: 1755,
      unsentQuantity: 2210,
      complete: false,
      error: null,
    });
    const line = lines.find((l) => l.msg.startsWith("place_sliced_order"));
    expect(line?.level).toBe("warn");
    expect(line?.msg).toBe(
      "place_sliced_order interrupted (Error): 1/3 slices placed, quantity 1755 placed, 2210 unsent",
    );
  });

  it("an abort after slice 2 was handed over is that slice's unknown and nothing is resent", async () => {
    const s = sliced([NIFTY_INFO, ack(1), { failure: "keyboard_interrupt" }, ack(3)]);
    // The harness aborts its own signal at every send; this test aborts its own signal at the
    // hand-over of the second PlaceOrder only.
    const controller = new AbortController();
    const send = s.ctx.transport.send.bind(s.ctx.transport);
    let orders = 0;
    s.ctx.transport.send = (req, opts) => {
      if (!req.url.endsWith("/PlaceOrder")) return send(req, opts);
      orders += 1;
      if (orders !== 2) return send(req, { ...opts, onSent: () => opts.onSent?.() });
      return send(req, {
        ...opts,
        onSent: () => {
          opts.onSent?.();
          controller.abort(new Error("interrupted"));
        },
      });
    };
    const error = await failure(s.client.placeSlicedOrder(ORDER, { signal: controller.signal }));
    const message = (error as Error).message;
    expect(message.startsWith("interrupted\n")).toBe(true);
    expect(message).toContain("slice 2 of 3 may have been sent");
    expect(message).toContain("(order ids: 26111500000001)");
    expect(message).toContain("Check orders() before sending anything again.");
    expect((error as Error).stack).toContain(message);
    expect(placeCount(s)).toBe(2);
    const infoLines = s.lines
      .filter((l) => l.ctx?.logger === "tradesmart.orders")
      .map((l) => l.msg.replace(/ in \d+ ms$/, ""));
    expect(infoLines).toContain("PlaceOrder unknown order_id=-");
    expect(infoLines).toContain("PlaceOrder: outcome unknown - check orders()");
    expect((error as { slicedResult?: { orderIds: string[] } }).slicedResult?.orderIds).toEqual([
      "26111500000001",
    ]);
  });

  const abortAfterFirst = (reason?: unknown): { s: Scripted; controller: AbortController } => {
    const controller = new AbortController();
    const base = recordingLogger([]);
    const s = sliced([NIFTY_INFO, ack(1), ack(2), ack(3)], {
      logger: {
        ...base,
        info: (msg) => {
          if (msg.startsWith("PlaceOrder accepted")) {
            if (reason === undefined) controller.abort();
            else controller.abort(reason);
          }
        },
      },
    });
    return { s, controller };
  };

  it("a DOMException abort reason gets the note too (its message is a prototype getter)", async () => {
    const { s, controller } = abortAfterFirst();
    const error = await failure(s.client.placeSlicedOrder(ORDER, { signal: controller.signal }));
    expect(error).toBeInstanceOf(DOMException);
    const message = (error as Error).message;
    expect(message).toContain("\nplaceSlicedOrder interrupted (DOMException): 1 slice(s) placed");
    expect(message).toContain("slice 2 of 3 may have been sent");
    expect(message).toContain("Check orders() before sending anything again.");
    expect(placeCount(s)).toBe(1);
  });

  it("a non-Error abort reason is left unchanged and still rethrown", async () => {
    const { s, controller } = abortAfterFirst("stop now");
    const error = await failure(s.client.placeSlicedOrder(ORDER, { signal: controller.signal }));
    expect(error).toBe("stop now");
    expect(placeCount(s)).toBe(1);
  });

  it("a frozen Error reason is rethrown unchanged without failing", async () => {
    const reason = Object.freeze(new Error("frozen"));
    const { s, controller } = abortAfterFirst(reason);
    const error = await failure(s.client.placeSlicedOrder(ORDER, { signal: controller.signal }));
    expect(error).toBe(reason);
    expect((error as Error).message).toBe("frozen");
  });

  it.each([
    ["a null-prototype object", (): unknown => Object.create(null), "object"],
    ["a string", (): unknown => "stop now", "string"],
  ])(
    "%s reason keeps the original value, the warning and the partial result",
    async (_n, make, type) => {
      const reason = make();
      const controller = new AbortController();
      const lines: LogLine[] = [];
      const base = recordingLogger(lines);
      const s = sliced([NIFTY_INFO, ack(1), ack(2), ack(3)], {
        logger: {
          ...base,
          info: (msg, ctx) => {
            base.info(msg, ctx);
            if (msg.startsWith("PlaceOrder accepted")) controller.abort(reason);
          },
        },
      });
      const error = await failure(s.client.placeSlicedOrder(ORDER, { signal: controller.signal }));
      expect(error).toBe(reason);
      expect(error).not.toBeInstanceOf(TypeError);
      expect(placeCount(s)).toBe(1);
      // The order ids placed before the interruption: attached where the value takes properties
      // (the null-prototype object), nothing claimed on a primitive; never more than slice 1.
      if (type === "object") {
        const partial = (error as { slicedResult?: SlicedOrderResult }).slicedResult;
        expect(partial?.orderIds).toEqual(["26111500000001"]);
        expect(partial).toMatchObject({
          placedQuantity: 1755,
          unsentQuantity: 2210,
          complete: false,
          error: null,
        });
      } else {
        expect(typeof error).toBe("string");
        expect(error).toBe("stop now");
      }
      const line = lines.find((l) => l.msg.startsWith("place_sliced_order"));
      expect(line?.level).toBe("warn");
      expect(line?.msg).toBe(
        `place_sliced_order interrupted (${type === "object" ? "Object" : type}): 1/3 slices placed, quantity 1755 placed, 2210 unsent`,
      );
    },
  );

  it("an abort before anything is sent sends nothing", async () => {
    const s = sliced([NIFTY_INFO, ack(1)]);
    const controller = new AbortController();
    controller.abort(new Error("early"));
    const error = await failure(s.client.placeSlicedOrder(ORDER, { signal: controller.signal }));
    expect((error as Error).message).toBe("early");
    expect(s.hits).toBe(0);
  });
});

describe("placeSlicedOrder: refused before anything is sent", () => {
  const refused = async (
    s: Scripted,
    order: PlaceSlicedOrderParams,
    type: new (...a: never[]) => unknown,
    expectedPlaces = 0,
  ): Promise<unknown> => {
    const error = await failure(s.client.placeSlicedOrder(order));
    expect(error).toBeInstanceOf(type);
    expect(placeCount(s)).toBe(expectedPlaces);
    return error;
  };

  it("an unknown contract is a RangeError and nothing at all is sent", async () => {
    const s = sliced([NIFTY_INFO]);
    await refused(s, { ...ORDER, tradingsymbol: "NOPE" }, RangeError);
    expect(s.hits).toBe(0);
  });

  it("a row without a usable lot size is a RangeError", async () => {
    const s = sliced([NIFTY_INFO]);
    await refused(s, { ...ORDER, tradingsymbol: "nolot" }, RangeError);
    expect(s.hits).toBe(0);
  });

  it("the lookup trims the trading symbol and ignores its case", async () => {
    const s = sliced([NIFTY_INFO, ack(1)]);
    const result = await s.client.placeSlicedOrder({
      ...ORDER,
      tradingsymbol: " nifty26nov24000ce ",
      quantity: 65,
    });
    expect(result.complete).toBe(true);
  });

  it("a lot size differing from GetSecurityInfo is a RangeError", async () => {
    const s = sliced([info("75", "1801")]);
    await refused(s, ORDER, RangeError);
  });

  it("an unknown freeze quantity without max_slice_quantity is a RangeError", async () => {
    await refused(sliced([info("65", null)]), ORDER, RangeError);
    await refused(sliced([info("65", "0")]), ORDER, RangeError);
  });

  it("an unknown freeze quantity with max_slice_quantity slices by it", async () => {
    const s = sliced([info("65", null), ack(1), ack(2)]);
    const result = await s.client.placeSlicedOrder({
      ...ORDER,
      quantity: 260,
      maxSliceQuantity: 130,
    });
    expect(result.sliceQuantities).toEqual([130, 130]);
  });

  it("a quantity that is not a whole number of lots is a RangeError", async () => {
    await refused(sliced([NIFTY_INFO]), { ...ORDER, quantity: 100 }, RangeError);
  });

  it("more slices than max_slices is a RangeError that gives the number needed", async () => {
    const error = await refused(sliced([NIFTY_INFO]), { ...ORDER, maxSlices: 2 }, RangeError);
    expect((error as Error).message).toContain("3");
  });

  it("bad quantity, max_slices and max_slice_quantity are RangeErrors before anything is read", async () => {
    for (const bad of [
      { quantity: 0 },
      { quantity: 1.5 },
      { maxSlices: 0 },
      { maxSliceQuantity: 0 },
    ]) {
      const s = sliced([NIFTY_INFO]);
      await refused(s, { ...ORDER, ...bad }, RangeError);
      expect(s.hits).toBe(0);
    }
  });

  it("a disclosed quantity larger than the smallest slice is a RangeError", async () => {
    await refused(sliced([NIFTY_INFO]), { ...ORDER, disclosedQuantity: 456 }, RangeError);
    const s = sliced([NIFTY_INFO, ack(1), ack(2), ack(3)]);
    await s.client.placeSlicedOrder({ ...ORDER, disclosedQuantity: 455 });
    expect(placeCount(s)).toBe(3);
  });

  it("what placeOrder refuses (a LIMIT order without a price) is refused with nothing sent", async () => {
    const noPrice: PlaceSlicedOrderParams = { ...ORDER, price: null };
    await refused(sliced([NIFTY_INFO]), noPrice, RequestValidationError);
  });

  it("more slices than the per-second limit under raise mode is a ConfigurationError naming the setting", async () => {
    const s = sliced([NIFTY_INFO], { rateLimitMode: "raise", orderRateLimitPerSecond: 2 });
    const error = await refused(s, ORDER, ConfigurationError);
    expect((error as Error).message).toContain("order_rate_limit_per_second");
    expect((error as Error).message).toContain("nothing was sent");
  });

  it("a max wait below 1 second with more slices than the per-second limit is a ConfigurationError", async () => {
    const s = sliced([NIFTY_INFO], { orderRateLimitMaxWait: 0.5, orderRateLimitPerSecond: 2 });
    const error = await refused(s, ORDER, ConfigurationError);
    expect((error as Error).message).toContain("order_rate_limit_max_wait");
  });

  it("more slices than the per-minute limit is a ConfigurationError", async () => {
    const s = sliced([NIFTY_INFO], { orderRateLimitPerSecond: 2, orderRateLimitPerMinute: 2 });
    const error = await refused(s, { ...ORDER, quantity: 65 * 28 * 2 }, ConfigurationError);
    expect((error as Error).message).toContain("order_rate_limit_per_minute");
  });

  it("not enough room in the current minute is a RateLimitError naming the minute window, with retry_after", async () => {
    const s = sliced([NIFTY_INFO]);
    for (let i = 0; i < 199; i++) {
      await s.ctx.limiter.acquire("orders", "PlaceOrder");
      s.clock.time += 150;
    }
    const error = (await refused(s, ORDER, RateLimitError)) as RateLimitError;
    expect(error.message).toBe("client-side rate limit for place_order (200 per minute)");
    expect(error.endpoint).toBe("PlaceOrder");
    expect(error.httpStatus).toBeNull();
    expect(error.retryAfter).not.toBeNull();
    expect(error.retryAfter as number).toBeGreaterThan(1);
  });

  it("room that frees within the max wait is waited for, not refused", async () => {
    const s = sliced([NIFTY_INFO, ack(1), ack(2), ack(3)], { orderRateLimitMaxWait: 60 });
    for (let i = 0; i < 199; i++) {
      await s.ctx.limiter.acquire("orders", "PlaceOrder");
      s.clock.time += 150;
    }
    const result = await s.client.placeSlicedOrder(ORDER);
    expect(result.complete).toBe(true);
    expect(placeCount(s)).toBe(3);
  });

  it("raise mode with no room in the minute is a RateLimitError", async () => {
    const s = sliced([NIFTY_INFO], { rateLimitMode: "raise" });
    for (let i = 0; i < 199; i++) {
      await s.ctx.limiter.acquire("orders", "PlaceOrder");
      s.clock.time += 150;
    }
    await refused(s, ORDER, RateLimitError);
  });

  it("a failed GetSecurityInfo read is raised as that read's error and nothing is placed", async () => {
    const s = sliced([{ body: '{"stat":"Not_Ok","emsg":"no such scrip"}' }]);
    await refused(s, ORDER, Error);
    expect(s.hits).toBe(1);
  });
});
