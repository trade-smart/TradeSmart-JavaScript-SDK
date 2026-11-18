import { describe, expect, it } from "vitest";
import { carryAdjustedForward, optionForward } from "../../src/lib/option-contracts.js";
import { expectClose, numberOf, toleranceOf, type VectorValue } from "./greeks-helpers.js";
import { loadVector } from "./vectors.js";

interface Input {
  function: "carry_adjusted_forward" | "option_forward";
  future_price: VectorValue;
  rate: VectorValue;
  dividend_yield?: VectorValue;
  future_years?: VectorValue;
  option_years?: VectorValue;
  exchange?: string;
  expiry_time?: string | null;
  future_expiry?: string;
  option_expiry?: string;
  now?: string;
}

describe("carry_forward.json", () => {
  const vector = loadVector("carry_forward.json");
  it("has cases", () => {
    expect(vector.cases.length).toBeGreaterThan(0);
  });
  const tol = toleranceOf(vector.tolerance, { abs: 0, rel: 0 });
  for (const c of vector.cases) {
    it(c.name, () => {
      const i = c.input as Input;
      const expected = c.expected as Record<string, VectorValue | boolean>;
      const q = i.dividend_yield === undefined ? undefined : numberOf(i.dividend_yield);
      const carry = (): number =>
        carryAdjustedForward(
          numberOf(i.future_price),
          numberOf(i.rate),
          numberOf(i.future_years as VectorValue),
          numberOf(i.option_years as VectorValue),
          q,
        );
      const forwardOf = (): ReturnType<typeof optionForward> =>
        optionForward({
          exchange: i.exchange as string,
          optionExpiry: i.option_expiry as string,
          futureExpiry: i.future_expiry as string,
          futurePrice: numberOf(i.future_price),
          rate: numberOf(i.rate),
          now: new Date(i.now as string),
          expiryTime: i.expiry_time ?? undefined,
          dividendYield: q,
        });
      const run = i.function === "carry_adjusted_forward" ? carry : forwardOf;
      if (expected["error"] !== undefined) {
        // The reference's ValueError is a RangeError here (§10.3 "Rate and yield range").
        expect(run).toThrow(RangeError);
        expect(run).toThrow(/^rate - dividendYield is out of range: /);
        return;
      }
      if (i.function === "carry_adjusted_forward") {
        expectClose(carry(), expected["forward"] as VectorValue, tol, "forward");
        return;
      }
      const got = forwardOf();
      expectClose(got.forward, expected["forward"] as VectorValue, tol, "forward");
      expect(got.sameExpiryFuture).toBe(expected["same_expiry_future"]);
    });
  }

  it("a huge finite rate that overflows the carry factor is a RangeError", () => {
    expect(() => carryAdjustedForward(100, -1e6, 1, 0)).toThrow(RangeError);
  });
});
