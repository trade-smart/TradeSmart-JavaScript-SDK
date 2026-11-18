import { describe, expect, it } from "vitest";
import { JsonNumber } from "../../src/lib/json.js";
import { planSlices } from "../../src/lib/slicing.js";
import { loadVector } from "./vectors.js";

// A JSON number is a JavaScript number here; booleans and null stay as they are.
function arg(value: unknown): unknown {
  return value instanceof JsonNumber ? Number(value.text) : value;
}

describe("slice_plan.json", () => {
  const vector = loadVector("slice_plan.json");
  for (const c of vector.cases) {
    it(c.name, () => {
      const input = c.input as Record<string, unknown>;
      const expected = c.expected as unknown[] | { error: string };
      const run = (): readonly number[] =>
        planSlices(
          input["exchange"] as string,
          arg(input["quantity"]) as number,
          arg(input["lot_size"]) as number,
          arg(input["freeze_quantity"]) as number | null,
          {
            maxSliceQuantity: arg(input["max_slice_quantity"]) as number | null,
            maxSlices: arg(input["max_slices"]) as number,
          },
        );
      if (Array.isArray(expected)) {
        expect(run()).toEqual(expected.map((n) => Number((n as JsonNumber).text)));
      } else {
        expect(run).toThrow(RangeError);
      }
    });
  }
});
