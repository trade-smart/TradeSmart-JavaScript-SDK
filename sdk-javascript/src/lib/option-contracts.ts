// Option contracts, their underlying future, expiry instants and the carry-adjusted forward
// (sdk-behaviour.md §10.2-10.4; Python: _option_contracts.py). Internal: no I/O, no public export.
// Every error is a `RangeError` (the vectors' `ValueError`).
import type { Decimal } from "decimal.js";
import type { ScriptMasterRow } from "../instruments/parse.js";
import { decimalFromText, plainDecimal } from "./decimal.js";
import { expOrRangeError } from "../greeks/math.js";

/** The exchange close (IST, `HH:MM`) an expiry instant defaults to. */
export const EXPIRY_CLOSE: Readonly<Record<string, string>> = {
  NFO: "15:30",
  BFO: "15:30",
  CDS: "12:30",
  BCD: "12:30",
  MCX: "23:30",
};

const SECONDS_PER_YEAR = 365 * 86400;
const IST_OFFSET_MS = 330 * 60_000;
/** Exchanges whose options are written on the future itself (no carry). */
const OPTIONS_ON_FUTURES = new Set(["MCX"]);
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const SCRIPT_DATE = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/;

/** `YYYY-MM-DD` when it is a real calendar date, else `null`. */
function checkedIso(year: number, month: number, day: number): string | null {
  const probe = new Date(Date.UTC(2000, month - 1, day));
  probe.setUTCFullYear(year);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  const pad = (n: number, w: number): string => String(n).padStart(w, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** Script-master expiry (`26-NOV-2026`, any letter case) to `YYYY-MM-DD`, or `null`. */
function parseScriptExpiry(value: string): string | null {
  const m = SCRIPT_DATE.exec(value.trim());
  if (m === null) return null;
  const month = MONTHS.indexOf((m[2] as string).toLowerCase());
  if (month < 0) return null;
  return checkedIso(Number(m[3]), month + 1, Number(m[1]));
}

/**
 * The expiry instant: `expiry` (`YYYY-MM-DD`) at the exchange close, or at `expiryTime`
 * (`HH:MM[:SS]`, IST) when given. An unknown exchange needs `expiryTime`.
 */
export function expiryInstant(exchange: string, expiry: string, expiryTime?: string): Date {
  const date = ISO_DATE.exec(expiry);
  if (date === null || checkedIso(Number(date[1]), Number(date[2]), Number(date[3])) === null) {
    throw new RangeError(`expiry must be a YYYY-MM-DD date, got ${JSON.stringify(expiry)}`);
  }
  let clock = expiryTime;
  if (clock === undefined) {
    const key = exchange.trim().toUpperCase();
    clock = Object.hasOwn(EXPIRY_CLOSE, key) ? EXPIRY_CLOSE[key] : undefined;
    if (clock === undefined) {
      throw new RangeError(
        `unknown exchange ${JSON.stringify(exchange)}: pass expiryTime explicitly`,
      );
    }
  }
  const t = CLOCK.exec(clock);
  if (t === null || Number(t[1]) > 23 || Number(t[2]) > 59 || Number(t[3] ?? "0") > 59) {
    throw new RangeError(`expiryTime must be HH:MM[:SS] in IST, got ${JSON.stringify(clock)}`);
  }
  const probe = new Date(
    Date.UTC(
      2000,
      Number(date[2]) - 1,
      Number(date[3]),
      Number(t[1]),
      Number(t[2]),
      Number(t[3] ?? "0"),
    ),
  );
  probe.setUTCFullYear(Number(date[1]));
  return new Date(probe.getTime() - IST_OFFSET_MS);
}

/** True once the expiry instant is at or before `now`. */
export function optionHasExpired(
  exchange: string,
  expiry: string,
  expiryTime: string | undefined,
  now: Date,
): boolean {
  return expiryInstant(exchange, expiry, expiryTime).getTime() <= now.getTime();
}

/** Year fraction on a 365-day basis; negative when `end` precedes `start`. */
export function yearsBetween(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / 1000 / SECONDS_PER_YEAR;
}

/** One option contract of the script master (`expiry` is `YYYY-MM-DD`). */
export interface OptionContractInfo {
  readonly exchange: string;
  readonly tradingsymbol: string;
  readonly token: string;
  readonly symbol: string;
  readonly expiry: string;
  readonly optionType: "CE" | "PE";
  readonly strike: Decimal;
  /** The strike as written in the file, trailing zeros kept (`"24000.00"`); a Decimal drops them. */
  readonly strikeText: string;
  readonly tickSize: Decimal | null;
  readonly lotSize: number | null;
}

/** The underlying future chosen for an option. */
export interface UnderlyingFuture {
  readonly tradingsymbol: string;
  readonly token: string;
  readonly expiry: string;
  readonly sameExpiry: boolean;
}

const cell = (row: ScriptMasterRow, key: string): string => row[key] ?? "";

/** Find the option row for `tradingsymbol` (trimmed, any case); a malformed match throws. */
export function findOption(
  rows: readonly ScriptMasterRow[],
  tradingsymbol: string,
): OptionContractInfo {
  const wanted = tradingsymbol.trim().toUpperCase();
  if (wanted === "") throw new RangeError("tradingsymbol is required");
  for (const row of rows) {
    if (cell(row, "TradingSymbol").trim().toUpperCase() !== wanted) continue;
    if (!cell(row, "Instrument").toUpperCase().startsWith("OPT")) continue;
    const bad = (why: string): RangeError =>
      new RangeError(`malformed instrument row for ${tradingsymbol}: ${why}`);
    const symbol = cell(row, "Symbol").trim();
    if (symbol === "") throw bad("missing Symbol");
    if (!Object.hasOwn(row, "OptionType")) throw bad("missing OptionType");
    const optionType = cell(row, "OptionType").trim().toUpperCase();
    if (optionType !== "CE" && optionType !== "PE") {
      throw bad(`OptionType ${JSON.stringify(cell(row, "OptionType"))} is not CE or PE`);
    }
    if (!Object.hasOwn(row, "Expiry")) throw bad("missing Expiry");
    const expiry = parseScriptExpiry(cell(row, "Expiry"));
    if (expiry === null) throw bad(`unparseable Expiry ${JSON.stringify(cell(row, "Expiry"))}`);
    const column = ["StrikePrice", "Strike"].find((c) => Object.hasOwn(row, c));
    if (column === undefined) throw bad("missing StrikePrice (or Strike)");
    const strikeText = plainDecimal(cell(row, column));
    const strike = decimalFromText(cell(row, column));
    if (strikeText === null || strike === null) {
      throw bad(`invalid ${column} ${JSON.stringify(cell(row, column))}`);
    }
    const lotText = cell(row, "LotSize").trim();
    let lotSize: number | null = null;
    if (lotText !== "") {
      const lot = decimalFromText(lotText);
      if (lot === null) throw bad(`invalid LotSize ${JSON.stringify(cell(row, "LotSize"))}`);
      lotSize = lot.trunc().toNumber();
    }
    return {
      exchange: cell(row, "Exchange").trim().toUpperCase(),
      tradingsymbol: cell(row, "TradingSymbol").trim(),
      token: cell(row, "Token").trim(),
      symbol,
      expiry,
      optionType,
      strike,
      strikeText: strikeText.text,
      tickSize: decimalFromText(cell(row, "TickSize")),
      lotSize,
    };
  }
  throw new RangeError(`option contract not found in instrument master: ${tradingsymbol}`);
}

/**
 * The `Symbol`s to look the future up by, in order: the option's own (trimmed, upper-cased), then,
 * when it ends in `OPT` with a stem, the stem plus `FUT` (BFO files `BSXOPT` options under `BSXFUT`).
 */
export function futureSymbols(symbol: string): string[] {
  const own = symbol.trim().toUpperCase();
  if (own.length > 3 && own.endsWith("OPT")) return [own, `${own.slice(0, -3)}FUT`];
  return [own];
}

interface DatedRow {
  readonly expiry: string;
  readonly row: ScriptMasterRow;
}

function usableFutures(
  rows: readonly ScriptMasterRow[],
  symbol: string,
  exchange: string,
): DatedRow[] {
  const out: DatedRow[] = [];
  for (const row of rows) {
    if (cell(row, "Symbol").trim().toUpperCase() !== symbol) continue;
    if (!cell(row, "Instrument").toUpperCase().startsWith("FUT")) continue;
    if (cell(row, "Exchange").trim().toUpperCase() !== exchange) continue;
    if (cell(row, "TradingSymbol").trim() === "") continue;
    const expiry = parseScriptExpiry(cell(row, "Expiry"));
    if (expiry !== null) out.push({ expiry, row });
  }
  return out;
}

/**
 * Pick the underlying future: the same expiry, else the nearest later, else the nearest earlier
 * (ties: first in file order). Looked up by the option's `Symbol`; only when none of its rows is
 * usable, and it ends in `OPT`, by the stem plus `FUT`.
 */
export function selectFuture(
  rows: readonly ScriptMasterRow[],
  option: Pick<OptionContractInfo, "exchange" | "expiry" | "symbol" | "tradingsymbol">,
): UnderlyingFuture {
  const symbols = futureSymbols(option.symbol);
  if (symbols[0] === "") {
    throw new RangeError(`option ${option.tradingsymbol} has a blank symbol; cannot find future`);
  }
  const exchange = option.exchange.trim().toUpperCase();
  let futures: DatedRow[] = [];
  for (const symbol of symbols) {
    futures = usableFutures(rows, symbol, exchange);
    if (futures.length > 0) break;
  }
  if (futures.length === 0) {
    const tried = symbols.length === 1 ? "" : ` (tried ${symbols.join(", ")})`;
    throw new RangeError(`no underlying future found for symbol ${symbols[0] ?? ""}${tried}`);
  }
  // ISO dates compare as text. Strict comparisons keep the first of tied rows.
  let same: DatedRow | undefined;
  let later: DatedRow | undefined;
  let earlier: DatedRow | undefined;
  for (const f of futures) {
    if (f.expiry === option.expiry) same ??= f;
    else if (f.expiry > option.expiry) {
      if (later === undefined || f.expiry < later.expiry) later = f;
    } else if (earlier === undefined || f.expiry > earlier.expiry) earlier = f;
  }
  const chosen = (same ?? later ?? earlier) as DatedRow;
  return {
    tradingsymbol: cell(chosen.row, "TradingSymbol").trim(),
    token: cell(chosen.row, "Token").trim(),
    expiry: chosen.expiry,
    sameExpiry: chosen.expiry === option.expiry,
  };
}

/**
 * Bring a future's price to the option's expiry: `F * exp(-(r - q) * (Tf - To))`. A carry factor that
 * overflows (an absurd but finite rate or yield, §10.3) is a `RangeError` naming the values; a
 * non-finite input, or a finite factor whose product with the price overflows, is a `RangeError` too.
 */
export function carryAdjustedForward(
  futurePrice: number,
  rate: number,
  futureYears: number,
  optionYears: number,
  dividendYield = 0,
): number {
  const inputs = [futurePrice, rate, futureYears, optionYears, dividendYield];
  const factor = inputs.every(Number.isFinite)
    ? expOrRangeError(
        -(rate - dividendYield) * (futureYears - optionYears),
        () =>
          "rate - dividendYield is out of range: " +
          "exp(-(rate - dividendYield) * (futureYears - optionYears)) overflows a float " +
          `(rate=${String(rate)}, dividendYield=${String(dividendYield)}, ` +
          `futureYears=${String(futureYears)}, optionYears=${String(optionYears)})`,
      )
    : Number.NaN;
  const result = futurePrice * factor;
  if (!Number.isFinite(result)) {
    throw new RangeError(
      "carry-adjusted forward is not a finite number (check rate and dividendYield)",
    );
  }
  return result;
}

export interface OptionForwardInput {
  readonly exchange: string;
  readonly optionExpiry: string;
  readonly futureExpiry: string;
  readonly futurePrice: number;
  readonly rate: number;
  readonly now: Date;
  readonly expiryTime?: string | undefined;
  readonly dividendYield?: number | undefined;
}

/**
 * The Black-76 forward for a future: carried to the option's expiry on every exchange except MCX
 * (options on the future itself); a same-expiry future is used as is.
 */
export function optionForward(input: OptionForwardInput): {
  forward: number;
  sameExpiryFuture: boolean;
} {
  const sameExpiryFuture = input.futureExpiry === input.optionExpiry;
  if (sameExpiryFuture || OPTIONS_ON_FUTURES.has(input.exchange.trim().toUpperCase())) {
    return { forward: input.futurePrice, sameExpiryFuture };
  }
  const optionAt = expiryInstant(input.exchange, input.optionExpiry, input.expiryTime);
  const futureAt = expiryInstant(input.exchange, input.futureExpiry, input.expiryTime);
  const forward = carryAdjustedForward(
    input.futurePrice,
    input.rate,
    yearsBetween(input.now, futureAt),
    yearsBetween(input.now, optionAt),
    input.dividendYield ?? 0,
  );
  return { forward, sameExpiryFuture };
}
