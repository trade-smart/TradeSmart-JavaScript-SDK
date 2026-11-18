import { describe, expect, it } from "vitest";
import { greeksFromPrice, type OptionSide, type PricingModel } from "../../src/greeks/index.js";
import {
  expectClose,
  nullableNumberOf,
  numberOf,
  toleranceOf,
  type VectorValue,
} from "./greeks-helpers.js";
import { loadVector } from "./vectors.js";

interface Input {
  model: string;
  option_type: string;
  option_price: VectorValue;
  underlying: VectorValue;
  strike: VectorValue;
  years: VectorValue;
  rate: VectorValue;
  dividend_yield?: VectorValue;
  tick_size?: VectorValue;
}

const FIELDS = ["price", "iv", "delta", "gamma", "theta", "vega", "rho"] as const;

describe("greeks_edge_cases.json", () => {
  const vector = loadVector("greeks_edge_cases.json");
  it("has cases", () => {
    expect(vector.cases.length).toBeGreaterThan(0);
  });
  const tol = toleranceOf(vector.tolerance, { abs: 0, rel: 0 });
  for (const c of vector.cases) {
    it(c.name, () => {
      const i = c.input as Input;
      const expected = c.expected as Record<string, VectorValue>;
      const run = () =>
        greeksFromPrice(
          nullableNumberOf(i.option_price),
          nullableNumberOf(i.underlying),
          numberOf(i.strike),
          numberOf(i.years),
          numberOf(i.rate),
          i.option_type as OptionSide,
          {
            model: i.model as PricingModel,
            dividendYield: i.dividend_yield === undefined ? 0 : numberOf(i.dividend_yield),
            tickSize: i.tick_size === undefined ? 0 : numberOf(i.tick_size),
          },
        );
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
