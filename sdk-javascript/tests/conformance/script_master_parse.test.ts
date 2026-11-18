// script_master_parse.json: script-master text to rows (sdk-behaviour.md §8.3).
import { describe, expect, it } from "vitest";
import { parseScriptMaster } from "../../src/instruments/parse.js";
import { loadVector } from "./vectors.js";

interface Input {
  text?: string;
  bytes_hex?: string;
}
interface Expected {
  rows?: Record<string, string>[];
  error?: string;
}

describe("script_master_parse.json", () => {
  for (const c of loadVector("script_master_parse.json").cases) {
    it(c.name, () => {
      const input = c.input as Input;
      const expected = c.expected as Expected;
      const bytes =
        input.bytes_hex !== undefined
          ? Uint8Array.from(Buffer.from(input.bytes_hex, "hex"))
          : new TextEncoder().encode(input.text ?? "");
      if (expected.error !== undefined) {
        let name = "no error";
        try {
          parseScriptMaster(bytes, "NSE_symbols.txt");
        } catch (e) {
          name = (e as Error).name;
        }
        expect(name).toBe(expected.error);
      } else {
        expect(parseScriptMaster(bytes, "NSE_symbols.txt")).toEqual(expected.rows);
      }
    });
  }
});
