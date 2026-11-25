import { describe, expect, it } from "vitest";
import { classifyResponse } from "../../src/lib/classify.js";
import {
  APIError,
  AuthenticationError,
  NotFoundError,
  OrderRejectedError,
  OrderStatusUnknownError,
  RateLimitError,
  ResponseParseError,
  ServerError,
} from "../../src/errors.js";

type Args = Parameters<typeof classifyResponse>[0];

function run(over: Partial<Args> & { bodyText: string }): ReturnType<typeof classifyResponse> {
  return classifyResponse({
    endpoint: "Limits",
    httpStatus: 200,
    stateChanging: false,
    expect: "object",
    allowEmpty: false,
    ...over,
  });
}

function fail(over: Partial<Args> & { bodyText: string }): Error {
  try {
    run(over);
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected an error");
}

/** The error `fail` returns, checked with `instanceof` (no cast): another class fails the test. */
function failAs<T extends Error>(
  type: abstract new (...args: never[]) => T,
  over: Partial<Args> & { bodyText: string },
): T {
  const error = fail(over);
  if (!(error instanceof type)) throw new Error(`expected ${type.name}, got ${error.name}`);
  return error;
}

const GTT = { endpoint: "PlaceGTTOrder", stateChanging: true } as const;

describe("classifyResponse extras", () => {
  it("returns the parsed object with numbers kept as text (row 8)", () => {
    const result = run({ bodyText: '{"stat":"Ok","x":12345678901234567890.50}' });
    expect(result.kind).toBe("ok");
    expect(JSON.stringify(result)).toContain("12345678901234567890.50");
  });

  it("a bare empty array is returned as an array, Not_Ok no data is the empty kind", () => {
    expect(run({ bodyText: "[]", expect: "list", allowEmpty: true })).toEqual({
      kind: "ok",
      body: [],
    });
    expect(
      run({
        bodyText: '{"stat":"Not_Ok","emsg":"No Data"}',
        expect: "list",
        allowEmpty: true,
        httpStatus: 401,
      }),
    ).toEqual({ kind: "empty" });
  });

  it("no data is an error where the endpoint does not allow empty", () => {
    expect(fail({ bodyText: '{"stat":"Not_Ok","emsg":"no data"}' })).toBeInstanceOf(APIError);
  });

  it("a 429 carries retryAfter on every RateLimitError path", () => {
    for (const bodyText of ['{"stat":"Not_Ok","emsg":"slow"}', "not json", "[1]", '"x"']) {
      const error = failAs(RateLimitError, { bodyText, httpStatus: 429, retryAfter: 3 });
      expect(error).toBeInstanceOf(RateLimitError);
      expect(error.retryAfter).toBe(3);
    }
    const none = failAs(RateLimitError, { bodyText: '{"stat":"Not_Ok"}', httpStatus: 429 });
    expect(none.retryAfter).toBeNull();
  });

  it("an emsg secret never reaches the message or the emsg attribute", () => {
    const error = failAs(APIError, {
      bodyText: '{"stat":"Not_Ok","emsg":"bad Bearer abc123secret and password=hunter2"}',
    });
    expect(error.message).not.toContain("abc123secret");
    expect(error.message).not.toContain("hunter2");
    expect(error.emsg).not.toContain("hunter2");
  });

  it("an unknown-outcome body is redacted and the message holds no server text", () => {
    const error = failAs(OrderStatusUnknownError, {
      endpoint: "PlaceOrder",
      stateChanging: true,
      bodyText: '{"stat":"Weird","susertoken":"tok123","emsg":"secret words"}',
    });
    expect(error).toBeInstanceOf(OrderStatusUnknownError);
    expect(error.body).not.toContain("tok123");
    expect(error.message).not.toContain("secret words");
    expect(error.message).toContain("orders()");
  });

  it("a GTT unknown outcome points to pending_gtts()", () => {
    const error = fail({ ...GTT, bodyText: "<html>", httpStatus: 502 });
    expect(error).toBeInstanceOf(OrderStatusUnknownError);
    expect(error.message).toContain("pending_gtts()");
  });

  it("the GTT success needs a non-blank string al_id; case is ignored", () => {
    expect(run({ ...GTT, bodyText: '{"stat":"OI CREATED","al_id":"7"}' }).kind).toBe("ok");
    for (const alId of ['"\\u00a0"', '"\\u001c"', '"\\u0085"', "7", "null", '""']) {
      expect(fail({ ...GTT, bodyText: `{"stat":"Oi created","al_id":${alId}}` })).toBeInstanceOf(
        OrderStatusUnknownError,
      );
    }
  });

  it("blank follows Python whitespace: a BOM is not whitespace", () => {
    expect(run({ ...GTT, bodyText: '{"stat":"Oi created","al_id":"\\ufeff"}' }).kind).toBe("ok");
  });

  it("a GTT success with a non-blank or non-string emsg is unknown", () => {
    for (const emsg of ['"x"', "1", "true", "[]"]) {
      expect(
        fail({ ...GTT, bodyText: `{"stat":"Oi created","al_id":"7","emsg":${emsg}}` }),
      ).toBeInstanceOf(OrderStatusUnknownError);
    }
    expect(run({ ...GTT, bodyText: '{"stat":"Oi created","al_id":"7","emsg":null}' }).kind).toBe(
      "ok",
    );
  });

  it("any array on a GTT or iceberg write is unknown, even with expect list", () => {
    for (const endpoint of ["PlaceGTTOrder", "PlaceIceBergOrder"]) {
      expect(
        fail({ endpoint, stateChanging: true, expect: "list", bodyText: "[]", allowEmpty: true }),
      ).toBeInstanceOf(OrderStatusUnknownError);
    }
  });

  it("iceberg false: reason from rejreason, else emsg; definite on every status", () => {
    const rejected = failAs(OrderRejectedError, {
      endpoint: "PlaceIceBergOrder",
      stateChanging: true,
      bodyText: '{"stat":"false","rejreason":"too small","emsg":"other"}',
      httpStatus: 500,
    });
    expect(rejected).toBeInstanceOf(OrderRejectedError);
    expect(rejected.emsg).toBe("too small");
    expect(rejected.message).toBe("PlaceIceBergOrder failed: too small");
    const fallback = failAs(APIError, {
      endpoint: "CancelIceBergOrder",
      stateChanging: true,
      bodyText: '{"stat":"false","rejreason":" ","emsg":"other"}',
    });
    expect(fallback.emsg).toBe("other");
    expect(
      fail({
        endpoint: "ModifyIceBergOrder",
        stateChanging: true,
        bodyText: '{"stat":"false"}',
        httpStatus: 404,
      }),
    ).toBeInstanceOf(NotFoundError);
  });

  it("a GTT write ignores 'no data' (rows 11-16 apply)", () => {
    expect(
      fail({
        endpoint: "CancelGTTOrder",
        stateChanging: true,
        allowEmpty: true,
        bodyText: '{"stat":"Not_Ok","emsg":"no data"}',
      }),
    ).toBeInstanceOf(OrderRejectedError);
  });

  it("session-expired text matches like Python's case-insensitive search", () => {
    for (const emsg of ["SESSION EXPIRED", "x Invalid Access Token y", "ınvalid sessıon"]) {
      expect(fail({ bodyText: JSON.stringify({ stat: "Not_Ok", emsg }) })).toBeInstanceOf(
        AuthenticationError,
      );
    }
  });

  it("status classes: 5xx Not_Ok is ServerError on a read, rejected on a write", () => {
    expect(fail({ bodyText: '{"stat":"Not_Ok"}', httpStatus: 503 })).toBeInstanceOf(ServerError);
    expect(
      fail({ bodyText: '{"stat":"Not_Ok"}', httpStatus: 503, stateChanging: true }),
    ).toBeInstanceOf(OrderRejectedError);
  });

  it("a non-JSON read: status class, else ResponseParseError (a 3xx is no class)", () => {
    expect(fail({ bodyText: "x", httpStatus: 503 })).toBeInstanceOf(ServerError);
    expect(fail({ bodyText: "x", httpStatus: 302 })).toBeInstanceOf(ResponseParseError);
    expect(fail({ bodyText: "x", httpStatus: 404 })).toBeInstanceOf(ResponseParseError);
  });

  it("a body nested too deeply keeps its classification and never shows the payload", () => {
    const deep = `${"[".repeat(5000)}${"]".repeat(5000)}`;
    const error = fail({ endpoint: "PlaceOrder", stateChanging: true, bodyText: deep });
    expect(error).toBeInstanceOf(OrderStatusUnknownError);
    const secret = `{"a":${deep},"susertoken":"tok999"}`;
    const error2 = fail({ endpoint: "PlaceOrder", stateChanging: true, bodyText: secret });
    expect(JSON.stringify(error2)).not.toContain("tok999");
  });
});
