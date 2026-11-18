import { describe, expect, it } from "vitest";
import { expiryInstant, optionHasExpired } from "../../src/lib/option-contracts.js";
import { loadVector } from "./vectors.js";

interface Input {
  function: "expiry_instant" | "option_has_expired";
  date: string;
  exchange: string;
  expiry_time: string | null;
  now?: string;
}

describe("expiry_instants.json", () => {
  const vector = loadVector("expiry_instants.json");
  it("has cases", () => {
    expect(vector.cases.length).toBeGreaterThan(0);
  });
  for (const c of vector.cases) {
    it(c.name, () => {
      const i = c.input as Input;
      const expected = c.expected as Record<string, unknown>;
      const time = i.expiry_time ?? undefined;
      const run = (): unknown =>
        i.function === "expiry_instant"
          ? expiryInstant(i.exchange, i.date, time).toISOString()
          : optionHasExpired(i.exchange, i.date, time, new Date(i.now as string));
      if (expected["error"] !== undefined) {
        expect(run).toThrow(RangeError);
        return;
      }
      if (i.function === "expiry_instant") {
        // Same instant as the vector's IST text.
        expect(run()).toBe(new Date(expected["instant"] as string).toISOString());
      } else {
        expect(run()).toBe(expected["expired"]);
      }
    });
  }
});
