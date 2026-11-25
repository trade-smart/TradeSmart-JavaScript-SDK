import { describe, expect, it } from "vitest";
import { encodeJData, type WirePayload } from "../../src/lib/codec.js";
import { toWireDecimal } from "../../src/lib/decimal.js";
import { RequestValidationError } from "../../src/errors.js";

const text = (payload: [string, string][]): string =>
  new TextDecoder().decode(encodeJData(payload));

describe("encodeJData nested values", () => {
  const body = (payload: WirePayload): string => new TextDecoder().decode(encodeJData(payload));

  it("keeps the key and item order of nested objects and lists", () => {
    expect(
      body([
        [
          "oivariable",
          [
            { d: "2", var_name: "x" },
            { var_name: "y", d: "1" },
          ],
        ],
        ["params", { z: "1", a: "2" }],
      ]),
    ).toBe(
      'jData={"oivariable":[{"d":"2","var_name":"x"},{"var_name":"y","d":"1"}],"params":{"z":"1","a":"2"}}',
    );
  });

  it("percent-encodes and escapes strings at any depth; empty list and object", () => {
    expect(
      body([
        ["a", { r: "a&b+c%d\n" }],
        ["b", []],
        ["c", {}],
      ]),
    ).toBe('jData={"a":{"r":"a%26b%2Bc%25d\\n"},"b":[],"c":{}}');
  });

  it("names the top-level key of a nested lone surrogate, once, sorted", () => {
    const bad = String.fromCharCode(0xd800);
    try {
      encodeJData([
        ["z", [{ r: bad }]],
        ["a", { r: bad, s: bad }],
        ["ok", "1"],
      ]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RequestValidationError);
      expect((error as RequestValidationError).errors.map((e) => e.loc)).toEqual([["a"], ["z"]]);
    }
  });
});

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
