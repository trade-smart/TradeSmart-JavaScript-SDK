import { describe, expect, expectTypeOf, it } from "vitest";
import type { SlicedOrderResult } from "../../src/models/generated/orders.js";
import {
  APIError,
  AuthenticationError,
  ConfigurationError,
  NetworkError,
  NotFoundError,
  OrderRejectedError,
  OrderStatusUnknownError,
  RateLimitError,
  RequestTimeoutError,
  RequestValidationError,
  ResponseParseError,
  ServerError,
  SubscriptionLimitError,
  TradeSmartError,
  TransportError,
} from "../../src/errors.js";

const api = { endpoint: "PlaceOrder", httpStatus: 401 };

describe("error taxonomy (sdk-behaviour 4.1)", () => {
  it("AuthenticationError is an APIError and a TradeSmartError with its own name", () => {
    const error = new AuthenticationError("bad token", api);
    expect(error).toBeInstanceOf(APIError);
    expect(error).toBeInstanceOf(TradeSmartError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AuthenticationError");
    expect(error.endpoint).toBe("PlaceOrder");
    expect(error.httpStatus).toBe(401);
  });

  it("every class keeps its parent and sets name to its class name", () => {
    const cases: [Error, abstract new (...args: never[]) => Error, string][] = [
      [new TradeSmartError("x"), TradeSmartError, "TradeSmartError"],
      [new ConfigurationError("x"), TradeSmartError, "ConfigurationError"],
      [new SubscriptionLimitError("x"), TradeSmartError, "SubscriptionLimitError"],
      [new TransportError("x"), TradeSmartError, "TransportError"],
      [new NetworkError("x"), TransportError, "NetworkError"],
      [new RequestTimeoutError("x"), TransportError, "RequestTimeoutError"],
      [
        new OrderStatusUnknownError("PlaceOrder", "timeout"),
        TradeSmartError,
        "OrderStatusUnknownError",
      ],
      [new APIError("x", api), TradeSmartError, "APIError"],
      [new RateLimitError("x", api), APIError, "RateLimitError"],
      [new NotFoundError("x", api), APIError, "NotFoundError"],
      [new ServerError("x", api), APIError, "ServerError"],
      [new OrderRejectedError("x", api), APIError, "OrderRejectedError"],
      [new RequestValidationError([]), TradeSmartError, "RequestValidationError"],
      [
        new ResponseParseError("x", { endpoint: "E", httpStatus: null, body: "" }),
        TradeSmartError,
        "ResponseParseError",
      ],
    ];
    for (const [error, parent, name] of cases) {
      expect(error).toBeInstanceOf(parent);
      expect(error.name).toBe(name);
    }
  });

  it("APIError keeps emsg, requestTime and a redacted raw", () => {
    const error = new APIError("x", {
      ...api,
      emsg: "Session expired",
      requestTime: "10:00:00 01-01-2026",
      raw: { stat: "Not_Ok", access_token: "secret-value", nested: { Checksum: "c" } },
    });
    expect(error.emsg).toBe("Session expired");
    expect(error.requestTime).toBe("10:00:00 01-01-2026");
    expect(JSON.stringify(error.raw)).not.toContain("secret-value");
    expect(error.raw).toEqual({
      stat: "Not_Ok",
      access_token: "***",
      nested: { Checksum: "***" },
    });
  });

  it("APIError defaults are null", () => {
    const error = new APIError("x", { endpoint: "E", httpStatus: null });
    expect(error.emsg).toBeNull();
    expect(error.requestTime).toBeNull();
    expect(error.raw).toBeNull();
  });

  it("RateLimitError carries retryAfter, default null", () => {
    expect(new RateLimitError("x", api).retryAfter).toBeNull();
    expect(new RateLimitError("x", { ...api, retryAfter: 2.5 }).retryAfter).toBe(2.5);
  });

  it("RequestValidationError lists wire keys, never values", () => {
    const error = new RequestValidationError([
      { type: "greater_than_equal", loc: ["qty"], msg: "must be at least 1" },
    ]);
    expect(error.message.startsWith("Invalid request parameters: ")).toBe(true);
    expect(error.message).toContain("qty");
    expect(error.errors).toHaveLength(1);
    expect(error.errors[0]?.loc).toEqual(["qty"]);
    expect(Object.isFrozen(error.errors)).toBe(true);
  });

  it("RequestValidationError names a cross-field rule by its message", () => {
    const error = new RequestValidationError([
      { type: "value_error", loc: [], msg: "MTF is not offered for MCX" },
    ]);
    expect(error.message).toBe("Invalid request parameters: MTF is not offered for MCX");
  });

  it("OrderStatusUnknownError redacts and truncates the body", () => {
    const error = new OrderStatusUnknownError("PlaceOrder", "timed out", {
      httpStatus: 502,
      body: `{"susertoken": "abc"}${"x".repeat(3000)}`,
    });
    expect(error.endpoint).toBe("PlaceOrder");
    expect(error.httpStatus).toBe(502);
    expect(error.body).not.toContain("abc");
    expect(error.body?.length).toBe(2000);
    expect(error.slicedResult).toBeNull();
    expect(error.message).toContain("PlaceOrder");
    expect(error.message).toContain("timed out");
    expect(new OrderStatusUnknownError("E", "m").body).toBeNull();
    expect(new OrderStatusUnknownError("E", "m").httpStatus).toBeNull();
  });

  it("ResponseParseError keeps a redacted, truncated body", () => {
    const error = new ResponseParseError("not JSON", {
      endpoint: "GetLimits",
      httpStatus: 200,
      body: "Authorization: Bearer abc.def",
    });
    expect(error.body).toContain("***");
    expect(error.body).not.toContain("abc.def");
    expect(error.endpoint).toBe("GetLimits");
    expect(error.httpStatus).toBe(200);
    expect(error.fields).toEqual([]);
    expect(error.protectedKey).toBe(false);
  });

  it("slicedResult has the generated SlicedOrderResult shape", () => {
    const error = new OrderStatusUnknownError("PlaceOrder", "timeout");
    expectTypeOf(error.slicedResult).toEqualTypeOf<SlicedOrderResult | null>();
    expectTypeOf<SlicedOrderResult["orderIds"]>().not.toBeUnknown();
    expectTypeOf<SlicedOrderResult["complete"]>().toEqualTypeOf<boolean>();
  });

  it("errors do not chain a cause", () => {
    expect(new AuthenticationError("x", api).cause).toBeUndefined();
  });
});
