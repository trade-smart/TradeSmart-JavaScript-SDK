import { describe, expect, it } from "vitest";
import { RequestValidationError } from "../../src/errors.js";
import { D, Decimal, toWireDecimal } from "../../src/lib/decimal.js";
import {
  FieldParseError,
  parseEnum,
  parseEpochTime,
  parseIstDateTime,
  parsePrice,
  parseQuantity,
  parseStr,
  parseStreamPrice,
  parseVolume,
} from "../../src/lib/fieldtypes.js";
import { JsonNumber } from "../../src/lib/json.js";

describe("parsePrice", () => {
  it("parses decimal text and equals the same value", () => {
    const p = parsePrice("101.10");
    expect(p?.toString()).toBe("101.1");
    expect(p?.equals(new Decimal("101.10"))).toBe(true);
  });
  it("maps null, undefined and blanks to null", () => {
    expect(parsePrice("")).toBeNull();
    expect(parsePrice("  ")).toBeNull();
    expect(parsePrice(null)).toBeNull();
    expect(parsePrice(undefined)).toBeNull();
  });
  it("rejects non-finite, hex, booleans and other types", () => {
    for (const bad of ["NaN", "Infinity", "0x10", "abc", true, {}, 1n, Number.NaN]) {
      expect(() => parsePrice(bad)).toThrow(FieldParseError);
    }
  });
  it("reads a JsonNumber from its exact text", () => {
    expect(parsePrice(new JsonNumber("0.1"))?.toFixed()).toBe("0.1");
  });
  it("uses the configured precision and exponent thresholds", () => {
    expect(D.precision).toBe(40);
    expect(new D("0.000000001").toString()).toBe("0.000000001");
    expect(new D("1e41").toString()).toBe("1e+41");
  });
});

describe("parseStreamPrice", () => {
  it("turns the ATO sentinel into null", () => {
    expect(parseStreamPrice("42949672.95")).toBeNull();
    expect(parseStreamPrice("42949672.950")).toBeNull();
  });
  it("keeps other prices", () => {
    expect(parseStreamPrice("42949672.96")?.toFixed()).toBe("42949672.96");
  });
});

describe("parseVolume", () => {
  it("keeps large integers exactly", () => {
    expect(parseVolume(new JsonNumber("12345678901234567"))?.toFixed()).toBe("12345678901234567");
  });
});

describe("parseQuantity", () => {
  it("accepts integral decimals", () => {
    expect(parseQuantity("10.00")).toBe(10);
    expect(parseQuantity(new JsonNumber("25"))).toBe(25);
    expect(parseQuantity(7)).toBe(7);
    expect(parseQuantity("")).toBeNull();
  });
  it("rejects fractions, booleans and unsafe integers", () => {
    for (const bad of ["10.5", true, 1.5, "9007199254740993", new JsonNumber("1e30")]) {
      expect(() => parseQuantity(bad)).toThrow(FieldParseError);
    }
  });
});

describe("parseEpochTime", () => {
  it("reads epoch seconds from text, numbers and JsonNumber", () => {
    expect(parseEpochTime("1794282300")?.toISOString()).toBe("2026-11-10T03:45:00.000Z");
    expect(parseEpochTime(new JsonNumber("1794282300"))?.getTime()).toBe(1794282300000);
  });
  it("maps zero and blank to null and rejects text", () => {
    expect(parseEpochTime("0")).toBeNull();
    expect(parseEpochTime("")).toBeNull();
    expect(() => parseEpochTime("abc")).toThrow(FieldParseError);
  });
});

describe("parseIstDateTime", () => {
  it("reports one unknown shape once through the injected callback", () => {
    const shapes: string[] = [];
    expect(parseIstDateTime("2026-11-10T09:15:00", (s) => shapes.push(s))).toBeNull();
    expect(parseIstDateTime("2027-12-11T10:16:01", (s) => shapes.push(s))).toBeNull();
    expect(shapes).toEqual(["9999-99-99T99:99:99"]);
  });
  it("does not report blanks or non-strings", () => {
    const shapes: string[] = [];
    for (const v of ["", "  ", null, 5, new JsonNumber("5")]) {
      expect(parseIstDateTime(v, (s) => shapes.push(s))).toBeNull();
    }
    expect(shapes).toEqual([]);
  });
  it("rejects impossible calendar dates", () => {
    expect(parseIstDateTime("31-02-2026", () => undefined)).toBeNull();
  });
});

describe("parseStr", () => {
  it("keeps the text of numbers", () => {
    expect(parseStr(new JsonNumber("00022"))).toBe("00022");
    expect(parseStr("abc")).toBe("abc");
    expect(parseStr(null)).toBeNull();
    expect(parseStr("")).toBe("");
  });
  it("rejects booleans and objects", () => {
    expect(() => parseStr(true)).toThrow(FieldParseError);
    expect(() => parseStr({})).toThrow(FieldParseError);
  });
});

describe("parseEnum", () => {
  const parse = parseEnum(new Set(["B", "S"]));
  it("passes known and unknown values through as strings", () => {
    expect(parse("B")).toBe("B");
    expect(parse("X")).toBe("X");
    expect(parse(new JsonNumber("1"))).toBe("1");
    expect(parse("  ")).toBeNull();
    expect(parse(null)).toBeNull();
    expect(parse.isKnown("B")).toBe(true);
    expect(parse.isKnown("X")).toBe(false);
  });
  it("rejects booleans", () => {
    expect(() => parse(false)).toThrow(FieldParseError);
  });
});

describe("toWireDecimal", () => {
  it("writes shortest round-trip number text", () => {
    expect(toWireDecimal(101.1, "prc")).toBe("101.1");
    expect(toWireDecimal(0.1 + 0.2, "prc")).toBe("0.30000000000000004");
    expect(toWireDecimal(1e-7, "prc")).toBe("0.0000001");
  });
  it("accepts Decimal and decimal strings", () => {
    expect(toWireDecimal(new Decimal("24000.5"), "prc")).toBe("24000.5");
    expect(toWireDecimal(" 12.50 ", "prc")).toBe("12.5");
  });
  it("bounds the exponent at ±1000 like the price grammar", () => {
    expect(toWireDecimal("1e1000", "prc")).toHaveLength(1001);
    for (const bad of ["1e1001", "1e999999999", "1e-1001", new Decimal("1e1001")]) {
      expect(() => toWireDecimal(bad, "prc")).toThrow(RequestValidationError);
    }
  });
  it("rejects bigint, non-finite and malformed input naming the field", () => {
    for (const bad of [10n, Number.NaN, Infinity, "abc", "0x1", "", null, true]) {
      expect(() => toWireDecimal(bad, "prc")).toThrow(RequestValidationError);
    }
    expect.assertions(9);
    try {
      toWireDecimal(10n, "prc");
    } catch (e) {
      expect((e as RequestValidationError).errors[0]?.loc).toEqual(["prc"]);
    }
  });
});
