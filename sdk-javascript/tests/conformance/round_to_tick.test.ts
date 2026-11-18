import { describe, expect, it } from "vitest";
import { roundToTick } from "../../src/lib/tick.js";
import { JsonNumber } from "../../src/lib/json.js";
import { loadVector } from "./vectors.js";

type Value = string | JsonNumber;

// A JSON number is a JavaScript number here (its text is the shortest round trip in the vectors).
function arg(value: Value): string | number {
  return value instanceof JsonNumber ? Number(value.text) : value;
}

describe("round_to_tick.json", () => {
  const vector = loadVector("round_to_tick.json");
  for (const c of vector.cases) {
    it(c.name, () => {
      const input = c.input as { price: Value; tick_size: Value };
      const expected = c.expected as { result?: string; error?: string };
      const run = (): string => roundToTick(arg(input.price), arg(input.tick_size));
      if (expected.error !== undefined) {
        expect(run).toThrow(RangeError);
      } else {
        expect(run()).toBe(expected.result);
      }
    });
  }
});
