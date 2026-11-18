import { describe, expect, it } from "vitest";
import { decimalEqual, loadVector } from "../conformance/vectors.js";

describe("conformance vector loader", () => {
  it("loads a vector file", () => {
    const v = loadVector("round_to_tick.json");
    expect(v.cases.length).toBeGreaterThan(0);
    expect(v.cases[0]?.name).toBe("already_on_tick");
  });

  it("compares decimals as values", () => {
    expect(decimalEqual("1.50", "1.5")).toBe(true);
    expect(decimalEqual("1.5", "1.51")).toBe(false);
  });
});
