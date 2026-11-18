// Shared helpers for the three Greeks conformance tests (not a test file itself).
import { expect } from "vitest";
import { JsonNumber } from "../../src/lib/json.js";

/** A vector input value: a JSON number, a string, `null`, or `"NaN"` / `"Infinity"` / `"-Infinity"`. */
export type VectorValue = JsonNumber | string | null;

/** The JavaScript number for a vector numeric input (`"NaN"` and the infinities are spelled as strings). */
export function numberOf(value: VectorValue): number {
  if (value instanceof JsonNumber) return Number(value.text);
  if (value === "NaN") return Number.NaN;
  if (value === "Infinity") return Infinity;
  if (value === "-Infinity") return -Infinity;
  throw new Error(`not a numeric vector value: ${String(value)}`);
}

/** Like `numberOf`, but `null` (or an absent key) stays `null`. */
export function nullableNumberOf(value: VectorValue | undefined): number | null {
  return value === null || value === undefined ? null : numberOf(value);
}

/** Assert `|actual - expected| <= abs + rel * |expected|`; a `null` expected means a `null` actual. */
export function expectClose(
  actual: number | null,
  expected: VectorValue | undefined,
  tol: { abs: number; rel: number },
  label: string,
): void {
  if (expected === null || expected === undefined) {
    expect(actual, label).toBeNull();
    return;
  }
  const e = numberOf(expected);
  expect(actual, label).not.toBeNull();
  const a = actual as number;
  expect(Math.abs(a - e), `${label}: ${String(a)} vs ${String(e)}`).toBeLessThanOrEqual(
    tol.abs + tol.rel * Math.abs(e),
  );
}

/** The file's tolerance (the loader keeps numbers as `JsonNumber`, so read them through `numberOf`). */
export function toleranceOf(
  tolerance: { abs?: number; rel?: number } | undefined,
  fallback: { abs: number; rel: number },
): { abs: number; rel: number } {
  const t = tolerance as { abs?: VectorValue; rel?: VectorValue } | undefined;
  return {
    abs: t?.abs === undefined ? fallback.abs : numberOf(t.abs),
    rel: t?.rel === undefined ? fallback.rel : numberOf(t.rel),
  };
}
