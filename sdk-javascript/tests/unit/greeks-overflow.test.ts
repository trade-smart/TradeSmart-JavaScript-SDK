// Spec 10.3 ("Rate and yield range"): an absurd but finite rate or dividend yield that overflows
// exp(-rate * years), exp(-dividendYield * years) or the carry factor is a RangeError (the
// reference's ValueError), never an infinite or null-filled result.
import { describe, expect, it } from "vitest";
import {
  black76,
  blackScholes,
  greeksFromPrice,
  impliedVolatility,
} from "../../src/greeks/index.js";
import { carryAdjustedForward } from "../../src/lib/option-contracts.js";

const RATE = "rate is out of range: exp(-rate * years) overflows a float";
const YIELD = "dividendYield is out of range: exp(-dividendYield * years) overflows a float";
const CARRY =
  "rate - dividendYield is out of range: " +
  "exp(-(rate - dividendYield) * (futureYears - optionYears)) overflows a float";

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("an overflowing discount or carry factor", () => {
  const cases: [string, () => unknown, string][] = [
    ["black76 rate", () => black76(100, 100, 0.25, -1e6, 0.2, "CE"), RATE],
    ["black76 long years", () => black76(100, 100, 1e6, -0.01, 0.2, "PE"), RATE],
    ["bsm rate", () => blackScholes(100, 100, 0.25, -1e6, 0.2, "CE"), RATE],
    [
      "bsm yield",
      () => blackScholes(100, 100, 0.25, 0.05, 0.2, "PE", { dividendYield: -1e6 }),
      YIELD,
    ],
    ["iv black76 rate", () => impliedVolatility(5, 100, 100, 0.25, -1e6, "CE"), RATE],
    [
      "iv bsm yield",
      () => impliedVolatility(5, 100, 100, 0.25, 0.05, "CE", { model: "bsm", dividendYield: -1e6 }),
      YIELD,
    ],
    ["gfp black76 rate", () => greeksFromPrice(5, 100, 100, 0.25, -1e6, "CE"), RATE],
    [
      "gfp bsm yield",
      () => greeksFromPrice(5, 100, 100, 0.25, 0.05, "CE", { model: "bsm", dividendYield: -1e6 }),
      YIELD,
    ],
    ["carry rate", () => carryAdjustedForward(24200, 1e6, 0.1, 0.2), CARRY],
    ["carry negative rate", () => carryAdjustedForward(24200, -1e6, 0.2, 0.1), CARRY],
    ["carry yield", () => carryAdjustedForward(24200, 0.065, 0.2, 0.1, 1e6), CARRY],
  ];
  for (const [name, fn, message] of cases) {
    it(`${name} is a RangeError`, () => {
      expect(fn).toThrow(RangeError);
      expect(fn).toThrow(new RegExp("^" + escape(message)));
    });
  }

  it("names the values in the message", () => {
    expect(() => blackScholes(100, 100, 0.25, 0.05, 0.2, "CE", { dividendYield: -1e6 })).toThrow(
      "dividendYield is out of range: exp(-dividendYield * years) overflows a float " +
        "(dividendYield=-1000000, years=0.25)",
    );
    expect(() => carryAdjustedForward(24200, -1e6, 0.2, 0.1)).toThrow(
      "rate - dividendYield is out of range: " +
        "exp(-(rate - dividendYield) * (futureYears - optionYears)) overflows a float " +
        "(rate=-1000000, dividendYield=0, futureYears=0.2, optionYears=0.1)",
    );
  });

  it("a factor that underflows to 0 is still a result", () => {
    expect(black76(100, 100, 0.25, 1e6, 0.2, "CE").price).toBe(0);
    expect(carryAdjustedForward(24200, 1e6, 0.2, 0.1)).toBe(0);
  });

  it("an expired option never computes the factor", () => {
    expect(black76(100, 90, 0, -1e6, 0.2, "CE").status).toBe("expired");
    expect(greeksFromPrice(5, 100, 90, -1, -1e6, "CE").status).toBe("expired");
  });
});
