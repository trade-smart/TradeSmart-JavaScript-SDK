import { describe, expect, it } from "vitest";
import { ClientConfig } from "../../src/config.js";
import {
  APIError,
  AuthenticationError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  RequestTimeoutError,
  ResponseParseError,
  ServerError,
} from "../../src/errors.js";
import { RetryPolicy, retryAfterForStatus, retryDelays } from "../../src/lib/retry.js";
import { JsonNumber } from "../../src/lib/json.js";
import { loadVector } from "./vectors.js";

const ABS = 1e-12;

function num(v: unknown): number {
  if (v instanceof JsonNumber) return Number(v.text);
  if (v === "NaN") return NaN;
  if (v === "Infinity") return Infinity;
  if (v === "-Infinity") return -Infinity;
  throw new Error(`unexpected value ${String(v)}`);
}

const api = { endpoint: "Limits", httpStatus: null };
const ERRORS: Record<string, () => Error> = {
  APIError: () => new APIError("x", api),
  AuthenticationError: () => new AuthenticationError("x", api),
  NetworkError: () => new NetworkError("x"),
  NotFoundError: () => new NotFoundError("x", api),
  RateLimitError: () => new RateLimitError("x", api),
  RequestTimeoutError: () => new RequestTimeoutError("x"),
  ResponseParseError: () =>
    new ResponseParseError("x", { endpoint: "Limits", httpStatus: 200, body: "" }),
  ServerError: () => new ServerError("x", api),
};

interface Input {
  function: "delay" | "should_retry" | "retry_after_header";
  attempt?: JsonNumber;
  base?: JsonNumber;
  cap?: JsonNumber;
  retry_after?: unknown;
  error?: string;
  max_retries?: JsonNumber;
  state_changing?: boolean;
  header?: string | null;
  http_status?: JsonNumber;
}
interface Expected {
  min?: JsonNumber;
  max?: JsonNumber;
  retry?: boolean;
  retry_after?: JsonNumber | null;
}

describe("retry_schedule.json", () => {
  for (const c of loadVector("retry_schedule.json").cases) {
    const input = c.input as Input;
    const expected = c.expected as Expected;
    it(c.name, () => {
      if (input.function === "delay") {
        const mk = (u: number) =>
          new RetryPolicy({
            maxRetries: 2,
            base: num(input.base),
            cap: num(input.cap),
            rng: () => u,
          });
        const retryAfter = input.retry_after === null ? null : num(input.retry_after);
        const attempt = num(input.attempt);
        const lo = mk(0).delay(attempt, retryAfter);
        const hi = mk(1).delay(attempt, retryAfter); // the exclusive upper bound
        const mid = mk(0.999999).delay(attempt, retryAfter);
        expect(Math.abs(lo - num(expected.min))).toBeLessThanOrEqual(ABS);
        expect(Math.abs(hi - num(expected.max))).toBeLessThanOrEqual(ABS);
        expect(mid).toBeGreaterThanOrEqual(lo);
        expect(mid).toBeLessThanOrEqual(hi);
      } else if (input.function === "should_retry") {
        const policy = new RetryPolicy({ maxRetries: num(input.max_retries), base: 0.5, cap: 8 });
        const make = ERRORS[input.error as string];
        if (make === undefined) throw new Error(`unknown error ${String(input.error)}`);
        expect(policy.shouldRetry(num(input.attempt), make(), input.state_changing === true)).toBe(
          expected.retry,
        );
      } else {
        const got = retryAfterForStatus(num(input.http_status), input.header ?? null, new Date(0));
        expect(got).toBe(expected.retry_after === null ? null : num(expected.retry_after));
      }
    });
  }

  it("retryDelays lists the default delays of one call", () => {
    const cfg = ClientConfig.create({});
    expect(retryDelays(cfg, () => 0)).toEqual([0.25, 0.5]);
    expect(retryDelays(cfg, () => 1)).toEqual([0.5, 1]);
  });

  it("a non-Error value is never retried", () => {
    const policy = new RetryPolicy({ maxRetries: 2, base: 0.5, cap: 8 });
    expect(policy.shouldRetry(0, "boom", false)).toBe(false);
  });
});
