// The sans-IO stream protocol and state (sdk-behaviour.md §9.2–9.4, §9.6, §2.6).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RequestValidationError, SubscriptionLimitError } from "../../src/errors.js";
import type { Logger, LogContext } from "../../src/lib/log.js";
import { STREAM_MESSAGE_PARSERS } from "../../src/models/generated/stream.js";
import {
  MESSAGE_KINDS,
  connectMessage,
  depthMessage,
  heartbeatMessage,
  orderUpdatesMessage,
  parseMessage,
  positionUpdatesMessage,
  reconnectDelayMs,
  toScripKey,
  toScripKeys,
  touchlineMessage,
  unsubscribeDepthMessage,
  unsubscribeOrdersMessage,
  unsubscribePositionsMessage,
  unsubscribeTouchlineMessage,
  type InstrumentsArg,
} from "../../src/stream/protocol.js";
import {
  MAX_SUBSCRIPTIONS,
  SnapshotCache,
  StateMachine,
  StreamState,
  SubscriptionRegistry,
} from "../../src/stream/state.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../specifications/test-fixtures",
);

const EXPECTED_KIND: Record<string, string> = {
  ak: "ConnectAck",
  tk: "TouchlineAck",
  tf: "TouchlineFeed",
  dk: "DepthAck",
  df: "DepthFeed",
  om: "OrderUpdate",
  pk: "PositionAck",
  pm: "PositionUpdate",
  uk: "UnsubscribeAck",
  udk: "UnsubscribeAck",
  uok: "UnsubscribeAck",
  upk: "UnsubscribeAck",
  hk: "HeartbeatAck",
};

interface Line {
  level: string;
  msg: string;
  ctx: LogContext | undefined;
}

function capture(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: string) =>
    (msg: string, ctx?: LogContext): void => {
      lines.push({ level, msg, ctx });
    };
  return {
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
    lines,
  };
}

describe("parseMessage", () => {
  const fixture = JSON.parse(
    readFileSync(path.join(FIXTURES, "ws_messages.json"), "utf8"),
  ) as Record<string, Record<string, unknown>>;

  for (const [name, wire] of Object.entries(fixture)) {
    it(`fixture ${name} parses to the model of its t`, () => {
      const t = wire["t"] as string;
      const parsed = parseMessage(JSON.stringify(wire));
      expect(parsed.kind).toBe(EXPECTED_KIND[t]);
      expect(parsed.message.t).toBe(t);
      expect(parsed.message.raw["t"]).toBe(t);
    });
  }

  it("every parser of STREAM_MESSAGE_PARSERS has a kind, and no other t does", () => {
    expect(Object.keys(MESSAGE_KINDS).sort()).toEqual(Object.keys(STREAM_MESSAGE_PARSERS).sort());
    for (const [t, kind] of Object.entries(EXPECTED_KIND)) expect(MESSAGE_KINDS[t]).toBe(kind);
  });

  it("reads a Buffer, an ArrayBuffer and a fragmented Buffer list", () => {
    const text = '{"t":"tf","e":"NSE","tk":"22","lp":"1.5"}';
    const buf = Buffer.from(text, "utf8");
    expect(parseMessage(buf).kind).toBe("TouchlineFeed");
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    expect(parseMessage(ab).kind).toBe("TouchlineFeed");
    expect(parseMessage([buf.subarray(0, 5), buf.subarray(5)]).kind).toBe("TouchlineFeed");
  });

  it("keeps prices exact (never through a float)", () => {
    const parsed = parseMessage('{"t":"tf","e":"NSE","tk":"22","lp":1156.123456789012345}');
    expect(parsed.kind).toBe("TouchlineFeed");
    if (parsed.kind !== "TouchlineFeed") return;
    expect(parsed.message.lastPrice?.toString()).toBe("1156.123456789012345");
  });

  it.each([
    ["an unknown t", '{"t":"zz","a":"1"}', "zz"],
    ["an inherited property name as t (constructor)", '{"t":"constructor"}', "constructor"],
    ["an inherited property name as t (toString)", '{"t":"toString"}', "toString"],
    ["an inherited property name as t (__proto__)", '{"t":"__proto__"}', "__proto__"],
    ["hasOwnProperty as t", '{"t":"hasOwnProperty"}', "hasOwnProperty"],
    ["a missing t", '{"a":"1"}', ""],
    ["a non-string t", '{"t":5}', ""],
  ])("%s gives UnknownMessage", (_label, text, t) => {
    const parsed = parseMessage(text);
    expect(parsed.kind).toBe("UnknownMessage");
    expect(parsed.message.t).toBe(t);
    expect(Object.isFrozen(parsed.message)).toBe(true);
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["a JSON array", "[1,2]"],
    ["a JSON string", '"text"'],
    ["JSON null", "null"],
  ])("%s gives UnknownMessage with the text kept", (_label, text) => {
    const parsed = parseMessage(text);
    expect(parsed.kind).toBe("UnknownMessage");
    expect(parsed.message.t).toBe("");
    expect(parsed.message.raw).toEqual({ text });
  });

  it("a model failure gives UnknownMessage and a WARNING that names the fields only", () => {
    const { logger, lines } = capture();
    const parsed = parseMessage('{"t":"tf","e":"NSE","tk":"22","lp":"SECRETVALUE"}', logger);
    expect(parsed.kind).toBe("UnknownMessage");
    expect(parsed.message.t).toBe("tf");
    expect(parsed.message.raw["lp"]).toBe("SECRETVALUE");
    const warnings = lines.filter((l) => l.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toContain("lp");
    expect(JSON.stringify(lines)).not.toContain("SECRETVALUE");
    expect(warnings[0]?.ctx?.logger).toBe("tradesmart.stream");
  });

  it("a protected-key failure (ResponseParseError) gives UnknownMessage, never an exception", () => {
    const { logger, lines } = capture();
    const parsed = parseMessage('{"t":"om","norenordno":{"x":"1"},"status":"Complete"}', logger);
    expect(parsed.kind).toBe("UnknownMessage");
    expect(parsed.message.t).toBe("om");
    expect(lines.filter((l) => l.level === "warn")).toHaveLength(1);
  });

  it("masks the redacted keys in raw", () => {
    const parsed = parseMessage('{"t":"zz","accesstoken":"tok-xyz"}');
    expect(parsed.message.raw["accesstoken"]).toBe("***");
  });
});

describe("outbound messages", () => {
  it("builds every request of §9.2", () => {
    expect(connectMessage("U1", "tok")).toEqual({
      t: "a",
      uid: "U1",
      actid: "U1",
      source: "API",
      accesstoken: "tok",
    });
    expect(Object.keys(connectMessage("U1", "tok"))).toEqual([
      "t",
      "uid",
      "actid",
      "source",
      "accesstoken",
    ]);
    expect(touchlineMessage(["NSE|22", "BSE|1"])).toEqual({ t: "t", k: "NSE|22#BSE|1" });
    expect(unsubscribeTouchlineMessage(["NSE|22"])).toEqual({ t: "u", k: "NSE|22" });
    expect(depthMessage(["NSE|22", "NSE|23"])).toEqual({ t: "d", k: "NSE|22#NSE|23" });
    expect(unsubscribeDepthMessage(["NSE|22"])).toEqual({ t: "ud", k: "NSE|22" });
    expect(orderUpdatesMessage("U1")).toEqual({ t: "o", actid: "U1" });
    expect(unsubscribeOrdersMessage()).toEqual({ t: "uo" });
    expect(positionUpdatesMessage("U1")).toEqual({ t: "p", uid: "U1" });
    expect(unsubscribePositionsMessage()).toEqual({ t: "up" });
    expect(heartbeatMessage()).toEqual({ t: "h" });
  });
});

describe("instruments arguments (§2.6)", () => {
  const TEXT =
    "Invalid request parameters: instruments.0 (expected 'EXCH|TOKEN', (exchange, token) or a list of them)";

  it.each([
    ["a number", 22],
    ["null", null],
    ["undefined", undefined],
    ["an object", { e: "NSE" }],
  ])("%s raises RequestValidationError with the exact text", (_label, value) => {
    const run = (): string[] => toScripKeys(value as unknown as InstrumentsArg);
    expect(run).toThrow(RequestValidationError);
    expect(run).toThrow(TEXT);
  });

  it("one [exchange, token] pair is one instrument", () => {
    expect(toScripKeys(["nse", "22"])).toEqual(["NSE|22"]);
  });

  it('a pair whose first item has a "|" is two instruments', () => {
    expect(toScripKeys(["NSE|22", "NSE|23"])).toEqual(["NSE|22", "NSE|23"]);
  });

  it("an error names the index of the bad item", () => {
    expect(() => toScripKeys(["NSE|22", "XYZ|1"])).toThrow(/instruments\.1 /);
  });

  it("toScripKey takes exactly one instrument", () => {
    expect(toScripKey("nse|22")).toBe("NSE|22");
    expect(toScripKey(["bse", "1"])).toBe("BSE|1");
    expect(() => toScripKey(["NSE|22"] as unknown as string)).toThrow(RequestValidationError);
    expect(() => toScripKey(["NSE|22", "NSE|23"] as unknown as string)).toThrow(
      RequestValidationError,
    );
    expect(() => toScripKey("NSE22")).toThrow(RequestValidationError);
    expect(() => toScripKey(5 as unknown as string)).toThrow(RequestValidationError);
  });
});

describe("reconnectDelayMs (§9.5)", () => {
  it("is min(cap, base·2^attempt)·(0.5 + U/2), in milliseconds", () => {
    expect(reconnectDelayMs(0, 1, 60, () => 0)).toBe(500);
    expect(reconnectDelayMs(0, 1, 60, () => 1)).toBe(1000);
    expect(reconnectDelayMs(3, 1, 60, () => 0.5)).toBe(8000 * 0.75);
    expect(reconnectDelayMs(10, 1, 60, () => 1)).toBe(60000);
    expect(reconnectDelayMs(5000, 1, 60, () => 0)).toBe(30000);
  });
});

describe("SubscriptionRegistry (§9.4)", () => {
  it("replays touchline sorted, depth sorted, orders, positions", () => {
    const r = new SubscriptionRegistry();
    r.addTouchline(["NSE|3", "NSE|1"]);
    r.addDepth(["NSE|9", "BSE|2"]);
    r.orders = true;
    r.positions = true;
    expect(r.restoreMessages("U1")).toEqual([
      { t: "t", k: "NSE|1#NSE|3" },
      { t: "d", k: "BSE|2#NSE|9" },
      { t: "o", actid: "U1" },
      { t: "p", uid: "U1" },
    ]);
    r.removeTouchline(["NSE|1", "NSE|3"]);
    r.orders = false;
    expect(r.restoreMessages("U1")).toEqual([
      { t: "d", k: "BSE|2#NSE|9" },
      { t: "p", uid: "U1" },
    ]);
  });

  it("allows 1000 subscriptions and refuses 1001; a key in both counts twice", () => {
    expect(MAX_SUBSCRIPTIONS).toBe(1000);
    const r = new SubscriptionRegistry();
    const keys = Array.from({ length: 500 }, (_, i) => `NSE|${String(i)}`);
    r.ensureCapacity({ touchline: keys });
    r.addTouchline(keys);
    r.ensureCapacity({ depth: keys });
    r.addDepth(keys);
    r.ensureCapacity({ touchline: ["NSE|0"] }); // already counted
    expect(() => {
      r.ensureCapacity({ depth: ["NSE|9999"] });
    }).toThrow(SubscriptionLimitError);
    expect(() => {
      r.ensureCapacity({ depth: ["NSE|9999"] });
    }).toThrow("Subscription limit exceeded: 1001 > 1000 per connection");
  });
});

describe("SnapshotCache (§9.3)", () => {
  it("merges every key but t per e|tk and returns copies", () => {
    const cache = new SnapshotCache();
    cache.update({ t: "tk", e: "NSE", tk: "22", lp: "1", v: "10" });
    cache.update({ t: "tf", e: "NSE", tk: "22", lp: "2" });
    expect(cache.get("NSE|22")).toEqual({ e: "NSE", tk: "22", lp: "2", v: "10" });
    const copy = cache.get("NSE|22");
    if (copy !== null) copy["lp"] = "changed";
    expect(cache.get("NSE|22")?.["lp"]).toBe("2");
    expect(cache.get("NSE|23")).toBeNull();
    cache.update({ t: "tf", lp: "3" }); // no e/tk: ignored
    expect(cache.get("NSE|22")?.["lp"]).toBe("2");
  });
});

describe("StateMachine (§9.6)", () => {
  it("reports each transition once and stays CLOSED", () => {
    const seen: string[] = [];
    const sm = new StateMachine((s) => seen.push(s));
    expect(sm.state).toBe(StreamState.DISCONNECTED);
    sm.transition(StreamState.CONNECTING);
    sm.transition(StreamState.CONNECTING);
    sm.transition(StreamState.AUTHENTICATING);
    sm.transition(StreamState.CONNECTED);
    sm.transition(StreamState.RECONNECTING);
    sm.transition(StreamState.CONNECTED);
    sm.transition(StreamState.CLOSED);
    sm.transition(StreamState.CONNECTED);
    sm.transition(StreamState.CLOSED);
    expect(seen).toEqual([
      "CONNECTING",
      "AUTHENTICATING",
      "CONNECTED",
      "RECONNECTING",
      "CONNECTED",
      "CLOSED",
    ]);
    expect(sm.state).toBe("CLOSED");
  });
});
