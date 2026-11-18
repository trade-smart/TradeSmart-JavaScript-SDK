import { describe, expect, it } from "vitest";
import { encodeJData } from "../../src/lib/codec.js";
import { toWireDecimal } from "../../src/lib/decimal.js";
import { RequestValidationError } from "../../src/errors.js";

const text = (payload: [string, string][]): string =>
  new TextDecoder().decode(encodeJData(payload));

describe("encodeJData", () => {
  it("percent-encodes the ampersand", () => {
    expect(text([["tsym", "M&M-EQ"]])).toBe('jData={"tsym":"M%26M-EQ"}');
  });

  it("writes U+2028 and U+2029 raw and does not escape '<'", () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    const value = `a${ls}b${ps}<c>`;
    const bytes = encodeJData([["r", value]]);
    // U+2028 is e2 80 a8 and U+2029 is e2 80 a9 in UTF-8, written as themselves.
    expect(Buffer.from(bytes).toString("hex")).toContain("61e280a862e280a93c633e");
    expect(new TextDecoder().decode(bytes)).toBe(`jData={"r":"${value}"}`);
  });

  it("escapes other control characters as lower-case \\u00xx", () => {
    expect(text([["r", String.fromCharCode(1, 0x1f)]])).toBe('jData={"r":"\\u0001\\u001f"}');
  });

  it("writes DEL raw", () => {
    expect(Buffer.from(encodeJData([["r", String.fromCharCode(0x7f)]])).toString("hex")).toContain(
      "227f22",
    );
  });

  it("encodes an astral character as four UTF-8 bytes, never as an escape", () => {
    const bytes = encodeJData([["r", String.fromCodePoint(0x1f600)]]);
    expect(Buffer.from(bytes).subarray(-6).toString("hex")).toBe("f09f9880227d");
  });

  it("encodes the wire text of a number price as the shortest decimal", () => {
    expect(text([["prc", toWireDecimal(101.1, "prc")]])).toBe('jData={"prc":"101.1"}');
  });

  it("returns a Uint8Array", () => {
    expect(encodeJData([])).toBeInstanceOf(Uint8Array);
  });

  it("rejects a lone surrogate in a value with one string_unicode issue naming the key", () => {
    let caught: unknown;
    try {
      encodeJData([["tsym", "\uD800"]]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RequestValidationError);
    const errors = (caught as RequestValidationError).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]?.type).toBe("string_unicode");
    expect(errors[0]?.loc).toEqual(["tsym"]);
  });

  it("rejects a trailing lone high surrogate and a lone low surrogate", () => {
    expect(() => encodeJData([["a", "x\uD83D"]])).toThrow(RequestValidationError);
    expect(() => encodeJData([["a", "\uDE00x"]])).toThrow(RequestValidationError);
  });

  it("accepts a valid surrogate pair", () => {
    expect(() => encodeJData([["a", "😀"]])).not.toThrow();
  });

  it("reports every bad key once, sorted, and never echoes the value", () => {
    let caught: unknown;
    try {
      encodeJData([
        ["zeta", "bad\uD800value"],
        ["ok", "fine"],
        ["alpha", "\uDC00"],
        ["zeta", "\uD800again"],
      ]);
    } catch (error) {
      caught = error;
    }
    const error = caught as RequestValidationError;
    expect(error.errors.map((issue) => issue.loc[0])).toEqual(["alpha", "zeta"]);
    expect(JSON.stringify(error.errors)).not.toContain("value");
    expect(error.message).not.toContain("value");
  });

  it("flags a key that is not valid UTF-8, without keeping the lone surrogate in the issue", () => {
    let caught: unknown;
    try {
      encodeJData([["k\uD800", "v"]]);
    } catch (error) {
      caught = error;
    }
    const error = caught as RequestValidationError;
    expect(error.errors).toHaveLength(1);
    expect(error.errors[0]?.type).toBe("string_unicode");
    expect(error.errors[0]?.loc[0]).toBe("k�");
  });
});
