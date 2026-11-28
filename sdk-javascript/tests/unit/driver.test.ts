// The JavaScript live-order driver (tests/live_orders/driver.ts, specifications/live-driver.md),
// tested offline: `serve` runs against a real client wired to the offline broker's dispatcher
// (no network, no account), or against a stub client that records its calls. Every environment
// is a mapping given to the code under test; no real TRADESMART_LIVE_* variable is read or set,
// and no order is ever placed.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Decimal } from "decimal.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TradeSmart } from "../../src/index.js";
import { drills } from "../../src/testing/index.js";
import { defaultTokenFilePath } from "../../src/token-store/token-file.js";
import {
  METHODS,
  NONCE_ENV,
  PROTOCOL,
  WireCapture,
  buildFromEnvironment,
  isEntryPoint,
  captureDispatcher,
  planEnvironment,
  runProgram,
  serve,
  startRefusal,
  type Built,
  type Env,
} from "../live_orders/driver.js";
import { SYNTHETIC_TOKEN, offlineWire, type OfflineWire } from "../helpers/offline-wire.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER_SOURCE = path.resolve(HERE, "../live_orders/driver.ts");

// The first `buildFromEnvironment` call loads the whole built SDK (`dist/`, about 80 modules,
// through vitest's module runner) and undici. That one-off load measured about 1-2 s warm and
// 4.5-5 s or more on a cold run right after `npm ci && npm run build`, over vitest's 5 s test limit:
// the first caller timed out, and the next one waited on the same pending import and timed out
// too. The load is not the behaviour under test, so it is paid once here, under a limit sized for
// it; the tests then share the loaded modules (the same files the driver imports).
// (Specifiers in variables, as in the driver: `dist/` may not exist when the code is typechecked.)
const BUILT_MODULES = ["../../dist/index.js", "../../dist/token-store/token-file.js", "undici"];
beforeAll(async () => {
  if (!existsSync(path.resolve(HERE, "../../dist/index.js"))) return;
  for (const specifier of BUILT_MODULES) await import(specifier);
}, 120_000);
const NONCE = "nonce-synthetic-0123456789";
const OPTION = "NIFTY27NOV26C24000";
const LIMIT_BUY = {
  exchange: "NFO",
  tradingsymbol: OPTION,
  quantity: 75,
  transaction_type: "B",
  product: "M",
  order_type: "LMT",
  price: "101.50",
};
const MODIFY = {
  exchange: "NFO",
  tradingsymbol: OPTION,
  quantity: 150,
  price: "102.00",
  order_type: "LMT",
  product: "M",
};
const OCO = {
  exchange: "NSE",
  tradingsymbol: "SBIN-EQ",
  transaction_type: "S",
  quantity: 1,
  product: "C",
  stop_loss: { trigger_value: "95", price: "94.5", order_type: "LMT", trigger_price: null },
  target: { trigger_value: "105", price: "105", order_type: "LMT", trigger_price: null },
  validity: "DAY",
  alert_validity: "GTT",
  tag: "driver-test-oco",
};
const GTT = {
  exchange: "NSE",
  tradingsymbol: "SBIN-EQ",
  alert_type: "LTP_B_O",
  trigger_value: "800",
  alert_validity: "GTT",
  tag: "driver-test-gtt",
  transaction_type: "B",
  order_type: "LMT",
  product: "C",
  validity: "DAY",
  quantity: 1,
  price: "800",
};

type Json = Record<string, unknown>;

interface Conversation {
  hello: Json;
  replies: Json[];
  lines: string[];
  code: number;
  log: string[];
}

function request(id: number, method: string, args: Json = {}): string {
  return JSON.stringify({ id, method, args });
}

/** Run `serve` on `lines` (each sent with its newline) and collect what it writes. */
async function converse(
  client: TradeSmart,
  capture: WireCapture,
  lines: string[],
  extra: { secrets?: string[]; nonce?: string } = {},
): Promise<Conversation> {
  const out: string[] = [];
  const log: string[] = [];
  const code = await serve(
    Readable.from(lines.map((line) => `${line}\n`)),
    { write: (text: string) => out.push(text) },
    client,
    {
      nonce: extra.nonce ?? NONCE,
      version: "2.1.1",
      environment: "uat",
      capture,
      secrets: extra.secrets ?? [],
      log: (line: string) => log.push(line),
    },
  );
  const all = out
    .join("")
    .split("\n")
    .filter((l) => l !== "");
  const first = JSON.parse(all[0] ?? "{}") as { hello: Json };
  return {
    hello: first.hello,
    replies: all.slice(1).map((line) => JSON.parse(line) as Json),
    lines: all,
    code,
    log,
  };
}

const wires: OfflineWire[] = [];
function wire(config: Parameters<typeof offlineWire>[0] = {}, clientId = "OFFLINE01"): OfflineWire {
  const w = offlineWire(config, clientId);
  wires.push(w);
  return w;
}
afterEach(async () => {
  while (wires.length > 0) await wires.pop()?.close();
});

function addNifty(w: OfflineWire): void {
  w.state.addInstrument("NFO", "2003", OPTION, {
    lotSize: 75,
    tickSize: "0.05",
    instrument: "OPTIDX",
    expiry: { date: "2027-11-25" },
    strike: 24000,
    optionType: "CE",
    underlying: "NIFTY",
    extra: { frzqty: 1801 },
  });
  w.state.addInstrument("NSE", "3045", "SBIN-EQ", {});
}

async function one(w: OfflineWire, method: string, args: Json = {}): Promise<Json> {
  const { replies } = await converse(w.client, w.capture, [request(1, method, args)]);
  return replies[0] as Json;
}

const ACCOUNT_KEYS = ["client_id", "user_id", "account_id", "uid", "actid"];
function keysAnywhere(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysAnywhere);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...keysAnywhere(item)]);
}

// ---------------------------------------------------------------------------------------------

describe("the handshake", () => {
  it("is the first line: sdk, version, environment, client id, the nonce and protocol 2", async () => {
    const w = wire();
    const run = await converse(w.client, w.capture, []);
    expect(run.hello).toEqual({
      sdk: "javascript",
      version: "2.1.1",
      environment: "uat",
      client_id: "OFFLINE01",
      run: NONCE,
      protocol: 2,
    });
    expect(PROTOCOL).toBe(2);
    expect(run.code).toBe(0); // end of file: a clean exit
    expect(run.replies).toEqual([]);
  });

  it("is never written when there is no nonce", async () => {
    const w = wire();
    const out: string[] = [];
    const code = await serve(Readable.from([]), { write: (t: string) => out.push(t) }, w.client, {
      nonce: "  ",
      version: "2.1.1",
      environment: "uat",
      capture: w.capture,
    });
    expect(code).toBe(2);
    expect(out).toEqual([]);
  });
});

describe("state-changing calls: one SDK call, the wire body in the reply", () => {
  it("place_order answers the id, the wire body and the HTTP status; one request goes out", async () => {
    const w = wire();
    const reply = await one(w, "place_order", LIMIT_BUY);
    const id = reply["result"] as string;
    expect(typeof id).toBe("string");
    expect(reply["raw"]).toMatchObject({ stat: "Ok", norenordno: id });
    expect(reply["http_status"]).toBe(200);
    expect(w.state.requests.map((r) => r.endpoint)).toEqual(["PlaceOrder"]);
    expect(w.state.orders[0]?.id).toBe(id);
    expect(keysAnywhere(reply["raw"]).filter((k) => ACCOUNT_KEYS.includes(k))).toEqual([]);
  });

  it("modify_order, cancel_order and exit_order each send exactly one request", async () => {
    const w = wire();
    addNifty(w);
    const id = (await one(w, "place_order", LIMIT_BUY))["result"] as string;
    const cover = (
      await one(w, "place_order", { ...LIMIT_BUY, product: "H", book_loss_price: "95.00" })
    )["result"] as string;
    const before = w.state.requests.length;
    const modified = await one(w, "modify_order", { order_id: id, ...MODIFY });
    expect(modified["result"]).toBe(id);
    expect(modified["http_status"]).toBe(200);
    expect(modified["raw"]).toMatchObject({ stat: "Ok" });
    expect(w.state.requests.length).toBe(before + 1);
    const cancelled = await one(w, "cancel_order", { order_id: id });
    expect(cancelled["result"]).toBe(id);
    expect(cancelled["raw"]).toMatchObject({ stat: "Ok" });
    expect(w.state.requests.length).toBe(before + 2);
    const exited = await one(w, "exit_order", { order_id: cover, product: "H" });
    expect(exited["result"]).toBe(cover);
    expect(w.state.requests.length).toBe(before + 3);
    expect(w.state.requests.slice(before).map((r) => r.endpoint)).toEqual([
      "ModifyOrder",
      "CancelOrder",
      "ExitSNOOrder",
    ]);
  });

  it("place_gtt, modify_gtt and cancel_gtt answer the alert id with the wire body", async () => {
    const w = wire();
    const placed = await one(w, "place_gtt", GTT);
    const alert = placed["result"] as string;
    expect(placed["raw"]).toMatchObject({ al_id: alert });
    expect(placed["http_status"]).toBe(200);
    const modified = await one(w, "modify_gtt", {
      alert_id: alert,
      ...GTT,
      trigger_value: "790",
      price: "790",
    });
    expect(modified["result"]).toBe(alert);
    const cancelled = await one(w, "cancel_gtt", { alert_id: alert });
    expect(cancelled["result"]).toBe(alert);
    expect(w.state.requests.map((r) => r.endpoint)).toEqual([
      "PlaceGTTOrder",
      "ModifyGTTOrder",
      "CancelGTTOrder",
    ]);
  });

  it("place_oco, modify_oco and cancel_oco answer the alert id with the wire body", async () => {
    const w = wire();
    const spy = vi.spyOn(w.client, "placeOco");
    const placed = await one(w, "place_oco", OCO);
    expect(spy).toHaveBeenCalledTimes(1);
    const sent = spy.mock.calls[0]?.[0] as unknown as Json;
    const stopLoss = sent["stopLoss"] as Json;
    expect(Decimal.isDecimal(stopLoss["triggerValue"])).toBe(true);
    expect(String(stopLoss["price"])).toBe("94.5");
    expect(stopLoss["orderType"]).toBe("LMT");
    expect(stopLoss).not.toHaveProperty("triggerPrice");
    expect(sent["alertValidity"]).toBe("GTT");
    const alert = placed["result"] as string;
    expect(placed["raw"]).toMatchObject({ al_id: alert });
    expect(placed["http_status"]).toBe(200);
    const modified = await one(w, "modify_oco", {
      alert_id: alert,
      ...OCO,
      stop_loss: { ...(OCO.stop_loss as Json), trigger_value: "96" },
    });
    expect(modified["result"]).toBe(alert);
    expect(modified["raw"]).toBeTruthy();
    const cancelled = await one(w, "cancel_oco", { alert_id: alert });
    expect(cancelled["result"]).toBe(alert);
    expect(cancelled["http_status"]).toBe(200);
    expect(w.state.requests.map((r) => r.endpoint)).toEqual([
      "PlaceOCOOrder",
      "ModifyOCOOrder",
      "CancelOCOOrder",
    ]);
  });

  it("an OCO leg that is not an object, or has a bad price, is refused before any call", async () => {
    const w = wire();
    const spy = vi.spyOn(w.client, "placeOco");
    await one(w, "place_oco", { ...OCO, stop_loss: "95" });
    await one(w, "place_oco", { ...OCO, target: { ...(OCO.target as Json), price: "abc" } });
    expect(spy).not.toHaveBeenCalled();
    expect(w.state.requests).toHaveLength(0);
  });

  it("place_sliced_order is one SDK call; its result carries a wire body per placed slice", async () => {
    const w = wire();
    addNifty(w);
    const spy = vi.spyOn(w.client, "placeSlicedOrder");
    const reply = await one(w, "place_sliced_order", {
      ...LIMIT_BUY,
      quantity: 3600,
      max_slice_quantity: 1800,
      max_slices: 5,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const result = reply["result"] as Json;
    expect(result["requested_quantity"]).toBe(3600);
    expect(result["slice_quantities"]).toEqual([1800, 1800]);
    expect(result["placed_quantity"]).toBe(3600);
    expect(result["unsent_quantity"]).toBe(0);
    expect(result["complete"]).toBe(true);
    expect(result["error"]).toBeNull();
    const ids = result["order_ids"] as string[];
    const slices = result["slices"] as Json[];
    expect(ids).toHaveLength(2);
    expect(slices.map((s) => s["order_id"])).toEqual(ids);
    slices.forEach((s, i) => {
      expect(s["raw"]).toMatchObject({ stat: "Ok", norenordno: ids[i] });
      expect(s["http_status"]).toBe(200);
    });
    expect(w.state.requests.filter((r) => r.endpoint === "PlaceOrder")).toHaveLength(2);
  });

  it("a definite failure on a later slice is a returned incomplete result naming its error", async () => {
    const w = wire();
    addNifty(w);
    // The second slice is rejected: arm the drill when the SDK places it.
    const original = w.client.placeOrder.bind(w.client);
    let calls = 0;
    vi.spyOn(w.client, "placeOrder").mockImplementation(async (params, options) => {
      calls += 1;
      if (calls === 2) w.state.failNext("PlaceOrder", drills.reject("RMS:Margin Exceeds"));
      return original(params, options);
    });
    const reply = await one(w, "place_sliced_order", {
      ...LIMIT_BUY,
      quantity: 3600,
      max_slice_quantity: 1800,
      max_slices: 5,
    });
    const result = reply["result"] as Json;
    expect(result["complete"]).toBe(false);
    expect(result["placed_quantity"]).toBe(1800);
    expect(result["unsent_quantity"]).toBe(1800);
    expect((result["order_ids"] as string[]).length).toBe(1);
    expect((result["slices"] as Json[]).length).toBe(1);
    const error = result["error"] as Json;
    expect(error["type"]).toBe("OrderRejectedError");
    expect(error["emsg"]).toBe("RMS:Margin Exceeds");
  });
});

describe("errors carry the contract name and its fields", () => {
  it("a rejection is OrderRejectedError with stat, emsg, status and the wire body", async () => {
    const w = wire();
    w.state.failNext("PlaceOrder", drills.reject("RMS:Margin Exceeds"));
    const reply = await one(w, "place_order", LIMIT_BUY);
    expect(reply).not.toHaveProperty("result");
    expect(reply["error"]).toMatchObject({
      type: "OrderRejectedError",
      stat: "Not_Ok",
      emsg: "RMS:Margin Exceeds",
      http_status: 200,
      sliced_result: null,
      fields: [],
    });
    const error = reply["error"] as Json;
    expect(error["raw"]).toMatchObject({ stat: "Not_Ok", emsg: "RMS:Margin Exceeds" });
    expect(w.state.requests).toHaveLength(1);
  });

  it("an ambiguous outcome is OrderStatusUnknownError, never a rejection or a success", async () => {
    const w = wire();
    w.state.failNext("PlaceOrder", drills.timeoutAfterSend());
    const reply = await one(w, "place_order", LIMIT_BUY);
    const error = reply["error"] as Json;
    expect(error["type"]).toBe("OrderStatusUnknownError");
    expect(reply).not.toHaveProperty("result");
    expect(w.state.requests).toHaveLength(1); // never resent
  });

  it("a 5xx page on a write is unknown, with the status and its text as the text", async () => {
    const w = wire();
    w.state.failNext("PlaceOrder", drills.serverError());
    const error = (await one(w, "place_order", LIMIT_BUY))["error"] as Json;
    expect(error["type"]).toBe("OrderStatusUnknownError");
    expect(error["http_status"]).toBe(503);
    expect(error["emsg"]).toBeNull();
    expect(typeof error["raw"]).toBe("string");
    expect(w.state.requests).toHaveLength(1);
  });

  it("a body that is not the expected JSON is OrderStatusUnknownError, never resent", async () => {
    const w = wire();
    w.state.failNext("PlaceOrder", drills.badBody());
    const error = (await one(w, "place_order", LIMIT_BUY))["error"] as Json;
    expect(error["type"]).toBe("OrderStatusUnknownError");
    expect(w.state.requests).toHaveLength(1);
  });

  it("a connect failure is NetworkError: nothing was sent and nothing is retried", async () => {
    const w = wire();
    w.state.failNext("PlaceOrder", drills.connectError());
    const error = (await one(w, "place_order", LIMIT_BUY))["error"] as Json;
    expect(error["type"]).toBe("NetworkError");
    expect(w.state.requests).toHaveLength(0);
  });

  it("the server's 429 is RateLimitError, sent: true, with the status", async () => {
    const w = wire();
    w.state.failNext("PlaceOrder", drills.rateLimit(2));
    const error = (await one(w, "place_order", LIMIT_BUY))["error"] as Json;
    expect(error).toMatchObject({ type: "RateLimitError", sent: true, http_status: 429 });
    expect(w.state.requests).toHaveLength(1);
  });

  it("the client's own limiter is RateLimitError with sent: false and http_status null", async () => {
    const w = wire({
      rateLimitMode: "raise",
      orderRateLimitPerSecond: 1,
      orderRateLimitPerMinute: 10,
    });
    const run = await converse(w.client, w.capture, [
      request(1, "place_order", LIMIT_BUY),
      request(2, "place_order", LIMIT_BUY),
    ]);
    expect(run.replies[0]).toHaveProperty("result");
    const error = run.replies[1]?.["error"] as Json;
    expect(error).toMatchObject({ type: "RateLimitError", sent: false, http_status: null });
    expect(w.state.requests).toHaveLength(1); // the refused call never went out
  });

  it("a parameter check is RequestValidationError with the sorted wire keys; nothing is sent", async () => {
    const w = wire();
    const error = (await one(w, "place_order", { ...LIMIT_BUY, quantity: 0, price: "-1" }))[
      "error"
    ] as Json;
    expect(error["type"]).toBe("RequestValidationError");
    expect(error["fields"]).toEqual([...(error["fields"] as string[])].sort());
    expect((error["fields"] as string[]).length).toBeGreaterThan(0);
    expect(error["raw"]).toBeNull();
    expect(error["http_status"]).toBeNull();
    expect(w.state.requests).toHaveLength(0);
    expect(w.capture.dispatched).toBe(0);
  });

  it("a closed client is ConfigurationError; nothing is sent", async () => {
    const w = wire();
    await w.client.close();
    const error = (await one(w, "place_order", LIMIT_BUY))["error"] as Json;
    expect(error["type"]).toBe("ConfigurationError");
    expect(w.state.requests).toHaveLength(0);
  });

  it("a RangeError before any write is ValueError (nothing sent)", async () => {
    const w = wire();
    const reply = await one(w, "place_sliced_order", { ...LIMIT_BUY, tradingsymbol: "NOSUCH" });
    const error = reply["error"] as Json;
    expect(error["type"]).toBe("ValueError");
    expect(w.state.requests.filter((r) => r.endpoint === "PlaceOrder")).toHaveLength(0);
  });

  it("an error the SDK does not name is an unknown outcome for a write and a network error for a read", async () => {
    const w = wire();
    vi.spyOn(w.client, "cancelOrder").mockRejectedValue(new Error("something else"));
    vi.spyOn(w.client, "margins").mockRejectedValue(new Error("something else"));
    const write = (await one(w, "cancel_order", { order_id: "1" }))["error"] as Json;
    expect(write["type"]).toBe("OrderStatusUnknownError");
    const read = (await one(w, "margins"))["error"] as Json;
    expect(read["type"]).toBe("NetworkError");
  });

  it("request with state_changing true is a write: an unnamed error is an unknown outcome", async () => {
    const w = wire();
    vi.spyOn(w.client, "request").mockRejectedValue(new Error("odd"));
    const args = { endpoint: "PlaceOrder", payload: {} };
    const changing = (await one(w, "request", { ...args, state_changing: true }))["error"] as Json;
    expect(changing["type"]).toBe("OrderStatusUnknownError");
    const reading = (await one(w, "request", { ...args, state_changing: false }))["error"] as Json;
    expect(reading["type"]).toBe("NetworkError");
  });

  it("a TypeError after a write went out is unknown, not ValueError", async () => {
    const w = wire();
    vi.spyOn(w.client, "placeOrder").mockImplementation(async () => {
      await w.client.cancelOrder("never-placed").catch(() => undefined);
      throw new TypeError("late");
    });
    const error = (await one(w, "place_order", LIMIT_BUY))["error"] as Json;
    expect(error["type"]).toBe("OrderStatusUnknownError");
  });

  it("a success without a wire body is reported as an unknown outcome", async () => {
    const w = wire();
    vi.spyOn(w.client, "cancelOrder").mockResolvedValue("1001"); // no request went out
    const reply = await one(w, "cancel_order", { order_id: "1001" });
    expect(reply).not.toHaveProperty("result");
    expect((reply["error"] as Json)["type"]).toBe("OrderStatusUnknownError");
  });
});

describe("the SDK's own unknown outcome of a sliced order keeps its partial result", () => {
  it("is an OrderStatusUnknownError whose sliced_result lists the placed slices only", async () => {
    const w = wire();
    addNifty(w);
    const original = w.client.placeOrder.bind(w.client);
    let calls = 0;
    vi.spyOn(w.client, "placeOrder").mockImplementation(async (params, options) => {
      calls += 1;
      if (calls === 2) w.state.failNext("PlaceOrder", drills.timeoutAfterSend());
      return original(params, options);
    });
    const reply = await one(w, "place_sliced_order", {
      ...LIMIT_BUY,
      quantity: 3600,
      max_slice_quantity: 1800,
      max_slices: 5,
    });
    const error = reply["error"] as Json;
    expect(error["type"]).toBe("OrderStatusUnknownError");
    const partial = error["sliced_result"] as Json;
    expect(partial["complete"]).toBe(false);
    expect(partial["error"]).toBeNull();
    expect(partial["placed_quantity"]).toBe(1800);
    expect((partial["slices"] as Json[]).length).toBe((partial["order_ids"] as string[]).length);
  });
});

describe("reads", () => {
  it("answer models as contract field names (snake_case) with Decimals as strings and `raw`", async () => {
    const w = wire();
    addNifty(w);
    const id = (await one(w, "place_order", LIMIT_BUY))["result"] as string;
    const reply = await one(w, "orders");
    const rows = reply["result"] as Json[];
    expect(rows).toHaveLength(1);
    const row = rows[0] as Json;
    expect(row["order_id"]).toBe(id);
    expect(row["price"]).toBe("101.5");
    expect(row["quantity"]).toBe(75);
    expect(row).toHaveProperty("raw");
    expect(row).not.toHaveProperty("orderId");
    expect(reply).not.toHaveProperty("raw"); // only a write carries the wire body
  });

  it("profile, margins, positions, quote and order_history are each one call", async () => {
    const w = wire();
    addNifty(w);
    w.state.setQuote("NSE", "3045", { lastPrice: "800.25" });
    const id = (await one(w, "place_order", LIMIT_BUY))["result"] as string;
    const before = w.state.requests.length;
    for (const [method, args] of [
      ["profile", {}],
      ["margins", {}],
      ["positions", {}],
      ["trades", {}],
      ["quote", { exchange: "NSE", token: "3045" }],
      ["order_history", { order_id: id }],
    ] as const) {
      const n = w.state.requests.length;
      const reply = await one(w, method, args);
      expect(reply).toHaveProperty("result");
      expect(w.state.requests.length).toBe(n + 1);
    }
    expect(w.state.requests.length).toBe(before + 6);
    const quote = (await one(w, "quote", { exchange: "NSE", token: "3045" }))["result"] as Json;
    expect(quote["last_price"]).toBe("800.25");
  });
});

describe("every protocol method is one SDK call by name", () => {
  const WRITES = [
    "place_order",
    "place_sliced_order",
    "modify_order",
    "cancel_order",
    "exit_order",
    "place_gtt",
    "modify_gtt",
    "cancel_gtt",
    "place_oco",
    "modify_oco",
    "cancel_oco",
  ];
  const READS = [
    "profile",
    "margins",
    "positions",
    "holdings",
    "orders",
    "order_history",
    "trades",
    "order_margin",
    "pending_gtts",
    "triggered_gtts",
    "gtt_alert_types",
    "search_instruments",
    "quote",
    "security_info",
    "option_chain",
    "historical_data",
    "daily_history",
    "option_greeks",
    "option_chain_snapshot",
    "buildup",
    "instruments",
    "download_instruments",
    "request",
  ];

  it("the table lists exactly the eight writes, the reads and request", () => {
    expect([...METHODS].sort()).toEqual([...WRITES, ...READS].sort());
  });

  /** A stub client: every function member resolves `null` and counts its calls. */
  function stub(): { client: TradeSmart; calls: [string, unknown[]][] } {
    const calls: [string, unknown[]][] = [];
    const names = [
      "placeOrder",
      "placeSlicedOrder",
      "modifyOrder",
      "cancelOrder",
      "exitOrder",
      "placeGtt",
      "modifyGtt",
      "cancelGtt",
      "placeOco",
      "modifyOco",
      "cancelOco",
      "profile",
      "margins",
      "positions",
      "holdings",
      "orders",
      "orderHistory",
      "trades",
      "orderMargin",
      "pendingGtts",
      "triggeredGtts",
      "gttAlertTypes",
      "searchInstruments",
      "quote",
      "securityInfo",
      "optionChain",
      "historicalData",
      "dailyHistory",
      "optionGreeks",
      "optionChainSnapshot",
      "buildup",
      "instruments",
      "downloadInstruments",
      "request",
    ];
    const client: Record<string, unknown> = { clientId: "STUB01" };
    for (const name of names) {
      client[name] = (...args: unknown[]) => {
        calls.push([name, args]);
        return Promise.resolve(null);
      };
    }
    return { client: client as unknown as TradeSmart, calls };
  }

  const MINIMAL: Record<string, Json> = {
    order_history: { order_id: "1" },
    search_instruments: { text: "SBIN" },
    quote: { exchange: "NSE", token: "3045" },
    security_info: { exchange: "NSE", token: "3045" },
    option_chain: { exchange: "NFO", tradingsymbol: OPTION, strike_price: "24000", count: 2 },
    historical_data: { exchange: "NSE", token: "3045" },
    daily_history: {
      exchange: "NSE",
      tradingsymbol: "SBIN-EQ",
      from_date: "2026-11-01",
      to_date: "2026-11-02",
    },
    option_greeks: { exchange: "NFO", tradingsymbol: OPTION },
    option_chain_snapshot: { exchange: "NFO", tradingsymbol: OPTION, strike_price: "24000" },
    buildup: { exchange: "NSE", token: "3045" },
    instruments: { exchange: "NSE" },
    download_instruments: { exchange: "NSE" },
    order_margin: { ...LIMIT_BUY },
    place_order: LIMIT_BUY,
    place_sliced_order: LIMIT_BUY,
    modify_order: { order_id: "1", ...MODIFY },
    cancel_order: { order_id: "1" },
    exit_order: { order_id: "1", product: "H" },
    place_gtt: GTT,
    modify_gtt: { alert_id: "1", ...GTT },
    cancel_gtt: { alert_id: "1" },
    place_oco: OCO,
    modify_oco: { alert_id: "1", ...OCO },
    cancel_oco: { alert_id: "1" },
    request: { endpoint: "Limits", payload: {}, state_changing: false },
  };

  it.each([...WRITES, ...READS])("%s calls the SDK once", async (method) => {
    const { client, calls } = stub();
    const capture = new WireCapture();
    const run = await converse(client, capture, [request(1, method, MINIMAL[method] ?? {})]);
    expect(run.code).toBe(0); // not a protocol violation
    expect(calls).toHaveLength(1);
  });

  it("maps the contract names to the SDK's methods", async () => {
    const { client, calls } = stub();
    const capture = new WireCapture();
    await converse(
      client,
      capture,
      METHODS.map((method, i) => request(i + 1, method, MINIMAL[method] ?? {})),
    );
    expect(calls.map(([name]) => name).sort()).toEqual(
      [
        "placeOrder",
        "placeSlicedOrder",
        "modifyOrder",
        "cancelOrder",
        "exitOrder",
        "placeGtt",
        "modifyGtt",
        "cancelGtt",
        "placeOco",
        "modifyOco",
        "cancelOco",
        "profile",
        "margins",
        "positions",
        "holdings",
        "orders",
        "orderHistory",
        "trades",
        "orderMargin",
        "pendingGtts",
        "triggeredGtts",
        "gttAlertTypes",
        "searchInstruments",
        "quote",
        "securityInfo",
        "optionChain",
        "historicalData",
        "dailyHistory",
        "optionGreeks",
        "optionChainSnapshot",
        "buildup",
        "instruments",
        "downloadInstruments",
        "request",
      ].sort(),
    );
  });

  it("converts the arguments: camelCase names, exact Decimals, nulls left out", async () => {
    const { client, calls } = stub();
    await converse(client, new WireCapture(), [
      request(1, "place_sliced_order", {
        ...LIMIT_BUY,
        trigger_price: null,
        disclosed_quantity: null,
        amo: false,
        tag: "t-1",
        max_slice_quantity: 1800,
        max_slices: 7,
      }),
    ]);
    const [name, args] = calls[0] ?? ["", []];
    expect(name).toBe("placeSlicedOrder");
    const params = args[0] as Record<string, unknown>;
    expect(params["transactionType"]).toBe("B");
    expect(params["orderType"]).toBe("LMT");
    expect(params["quantity"]).toBe(75);
    expect(params["amo"]).toBe(false);
    expect(params["tag"]).toBe("t-1");
    expect(params["maxSliceQuantity"]).toBe(1800);
    expect(params["maxSlices"]).toBe(7);
    expect(params).not.toHaveProperty("triggerPrice");
    expect(params).not.toHaveProperty("disclosedQuantity");
    const price = params["price"];
    expect(price instanceof Decimal).toBe(true);
    expect((price as Decimal).toFixed()).toBe("101.5"); // exact, never a binary float
  });

  it("a price that is not a decimal is a ValueError and nothing is called", async () => {
    const { client, calls } = stub();
    const run = await converse(client, new WireCapture(), [
      request(1, "place_order", { ...LIMIT_BUY, price: "abc" }),
    ]);
    expect(calls).toEqual([]);
    expect((run.replies[0]?.["error"] as Json)["type"]).toBe("ValueError");
  });

  it("modify_order passes the id first and the rest as the parameters", async () => {
    const { client, calls } = stub();
    await converse(client, new WireCapture(), [
      request(1, "modify_order", { order_id: "77", ...MODIFY }),
      request(2, "exit_order", { order_id: "78", product: "H" }),
    ]);
    expect(calls[0]?.[1][0]).toBe("77");
    expect((calls[0]?.[1][1] as Record<string, unknown>)["orderType"]).toBe("LMT");
    expect(calls[1]?.[1]).toEqual(["78", "H"]);
  });
});

describe("the protocol loop", () => {
  it("answers each request before reading the next, in order, with its id", async () => {
    const order: string[] = [];
    const client = {
      clientId: "STUB01",
      profile: async () => {
        order.push("profile:start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("profile:end");
        return null;
      },
      margins: () => {
        order.push("margins:start");
        return Promise.resolve(null);
      },
    } as unknown as TradeSmart;
    const run = await converse(client, new WireCapture(), [
      request(5, "profile"),
      request(9, "margins"),
    ]);
    expect(order).toEqual(["profile:start", "profile:end", "margins:start"]);
    expect(run.replies.map((r) => r["id"])).toEqual([5, 9]);
  });

  it("finishes the call in flight and replies when stdin ends, then exits 0", async () => {
    const client = {
      clientId: "STUB01",
      profile: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return null;
      },
    } as unknown as TradeSmart;
    const run = await converse(client, new WireCapture(), [request(1, "profile")]);
    expect(run.replies).toHaveLength(1);
    expect(run.code).toBe(0);
  });

  it("handles a request split across chunks and several in one chunk", async () => {
    const calls: string[] = [];
    const client = {
      clientId: "STUB01",
      profile: () => {
        calls.push("profile");
        return Promise.resolve(null);
      },
    } as unknown as TradeSmart;
    const text = `${request(1, "profile")}\n${request(2, "profile")}\n`;
    const out: string[] = [];
    const code = await serve(
      Readable.from([text.slice(0, 10), text.slice(10, 50), text.slice(50)]),
      { write: (t: string) => out.push(t) },
      client,
      { nonce: NONCE, version: "2.1.1", environment: "uat", capture: new WireCapture() },
    );
    expect(code).toBe(0);
    expect(calls).toEqual(["profile", "profile"]);
    expect(out).toHaveLength(3); // hello and two replies, one line each
  });

  it.each([
    ["a line that is not JSON", "not json"],
    ["a JSON array", "[1]"],
    ["a JSON string", '"profile"'],
    ["a request without an id", '{"method":"profile","args":{}}'],
    ["a request without a method", '{"id":1,"args":{}}'],
    ["an id that is a boolean", '{"id":true,"method":"profile"}'],
    ["an id that is a string", '{"id":"1","method":"profile"}'],
    ["an id that is a float", '{"id":1.5,"method":"profile"}'],
    ["a method that is not a string", '{"id":1,"method":5}'],
    ["args that are not an object", '{"id":1,"method":"profile","args":[]}'],
    ["a blank line", ""],
  ])("%s is a protocol violation: exit 1, no reply, no call", async (_name, line) => {
    const calls: string[] = [];
    const client = {
      clientId: "STUB01",
      profile: () => {
        calls.push("profile");
        return Promise.resolve(null);
      },
    } as unknown as TradeSmart;
    const run = await converse(client, new WireCapture(), [line, request(2, "profile")]);
    expect(run.code).toBe(1);
    expect(run.replies).toEqual([]);
    expect(calls).toEqual([]); // the line after it is never read
    expect(run.log.join("\n")).toContain("protocol violation");
  });

  it("an unknown method is a protocol violation: no call, no reply, exit 1", async () => {
    const w = wire();
    const run = await converse(w.client, w.capture, [request(1, "drop_database")]);
    expect(run.code).toBe(1);
    expect(run.replies).toEqual([]);
    expect(w.state.requests).toHaveLength(0);
    expect(w.capture.dispatched).toBe(0);
  });

  it("a last line without its newline is a violation (never guessed)", async () => {
    const calls: string[] = [];
    const client = {
      clientId: "STUB01",
      profile: () => {
        calls.push("profile");
        return Promise.resolve(null);
      },
    } as unknown as TradeSmart;
    const out: string[] = [];
    const code = await serve(
      Readable.from([request(1, "profile")]),
      { write: (t: string) => out.push(t) },
      client,
      { nonce: NONCE, version: "2.1.1", environment: "uat", capture: new WireCapture() },
    );
    expect(code).toBe(1);
    expect(calls).toEqual([]);
  });

  it("writes nothing but protocol lines to stdout; logs go to the log sink, redacted", async () => {
    const secret = "synthetic-secret-token-98765";
    const client = {
      clientId: "STUB01",
      margins: () => Promise.reject(new Error(`boom with ${secret} and Bearer abc.def`)),
    } as unknown as TradeSmart;
    const run = await converse(client, new WireCapture(), [request(1, "margins")], {
      secrets: [secret],
    });
    for (const line of run.lines) {
      const parsed = JSON.parse(line) as Json;
      expect("hello" in parsed || "id" in parsed).toBe(true);
    }
    const everything = run.lines.join("\n") + run.log.join("\n");
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain("abc.def");
    expect(run.log.length).toBeGreaterThan(0); // the unexpected error was logged (redacted)
  });

  it("never echoes the nonce or the client's token in a log line", async () => {
    const w = wire();
    w.state.failNext("PlaceOrder", drills.reject("RMS"));
    const run = await converse(w.client, w.capture, [request(1, "place_order", LIMIT_BUY)], {
      secrets: [SYNTHETIC_TOKEN],
    });
    expect(run.log.join("\n")).not.toContain(NONCE);
    expect(run.log.join("\n")).not.toContain(SYNTHETIC_TOKEN);
  });
});

describe("the wire capture", () => {
  it("records each response body and status and still hands the SDK its body", async () => {
    const w = wire();
    await w.client.margins();
    expect(w.capture.dispatched).toBe(1);
    expect(w.capture.entries).toHaveLength(1);
    const entry = w.capture.entries[0];
    expect(entry?.endpoint).toBe("Limits");
    expect(entry?.status).toBe(200);
    expect(JSON.parse(entry?.text ?? "{}")).toMatchObject({ stat: "Ok" });
  });

  it("counts write requests apart from reads", async () => {
    const w = wire();
    await w.client.margins();
    expect(w.capture.writesDispatched).toBe(0);
    await w.client.placeOrder({
      exchange: "NSE",
      tradingsymbol: "SBIN-EQ",
      quantity: 1,
      transactionType: "B",
      product: "C",
      orderType: "LMT",
      price: "1",
    });
    expect(w.capture.writesDispatched).toBe(1);
    expect(w.capture.dispatched).toBe(2);
  });

  it("delegates closed and destroyed to the wrapped dispatcher", () => {
    const inner = { closed: false, destroyed: false } as unknown as Parameters<
      typeof captureDispatcher
    >[0];
    const wrapped = captureDispatcher(inner, new WireCapture()) as unknown as {
      closed: boolean;
      destroyed: boolean;
    };
    expect(wrapped.closed).toBe(false);
    (inner as unknown as { closed: boolean }).closed = true;
    expect(wrapped.closed).toBe(true);
  });
});

describe("the start-up refusal", () => {
  const OK: Env = {
    [NONCE_ENV]: NONCE,
    TRADESMART_LIVE_TESTS: "1",
    TRADESMART_LIVE_ORDER_TESTS: "1",
  };

  it("passes with the nonce and both opt-ins", () => {
    expect(startRefusal(OK)).toBeNull();
  });

  it.each([
    ["no nonce", { ...OK, [NONCE_ENV]: undefined }],
    ["a blank nonce", { ...OK, [NONCE_ENV]: "   " }],
    ["no TRADESMART_LIVE_TESTS", { ...OK, TRADESMART_LIVE_TESTS: undefined }],
    ["TRADESMART_LIVE_TESTS=0", { ...OK, TRADESMART_LIVE_TESTS: "0" }],
    ["TRADESMART_LIVE_TESTS=true", { ...OK, TRADESMART_LIVE_TESTS: "true" }],
    ["no TRADESMART_LIVE_ORDER_TESTS", { ...OK, TRADESMART_LIVE_ORDER_TESTS: undefined }],
    ["TRADESMART_LIVE_ORDER_TESTS=yes", { ...OK, TRADESMART_LIVE_ORDER_TESTS: "yes" }],
    ["an empty environment", {}],
  ])("refuses with %s", (_name, env) => {
    const reason = startRefusal(env);
    expect(reason).toMatch(/refusing/);
    expect(reason).not.toContain(NONCE);
  });

  function io(): { stdout: string[]; stderr: string[]; target: Parameters<typeof runProgram>[1] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      stdout,
      stderr,
      target: {
        stdin: Readable.from([]),
        stdout: { write: (t: string) => stdout.push(t) },
        stderr: { write: (t: string) => stderr.push(t) },
      },
    };
  }

  it.each([
    ["the nonce", { ...OK, [NONCE_ENV]: undefined }],
    ["TRADESMART_LIVE_TESTS", { ...OK, TRADESMART_LIVE_TESTS: undefined }],
    ["TRADESMART_LIVE_ORDER_TESTS", { ...OK, TRADESMART_LIVE_ORDER_TESTS: "0" }],
  ])(
    "the program exits 2 without %s: no client built, no request, nothing on stdout",
    async (_n, env) => {
      const build = vi.fn<(env: Env) => Promise<Built>>();
      const { stdout, stderr, target } = io();
      const code = await runProgram(env, target, build);
      expect(code).toBe(2);
      expect(build).not.toHaveBeenCalled();
      expect(stdout).toEqual([]);
      expect(stderr.join("")).toMatch(/refusing/);
    },
  );

  it("builds the client only after the checks, serves, and closes what it built", async () => {
    const w = wire();
    const close = vi.fn(() => Promise.resolve());
    const build = vi.fn((): Promise<Built> =>
      Promise.resolve({
        client: w.client,
        capture: w.capture,
        version: "2.1.1",
        environment: "uat",
        secrets: [],
        close,
      }),
    );
    const { stdout, target } = io();
    const code = await runProgram(OK, target, build);
    expect(code).toBe(0);
    expect(build).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    const hello = JSON.parse(stdout.join("").split("\n")[0] ?? "{}") as { hello: Json };
    expect(hello.hello["run"]).toBe(NONCE);
  });

  it("a client that cannot be built is exit 2 with one redacted line and no hello", async () => {
    const build = vi.fn((): Promise<Built> =>
      Promise.reject(new Error(`no token ${NONCE} Bearer xyz.123`)),
    );
    const { stdout, stderr, target } = io();
    const code = await runProgram(OK, target, build);
    expect(code).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).not.toContain(NONCE);
    expect(stderr.join("")).not.toContain("xyz.123");
  });
});

describe("the environment the client is built for", () => {
  const store = (saved: string | null = null): Parameters<typeof planEnvironment>[1] => ({
    defaultTokenFilePath,
    savedClientId: () => saved,
    platform: "linux",
    home: "/home/u",
    cwd: "/repo",
  });
  const URLS = {
    TRADESMART_ENV_BASE_URL: "https://uat.example.test/NorenWClientAPIV2",
    TRADESMART_ENV_WS_URL: "wss://uat.example.test/ws/",
    TRADESMART_ENV_AUTHORIZE_URL: "https://uat.example.test/authorize",
  };

  it("production by default; TRADESMART_BASE_URL overrides only the REST base", () => {
    const plain = planEnvironment({}, store());
    expect(plain.name).toBe("production");
    expect(plain.config).toEqual({});
    const base = planEnvironment({ TRADESMART_BASE_URL: " https://p.example.test/x " }, store());
    expect(base.config).toEqual({ baseUrl: "https://p.example.test/x" });
  });

  it("a non-production environment needs all three URLs and uses them", () => {
    const plan = planEnvironment({ TRADESMART_ENV: "UAT", ...URLS }, store());
    expect(plan.name).toBe("uat");
    expect(plan.config).toEqual({
      baseUrl: URLS.TRADESMART_ENV_BASE_URL,
      wsUrl: URLS.TRADESMART_ENV_WS_URL,
      authorizeUrl: URLS.TRADESMART_ENV_AUTHORIZE_URL,
    });
    for (const name of Object.keys(URLS)) {
      const missing = { TRADESMART_ENV: "uat", ...URLS, [name]: "" };
      expect(() => planEnvironment(missing, store())).toThrow(new RegExp(name));
    }
    const sm = planEnvironment(
      {
        TRADESMART_ENV: "uat",
        ...URLS,
        TRADESMART_ENV_SCRIPT_MASTER_URL: "https://sm.example.test",
      },
      store(),
    );
    expect(sm.config).toMatchObject({ scriptMasterBaseUrl: "https://sm.example.test" });
  });

  it.each(["UAT_1", "a b", "uat/x", "../x"])("refuses the environment name %j", (name) => {
    expect(() => planEnvironment({ TRADESMART_ENV: name, ...URLS }, store())).toThrow(
      /not a valid environment name/,
    );
  });

  it("a non-production run reads its own token file, never the production one", () => {
    const plan = planEnvironment({ TRADESMART_ENV: "uat", ...URLS }, store());
    expect(plan.env["TRADESMART_TOKEN_FILE"]).toBe("/home/u/.config/tradesmart/uat-token.json");
    const prod = planEnvironment({ TRADESMART_TOKEN_FILE: "/x/mine.json" }, store());
    expect(prod.env["TRADESMART_TOKEN_FILE"]).toBe("/x/mine.json"); // production: as set
  });

  it("refuses a token file override that is the production file or named token.json", () => {
    const env = { TRADESMART_ENV: "uat", ...URLS };
    expect(() =>
      planEnvironment(
        { ...env, TRADESMART_TOKEN_FILE: "/home/u/.config/tradesmart/token.json" },
        store(),
      ),
    ).toThrow(/production token file/);
    expect(() =>
      planEnvironment({ ...env, TRADESMART_TOKEN_FILE: "/elsewhere/TOKEN.JSON" }, store()),
    ).toThrow(/token\.json/);
    const ok = planEnvironment({ ...env, TRADESMART_TOKEN_FILE: "/elsewhere/uat.json" }, store());
    expect(ok.env["TRADESMART_TOKEN_FILE"]).toBe("/elsewhere/uat.json");
  });

  it("refuses the shell's token or a client id that differs from the saved login", () => {
    const env = { TRADESMART_ENV: "uat", ...URLS };
    expect(() =>
      planEnvironment({ ...env, TRADESMART_ACCESS_TOKEN: "x-token-1" }, store()),
    ).toThrow(/TRADESMART_ACCESS_TOKEN/);
    expect(() =>
      planEnvironment({ ...env, TRADESMART_CLIENT_ID: "OTHER1" }, store("UAT123")),
    ).toThrow(/TRADESMART_CLIENT_ID/);
    expect(() =>
      planEnvironment({ ...env, TRADESMART_CLIENT_ID: "uat123" }, store("UAT123")),
    ).not.toThrow(); // case-insensitive, as the Python harness compares
    expect(() =>
      planEnvironment({ ...env, TRADESMART_CLIENT_ID: "OTHER1" }, store(null)),
    ).not.toThrow();
  });
});

describe("the program (tests/live_orders/driver.ts)", () => {
  const dist = path.resolve(HERE, "../../dist/index.js");

  // The real program, as the harness starts it (Node's native type stripping), with a fake
  // environment that lacks the nonce or an opt-in: it must exit 2 before building anything.
  it.each([
    ["nothing at all", {}],
    ["no nonce", { TRADESMART_LIVE_TESTS: "1", TRADESMART_LIVE_ORDER_TESTS: "1" }],
    ["no opt-ins", { [NONCE_ENV]: NONCE }],
    ["one opt-in", { [NONCE_ENV]: NONCE, TRADESMART_LIVE_TESTS: "1" }],
    ["only the order opt-in", { [NONCE_ENV]: NONCE, TRADESMART_LIVE_ORDER_TESTS: "1" }],
  ])(
    "started as a process with %s it refuses: exit 2, nothing on stdout",
    (_name, env) => {
      const child = spawnSync(process.execPath, [DRIVER_SOURCE], {
        env: { PATH: process.env["PATH"] ?? "", ...env },
        input: "",
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(child.status).toBe(2);
      expect(child.stdout).toBe("");
      expect(child.stderr).toMatch(/refusing to start/);
      expect(child.stderr).not.toContain(NONCE);
    },
    // The child gets 30 s; the test's own limit must exceed it (vitest fails a synchronous test
    // that ran past its limit, 5 s by default, even after spawnSync returned in time).
    60_000,
  );
  it.skipIf(!existsSync(dist))(
    "buildFromEnvironment builds from the environment given, and refuses without a login (no network)",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "tradesmart-driver-env-"));
      try {
        await expect(
          buildFromEnvironment({
            [NONCE_ENV]: NONCE,
            TRADESMART_TOKEN_FILE: path.join(dir, "none.json"),
            HOME: dir,
          }),
        ).rejects.toThrow(/TRADESMART_CLIENT_ID|access token/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  const source = (): string => readFileSync(DRIVER_SOURCE, "utf8");

  it("never logs through console and does not retry, batch or loop over calls", () => {
    const text = source();
    expect(text).not.toMatch(/\bconsole\./);
    expect(text).not.toMatch(/\bsetInterval\b/);
  });

  it("imports the built SDK (dist), never src, and only after the start-up checks", () => {
    const text = source();
    expect(text).toContain("../../dist/index.js");
    // Types only come from src (erased at run time); no value is ever imported from it.
    expect(text).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+["']\.\.\/\.\.\/src\//m);
  });
});

// ---------------------------------------------------------------------------------------------
// Fix round 1: the program's own build path, and the entry guard.

describe("buildFromEnvironment (the program's build path, offline)", () => {
  const dist = path.resolve(HERE, "../../dist/index.js");
  const URLS = {
    TRADESMART_ENV: "uat",
    TRADESMART_ENV_BASE_URL: "https://uat.example.test/NorenWClientAPIV2",
    TRADESMART_ENV_WS_URL: "wss://uat.example.test/ws/",
    TRADESMART_ENV_AUTHORIZE_URL: "https://uat.example.test/authorize",
  };

  /** `YYYY-MM-DDTHH:MM:SS+05:30`, the Python SDK's saved-login timestamp. */
  function ist(date: Date): string {
    return `${new Date(date.getTime() + 330 * 60_000).toISOString().slice(0, 19)}+05:30`;
  }

  function login(dir: string, clientId: string, token: string): string {
    const file = path.join(dir, "uat-token.json");
    const issued = new Date(Date.now() - 1000);
    // The shape `tradesmart._token_store.save` writes (owner-only file in an owner-only folder).
    writeFileSync(
      file,
      JSON.stringify({
        client_id: clientId,
        access_token: token,
        issued_at: ist(issued),
        expires_at: ist(new Date(issued.getTime() + 20 * 3_600_000)),
      }),
      { mode: 0o600 },
    );
    chmodSync(file, 0o600);
    return file;
  }

  it.skipIf(!existsSync(dist))(
    "builds from a Python-format saved login for TRADESMART_ENV=uat, sends no request, closes",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "tradesmart-driver-build-"));
      chmodSync(dir, 0o700);
      try {
        const token = "synthetic-saved-login-token-0042";
        const file = login(dir, "UAT123", token);
        const built = await buildFromEnvironment({
          ...URLS,
          [NONCE_ENV]: NONCE,
          TRADESMART_TOKEN_FILE: file,
          HOME: dir,
        });
        expect(built.client.clientId).toBe("UAT123");
        expect(built.environment).toBe("uat");
        expect(built.version).toBe("2.1.1");
        expect(built.client.config.baseUrl).toBe(URLS.TRADESMART_ENV_BASE_URL);
        expect(built.secrets).toContain(token);
        expect(built.capture.dispatched).toBe(0); // building sends nothing
        expect(String(built.client)).not.toContain(token);
        await expect(built.close()).resolves.toBeUndefined();
        expect(built.capture.dispatched).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!existsSync(dist))(
    "refuses a build with no usable token even when an app key is set (the driver never logs in)",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "tradesmart-driver-build-"));
      try {
        await expect(
          buildFromEnvironment({
            ...URLS,
            [NONCE_ENV]: NONCE,
            TRADESMART_TOKEN_FILE: path.join(dir, "uat-token.json"),
            TRADESMART_CLIENT_ID: "UAT123",
            TRADESMART_APP_KEY: "synthetic-app-key-0001",
            HOME: dir,
          }),
        ).rejects.toThrow(/no usable login|log in/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("the entry guard compares real paths", () => {
  it("runs for the file itself, for a symlink to it, and not for another file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tradesmart-driver-entry-"));
    try {
      const real = path.join(dir, "driver.ts");
      const other = path.join(dir, "other.ts");
      writeFileSync(real, "");
      writeFileSync(other, "");
      const link = path.join(dir, "link.ts");
      symlinkSync(real, link);
      const url = `file://${real}`;
      expect(isEntryPoint(real, url)).toBe(true);
      expect(isEntryPoint(link, url)).toBe(true);
      expect(isEntryPoint(other, url)).toBe(false);
      expect(isEntryPoint(undefined, url)).toBe(false);
      expect(isEntryPoint(path.join(dir, "missing.ts"), url)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
