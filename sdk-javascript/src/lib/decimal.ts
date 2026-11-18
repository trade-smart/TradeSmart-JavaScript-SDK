import { Decimal } from "decimal.js";
import { fieldError } from "../errors.js";

export { Decimal } from "decimal.js";

/** The SDK's configured Decimal: 40 digits, half-up, plain text up to 1e-30 and 1e40. */
export const D = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 40,
});

/**
 * Python's default `decimal` context: 28 significant digits, half-even. For results the Python SDK
 * computes with plain `Decimal` arithmetic (the put-call ratio), so both SDKs print the same digits.
 */
export const PY = Decimal.clone({
  precision: 28,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -30,
  toExpPos: 40,
});

const DECIMAL_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Parse decimal text (no hex, no NaN or Infinity); `null` when it is not a finite decimal. */
export function decimalFromText(text: string): Decimal | null {
  const trimmed = text.trim();
  if (!DECIMAL_TEXT.test(trimmed)) return null;
  const value = new D(trimmed);
  return value.isFinite() ? value : null;
}

/** Python's `Decimal(text)` syntax (ASCII digits, no underscores, no NaN or Infinity). */
const PY_DECIMAL_TEXT = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d{1,9}))?$/;

/** Largest exponent magnitude accepted (a price beyond it is nonsense; its text would be huge). */
const MAX_EXPONENT = 1000;

/** A decimal written in plain notation, with its sign (`0` for any zero, `-0` included). */
export interface PlainDecimal {
  readonly text: string;
  readonly sign: -1 | 0 | 1;
}

/**
 * Decimal text in plain notation exactly as Python's `format(Decimal(text.strip()), "f")` writes
 * it: the digits as given (trailing zeros kept, leading zeros dropped), the exponent applied
 * without rounding, a `+` sign dropped, a `-` kept (also on zero). `null` when the trimmed text
 * is not a finite decimal (stricter than Python: no `_` separators, no non-ASCII digits, and an
 * exponent beyond ±1000 is refused).
 */
export function plainDecimal(text: string): PlainDecimal | null {
  const match = PY_DECIMAL_TEXT.exec(text.trim());
  if (match === null) return null;
  const negative = match[1] === "-";
  const integer = match[2] ?? "";
  const fraction = match[3] ?? match[4] ?? "";
  const exponent = Number(match[5] ?? "0") - fraction.length;
  if (Math.abs(exponent) > MAX_EXPONENT) return null;
  const coefficient = (integer + fraction).replace(/^0+/, "") || "0";
  let digits: string;
  if (exponent >= 0) {
    digits = coefficient === "0" ? "0" : coefficient + "0".repeat(exponent);
  } else {
    const places = -exponent;
    const padded = coefficient.padStart(places + 1, "0");
    digits = `${padded.slice(0, -places)}.${padded.slice(-places)}`;
  }
  const sign = coefficient === "0" ? 0 : negative ? -1 : 1;
  return { text: negative ? `-${digits}` : digits, sign };
}

/**
 * A typed order or GTT price as `PlainDecimal` (sdk-behaviour.md §7.3; Task 11 ruling): a string
 * is read as Python's `Decimal(str)` and keeps its own digits (`"2001.00"` stays `"2001.00"`); a
 * finite `number` goes through its shortest text (`String(n)`); a finite `Decimal` through
 * decimal.js text (its trailing zeros are already gone). Anything else (a boolean, NaN,
 * Infinity, other types) is `null`.
 */
export function priceDecimal(value: unknown): PlainDecimal | null {
  if (typeof value === "string") return plainDecimal(value);
  if (typeof value === "number") return Number.isFinite(value) ? plainDecimal(String(value)) : null;
  if (Decimal.isDecimal(value)) {
    return value.isFinite() ? plainDecimal(value.toFixed()) : null;
  }
  return null;
}

/**
 * Request-side price to its plain wire text. Accepts a `Decimal`, a decimal string or a finite
 * `number` (via its shortest round-trip text); anything else throws `RequestValidationError`.
 */
export function toWireDecimal(value: unknown, field: string): string {
  let parsed: Decimal | null = null;
  if (value instanceof Decimal) {
    parsed = value.isFinite() ? value : null;
  } else if (typeof value === "string") {
    parsed = decimalFromText(value);
  } else if (typeof value === "number" && Number.isFinite(value)) {
    parsed = decimalFromText(String(value));
  }
  // An exponent beyond ±MAX_EXPONENT would build an enormous plain-text string (same bound as
  // the typed price grammar, `plainDecimal`).
  if (parsed !== null && !parsed.isZero() && Math.abs(parsed.e) > MAX_EXPONENT) parsed = null;
  if (parsed === null)
    throw fieldError(
      field,
      "decimal_type",
      "expected a Decimal, a decimal string or a finite number",
    );
  return parsed.toFixed();
}
