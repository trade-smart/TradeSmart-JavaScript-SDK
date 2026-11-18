import { describe, expect, it } from "vitest";
import { black76, blackScholes, type OptionSide } from "../../src/greeks/index.js";
import { expectClose, numberOf, toleranceOf, type VectorValue } from "./greeks-helpers.js";
import { loadVector } from "./vectors.js";

interface Input {
  model: string;
  option_type: string;
  underlying: VectorValue;
  strike: VectorValue;
  years: VectorValue;
  rate: VectorValue;
  volatility: VectorValue;
  dividend_yield?: VectorValue;
}

const FIELDS = ["price", "iv", "delta", "gamma", "theta", "vega", "rho"] as const;

describe("greeks_prices.json", () => {
  const vector = loadVector("greeks_prices.json");
  it("has cases", () => {
    expect(vector.cases.length).toBeGreaterThan(0);
  });
  const tol = toleranceOf(vector.tolerance, { abs: 0, rel: 0 });
  for (const c of vector.cases) {
    it(c.name, () => {
      const i = c.input as Input;
      const expected = c.expected as Record<string, VectorValue>;
      const run = () => {
        const args = [
          numberOf(i.underlying),
          numberOf(i.strike),
          numberOf(i.years),
          numberOf(i.rate),
          numberOf(i.volatility),
          i.option_type as OptionSide,
        ] as const;
        return i.model === "bsm"
          ? blackScholes(...args, {
              dividendYield: i.dividend_yield === undefined ? 0 : numberOf(i.dividend_yield),
            })
          : black76(...args);
      };
      if (expected["error"] !== undefined) {
        expect(run).toThrow(RangeError);
        return;
      }
      const got = run();
      for (const f of FIELDS) expectClose(got[f], expected[f], tol, f);
      expect(got.status).toBe(expected["status"]);
      expectClose(got.yearsToExpiry, expected["years_to_expiry"], tol, "yearsToExpiry");
    });
  }
});
