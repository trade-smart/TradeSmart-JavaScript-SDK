// Client-side validation of the order and GTT parameters (sdk-behaviour.md §2.4, §2.8, §4.1),
// mirroring the request models of sdk-python/src/tradesmart/models/{orders,gtt}.py. Every check
// runs and every failure is collected (one `ValidationIssue` per failed check, `loc` = the wire
// key; a cross-field rule has an empty `loc` and is named by its message); `throwIfInvalid` then
// raises one `RequestValidationError`. A cross-field rule is skipped when a field it reads already
// failed. Messages never contain a value.
import { RequestValidationError, type ValidationIssue } from "../errors.js";
import { type EnumName, resolveEnum } from "../enums.js";
import { type PlainDecimal, priceDecimal } from "./decimal.js";

/** A price parameter: a `Decimal`, decimal text or a finite number (§7.3). */
export type { PlainDecimal };

/** The wire codes of the market order types (no price needed: `prc` is sent as `0`). */
export const MARKET_TYPES: ReadonlySet<string> = new Set(["MKT", "SL-MKT"]);
/** The wire codes of the stop-loss order types (a trigger price is required). */
export const STOP_TYPES: ReadonlySet<string> = new Set(["SL-LMT", "SL-MKT"]);

function absent(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

/** Collects the failed checks of one call's parameters. */
export class Validator {
  readonly issues: ValidationIssue[] = [];
  readonly #failed = new Set<string>();

  /** True when no check of the wire key `key` failed. */
  ok(key: string): boolean {
    return !this.#failed.has(key);
  }

  /** Record a failed field check (`loc` = the wire key). */
  fail(key: string, type: string, msg: string): null {
    this.#failed.add(key);
    this.issues.push({ type, loc: [key], msg });
    return null;
  }

  /** Record a failed cross-field rule (empty `loc`; the message names it). */
  rule(msg: string): void {
    this.issues.push({ type: "value_error", loc: [], msg });
  }

  /** The wire code of an enum value (any case, a word or the code), or `null` after an issue. */
  enumCode(name: EnumName, value: unknown, key: string): string | null {
    if (absent(value)) return this.fail(key, "missing", "is required");
    try {
      return resolveEnum(name, value, key);
    } catch (error) {
      if (!(error instanceof RequestValidationError)) throw error;
      this.#failed.add(key);
      this.issues.push(...error.errors);
      return null;
    }
  }

  /** A required string (any text, empty included); an integer is never converted. */
  text(value: unknown, key: string): string | null {
    if (absent(value)) return this.fail(key, "missing", "is required");
    if (typeof value !== "string") return this.fail(key, "string_type", "must be a string");
    return value;
  }

  /** An optional string: `null` when not given. */
  optionalText(value: unknown, key: string): string | null {
    return absent(value) ? null : this.text(value, key);
  }

  /** A required non-empty string (order ids). */
  nonEmpty(value: unknown, key: string): string | null {
    const text = this.text(value, key);
    if (text === "") return this.fail(key, "string_too_short", "must not be empty");
    return text;
  }

  /** A required string with at least one non-whitespace character (GTT tag, alert id, algo id). */
  nonBlank(value: unknown, key: string): string | null {
    const text = this.text(value, key);
    if (text !== null && !/\S/.test(text)) {
      return this.fail(key, "string_pattern_mismatch", "must not be blank");
    }
    return text;
  }

  /** A required whole number (a safe integer `number`; booleans and text refused) of at least `min`. */
  integer(value: unknown, key: string, min: number): number | null {
    if (absent(value)) return this.fail(key, "missing", "is required");
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      return this.fail(key, "int_type", "must be a whole number");
    }
    if (value < min) {
      return this.fail(
        key,
        "greater_than_equal",
        `must be greater than or equal to ${String(min)}`,
      );
    }
    return value;
  }

  /** An optional whole number of at least `min`: `null` when not given. */
  optionalInteger(value: unknown, key: string, min: number): number | null {
    return absent(value) ? null : this.integer(value, key, min);
  }

  /** An optional boolean, `fallback` when not given. */
  bool(value: unknown, key: string, fallback: boolean): boolean | null {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") return this.fail(key, "bool_type", "must be true or false");
    return value;
  }

  /**
   * A price (Python `Money`): a finite decimal, at least 0 unless `signed`. `null` when not given
   * (`required` records an issue) or invalid.
   */
  price(
    value: unknown,
    key: string,
    options: { required: boolean; signed?: boolean },
  ): PlainDecimal | null {
    if (absent(value)) {
      return options.required ? this.fail(key, "missing", "is required") : null;
    }
    const parsed = priceDecimal(value);
    if (parsed === null) {
      return this.fail(
        key,
        "decimal_type",
        "must be a Decimal, a decimal string or a finite number",
      );
    }
    if (options.signed !== true && parsed.sign < 0) {
      return this.fail(key, "greater_than_equal", "must be greater than or equal to 0");
    }
    return parsed;
  }

  /** Raise every collected issue as one `RequestValidationError` (nothing is sent). */
  throwIfInvalid(): void {
    if (this.issues.length > 0) throw new RequestValidationError(this.issues);
  }
}

/**
 * The parameters object of a typed method: an object whose keys are all in `allowed`. Anything
 * else is a programming error (`TypeError`, nothing sent), as an unknown keyword argument is in
 * Python: a misspelt optional parameter must never be dropped silently from an order.
 */
export function checkParams(
  method: string,
  params: unknown,
  allowed: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new TypeError(`${method}() parameters must be an object`);
  }
  const known = new Set(allowed);
  for (const key of Object.keys(params)) {
    if (!known.has(key)) throw new TypeError(`${method}() got an unknown parameter '${key}'`);
  }
  return params as Readonly<Record<string, unknown>>;
}

/**
 * The price rules shared by orders and GTT orders (Python `_check_price_rules` and
 * `_check_trigger_type`): price > 0 unless MKT / SL-MKT; a trigger price > 0 for SL-LMT /
 * SL-MKT and none for the other types.
 */
export function checkPriceRules(
  v: Validator,
  orderType: string | null,
  price: PlainDecimal | null,
  triggerPrice: PlainDecimal | null,
): void {
  if (orderType === null) return;
  if (price !== null && v.ok("prc") && !MARKET_TYPES.has(orderType) && price.sign <= 0) {
    v.rule("price must be greater than 0 for limit and stop-loss limit orders");
  }
  if (!v.ok("trgprc")) return;
  if (STOP_TYPES.has(orderType)) {
    if (triggerPrice === null || triggerPrice.sign <= 0) {
      v.rule("trigger_price is required and must be greater than 0 for stop-loss orders");
    }
  } else if (triggerPrice !== null) {
    v.rule("trigger_price applies to stop-loss orders (SL-LMT, SL-MKT) only");
  }
}

/**
 * The price of an order: given, or `0` for MKT / SL-MKT without one (Python
 * `_default_market_price`); otherwise required.
 */
export function orderPrice(
  v: Validator,
  value: unknown,
  orderType: string | null,
): PlainDecimal | null {
  if (absent(value) && orderType !== null && MARKET_TYPES.has(orderType)) {
    return { text: "0", sign: 0 };
  }
  return v.price(value, "prc", { required: true });
}
