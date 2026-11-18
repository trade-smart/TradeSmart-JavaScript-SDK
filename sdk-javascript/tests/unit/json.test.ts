import { describe, expect, it } from "vitest";
import { JsonNumber, losslessReviver, parseJsonLossless } from "../../src/lib/json.js";

describe("losslessReviver", () => {
  it("throws instead of returning a float when the source text is missing", () => {
    expect(() => losslessReviver("a", 1.5, {})).toThrow("lossless JSON needs reviver source text");
    expect(() => losslessReviver("a", 1.5, undefined)).toThrow(
      "lossless JSON needs reviver source text",
    );
  });
  it("passes non-numbers through without needing a source", () => {
    expect(losslessReviver("a", "s", {})).toBe("s");
  });
});

describe("parseJsonLossless", () => {
  it("keeps the exact text of numbers", () => {
    const v = parseJsonLossless('{"a":26111500000123456,"b":1.10}') as Record<string, JsonNumber>;
    expect(v["a"]).toBeInstanceOf(JsonNumber);
    expect(v["a"]?.text).toBe("26111500000123456");
    expect(v["b"]?.text).toBe("1.10");
  });

  it("handles nested arrays and objects, leaving other values as JSON.parse does", () => {
    const v = parseJsonLossless('{"x":[1,[2.50,{"y":-0.0}],"s",true,null]}') as {
      x: [JsonNumber, [JsonNumber, { y: JsonNumber }], string, boolean, null];
    };
    expect(v.x[0].text).toBe("1");
    expect(v.x[1][0].text).toBe("2.50");
    expect(v.x[1][1].y.text).toBe("-0.0");
    expect(v.x.slice(2)).toEqual(["s", true, null]);
  });

  it("parses a bare number and keeps exponent text", () => {
    expect((parseJsonLossless("1e400") as JsonNumber).text).toBe("1e400");
  });

  it("rejects invalid JSON", () => {
    expect(() => parseJsonLossless("{")).toThrow(SyntaxError);
  });
});
