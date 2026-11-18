// Response field-type parsers (models.md "Field types"). Each takes the lossless-parsed wire
// value and returns the typed value, `null` for absent/blank, or throws `FieldParseError`.
import { Decimal, decimalFromText } from "./decimal.js";
import { FieldParseError } from "./field-errors.js";

import { JsonNumber } from "./json.js";
import { parseIstText } from "./time.js";

export { FieldParseError };

/** The stream "price not set" sentinel (an unsigned 32-bit value / 100): ATO, not a price. */
const ATO_PRICE = new Decimal("42949672.95");

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

/** Exact text of a number-like wire value, or `null` for other types. */
function numericText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof JsonNumber) return value.text;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function parsePrice(value: unknown): Decimal | null {
  if (isBlank(value)) return null;
  if (value instanceof Decimal) {
    if (!value.isFinite()) throw new FieldParseError("price");
    return value;
  }
  const text = numericText(value);
  const result = text === null ? null : decimalFromText(text);
  if (result === null) throw new FieldParseError("price");
  return result;
}

export function parseStreamPrice(value: unknown): Decimal | null {
  const result = parsePrice(value);
  return result?.equals(ATO_PRICE) === true ? null : result;
}

export function parseVolume(value: unknown): Decimal | null {
  return parsePrice(value);
}

export function parseQuantity(value: unknown): number | null {
  if (isBlank(value)) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new FieldParseError("quantity");
    return value;
  }
  const number = parsePrice(value);
  if (number === null || !number.isInteger()) throw new FieldParseError("quantity");
  const result = number.toNumber();
  if (!Number.isSafeInteger(result) || !new Decimal(result).equals(number)) {
    throw new FieldParseError("quantity");
  }
  return result;
}

/** Epoch seconds (text or number; a fraction is truncated) to an instant; `0` and blank are null. */
export function parseEpochTime(value: unknown): Date | null {
  if (isBlank(value)) return null;
  if (value instanceof Date) return value;
  const text = numericText(value);
  const parsed = text === null ? null : decimalFromText(text);
  if (parsed === null) throw new FieldParseError("epoch time");
  const seconds = parsed.trunc();
  if (seconds.isZero()) return null;
  const date = new Date(seconds.toNumber() * 1000);
  if (Number.isNaN(date.getTime())) throw new FieldParseError("epoch time");
  return date;
}

const MAX_SHAPES = 50; // bounded: a feed of ever-new shapes must not grow memory or logs
const reportedShapes = new Set<string>();

/** Forget the shapes already reported (tests). */
export function resetReportedShapes(): void {
  reportedShapes.clear();
}

/**
 * IST text (five documented formats) to an instant. Blank, non-string or unrecognised text is
 * `null`; an unrecognised text is reported once per distinct shape (digits as `9`, at most 50
 * shapes, never the raw value) through `onUnknownShape`.
 */
export function parseIstDateTime(
  value: unknown,
  onUnknownShape?: (shape: string) => void,
): Date | null {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const parsed = parseIstText(text);
  if (parsed !== null) return parsed;
  const shape = text.replace(/\d/g, "9").slice(0, 40);
  if (!reportedShapes.has(shape) && reportedShapes.size < MAX_SHAPES) {
    reportedShapes.add(shape);
    onUnknownShape?.(shape);
  }
  return null;
}

/** Ids and text: numbers keep their exact source text; blank text is kept as is. */
export function parseStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (value instanceof Decimal) return value.toString();
  const text = numericText(value);
  if (text === null) throw new FieldParseError("string");
  return text;
}

export interface EnumParser {
  (value: unknown): string | null;
  /** Whether a wire value is one of the known members. */
  isKnown: (value: string) => boolean;
}

/** Known and unknown values both stay strings (an unknown wire value never fails); blank is null. */
export function parseEnum(values: ReadonlySet<string>): EnumParser {
  const parse = (value: unknown): string | null => {
    if (isBlank(value)) return null;
    const text = parseStr(value);
    if (text === null) return null;
    return text;
  };
  return Object.assign(parse, { isKnown: (value: string): boolean => values.has(value) });
}
