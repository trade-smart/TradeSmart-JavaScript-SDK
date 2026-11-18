// GENERATED from specifications/models.json by scripts/gen-models.ts — do not edit
import type { Decimal } from "../../lib/decimal.js";
import type { Buildup } from "./enums.js";

/** One option contract of a chain snapshot. */
export interface ChainRow {
  readonly strike: Decimal;
  readonly optionType: string;
  readonly tradingsymbol: string;
  readonly token: string;
  readonly lastPrice: Decimal | null;
  readonly openInterest: Decimal | null;
  readonly volume: Decimal | null;
  readonly close: Decimal | null;
}

/** Quotes for a set of option contracts taken at `fetched_at`. */
export interface OptionChainSnapshot {
  readonly exchange: string;
  readonly tradingsymbol: string;
  readonly fetchedAt: Date;
  readonly rows: readonly ChainRow[];
  readonly missing: readonly string[];
}

/** Max-pain strike and the total payout to option buyers at each candidate strike. */
export interface MaxPain {
  readonly strike: Decimal;
  readonly payouts: ReadonlyMap<string, Decimal>;
}

/** A buildup classification with the changes it was derived from. */
export interface BuildupReading {
  readonly state: Buildup;
  readonly priceChange: Decimal | null;
  readonly oiChange: Decimal | null;
  readonly basis: string;
}
