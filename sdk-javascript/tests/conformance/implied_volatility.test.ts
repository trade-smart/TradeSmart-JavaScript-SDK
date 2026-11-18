import { describe, expect, it } from "vitest";
import {
  black76,
  blackScholes,
  impliedVolatility,
  type OptionSide,
  type PricingModel,
} from "../../src/greeks/index.js";
import { expectClose, numberOf, toleranceOf, type VectorValue } from "./greeks-helpers.js";
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
}

describe("implied_volatility.json", () => {
  const vector = loadVector("implied_volatility.json");
  it("has cases", () => {
    expect(vector.cases.length).toBeGreaterThan(0);
  });
  const tol = toleranceOf(vector.tolerance, { abs: 1e-6, rel: 0 });
  for (const c of vector.cases) {
    it(c.name, () => {
      const i = c.input as Input;
      const expected = c.expected as Record<string, VectorValue>;
      const dividendYield = i.dividend_yield === undefined ? 0 : numberOf(i.dividend_yield);
      const model = i.model as PricingModel;
      const run = (): number | null =>
        impliedVolatility(
          numberOf(i.option_price),
          numberOf(i.underlying),
          numberOf(i.strike),
          numberOf(i.years),
          numberOf(i.rate),
          i.option_type as OptionSide,
          { model, dividendYield },
        );
      if (expected["error"] !== undefined) {
        expect(run).toThrow(RangeError);
        return;
      }
      const iv = run();
      expectClose(iv, expected["iv"], tol, "iv");
      if (iv !== null) {
        // Re-pricing at the returned IV reproduces the input price within 1e-8.
        const args = [
          numberOf(i.underlying),
          numberOf(i.strike),
          numberOf(i.years),
          numberOf(i.rate),
          iv,
          i.option_type as OptionSide,
        ] as const;
        const priced =
          model === "bsm" ? blackScholes(...args, { dividendYield }) : black76(...args);
        expect(Math.abs((priced.price as number) - numberOf(i.option_price))).toBeLessThanOrEqual(
          1e-8,
        );
      }
    });
  }
});
