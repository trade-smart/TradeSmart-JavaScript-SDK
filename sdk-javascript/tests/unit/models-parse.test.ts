import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { Decimal } from "../../src/lib/decimal.js";
import { ResponseParseError } from "../../src/errors.js";
import { parseJsonLossless } from "../../src/lib/json.js";
import {
  OrderStatus,
  STREAM_MESSAGE_PARSERS,
  Secret,
  parseAccessToken,
  parseCandle,
  parseDailyCandle,
  parseGtt,
  parseHolding,
  parseLimits,
  parseOptionContract,
  parseOrder,
  parseOrderAck,
  parseOrderHistoryEntry,
  parseOrderMargin,
  parsePosition,
  parseQuote,
  parseScripMatch,
  parseSecurityInfo,
  parseTrade,
  parseTriggeredGtt,
  parseUserDetails,
  type ParseContext,
} from "../../src/models/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, "../../../specifications/test-fixtures");

function fixture(name: string): unknown {
  return parseJsonLossless(readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected an array");
  return value as unknown[];
}

function valuesOf(value: unknown): unknown[] {
  return asArray((value as { values?: unknown }).values);
}

type Parse = (wire: unknown, ctx?: ParseContext) => object;

/** How a success fixture's body becomes records: the model parser and where the records sit. */
interface FixtureMapping {
  parse: Parse;
  records: (body: unknown) => unknown[];
}

const one = (body: unknown): unknown[] => [body];

/** `GenAcsTok` bodies carry no times: the client adds `issued_at`/`expires_at` (sdk-behaviour §6.3). */
const withTokenTimes = (body: unknown): unknown[] => [
  {
    ...(body as object),
    issued_at: new Date("2026-11-15T03:00:00Z"),
    expires_at: new Date("2026-11-16T00:30:00Z"),
  },
];

// Endpoint names: sdk-behaviour.md §2.3 and specifications/test-fixtures/README.md.
const FIXTURES: Record<string, FixtureMapping> = {
  "gen_acs_tok_success.json": { parse: parseAccessToken, records: withTokenTimes }, // GenAcsTok
  "user_details_success.json": { parse: parseUserDetails, records: one }, // UserDetails
  "limits_success.json": { parse: parseLimits, records: one }, // Limits
  "holdings_success.json": { parse: parseHolding, records: asArray }, // Holdings
  "position_book_success.json": { parse: parsePosition, records: asArray }, // PositionBook
  "order_book_success.json": { parse: parseOrder, records: asArray }, // OrderBook
  "single_ord_hist_success.json": { parse: parseOrderHistoryEntry, records: asArray }, // SingleOrdHist
  "trade_book_success.json": { parse: parseTrade, records: asArray }, // TradeBook
  "order_margin_success.json": { parse: parseOrderMargin, records: one }, // GetOrderMargin
  "place_order_success.json": { parse: parseOrderAck, records: one }, // PlaceOrder
  "cancel_order_success.json": { parse: parseOrderAck, records: one }, // CancelOrder
  "pending_gtts_success.json": { parse: parseGtt, records: asArray }, // GetPendingGTTOrder
  "triggered_gtts_success.json": { parse: parseTriggeredGtt, records: asArray }, // GetTrgOi
  "search_scrip_success.json": { parse: parseScripMatch, records: valuesOf }, // SearchScrip
  "get_quotes_success.json": { parse: parseQuote, records: one }, // GetQuotes
  "security_info_success.json": { parse: parseSecurityInfo, records: one }, // GetSecurityInfo
  "option_chain_success.json": { parse: parseOptionContract, records: valuesOf }, // GetOptionChain
  "tpseries_success.json": { parse: parseCandle, records: asArray }, // TPSeries
  // EODChartData: each element is a JSON object encoded as a string (double-encoded).
  "eod_chart_success.json": {
    parse: parseDailyCandle,
    records: (body) => asArray(body).map((item) => parseJsonLossless(item as string)),
  },
};

// Success fixtures with no model: the GTT writes and GetEnabledGTTs return plain strings
// (`al_id`, the `ai_ts[].ai_t` values), sdk-behaviour.md §2.3.
const NO_MODEL = new Set([
  "place_gtt_success.json",
  "modify_gtt_success.json",
  "cancel_gtt_success.json",
  "enabled_gtts_success.json",
]);

describe("success fixtures", () => {
  it("every *_success.json is mapped to a model or skipped by name", () => {
    const names = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith("_success.json"));
    for (const name of names) {
      expect(name in FIXTURES || NO_MODEL.has(name), name).toBe(true);
    }
  });

  for (const [name, mapping] of Object.entries(FIXTURES)) {
    it(`parses ${name}`, () => {
      const records = mapping.records(fixture(name));
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        const model = mapping.parse(record);
        expect(Object.isFrozen(model)).toBe(true);
      }
    });
  }

  it("parses the live-shape cancel acknowledgement (`result` kept in extra)", () => {
    const ack = parseOrderAck(fixture("cancel_order_ack_live_shape.json"));
    expect(ack.stat).toBe("Ok");
    expect(ack.extra["result"]).toBe("26111000000001");
  });

  it("parses every WebSocket message through its `t`", () => {
    const messages = fixture("ws_messages.json") as Record<string, { t: string }>;
    for (const [key, message] of Object.entries(messages)) {
      const parse = STREAM_MESSAGE_PARSERS[message.t];
      expect(parse, key).toBeDefined();
      const parsed = parse?.(message) as { t: string };
      expect(parsed.t, key).toBe(message.t);
    }
  });
});

describe("Order", () => {
  const first = (): Record<string, unknown> => ({
    ...(asArray(fixture("order_book_success.json"))[0] as object),
  });

  it("has typed fields: orderId string, price Decimal, quantity number, known status", () => {
    const order = parseOrder(first());
    expect(order.orderId).toBe("26062000004241");
    expect(order.price).toBeInstanceOf(Decimal);
    expect(order.price?.toString()).toBe("1584");
    expect(order.quantity).toBe(1);
    expect(Object.values(OrderStatus)).toContain(order.status);
    expect(order.status).toBe(OrderStatus.REJECTED);
    expect(order.sPrdtAli).toBe("BO");
  });

  it("a failing lenient field becomes null and keeps its value in raw", () => {
    const seen: string[][] = [];
    const order = parseOrder(
      { ...first(), qty: "abc" },
      { onLenientFields: (_model, keys) => seen.push([...keys]) },
    );
    expect(order.quantity).toBeNull();
    expect(order.raw["qty"]).toBe("abc");
    expect(seen).toEqual([["qty"]]);
  });

  it("a failing protected key fails the record, naming the key but not the value", () => {
    const parse = (): unknown => parseOrder({ ...first(), norenordno: {} });
    expect(parse).toThrow(ResponseParseError);
    try {
      parse();
    } catch (error) {
      const e = error as ResponseParseError;
      expect(e.model).toBe("Order");
      expect(e.fields).toEqual(["norenordno"]);
      expect(e.protectedKey).toBe(true);
      expect(e.message).not.toContain("[object Object]");
    }
  });

  it("an unknown status stays the original string", () => {
    expect(parseOrder({ ...first(), status: "NEW_STATE" }).status).toBe("NEW_STATE");
  });

  it("unknown keys land in extra", () => {
    const order = parseOrder({ ...first(), zz: "1" });
    expect(order.extra["zz"]).toBe("1");
    expect(Object.keys(order.extra)).toEqual(["zz"]);
    expect(order.C).toBe("C"); // a documented key, not extra
  });

  it("a wire key __proto__ stays an own extra key and never sets the prototype", () => {
    const wire = parseJsonLossless('{"norenordno": "1", "__proto__": {"polluted": "yes"}}');
    const order = parseOrder(wire);
    expect(Object.getPrototypeOf(order.extra)).toBe(Object.prototype);
    expect(Object.keys(order.extra)).toEqual(["__proto__"]);
    expect((order.extra as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("raw and extra are frozen shallow copies", () => {
    const wire = first();
    const order = parseOrder(wire);
    expect(order.raw).not.toBe(wire);
    expect(order.raw).toEqual(wire);
    expect(Object.isFrozen(order.raw)).toBe(true);
    expect(Object.isFrozen(order.extra)).toBe(true);
  });

  it("raw goes through the context's redact hook", () => {
    const order = parseOrder(first(), { redact: (raw) => ({ ...raw, uid: "***" }) });
    expect(order.raw["uid"]).toBe("***");
    expect(order.raw["norenordno"]).toBe("26062000004241");
  });

  it("a record that is not a JSON object fails", () => {
    expect(() => parseOrder("nope")).toThrow(ResponseParseError);
    expect(() => parseOrder([])).toThrow(ResponseParseError);
    expect(() => parseOrder(null)).toThrow(/expected a JSON object/);
  });
});

describe("strict (non-lenient) models", () => {
  it("a failing field fails the whole record", () => {
    const body = fixture("limits_success.json") as Record<string, unknown>;
    expect(() => parseLimits({ ...body, cash: "not-a-number" })).toThrow(ResponseParseError);
  });

  it("a missing required field fails the record", () => {
    expect(() => parseAccessToken({ issued_at: new Date(), expires_at: new Date() })).toThrow(
      ResponseParseError,
    );
  });
});

describe("nested models", () => {
  it("parse lists of nested records, each with its own raw", () => {
    const holding = parseHolding(asArray(fixture("holdings_success.json"))[0]);
    const instrument = holding.instruments?.[0];
    expect(instrument?.tradingsymbol).toBe("TESTCO-EQ");
    expect(instrument?.raw["token"]).toBe("1001");
    expect(Object.isFrozen(holding.instruments)).toBe(true);
  });

  it("a failing nested record nulls the field of a lenient model", () => {
    const wire = asArray(fixture("holdings_success.json"))[0] as Record<string, unknown>;
    const holding = parseHolding({ ...wire, exch_tsym: [{ pp: "x.y" }] });
    expect(holding.instruments).toBeNull();
  });
});

describe("AccessToken secrets", () => {
  const token = (): ReturnType<typeof parseAccessToken> => {
    const record = withTokenTimes(fixture("gen_acs_tok_success.json"))[0];
    return parseAccessToken({ ...(record as object), susertoken: "synthetic-susertoken" });
  };

  it("prints *** through String() and JSON.stringify", () => {
    const t = token();
    expect(t.susertoken).toBeInstanceOf(Secret);
    expect(String(t.susertoken)).toBe("***");
    expect(JSON.stringify(t.susertoken)).toBe('"***"');
    expect(JSON.stringify({ t: t.accessToken })).not.toContain("test-access-token");
    expect(inspect(t.accessToken)).toBe("***");
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- the point of the check
    expect(`${t.accessToken}`).toBe("***");
  });

  it("reveal() returns the value", () => {
    const t = token();
    expect(t.accessToken.reveal()).toBe("test-access-token");
    expect(t.susertoken?.reveal()).toBe("synthetic-susertoken");
  });

  it("required datetime fields come back as Dates", () => {
    expect(token().issuedAt).toBeInstanceOf(Date);
  });
});

describe("stream messages", () => {
  it("StreamPrice maps the ATO sentinel to null and defaults t", () => {
    const parse = STREAM_MESSAGE_PARSERS["tf"];
    const tick = parse?.({ t: "tf", e: "NSE", tk: "22", lp: "42949672.95" }) as {
      lastPrice: unknown;
    };
    expect(tick.lastPrice).toBeNull();
  });
});
