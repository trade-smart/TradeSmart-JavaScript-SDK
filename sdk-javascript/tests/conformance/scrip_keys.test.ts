import { describe, expect, it } from "vitest";
import { RequestValidationError } from "../../src/errors.js";
import { JsonNumber } from "../../src/lib/json.js";
import { toScripKeys, type InstrumentsArg } from "../../src/stream/protocol.js";
import { loadVector } from "./vectors.js";

// The vectors are read losslessly: a JSON number (a bad token) becomes a plain number here.
function plain(value: unknown): unknown {
  if (value instanceof JsonNumber) return Number(value.text);
  if (Array.isArray(value)) return value.map(plain);
  return value;
}

describe("scrip_keys.json", () => {
  const vector = loadVector("scrip_keys.json");
  for (const c of vector.cases) {
    it(c.name, () => {
      const input = plain((c.input as { instruments: unknown }).instruments) as InstrumentsArg;
      const expected = c.expected as { keys?: string[]; error?: string };
      if (expected.error !== undefined) {
        expect(expected.error).toBe("RequestValidationError");
        expect(() => toScripKeys(input)).toThrow(RequestValidationError);
      } else {
        expect(toScripKeys(input)).toEqual(expected.keys);
      }
    });
  }
});
