// `tradesmart/analytics`: option-chain analytics (put-call ratio, max pain) and open-interest
// buildup classification (sdk-behaviour.md §11.1-11.3). All arithmetic is exact `Decimal`.
import { D, Decimal, PY, decimalFromText } from "../lib/decimal.js";
import { Buildup } from "../models/generated/enums.js";
import type {
  BuildupReading,
  ChainRow,
  MaxPain,
  OptionChainSnapshot,
} from "../models/generated/analytics.js";

export type { BuildupReading, ChainRow, MaxPain, OptionChainSnapshot };
export { Buildup };

/** What `pcr` and `maxPain` read: a snapshot, or anything with its `rows`. */
export type ChainRows = OptionChainSnapshot | { readonly rows: readonly ChainRow[] };

const ZERO = new D(0);
const ZERO_PY = new PY(0);

/** Put-call ratio: Σ PE / Σ CE of open interest (default) or volume; `null` when Σ CE is zero. */
export function pcr(snapshot: ChainRows, options?: { by?: "oi" | "volume" }): Decimal | null {
  const by: string = options?.by ?? "oi";
  if (by !== "oi" && by !== "volume") {
    throw new RangeError(`by must be 'oi' or 'volume', not ${JSON.stringify(by)}`);
  }
  // Python computes this with its default context (28 digits, half-even), so this does too.
  let puts = new PY(0);
  let calls = new PY(0);
  for (const row of snapshot.rows) {
    const value = by === "oi" ? row.openInterest : row.volume;
    const amount = value === null ? ZERO_PY : new PY(value);
    // Only the exact upper-case option types count.
    if (row.optionType === "PE") puts = puts.plus(amount);
    else if (row.optionType === "CE") calls = calls.plus(amount);
  }
  if (calls.isZero()) return null;
  return puts.div(calls);
}

/**
 * The strike that minimises the total payout to option buyers (ties go to the lowest strike) and
 * every candidate strike's payout, keyed by the strike's decimal text. `null` when no row has an
 * open-interest value.
 */
export function maxPain(snapshot: ChainRows): MaxPain | null {
  const rows = snapshot.rows;
  if (!rows.some((r) => r.openInterest !== null)) return null;
  // Distinct strikes by value (so 100 and 100.0 are one), sorted ascending.
  const strikes: Decimal[] = [];
  for (const r of rows) {
    const k = new D(r.strike);
    if (!strikes.some((s) => s.equals(k))) strikes.push(k);
  }
  strikes.sort((a, b) => a.cmp(b));
  const payouts = new Map<string, Decimal>();
  let best: Decimal | null = null;
  let bestPayout: Decimal = ZERO;
  for (const s of strikes) {
    let total = ZERO;
    for (const r of rows) {
      const oi = r.openInterest === null ? ZERO : new D(r.openInterest);
      const k = new D(r.strike);
      if (r.optionType === "CE") total = total.plus(oi.times(Decimal.max(ZERO, s.minus(k))));
      else if (r.optionType === "PE") total = total.plus(oi.times(Decimal.max(ZERO, k.minus(s))));
    }
    payouts.set(s.toFixed(), total);
    // Strictly lower only: the first (lowest) strike wins a tie.
    if (best === null || total.lt(bestPayout)) {
      best = s;
      bestPayout = total;
    }
  }
  return { strike: best as Decimal, payouts };
}

/** Classify a price / open-interest move; zero, missing or non-finite input is `neutral`. */
export function classifyBuildup(
  priceChange: Decimal | number | null,
  oiChange: Decimal | number | null,
): Buildup {
  const price = signOf(priceChange);
  const oi = signOf(oiChange);
  if (price === 0 || oi === 0) return Buildup.NEUTRAL;
  if (price > 0) return oi > 0 ? Buildup.LONG_BUILDUP : Buildup.SHORT_COVERING;
  return oi > 0 ? Buildup.SHORT_BUILDUP : Buildup.LONG_UNWINDING;
}

/** -1, 1, or 0 for zero, missing, non-finite or any value that is not a number or Decimal. */
function signOf(value: Decimal | number | null | undefined): -1 | 0 | 1 {
  if (typeof value === "number") {
    return !Number.isFinite(value) || value === 0 ? 0 : value > 0 ? 1 : -1;
  }
  if (Decimal.isDecimal(value)) {
    return !value.isFinite() || value.isZero() ? 0 : value.isPositive() ? 1 : -1;
  }
  return 0;
}

/** A snapshot value as a finite Decimal; booleans, blanks, junk, NaN and Infinity are missing. */
function num(value: unknown): Decimal | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (Decimal.isDecimal(value)) return value.isFinite() ? new D(value) : null;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") {
    const text = String(value).trim();
    return text === "" ? null : decimalFromText(text);
  }
  return null;
}

/**
 * Classify from a stream `snapshot()` mapping (wire keys `lp`, `c`, `oi`, `poi`): price change
 * `lp - c`, open-interest change `oi - poi`; unparseable values count as missing.
 */
export function buildupFromSnapshot(snapshot: Readonly<Record<string, unknown>>): BuildupReading {
  const lp = num(snapshot["lp"]);
  const c = num(snapshot["c"]);
  const oi = num(snapshot["oi"]);
  const poi = num(snapshot["poi"]);
  const priceChange = lp !== null && c !== null ? lp.minus(c) : null;
  const oiChange = oi !== null && poi !== null ? oi.minus(poi) : null;
  return {
    state: classifyBuildup(priceChange, oiChange),
    priceChange,
    oiChange,
    basis: "previous_close_and_previous_oi",
  };
}
