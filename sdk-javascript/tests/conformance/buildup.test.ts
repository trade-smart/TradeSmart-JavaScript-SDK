import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { buildupFromSnapshot, classifyBuildup } from "../../src/analytics/index.js";
import { JsonNumber } from "../../src/lib/json.js";
import { loadVector } from "./vectors.js";

interface Input {
  function: "classify_buildup" | "buildup_from_snapshot";
  price_change?: JsonNumber | string | null;
  oi_change?: JsonNumber | string | null;
  snapshot?: Record<string, unknown>;
}

/** A vector change value as a JavaScript number ("NaN" / "Infinity" words included). */
function asNumber(v: JsonNumber | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof JsonNumber) return Number(v.text);
  return Number(v);
}

/** Snapshot values as a stream would hold them: strings, booleans, null or plain numbers. */
function plain(snapshot: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(snapshot).map(([k, v]) => [k, v instanceof JsonNumber ? Number(v.text) : v]),
  );
}

function sameDecimal(got: Decimal | null, want: string | null): void {
  if (want === null) expect(got).toBeNull();
  else expect(got !== null && got.equals(new Decimal(want))).toBe(true);
}

describe("buildup.json", () => {
  const vector = loadVector("buildup.json");
  it("has cases", () => {
    expect(vector.cases.length).toBeGreaterThan(0);
  });
  for (const c of vector.cases) {
    it(c.name, () => {
      const i = c.input as Input;
      const expected = c.expected as Record<string, string | null>;
      if (i.function === "classify_buildup") {
        expect(classifyBuildup(asNumber(i.price_change), asNumber(i.oi_change))).toBe(
          expected["state"],
        );
        return;
      }
      const got = buildupFromSnapshot(plain(i.snapshot as Record<string, unknown>));
      expect(got.state).toBe(expected["state"]);
      expect(got.basis).toBe(expected["basis"]);
      sameDecimal(got.priceChange, expected["price_change"] as string | null);
      sameDecimal(got.oiChange, expected["oi_change"] as string | null);
    });
  }

  it("accepts Decimal inputs", () => {
    expect(classifyBuildup(new Decimal("0.1"), new Decimal("-3"))).toBe("short_covering");
    expect(classifyBuildup(new Decimal("NaN"), new Decimal("3"))).toBe("neutral");
  });
});
