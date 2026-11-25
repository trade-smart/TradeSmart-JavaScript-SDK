// Pins the runtime exports of the `tradesmart` entry point, so an accidental export (an internal
// helper, the codec, the call path, a parse engine detail) fails the suite.
import { describe, expect, it } from "vitest";
import * as index from "../../src/index.js";

const PUBLIC_NAMES = [
  // client, stream, configuration
  "ClientConfig",
  "TradeSmart",
  "TradeSmartStream",
  "VERSION",
  // logging
  "isOco",
  "noopLogger",
  "ocoSides",
  // errors
  "APIError",
  "AuthenticationError",
  "ConfigurationError",
  "NetworkError",
  "NotFoundError",
  "OrderRejectedError",
  "OrderStatusUnknownError",
  "RateLimitError",
  "RequestTimeoutError",
  "RequestValidationError",
  "ResponseParseError",
  "ServerError",
  "SubscriptionLimitError",
  "TradeSmartError",
  "TransportError",
  // enums
  "Buildup",
  "Exchange",
  "GttAlertType",
  "GttValidity",
  "OrderStatus",
  "OrderType",
  "Product",
  "StreamState",
  "TransactionType",
  "Validity",
  // authorisation and helpers
  "AccessToken",
  "Decimal",
  "buildAuthorizeUrl",
  "computeChecksum",
  "istDate",
  "roundToTick",
];

describe("public surface", () => {
  it("exports exactly the pinned names", () => {
    expect(Object.keys(index).sort()).toEqual([...PUBLIC_NAMES].sort());
  });

  it("does not export internals", () => {
    const internals = [
      "fieldError",
      "classifyResponse",
      "encodeJData",
      "TPS_INTERVALS",
      "parseModel",
      "resolveEnum",
      "D",
      "Secret",
    ];
    for (const name of internals) expect(index, name).not.toHaveProperty(name);
  });

  it("tradesmart/greeks exports exactly the pinned names", async () => {
    const greeks = await import("../../src/greeks/index.js");
    expect(Object.keys(greeks).sort()).toEqual(
      [
        "DEFAULT_DIVIDEND_YIELD",
        "DEFAULT_RATE",
        "MIN_YEARS",
        "NEAR_EXPIRY_YEARS",
        "black76",
        "blackScholes",
        "greeksFromPrice",
        "impliedVolatility",
      ].sort(),
    );
    expect(greeks.DEFAULT_RATE).toBe(0.065);
    expect(greeks.DEFAULT_DIVIDEND_YIELD).toBe(0);
    expect(greeks.MIN_YEARS).toBe(1 / (365 * 24 * 60));
    expect(greeks.NEAR_EXPIRY_YEARS).toBe(30 / (365 * 24 * 60));
  });

  it("tradesmart/analytics exports exactly the pinned names", async () => {
    const analytics = await import("../../src/analytics/index.js");
    expect(Object.keys(analytics).sort()).toEqual(
      ["Buildup", "buildupFromSnapshot", "classifyBuildup", "maxPain", "pcr"].sort(),
    );
  });

  it("tradesmart/testing exports exactly the pinned names", async () => {
    const testing = await import("../../src/testing/index.js");
    expect(Object.keys(testing).sort()).toEqual(["OfflineBroker", "drills"]);
    expect(Object.keys(testing.drills).sort()).toEqual(
      [
        "badBody",
        "connectError",
        "rateLimit",
        "reject",
        "serverError",
        "sessionExpired",
        "timeoutAfterSend",
      ].sort(),
    );
  });

  it("tradesmart does not export the offline broker", () => {
    expect(index).not.toHaveProperty("OfflineBroker");
    expect(index).not.toHaveProperty("drills");
  });

  it("the re-exported Decimal is the decimal.js class", async () => {
    const { Decimal } = await import("decimal.js");
    expect(index.Decimal).toBe(Decimal);
  });
});

// Type-level pins: these names must stay exported as types (a rename fails `npm run typecheck`).
import type {
  BuildupReading,
  ChainRow,
  MaxPain,
  OptionChainSnapshot,
  OptionChainSnapshotOptions,
  OptionGreeks,
  OptionGreeksOptions,
} from "../../src/index.js";

describe("public result types", () => {
  it("are exported and the client has the three derived methods", () => {
    type Pinned = [
      BuildupReading,
      ChainRow,
      MaxPain,
      OptionChainSnapshot,
      OptionChainSnapshotOptions,
      OptionGreeks,
      OptionGreeksOptions,
    ];
    const names: Pinned extends unknown[] ? string[] : never = [
      "optionGreeks",
      "optionChainSnapshot",
      "buildup",
    ];
    for (const name of names) {
      expect(typeof (index.TradeSmart.prototype as unknown as Record<string, unknown>)[name]).toBe(
        "function",
      );
    }
  });
});
