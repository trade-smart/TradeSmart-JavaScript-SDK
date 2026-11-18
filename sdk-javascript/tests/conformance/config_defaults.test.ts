import { describe, expect, it } from "vitest";
import { ClientConfig, type ClientConfigInit } from "../../src/config.js";
import { ConfigurationError } from "../../src/errors.js";
import { JsonNumber } from "../../src/lib/json.js";
import { noopLogger } from "../../src/lib/log.js";
import { VERSION } from "../../src/version.js";
import { INEXPRESSIBLE, inexpressibleReason, skipInexpressible } from "./skips.js";
import { loadVector } from "./vectors.js";

const FILE = "config_defaults.json";
const vector = loadVector(FILE);

interface ConfigCase {
  name: string;
  input: { fields: string[] | null; overrides: Record<string, unknown> };
  expected: Record<string, unknown>;
}
const cases = vector.cases as unknown as ConfigCase[];

const INTEGER_SETTINGS = new Set([
  "max_retries",
  "max_connections",
  "max_keepalive_connections",
  "stream_backlog_limit",
  "script_master_recheck_minutes",
  "reconnect_max_attempts",
  "order_rate_limit_per_second",
  "order_rate_limit_per_minute",
]);

function camel(name: string): string {
  return name.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** Vector value to a JavaScript value: numbers from their text, non-finite strings to numbers. */
function toValue(v: unknown): unknown {
  if (v instanceof JsonNumber) return Number(v.text);
  if (v === "NaN") return Number.NaN;
  if (v === "Infinity") return Number.POSITIVE_INFINITY;
  if (v === "-Infinity") return Number.NEGATIVE_INFINITY;
  return v;
}

/** An integral float (`2.0`) given for an integer setting: JavaScript cannot tell it from `2`. */
function isIntegralFloatForInteger(overrides: Record<string, unknown>): boolean {
  return Object.entries(overrides).some(
    ([key, v]) =>
      INTEGER_SETTINGS.has(key) &&
      v instanceof JsonNumber &&
      v.text.includes(".") &&
      Number.isInteger(Number(v.text)),
  );
}

/**
 * Python's words in the vector's messages mapped to JavaScript's (sdk-behaviour 12):
 * `True or False` to `true or false`, `None` to `null`.
 */
function jsMessage(message: string): string {
  return message.replace("True or False", "true or false").replace(/\bNone\b/g, "null");
}

function init(overrides: Record<string, unknown>): ClientConfigInit {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(overrides)) out[camel(key)] = toValue(v);
  return out;
}

describe("config_defaults.json", () => {
  it("lists exactly the cases that give an integral float to an integer setting", () => {
    const detected = cases
      .filter((c) => isIntegralFloatForInteger(c.input.overrides))
      .map((c) => `${FILE}:${c.name}`)
      .sort();
    const listed = Object.keys(INEXPRESSIBLE)
      .filter((k) => k.startsWith(`${FILE}:`))
      .sort();
    expect(listed).toEqual(detected);
    for (const reason of Object.values(INEXPRESSIBLE)) {
      expect(reason).toBe("JavaScript cannot tell 2.0 from 2");
    }
  });

  it("refuses to skip a case that is not listed", () => {
    expect(() => {
      skipInexpressible(FILE, "defaults");
    }).toThrow();
  });

  for (const c of cases) {
    it(c.name, (ctx) => {
      if (isIntegralFloatForInteger(c.input.overrides)) {
        skipInexpressible(FILE, c.name);
        ctx.skip();
        return;
      }
      expect(inexpressibleReason(FILE, c.name)).toBeUndefined();
      const overrides = init(c.input.overrides);
      const expected = c.expected;
      if (typeof expected["error"] === "string") {
        expect(expected["error"]).toBe("ConfigurationError");
        const message = jsMessage(expected["message"] as string);
        let thrown: unknown;
        try {
          ClientConfig.create(overrides);
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(ConfigurationError);
        expect((thrown as ConfigurationError).message).toBe(message);
        return;
      }
      const config = ClientConfig.create(overrides) as unknown as Record<string, unknown>;
      const fields = c.input.fields ?? Object.keys(expected);
      expect(fields.length).toBeGreaterThan(0);
      for (const field of fields) {
        let want = toValue(expected[field]);
        // The vector's default user agent is the Python SDK's; this SDK substitutes its own.
        if (want === "tradesmart-python/<version>") want = `tradesmart-javascript/${VERSION}`;
        expect(config[camel(field)], field).toEqual(want);
      }
    });
  }
});

describe("ClientConfig", () => {
  it("rejects more than 10 orders per second without an algo id", () => {
    expect(() => ClientConfig.create({ orderRateLimitPerSecond: 11 })).toThrow(
      new ConfigurationError(
        "order_rate_limit_per_second above 10 needs algo_id (TradeSmart requires an algo ID for more than 10 orders per second)",
      ),
    );
  });

  it("is frozen", () => {
    expect(Object.isFrozen(ClientConfig.create())).toBe(true);
  });

  it("defaults the logger to the no-op logger and keeps a given one", () => {
    expect(ClientConfig.create().logger).toBe(noopLogger);
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    expect(ClientConfig.create({ logger }).logger).toBe(logger);
  });

  it("treats undefined as not given", () => {
    expect(ClientConfig.create({ maxRetries: undefined }).maxRetries).toBe(2);
  });

  it("rejects a setting name it does not know", () => {
    expect(() => ClientConfig.create({ maxRetry: 3 } as unknown as ClientConfigInit)).toThrow(
      ConfigurationError,
    );
  });
});
