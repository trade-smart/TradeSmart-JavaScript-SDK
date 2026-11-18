import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { pcr } from "../../src/analytics/index.js";
import { toRows, type VectorRow } from "./analytics-helpers.js";
import { loadVector } from "./vectors.js";

interface Input {
  by: "oi" | "volume";
  rows: VectorRow[];
}

describe("pcr.json", () => {
  const vector = loadVector("pcr.json");
  it("has cases", () => {
    expect(vector.cases.length).toBeGreaterThan(0);
  });
  for (const c of vector.cases) {
    it(c.name, () => {
      const i = c.input as Input;
      const expected = c.expected as Record<string, unknown>;
      const snapshot = { rows: toRows(i.rows) };
      if (expected["error"] !== undefined) {
        expect(() => pcr(snapshot, { by: i.by })).toThrow(RangeError);
        expect(() => pcr(snapshot, { by: i.by })).toThrow(/by must be 'oi' or 'volume', not /);
        return;
      }
      const got = pcr(snapshot, { by: i.by });
      if (expected["pcr"] === null) {
        expect(got).toBeNull();
        return;
      }
      expect(got).not.toBeNull();
      const diff = (got as Decimal).minus(new Decimal(expected["pcr"] as string)).abs();
      expect(diff.lte(new Decimal("1e-12"))).toBe(true);
    });
  }

  it("defaults to open interest", () => {
    const rows = toRows([
      { strike: "1", option_type: "CE", open_interest: "4", volume: "1" },
      { strike: "1", option_type: "PE", open_interest: "2", volume: "1" },
    ]);
    expect(pcr({ rows })?.toFixed()).toBe("0.5");
  });

  // A non-terminating ratio prints the digits Python's default context gives (28 significant
  // digits, half-even): the expected text was produced by the Python SDK's `pcr` in Docker.
  it.each([
    ["1", "3", "0.3333333333333333333333333333"],
    ["2", "3", "0.6666666666666666666666666667"],
    ["100", "7", "14.28571428571428571428571429"],
    ["12345", "98765", "0.1249936718473143320002025009"],
  ])("pcr %s over %s matches the Python SDK digit for digit", (puts, calls, expected) => {
    const rows = toRows([
      { strike: "1", option_type: "CE", open_interest: calls, volume: "1" },
      { strike: "1", option_type: "PE", open_interest: puts, volume: "1" },
    ]);
    expect(pcr({ rows })?.toFixed()).toBe(expected);
  });
});
