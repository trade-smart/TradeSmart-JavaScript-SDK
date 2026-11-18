// Shared by the analytics conformance tests: vector rows to `ChainRow`s.
import { Decimal } from "decimal.js";
import type { ChainRow } from "../../src/models/generated/analytics.js";

export interface VectorRow {
  strike: string;
  option_type: string;
  open_interest: string | null;
  volume: string | null;
}

const dec = (v: string | null): Decimal | null => (v === null ? null : new Decimal(v));

export function toRows(rows: readonly VectorRow[]): ChainRow[] {
  return rows.map((r, i) => ({
    strike: new Decimal(r.strike),
    optionType: r.option_type,
    tradingsymbol: "SYM" + String(i),
    token: String(i),
    lastPrice: null,
    openInterest: dec(r.open_interest),
    volume: dec(r.volume),
    close: null,
  }));
}
