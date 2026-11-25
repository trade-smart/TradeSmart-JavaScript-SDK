import { describe, expect, it } from "vitest";
import { encodeJData, type WirePayload } from "../../src/lib/codec.js";
import { RequestValidationError } from "../../src/errors.js";
import { loadVector } from "./vectors.js";

interface Input {
  payload: [string, string][];
}
interface Expected {
  body?: string;
  utf8_hex?: string;
  error?: string;
  fields?: string[];
}

describe("jdata_encoding.json", () => {
  const vector = loadVector("jdata_encoding.json");
  for (const c of vector.cases) {
    it(c.name, () => {
      const input = c.input as Input;
      const expected = c.expected as Expected;
      const payload: WirePayload = input.payload;
      if (expected.error !== undefined) {
        let thrown: unknown;
        try {
          encodeJData(payload);
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(RequestValidationError);
        if (expected.fields !== undefined) {
          const errors = (thrown as RequestValidationError).errors;
          expect(errors.map((e) => e.loc[0])).toEqual(expected.fields);
        }
        return;
      }
      const bytes = encodeJData(payload);
      // Byte for byte, not only as text.
      expect(Buffer.from(bytes).toString("hex")).toBe(expected.utf8_hex);
      expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(expected.body);
    });
  }
});
