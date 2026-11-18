// specifications/test-fixtures/errors.json through the response classifier (sdk-behaviour.md §4.2).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyResponse } from "../../src/lib/classify.js";
import { APIError, AuthenticationError, OrderRejectedError } from "../../src/errors.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../specifications/test-fixtures",
);
const raw = JSON.parse(readFileSync(path.join(FIXTURES, "errors.json"), "utf8")) as Record<
  string,
  unknown
>;
const text = (key: string): string => JSON.stringify(raw[key]);

const base = {
  endpoint: "Limits",
  httpStatus: 200,
  stateChanging: false,
  expect: "object",
  allowEmpty: false,
} as const;

describe("errors.json", () => {
  it("has the five documented failure examples", () => {
    expect(Object.keys(raw).sort()).toEqual([
      "invalid_token",
      "no_data",
      "order_reject",
      "search_no_data",
      "session_expired",
    ]);
  });

  it("invalid_token and session_expired are authentication errors", () => {
    expect(() => classifyResponse({ ...base, bodyText: text("invalid_token") })).toThrow(
      AuthenticationError,
    );
    expect(() => classifyResponse({ ...base, bodyText: text("session_expired") })).toThrow(
      AuthenticationError,
    );
  });

  it("no_data is an empty list on a list endpoint that allows it, else a plain APIError", () => {
    expect(
      classifyResponse({
        ...base,
        endpoint: "OrderBook",
        expect: "list",
        allowEmpty: true,
        bodyText: text("no_data"),
      }),
    ).toEqual({ kind: "empty" });
    expect(() => classifyResponse({ ...base, bodyText: text("no_data") })).toThrow(APIError);
  });

  it("search_no_data is an empty result on SearchScrip", () => {
    expect(
      classifyResponse({
        ...base,
        endpoint: "SearchScrip",
        allowEmpty: true,
        bodyText: text("search_no_data"),
      }),
    ).toEqual({ kind: "empty" });
  });

  it("order_reject on a state-changing call is OrderRejectedError", () => {
    expect(() =>
      classifyResponse({
        ...base,
        endpoint: "CancelOrder",
        stateChanging: true,
        bodyText: text("order_reject"),
      }),
    ).toThrow(OrderRejectedError);
  });
});
