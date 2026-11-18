// The fallback failure of `selectFuture` names both symbols it looked up (the vectors only pin
// the error type).
import { describe, expect, it } from "vitest";
import { selectFuture } from "../../src/lib/option-contracts.js";

describe("selectFuture failure message", () => {
  it("names the OPT symbol and its FUT fallback", () => {
    const option = { exchange: "BFO", expiry: "2026-11-26", symbol: "BSXOPT", tradingsymbol: "X" };
    expect(() => selectFuture([], option)).toThrow(RangeError);
    expect(() => selectFuture([], option)).toThrow(/BSXOPT.*BSXFUT/);
  });

  it("names only the one symbol when there is no fallback", () => {
    const option = { exchange: "NFO", expiry: "2026-11-26", symbol: "NIFTY", tradingsymbol: "X" };
    expect(() => selectFuture([], option)).toThrow(/NIFTY/);
    expect(() => selectFuture([], option)).not.toThrow(/tried/);
  });
});
