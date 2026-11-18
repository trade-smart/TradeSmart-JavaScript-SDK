// Sliced orders (sdk-behaviour.md §5.7; Python: _slicing.py): split a quantity into slices that
// each fit the exchange freeze limit, plus the non-I/O steps `placeSlicedOrder` assembles: the
// script-master lookup result, the up-front refusals and the per-call accounting. Quantities are
// in trade units on every exchange, MCX included: a whole multiple of the lot size (F21).
// Messages never contain a symbol or a price (§13); Python's `ValueError` is a `RangeError`.
import { Decimal } from "decimal.js";
import type { ClientConfig } from "../config.js";
import { ConfigurationError, RateLimitError } from "../errors.js";
import type { OrderStatusUnknownError, TradeSmartError } from "../errors.js";
import type { SecurityInfo, SlicedOrderResult } from "../models/index.js";
import type { PlaceOrderParams } from "../endpoints/orders.js";
import type { ScriptMasterRow } from "../instruments/parse.js";
import type { Logger } from "./log.js";

/**
 * A type name for a thrown value, never throwing itself: an abort reason may have no constructor
 * (`Object.create(null)`), a throwing getter or be a revoked Proxy, and none of that may replace
 * the original interruption.
 */
function typeNameOf(thrown: unknown): string {
  if (typeof thrown !== "object" || thrown === null) return typeof thrown;
  try {
    const name = (thrown as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof name === "string" && name !== "" ? name : "Object";
  } catch {
    return "Object";
  }
}

export const DEFAULT_MAX_SLICES = 25;

/** Parameters of `placeSlicedOrder()`: every `placeOrder` parameter, plus the slicing limits. */
export interface PlaceSlicedOrderParams extends PlaceOrderParams {
  /** The largest slice, in trade units, a whole number of lots; never raises the freeze limit. */
  maxSliceQuantity?: number | null | undefined;
  /** At most this many slices (default 25). */
  maxSlices?: number | undefined;
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function requirePositiveInt(value: unknown, name: string): number {
  if (!isInt(value) || value < 1) throw new RangeError(`${name} must be an integer of at least 1`);
  return value;
}

/**
 * The largest quantity one slice may carry, in trade units: `floor(frzqty / lot) * lot` (a slice
 * may equal `frzqty`). `maxSliceQuantity` lowers it (never raises it) and must be a whole number
 * of lots. A freeze quantity of `null` or at most 0 is unknown: `maxSliceQuantity` is then
 * required. `RangeError` for invalid arguments or a maximum below one lot.
 */
export function maxSliceSize(
  lotSize: number,
  freezeQuantity: number | null,
  maxSliceQuantity: number | null | undefined,
): number {
  if (!isInt(lotSize) || lotSize < 1)
    throw new RangeError("lot size must be an integer of at least 1");
  if (freezeQuantity !== null && !isInt(freezeQuantity)) {
    throw new RangeError("freeze quantity must be an integer or null");
  }
  const cap =
    maxSliceQuantity === null || maxSliceQuantity === undefined
      ? null
      : requirePositiveInt(maxSliceQuantity, "max_slice_quantity");
  if (cap !== null && cap % lotSize !== 0) {
    throw new RangeError(
      `max_slice_quantity ${String(cap)} is not a whole number of lots (lot size ${String(lotSize)})`,
    );
  }
  if (freezeQuantity === null || freezeQuantity <= 0) {
    if (cap === null) {
      throw new RangeError("freeze quantity unknown for this contract: pass maxSliceQuantity");
    }
    return cap;
  }
  const lots = Math.floor(freezeQuantity / lotSize);
  if (lots < 1) {
    throw new RangeError(
      `freeze quantity ${String(freezeQuantity)} is below one lot (lot size ${String(lotSize)})`,
    );
  }
  const largest = lots * lotSize;
  return cap === null ? largest : Math.min(largest, cap);
}

/**
 * Split `quantity` into slices: as many full slices as fit, then the remainder. A quantity at or
 * below the largest slice is one slice. `RangeError` when an argument is invalid, the slice size
 * cannot be found (`maxSliceSize`), the quantity is not a whole number of lots, or more than
 * `maxSlices` slices are needed. `exchange` is validated (a string) but does not change the sizing.
 */
export function planSlices(
  exchange: string,
  quantity: number,
  lotSize: number,
  freezeQuantity: number | null,
  options: { maxSliceQuantity?: number | null | undefined; maxSlices?: number | undefined } = {},
): readonly number[] {
  if (typeof exchange !== "string") throw new RangeError("exchange must be a string");
  requirePositiveInt(quantity, "quantity");
  const maxSlices = requirePositiveInt(options.maxSlices ?? DEFAULT_MAX_SLICES, "max_slices");
  const size = maxSliceSize(lotSize, freezeQuantity, options.maxSliceQuantity);
  if (quantity % lotSize !== 0) {
    throw new RangeError(
      `quantity ${String(quantity)} is not a whole number of lots (lot size ${String(lotSize)})`,
    );
  }
  const full = Math.floor(quantity / size);
  const remainder = quantity % size;
  const count = full + (remainder > 0 ? 1 : 0);
  if (count > maxSlices) {
    throw new RangeError(
      `quantity ${String(quantity)} needs ${String(count)} slices of at most ${String(size)}, ` +
        `more than max_slices=${String(maxSlices)}; pass maxSlices of ${String(count)} or more to allow it`,
    );
  }
  const slices = new Array<number>(full).fill(size);
  if (remainder > 0) slices.push(remainder);
  return slices;
}

// --------------------------------------------------------------------------- client assembly

/** Refuse bad sizes and a non-string trading symbol before any request (`RangeError`). */
export function checkSliceArguments(
  quantity: unknown,
  maxSliceQuantity: unknown,
  maxSlices: unknown,
  tradingsymbol: unknown,
): void {
  requirePositiveInt(quantity, "quantity");
  requirePositiveInt(maxSlices, "max_slices");
  if (maxSliceQuantity !== null && maxSliceQuantity !== undefined) {
    requirePositiveInt(maxSliceQuantity, "max_slice_quantity");
  }
  if (typeof tradingsymbol !== "string" || tradingsymbol.trim() === "") {
    throw new RangeError("tradingsymbol must be a non-empty string");
  }
}

/** The script-master row's `Token` and `LotSize`; `RangeError` when no row or an unusable one. */
export function contractTokenAndLot(
  row: ScriptMasterRow | null,
  exchange: string,
): { token: string; lotSize: number } {
  if (row === null) {
    throw new RangeError(`the trading symbol was not found in the ${exchange} script master`);
  }
  const token = (row["Token"] ?? "").trim();
  let number = new Decimal(0);
  try {
    number = new Decimal((row["LotSize"] ?? "").trim());
  } catch {
    // Not a number: refused below.
  }
  if (token === "" || !number.isFinite() || number.lt(1) || !number.isInteger()) {
    throw new RangeError(
      `the trading symbol has no usable token or lot size in the ${exchange} script master`,
    );
  }
  return { token, lotSize: number.toNumber() };
}

/**
 * `frzqty` of `securityInfo()` (`null` when blank; a `frzqty` that is not an integer already
 * failed the read). Its lot size (`ls`), when present, must equal the script master's.
 */
export function freezeQuantity(info: SecurityInfo, lotSize: number): number | null {
  if (info.lotSize !== null && info.lotSize !== lotSize) {
    throw new RangeError(
      `lot size differs: GetSecurityInfo says ${String(info.lotSize)}, the script master ` +
        `${String(lotSize)} (stale data; refresh with downloadInstruments with force)`,
    );
  }
  return info.frzqty;
}

/** `disclosedQuantity` may not exceed the smallest slice (`RangeError`). */
export function checkDisclosedQuantity(
  disclosedQuantity: unknown,
  slices: readonly number[],
): void {
  const smallest = Math.min(...slices);
  if (isInt(disclosedQuantity) && disclosedQuantity > smallest) {
    throw new RangeError(
      `disclosed_quantity ${String(disclosedQuantity)} is larger than the smallest slice ${String(smallest)}`,
    );
  }
}

/**
 * Refuse (`ConfigurationError`, nothing sent) slices the client order limiter would stop part-way:
 * more than `order_rate_limit_per_minute` could never go out within one minute; more than
 * `order_rate_limit_per_second` need a wait of up to one second, which `raise` mode never does and
 * an `order_rate_limit_max_wait` below 1 cannot.
 */
export function checkOrderRateFit(sliceCount: number, config: ClientConfig): void {
  const perMinute = config.orderRateLimitPerMinute;
  if (sliceCount > perMinute) {
    throw new ConfigurationError(
      `placeSlicedOrder: ${String(sliceCount)} slices are more than ` +
        `order_rate_limit_per_minute=${String(perMinute)}, so the client-side rate limit could ` +
        "never send them all within one minute; nothing was sent. Raise " +
        "order_rate_limit_per_minute (at most 600) or send fewer slices",
    );
  }
  const perSecond = config.orderRateLimitPerSecond;
  if (sliceCount <= perSecond) return;
  let reason: string;
  if (config.rateLimitMode === "raise") {
    reason = 'rate_limit_mode="raise" never waits for the next second';
  } else if (config.orderRateLimitMaxWait < 1) {
    reason = `order_rate_limit_max_wait=${String(config.orderRateLimitMaxWait)} is below the 1 second window`;
  } else {
    return;
  }
  throw new ConfigurationError(
    `placeSlicedOrder: ${String(sliceCount)} slices are more than ` +
      `order_rate_limit_per_second=${String(perSecond)} and ${reason}, so the client-side rate ` +
      `limit would stop the order after ${String(perSecond)} slices; nothing was sent. Use ` +
      'rate_limit_mode="wait" with order_rate_limit_max_wait of at least 1.0, or send fewer slices',
  );
}

/**
 * Refuse (`RateLimitError`, nothing sent) slices the current minute has no room for. `wait` is
 * `RateLimiter.orderRoomWait`: seconds until the whole order fits the per-minute window. `raise`
 * mode never waits and a wait above `order_rate_limit_max_wait` is longer than the limiter would
 * wait, so the order would stop part-way.
 */
export function checkOrderRoom(wait: number, config: ClientConfig): void {
  if (wait <= 0) return;
  if (config.rateLimitMode === "raise" || wait > config.orderRateLimitMaxWait) {
    throw new RateLimitError(
      `client-side rate limit for place_order (${String(config.orderRateLimitPerMinute)} per minute)`,
      { endpoint: "PlaceOrder", httpStatus: null, retryAfter: wait },
    );
  }
}

/**
 * Add `note` on a new line to an `Error`'s message (Python's `add_note`), in place, and to its
 * `stack` when that starts with the old message so an uncaught rejection prints it. `defineProperty`
 * because a `DOMException`'s `message` is a prototype getter. Never fails: a value that refuses
 * (frozen, not an `Error`) is left as it was.
 */
function appendNote(thrown: unknown, note: string): void {
  if (!(thrown instanceof Error)) return;
  try {
    const before = thrown.message;
    const stack = thrown.stack;
    const head = `${thrown.name}: ${before}`;
    Object.defineProperty(thrown, "message", {
      value: `${before}\n${note}`,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    if (typeof stack === "string" && stack.startsWith(head)) {
      Object.defineProperty(thrown, "stack", {
        value: `${head}\n${note}${stack.slice(head.length)}`,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  } catch {
    // Left unchanged; the caller still rethrows the value.
  }
}

/** The slices of one `placeSlicedOrder` call and the ids acknowledged so far. */
export class SliceProgress {
  readonly orderIds: string[] = [];

  constructor(
    readonly requested: number,
    readonly slices: readonly number[],
    private readonly log: Logger,
  ) {}

  result(error: TradeSmartError | null = null): SlicedOrderResult {
    const placed = this.slices.slice(0, this.orderIds.length).reduce((a, b) => a + b, 0);
    return Object.freeze({
      requestedQuantity: this.requested,
      sliceQuantities: Object.freeze([...this.slices]),
      orderIds: Object.freeze([...this.orderIds]),
      placedQuantity: placed,
      unsentQuantity: this.requested - placed,
      complete: this.orderIds.length === this.slices.length,
      error,
    });
  }

  /** Every slice placed: the complete result, logged at INFO. */
  done(): SlicedOrderResult {
    return this.logged("complete", this.result(), false);
  }

  /** A definite failure on the next slice: the partial result with `error`, logged. */
  stopped(error: TradeSmartError): SlicedOrderResult {
    return this.logged(`stopped (${error.constructor.name})`, this.result(error), false);
  }

  /** An ambiguous slice: attach the partial result and a note to `error` (the caller re-raises). */
  unknown(error: OrderStatusUnknownError): void {
    const partial = this.result();
    error.slicedResult = partial;
    error.message +=
      `; placeSlicedOrder: slice ${String(this.orderIds.length + 1)} of ${String(this.slices.length)} ` +
      `has an unknown outcome; ${String(this.orderIds.length)} slice(s) placed ` +
      `(${String(partial.placedQuantity)} of ${String(this.requested)}), nothing more was sent. ` +
      "Check orders() before sending anything again.";
    this.logged("unknown", partial, true);
  }

  /**
   * Anything else (an abort, a non-SDK error) stopped the loop: attach the partial result as
   * `slicedResult` when the value accepts properties (never failing when it does not) and log a
   * WARNING summary. The caller re-raises the value unchanged.
   */
  interrupted(thrown: unknown): void {
    const partial = this.result();
    const name = typeNameOf(thrown);
    const count = this.orderIds.length;
    const pending =
      count < this.slices.length
        ? `slice ${String(count + 1)} of ${String(this.slices.length)} may have been sent; `
        : "";
    const note =
      `placeSlicedOrder interrupted (${name}): ${String(count)} slice(s) placed ` +
      `(order ids: ${this.orderIds.join(", ") || "none"}), quantity ` +
      `${String(partial.placedQuantity)} of ${String(this.requested)} placed, ` +
      `${String(partial.unsentQuantity)} unsent; ${pending}nothing more was sent. ` +
      "Check orders() before sending anything again.";
    try {
      if (typeof thrown === "object" && thrown !== null && Object.isExtensible(thrown)) {
        (thrown as { slicedResult?: SlicedOrderResult }).slicedResult = partial;
      }
    } catch {
      // A value that refuses properties: the summary line still names the counts.
    }
    appendNote(thrown, note);
    this.logged(`interrupted (${name})`, partial, true);
  }

  private logged(word: string, result: SlicedOrderResult, warn: boolean): SlicedOrderResult {
    const text =
      `place_sliced_order ${word}: ${String(result.orderIds.length)}/` +
      `${String(result.sliceQuantities.length)} slices placed, quantity ` +
      `${String(result.placedQuantity)} placed, ${String(result.unsentQuantity)} unsent`;
    if (result.complete && !warn) this.log.info(text);
    else this.log.warn(text);
    return result;
  }
}
