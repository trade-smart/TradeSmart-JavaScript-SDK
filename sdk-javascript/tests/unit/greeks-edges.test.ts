// Review Focus 1: absurd-but-valid inputs never throw and never yield NaN or infinity.
import { describe, expect, it } from "vitest";
import {
  black76,
  blackScholes,
  greeksFromPrice,
  impliedVolatility,
  type OptionSide,
} from "../../src/greeks/index.js";

const FIELDS = ["price", "iv", "delta", "gamma", "theta", "vega", "rho", "yearsToExpiry"] as const;

function expectFiniteOrNull(result: object): void {
  for (const f of FIELDS) {
    const v = (result as Record<string, number | null>)[f];
    expect(v === null || Number.isFinite(v), `${f} = ${String(v)}`).toBe(true);
  }
}

const loose = (v: unknown): number => v as number;

describe("greeks edge inputs", () => {
  // name, underlying, strike, years, rate, volatility
  const cases: [string, number, number, number, number, number][] = [
    ["years 1e-9", 100, 100, 1e-9, 0.065, 0.2],
    ["strike 1e-6 x underlying", 100, 1e-4, 0.25, 0.065, 0.2],
    ["strike 1e6 x underlying", 100, 1e8, 0.25, 0.065, 0.2],
    ["volatility 4.999", 100, 100, 0.25, 0.065, 4.999],
    ["rate 1e300", 100, 100, 0.25, 1e300, 0.2],
  ];
  for (const [name, u, k, t, r, v] of cases) {
    for (const type of ["CE", "PE"] as const) {
      it(`${name} (${type}) never throws and stays finite-or-null`, () => {
        expectFiniteOrNull(black76(u, k, t, r, v, type));
        expectFiniteOrNull(blackScholes(u, k, t, r, v, type, { dividendYield: 0.01 }));
        const iv = impliedVolatility(3, u, k, t, r, type);
        expect(iv === null || Number.isFinite(iv)).toBe(true);
        expectFiniteOrNull(greeksFromPrice(3, u, k, t, r, type));
        expectFiniteOrNull(greeksFromPrice(3, u, k, t, r, type, { model: "bsm" }));
      });
    }
  }

  it("rejects non-number and non-finite arguments with a RangeError naming the parameter", () => {
    expect(() => black76(loose(true), 100, 0.25, 0.065, 0.2, "CE")).toThrow(/forward/);
    expect(() => black76(100, loose("100"), 0.25, 0.065, 0.2, "CE")).toThrow(RangeError);
    expect(() => black76(100, loose(10n), 0.25, 0.065, 0.2, "CE")).toThrow(/strike/);
    expect(() =>
      blackScholes(100, 100, 0.25, 0.065, 0.2, "CE", { dividendYield: loose(false) }),
    ).toThrow(/dividendYield/);
    expect(() => impliedVolatility(loose({}), 100, 100, 0.25, 0.065, "CE")).toThrow(/optionPrice/);
    expect(() =>
      greeksFromPrice(3, 100, 100, 0.25, 0.065, "CE", { tickSize: loose(true) }),
    ).toThrow(/tickSize/);
    expect(() => black76(Number.NaN, 100, 0.25, 0.065, 0.2, "CE")).toThrow(/forward/);
    expect(() => black76(100, 100, Infinity, 0.065, 0.2, "CE")).toThrow(/years/);
    expect(() => black76(100, 100, 0.25, Number.NaN, 0.2, "CE")).toThrow(/rate/);
    expect(() => black76(100, 100, 0.25, 0.065, 0, "CE")).toThrow(/volatility/);
  });

  it("treats a missing price or underlying as no_price and normalises the option type", () => {
    expect(
      greeksFromPrice(loose(undefined), 100, 100, 0.25, 0.065, "ce" as OptionSide).status,
    ).toBe("no_price");
    expect(greeksFromPrice(3, null, 100, 0.25, 0.065, " put " as OptionSide).status).toBe(
      "no_price",
    );
    expect(black76(100, 100, 0.25, 0.065, 0.2, " call " as OptionSide).delta).toBeGreaterThan(0);
    expect(black76(100, 100, 0.25, 0.065, 0.2, "put" as OptionSide).delta).toBeLessThan(0);
    expect(() => black76(100, 100, 0.25, 0.065, 0.2, 5 as unknown as OptionSide)).toThrow(
      /optionType/,
    );
    expect(() =>
      impliedVolatility(3, 100, 100, 0.25, 0.065, "CE", { model: "x" as "bsm" }),
    ).toThrow(/model/);
  });
});

describe("greeks NaN clamp (matches Python max(-40, min(40, nan)) == 40)", () => {
  // volatility 1e308 over 1e6 years: sigma*sqrt(t) and the drift are both +inf, so d1 = inf/inf = NaN.
  // Python clamps NaN to 40, so d1 = 40 and d2 = clamp(40 - inf) = -40 (values from greeks.py).
  it("call: price 100, delta 1, gamma/theta/vega 0, rho -1e6", () => {
    const g = black76(100, 100, 1e6, 0, 1e308, "CE");
    expect(g).toMatchObject({
      price: 100,
      iv: 1e308,
      delta: 1,
      gamma: 0,
      theta: 0,
      vega: 0,
      rho: -1000000,
      status: "ok",
    });
  });

  it("put: price 100, delta -0, rho -1e6", () => {
    const g = black76(100, 100, 1e6, 0, 1e308, "PE");
    expect(g.price).toBe(100);
    expect(g.delta).toBeCloseTo(0, 12);
    expect(g.rho).toBe(-1000000);
  });
});

describe("greeks edge sanity (not merely finite-or-null)", () => {
  it("deep ITM call delta is about 1, deep OTM about 0, put mirrored", () => {
    expect(black76(100, 1e-4, 0.25, 0.065, 0.2, "CE").delta).toBeCloseTo(
      Math.exp(-0.065 * 0.25),
      9,
    );
    expect(black76(100, 1e8, 0.25, 0.065, 0.2, "CE").delta).toBeCloseTo(0, 12);
    expect(black76(100, 1e8, 0.25, 0.065, 0.2, "PE").delta).toBeCloseTo(
      -Math.exp(-0.065 * 0.25),
      9,
    );
  });

  it("volatility 4.999 gives a non-null positive price and iv", () => {
    const g = black76(100, 100, 0.25, 0.065, 4.999, "CE");
    expect(g.price).not.toBeNull();
    expect(g.price as number).toBeGreaterThan(0);
    expect(g.iv).toBe(4.999);
  });

  it("years 1e-9 is floored to one minute and still prices", () => {
    const g = black76(100, 100, 1e-9, 0.065, 0.2, "CE");
    expect(g.price).not.toBeNull();
    expect(g.yearsToExpiry).toBe(1e-9);
    expect(g.status).toBe("near_expiry");
  });
});
