import { describe, expect, it } from "vitest";
import { D, Decimal } from "../../src/lib/decimal.js";
import { roundToTick } from "../../src/lib/tick.js";
import { roundToTick as publicRoundToTick } from "../../src/index.js";

describe("roundToTick", () => {
  it("is exported from the package entry point", () => {
    expect(publicRoundToTick).toBe(roundToTick);
  });

  it("accepts Decimal instances", () => {
    expect(roundToTick(new D("100.03"), new Decimal("0.05"))).toBe("100.05");
  });

  it("reads a float through its shortest text, never through binary noise", () => {
    expect(roundToTick(1584.45 * 1.001, "0.05")).toBe("1586.05");
    expect(roundToTick(0.1 + 0.2, 0.05)).toBe("0.30");
  });

  it("rounds a half-way price away from zero in both directions", () => {
    expect(roundToTick("100.025", "0.05")).toBe("100.05");
    expect(roundToTick("-100.025", "0.05")).toBe("-100.05");
    expect(roundToTick("-100.075", "0.05")).toBe("-100.10");
  });

  it("ignores trailing zeros of the tick for its decimal places", () => {
    expect(roundToTick("100.04", "0.100")).toBe("100.0");
    expect(roundToTick("1234", "50")).toBe("1250");
  });

  it("keeps the sign of a negative price that rounds to zero, as the Python reference does", () => {
    // Outputs confirmed from Python round_to_tick (str of the Decimal).
    expect(roundToTick("-0.01", "0.05")).toBe("-0.00");
    expect(roundToTick("-0.02", "0.05")).toBe("-0.00");
    expect(roundToTick(-0.001, "1")).toBe("-0");
    expect(roundToTick("-0.024", "0.100")).toBe("-0.0");
    expect(roundToTick("0", "0.05")).toBe("0.00");
  });

  it("throws RangeError for a tick of zero or below, or a non-finite value", () => {
    for (const bad of [0, -0.05, "0", "-1", "NaN", "Infinity", Number.NaN, Infinity, ""]) {
      expect(() => roundToTick("100", bad)).toThrow(RangeError);
    }
    for (const bad of ["abc", "", "NaN", "-Infinity", Number.NaN, new D("NaN")]) {
      expect(() => roundToTick(bad, "0.05")).toThrow(RangeError);
    }
    expect(() => roundToTick(null as unknown as string, "0.05")).toThrow(RangeError);
    expect(() => roundToTick("1", {} as unknown as string)).toThrow(RangeError);
  });

  it("never puts the value in the error message", () => {
    for (const run of [
      () => roundToTick("hunter2.5x", "0.05"),
      () => roundToTick("100", "-7.77"),
      () => roundToTick("100", "secret-tick"),
    ]) {
      try {
        run();
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(RangeError);
        expect((error as Error).message).not.toMatch(/hunter|7\.77|secret/);
      }
    }
  });
});
