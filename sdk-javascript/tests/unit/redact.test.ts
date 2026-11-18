import { describe, expect, it } from "vitest";
import { JsonNumber } from "../../src/lib/json.js";
import { maskKeys, redactObject, redactText } from "../../src/lib/redact.js";

describe("redactText", () => {
  it("masks a Bearer token", () => {
    const out = redactText("Authorization: Bearer abc.def");
    expect(out).toContain("***");
    expect(out).not.toContain("abc.def");
  });

  it("masks JSON key/value pairs, keeping the layout", () => {
    expect(redactText('{"susertoken": "x1"}')).toBe('{"susertoken": "***"}');
    expect(redactText("{'access_token':'x1', 'a': 'b'}")).toBe("{'access_token':'***', 'a': 'b'}");
  });

  it("masks non-string JSON values and values with escaped quotes", () => {
    expect(redactText('{"code": 12345, "a": 1}')).toBe('{"code": ***, "a": 1}');
    expect(redactText('{"password": "a\\"b"}')).toBe('{"password": "***"}');
  });

  it("masks key=value pairs of every listed key, any case", () => {
    expect(redactText("a=1&Access_Token=zzz&code=abc&checksum=q")).toBe(
      "a=1&Access_Token=***&code=***&checksum=***",
    );
    for (const key of [
      "authorization",
      "access_token",
      "accesstoken",
      "susertoken",
      "refresh_token",
      "checksum",
      "code",
      "secret_key",
      "app_key",
      "password",
    ]) {
      expect(redactText(`${key}=v1`)).toBe(`${key}=***`);
    }
  });

  it("does not mask a longer word that ends in a key", () => {
    expect(redactText("barcode=77")).toBe("barcode=77");
  });

  it("cuts to 2000 characters by default and to maxLen when given", () => {
    expect(redactText("a".repeat(3000))).toHaveLength(2000);
    expect(redactText("a".repeat(3000), 500)).toHaveLength(500);
    expect(redactText("short")).toBe("short");
  });

  it("redacts before cutting, so a secret is never half-shown", () => {
    const out = redactText(`${"a".repeat(1990)} access_token=abcdefghijklmnop`);
    expect(out).not.toContain("abcd");
  });
});

describe("redactObject", () => {
  it("masks keys at any depth, any case, in lists too, without mutating the input", () => {
    const input = {
      checksum: "c",
      nested: { access_token: "t", list: [{ Password: "p", ok: 1 }] },
    };
    const out = redactObject(input);
    expect(out).toEqual({
      checksum: "***",
      nested: { access_token: "***", list: [{ Password: "***", ok: 1 }] },
    });
    expect(input.checksum).toBe("c");
    expect(input.nested.access_token).toBe("t");
  });

  it("redacts text patterns inside string values", () => {
    expect(redactObject({ msg: "got Bearer abc" })).toEqual({ msg: "got Bearer ***" });
  });

  it("leaves other values (JsonNumber, Date, numbers, null) as they are", () => {
    const n = new JsonNumber("1");
    const d = new Date(0);
    const out = redactObject({ n, d, x: 2, y: null }) as Record<string, unknown>;
    expect(out["n"]).toBe(n);
    expect(out["d"]).toBe(d);
    expect(out["x"]).toBe(2);
    expect(out["y"]).toBeNull();
  });

  it("turns an Error into text with a redacted message", () => {
    expect(redactObject(new Error("tok=Bearer xyz"))).toBe("Error: tok=Bearer ***");
  });

  it("does not set the prototype from a __proto__ key", () => {
    const input = JSON.parse('{"__proto__": {"x": 1}}') as unknown;
    const out = redactObject(input) as object;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it("replaces a structure nested too deeply instead of overflowing the stack", () => {
    let deep: unknown = { end: 1 };
    for (let i = 0; i < 5000; i += 1) deep = { child: deep };
    expect(() => redactObject(deep)).not.toThrow();
    expect(JSON.stringify(redactObject(deep))).toContain("nested too deeply");
  });
});

describe("maskKeys (keys only, for model raw)", () => {
  it("masks listed keys at every depth plus the extra keys at the top level, keeps strings", () => {
    const out = maskKeys(
      { a: "Bearer keep", Code: 1, n: { susertoken: "s", x: [{ app_key: "k" }] }, own: "v" },
      ["own"],
    );
    expect(out).toEqual({
      a: "Bearer keep",
      Code: "***",
      n: { susertoken: "***", x: [{ app_key: "***" }] },
      own: "***",
    });
  });
});
