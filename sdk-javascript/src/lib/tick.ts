// `roundToTick` (sdk-behaviour.md §2.7): Decimal arithmetic only, never `Math.round` or floats.
import { D, Decimal, decimalFromText } from "./decimal.js";

/** A finite decimal from a `Decimal`, decimal text or a finite number (via its shortest text). */
function toFinite(value: unknown, name: string): Decimal {
  let parsed: Decimal | null = null;
  if (value instanceof Decimal) {
    parsed = value.isFinite() ? new D(value) : null;
  } else if (typeof value === "string") {
    parsed = decimalFromText(value);
  } else if (typeof value === "number") {
    parsed = decimalFromText(String(value));
  }
  if (parsed === null) throw new RangeError(`${name} must be a finite number`);
  return parsed;
}

/**
 * Round `price` to the nearest multiple of `tickSize`, a half-way price away from zero
 * (`-100.025` at tick `0.05` gives `-100.05`), written with the tick's decimal places (trailing
 * zeros of the tick ignored). Throws `RangeError` for a tick of zero or below or a non-finite or
 * non-numeric input; the message never contains the value.
 */
export function roundToTick(
  price: Decimal | string | number,
  tickSize: Decimal | string | number,
): string {
  const tick = toFinite(tickSize, "tickSize");
  if (!tick.isPositive() || tick.isZero()) throw new RangeError("tickSize must be greater than 0");
  const value = toFinite(price, "price");
  const ticks = value.div(tick).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const result = ticks.mul(tick);
  // Like the Python reference, a negative price that rounds to zero keeps its sign ("-0.00").
  // (`toFixed` drops the sign of a zero, so it is put back: the tick is positive, so the sign of the
  // result is the sign of the price.)
  const text = result.toFixed(tick.decimalPlaces());
  return result.isZero() && value.isNegative() ? `-${text}` : text;
}
