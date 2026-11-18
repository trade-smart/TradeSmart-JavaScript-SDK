import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { maxPain } from "../../src/analytics/index.js";
import { toRows, type VectorRow } from "./analytics-helpers.js";
import { loadVector } from "./vectors.js";

interface Input {
  rows: VectorRow[];
}

describe("max_pain.json", () => {
  const vector = loadVector("max_pain.json");
  it("has cases", () => {
    expect(vector.cases.length).toBeGreaterThan(0);
  });
  for (const c of vector.cases) {
    it(c.name, () => {
      const i = c.input as Input;
      const expected = (c.expected as { max_pain: null | { strike: string; payouts: object } })
        .max_pain;
      const got = maxPain({ rows: toRows(i.rows) });
      if (expected === null) {
        expect(got).toBeNull();
        return;
      }
      expect(got).not.toBeNull();
      const result = got as NonNullable<typeof got>;
      expect(result.strike.equals(new Decimal(expected.strike))).toBe(true);
      const want = Object.entries(expected.payouts as Record<string, string>);
      expect(result.payouts.size).toBe(want.length);
      for (const [strike, payout] of want) {
        // Keys are compared as decimals: find the entry whose key equals the expected strike.
        const entry = [...result.payouts].find(([k]) => new Decimal(k).equals(new Decimal(strike)));
        expect(entry, `payout for ${strike}`).toBeDefined();
        expect((entry as [string, Decimal])[1].equals(new Decimal(payout))).toBe(true);
      }
    });
  }
});
