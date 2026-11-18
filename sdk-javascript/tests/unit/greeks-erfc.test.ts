// The normal-CDF port must agree with Python's `math.erfc` to 1e-15 (reference values below were
// generated with CPython `math.erfc` for the branch boundaries of the msun routine).
import { describe, expect, it } from "vitest";
import { cdf, erfc, pdf } from "../../src/greeks/math.js";

const REFERENCE: [number, number][] = [
  [-30, 2.0],
  [-8, 2.0],
  [-6.5, 2.0],
  [-5.5, 1.9999999999999927],
  [-3.1, 1.9999883513426329],
  [-2.9, 1.9999589021219006],
  [-2.0, 1.9953222650189528],
  [-1.3, 1.9340079449406524],
  [-1.0, 1.842700792949715],
  [-0.9, 1.7969082124228322],
  [-0.5, 1.5204998778130465],
  [-0.2, 1.2227025892104786],
  [-0.01, 1.0112834155558497],
  [0.0, 1.0],
  [1e-20, 1.0],
  [0.01, 0.9887165844441503],
  [0.2, 0.7772974107895215],
  [0.3, 0.6713732405408726],
  [0.7, 0.32219880616258156],
  [0.84, 0.23485728854500548],
  [0.9, 0.20309178757716786],
  [1.0, 0.15729920705028513],
  [1.2, 0.08968602177036465],
  [1.3, 0.06599205505934755],
  [1.7, 0.016209541409225436],
  [2.0, 0.004677734981047265],
  [2.5, 0.0004069520174449589],
  [2.85, 5.5656279961398957e-5],
  [2.9, 4.109787809945886e-5],
  [3.5, 7.430983723414128e-7],
  [5.0, 1.5374597944280351e-12],
  [6.1, 6.314602150193718e-18],
  [10.0, 2.088487583762545e-45],
  [20.0, 5.3958656116079005e-176],
  [26.0, 5.663192408856143e-296],
  [27.5, 0.0],
];

describe("erfc / normal CDF", () => {
  for (const [x, expected] of REFERENCE) {
    it(`erfc(${String(x)}) matches Python math.erfc`, () => {
      const got = erfc(x);
      expect(Math.abs(got - expected)).toBeLessThanOrEqual(1e-15 + 1e-15 * Math.abs(expected));
    });
  }

  it("handles the non-finite inputs", () => {
    expect(erfc(Infinity)).toBe(0);
    expect(erfc(-Infinity)).toBe(2);
    expect(erfc(Number.NaN)).toBeNaN();
    expect(erfc(1e-300)).toBe(1);
  });

  it("cdf and pdf are the standard normal", () => {
    expect(cdf(0)).toBe(0.5);
    expect(cdf(1.96)).toBeCloseTo(0.9750021048517795, 15);
    expect(cdf(-8) + cdf(8)).toBeCloseTo(1, 15);
    expect(pdf(0)).toBeCloseTo(0.3989422804014327, 15);
  });
});
