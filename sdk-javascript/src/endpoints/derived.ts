// Derived reads: `optionGreeks`, `optionChainSnapshot` and `buildup` (sdk-behaviour.md §10.7, §11.3,
// §11.4; Python: client.py with _option_contracts.py). They combine REST calls (through the
// client's own `quote`, `optionChain` and `historicalData`) with the script master and the
// `greeks` and `analytics` modules. The client methods delegate here, as the other groups do.
import type { Decimal } from "decimal.js";
import { APIError, NotFoundError, ResponseParseError, TradeSmartError } from "../errors.js";
import type { Exchange } from "../enums.js";
import { exchangeCode } from "../instruments/download.js";
import { futureKey, type ContractIndex } from "../instruments/cache.js";
import { classifyBuildup, maxPain, pcr } from "../analytics/index.js";
import { DEFAULT_DIVIDEND_YIELD, DEFAULT_RATE, greeksFromPrice } from "../greeks/index.js";
import { D, decimalFromText } from "../lib/decimal.js";
import {
  expiryInstant,
  findOption,
  futureSymbols,
  optionForward,
  optionHasExpired,
  selectFuture,
  yearsBetween,
  type OptionContractInfo,
  type UnderlyingFuture,
} from "../lib/option-contracts.js";
import type { ScriptMasterRow } from "../instruments/parse.js";
import type {
  BuildupReading,
  ChainRow,
  MaxPain,
  OptionChainSnapshot as ChainData,
} from "../models/generated/analytics.js";
import type { OptionGreeks } from "../models/generated/greeks.js";
import type { Candle, OptionContract, Quote } from "../models/generated/market.js";
import type { OpenEnum } from "../models/base.js";
import type { PriceInput } from "./orders.js";

/** The most quotes a chain snapshot has in flight at once (§11.4). */
export const MAX_QUOTES_IN_FLIGHT = 10;

/** What these reads need from the client; the clock is a seam for tests. */
export interface DerivedDeps {
  quote(exchange: string, token: string, signal: AbortSignal | undefined): Promise<Quote>;
  optionChain(
    exchange: string,
    tradingsymbol: string,
    strikePrice: PriceInput,
    count: number,
    signal: AbortSignal | undefined,
  ): Promise<readonly OptionContract[]>;
  historicalData(
    exchange: string,
    token: string,
    from: Date,
    to: Date,
    signal: AbortSignal | undefined,
  ): Promise<readonly Candle[]>;
  contractIndex(exchange: string, signal: AbortSignal | undefined): Promise<ContractIndex>;
  now(): Date;
}

/** Options of `optionGreeks()`. */
export interface OptionGreeksOptions {
  /** Annual, continuously compounded; default `0.065`. */
  rate?: number | undefined;
  /** Annual, continuous; default `0`. */
  dividendYield?: number | undefined;
  /** The option's price; fetched with `quote()` when omitted (and the option has not expired). */
  optionPrice?: PriceInput | null | undefined;
  /** The underlying future's price (Black-76); fetched when omitted. Not with `spotPrice`. */
  underlyingPrice?: PriceInput | null | undefined;
  /** The spot price (Black-Scholes-Merton). Not with `underlyingPrice`. */
  spotPrice?: PriceInput | null | undefined;
  /** `HH:MM[:SS]` in IST; overrides the exchange's expiry close. */
  expiryTime?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** Options of `optionChainSnapshot()`. */
export interface OptionChainSnapshotOptions {
  /** Strikes either side of the strike price; default 25. */
  count?: number | undefined;
  signal?: AbortSignal | undefined;
}

/** A chain snapshot: `GetOptionChain` plus one quote per contract (§11.4). */
export interface OptionChainSnapshot extends ChainData {
  /** Put-call ratio of open interest (`by: "oi"`, default) or volume; `null` when Σ CE is zero. */
  pcr(options?: { by?: "oi" | "volume" }): Decimal | null;
  /** The max-pain strike and the payouts, `null` when no row has open interest. */
  maxPain(): MaxPain | null;
}

/** `describe` for a message: the value as text, never an object dump. */
function show(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "bigint") return `${value.toString()}n`;
  return value === null || value === undefined ? String(value) : "a non-number value";
}

/** `rate` and `dividendYield` as finite numbers, checked before any request (§10.7 step 0). */
function checkRates(
  rate: unknown,
  dividendYield: unknown,
): { rate: number; dividendYield: number } {
  const out: number[] = [];
  for (const [name, value] of [
    ["rate", rate],
    ["dividendYield", dividendYield],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new RangeError(`${name} must be a finite number, got ${show(value)}`);
    }
    out.push(value);
  }
  return { rate: out[0] as number, dividendYield: out[1] as number };
}

/**
 * A price as a `number`: `null` or `undefined` and any non-finite value are no price (`null`); a
 * boolean, an unparseable string or any other type is a `RangeError` naming the parameter.
 */
function asNumber(value: unknown, name: string): number | null {
  if (value === null || value === undefined) return null;
  let parsed: number;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "string") {
    const decimal = decimalFromText(value);
    if (decimal === null) {
      throw new RangeError(`${name} must be a finite number, got ${JSON.stringify(value)}`);
    }
    parsed = decimal.toNumber();
  } else if (typeof (value as { toNumber?: unknown }).toNumber === "function") {
    parsed = (value as Decimal).toNumber();
  } else throw new RangeError(`${name} must be a finite number, got ${show(value)}`);
  return Number.isFinite(parsed) ? parsed : null;
}

/** True for a quote failure that concerns one contract only (§11.4); every other error propagates. */
export function isContractQuoteFailure(error: unknown): boolean {
  return (
    (error instanceof APIError && Object.getPrototypeOf(error) === APIError.prototype) ||
    error instanceof NotFoundError ||
    error instanceof ResponseParseError
  );
}

function rowsFor(index: ContractIndex, option: OptionContractInfo): readonly ScriptMasterRow[] {
  const exchange = option.exchange.trim().toUpperCase();
  return futureSymbols(option.symbol).flatMap(
    (symbol) => index.futures.get(futureKey(symbol, exchange)) ?? [],
  );
}

/**
 * The Black-76 forward. A carry factor that overflows (an absurd but finite rate) is a
 * `RangeError` (§10.3); a finite factor whose product with the price overflows leaves no forward
 * (`null`, so the status is `no_price`), as the reference's non-finite price rule does.
 */
function forwardOf(
  input: Parameters<typeof optionForward>[0],
): ReturnType<typeof optionForward> | { forward: null; sameExpiryFuture: boolean } {
  try {
    return optionForward(input);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    // Same call with a price of 1: when that also fails, the factor itself overflowed.
    optionForward({ ...input, futurePrice: 1 });
    return { forward: null, sameExpiryFuture: false };
  }
}

/** Implied volatility and Greeks of an option (§10.7). */
export async function optionGreeks(
  deps: DerivedDeps,
  exchange: OpenEnum<Exchange>,
  tradingsymbol: string,
  options: OptionGreeksOptions = {},
): Promise<OptionGreeks> {
  const { signal } = options;
  const { rate, dividendYield } = checkRates(
    options.rate === undefined ? DEFAULT_RATE : options.rate,
    options.dividendYield === undefined ? DEFAULT_DIVIDEND_YIELD : options.dividendYield,
  );
  // Every price is checked before anything is read or requested.
  asNumber(options.optionPrice, "optionPrice");
  asNumber(options.underlyingPrice, "underlyingPrice");
  asNumber(options.spotPrice, "spotPrice");
  const code = exchangeCode(exchange);
  const spotGiven = options.spotPrice !== undefined && options.spotPrice !== null;
  const underlyingGiven = options.underlyingPrice !== undefined && options.underlyingPrice !== null;
  if (spotGiven && underlyingGiven) {
    throw new RangeError(
      "pass spotPrice (Black-Scholes-Merton) or underlyingPrice (Black-76), not both",
    );
  }
  const index = await deps.contractIndex(code, signal);
  const wanted = tradingsymbol.trim().toUpperCase();
  const option = findOption(index.options.get(wanted) ?? [], tradingsymbol);
  const model = spotGiven ? "bsm" : "black76";
  const future: UnderlyingFuture | null =
    spotGiven || underlyingGiven ? null : selectFuture(rowsFor(index, option), option);

  const expired = optionHasExpired(code, option.expiry, options.expiryTime, deps.now());
  let underlyingPrice: PriceInput | null = options.underlyingPrice ?? null;
  if (future !== null) {
    try {
      underlyingPrice = (await deps.quote(code, future.token, signal)).lastPrice;
    } catch (error) {
      if (!(expired && error instanceof TradeSmartError && isContractQuoteFailure(error))) {
        throw error;
      }
      underlyingPrice = null;
    }
  }
  let optionPrice: PriceInput | null = options.optionPrice ?? null;
  if (optionPrice === null && !expired) {
    optionPrice = (await deps.quote(code, option.token, signal)).lastPrice;
  }

  const now = deps.now();
  const expiry = expiryInstant(code, option.expiry, options.expiryTime);
  const years = yearsBetween(now, expiry);
  const optionNumber = asNumber(optionPrice, "optionPrice");
  const underlying = asNumber(
    spotGiven ? options.spotPrice : underlyingPrice,
    spotGiven ? "spotPrice" : "underlyingPrice",
  );
  let forward: number | null = null;
  if (model === "black76") {
    forward = underlying;
    if (forward !== null && future !== null) {
      forward = forwardOf({
        exchange: code,
        optionExpiry: option.expiry,
        futureExpiry: future.expiry,
        futurePrice: forward,
        rate,
        now,
        expiryTime: options.expiryTime,
        dividendYield,
      }).forward;
    }
  }
  const tick = option.tickSize;
  const greeks = greeksFromPrice(
    optionNumber,
    model === "black76" ? forward : underlying,
    option.strike.toNumber(),
    years,
    rate,
    option.optionType,
    {
      model,
      dividendYield,
      tickSize: tick !== null && tick.isFinite() ? tick.toNumber() : 0,
    },
  );
  return {
    price: greeks.price,
    iv: greeks.iv,
    delta: greeks.delta,
    gamma: greeks.gamma,
    theta: greeks.theta,
    vega: greeks.vega,
    rho: greeks.rho,
    status: greeks.status,
    yearsToExpiry: greeks.yearsToExpiry,
    optionTradingsymbol: option.tradingsymbol,
    optionPrice: optionNumber,
    underlyingTradingsymbol: future === null ? null : future.tradingsymbol,
    underlyingPrice: underlying,
    forward,
    sameExpiryFuture: future === null ? null : future.sameExpiry,
    model,
    rate,
    dividendYield,
    expiry,
    calculatedAt: now,
  };
}

class ChainSnapshot implements OptionChainSnapshot {
  constructor(
    readonly exchange: string,
    readonly tradingsymbol: string,
    readonly fetchedAt: Date,
    readonly rows: readonly ChainRow[],
    readonly missing: readonly string[],
  ) {
    Object.freeze(this);
  }

  pcr(options?: { by?: "oi" | "volume" }): Decimal | null {
    return pcr(this, options);
  }

  maxPain(): MaxPain | null {
    return maxPain(this);
  }
}

/** The name a missing contract is listed under (§11.4). */
function missingName(contract: OptionContract, kind: string): string {
  const text = contract.raw["strprc"];
  const strike =
    contract.strikePrice === null
      ? "?"
      : typeof text === "string"
        ? text.trim()
        : contract.strikePrice.toFixed();
  return contract.tradingsymbol || contract.token || `${strike} ${kind || "?"}`;
}

/** `GetOptionChain` plus one quote per contract, at most 10 in flight (§11.4). */
export async function optionChainSnapshot(
  deps: DerivedDeps,
  exchange: OpenEnum<Exchange>,
  tradingsymbol: string,
  strikePrice: PriceInput,
  options: OptionChainSnapshotOptions = {},
): Promise<OptionChainSnapshot> {
  const code = exchangeCode(exchange);
  const contracts = await deps.optionChain(
    code,
    tradingsymbol,
    strikePrice,
    options.count ?? 25,
    options.signal,
  );
  const quotes: (Quote | null)[] = contracts.map(() => null);
  // The first error that is not specific to one contract stops the rest (their requests are
  // aborted) and is the one raised.
  const stop = new AbortController();
  const signal =
    options.signal === undefined ? stop.signal : AbortSignal.any([options.signal, stop.signal]);
  const state: { fatal: { error: unknown } | null } = { fatal: null };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (state.fatal === null && next < contracts.length) {
      const at = next++;
      const token = (contracts[at] as OptionContract).token;
      if (!token) continue;
      try {
        quotes[at] = await deps.quote(code, token, signal);
      } catch (error) {
        if (isContractQuoteFailure(error)) continue;
        state.fatal ??= { error };
        stop.abort();
        return;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_QUOTES_IN_FLIGHT, contracts.length) }, () => worker()),
  );
  if (state.fatal !== null) throw state.fatal.error;

  const rows: ChainRow[] = [];
  const missing: string[] = [];
  contracts.forEach((contract, at) => {
    const quote = quotes[at] ?? null;
    const kind = (contract.optionType ?? "").trim().toUpperCase();
    if (quote === null || contract.strikePrice === null || (kind !== "CE" && kind !== "PE")) {
      missing.push(missingName(contract, kind));
      return;
    }
    rows.push({
      strike: contract.strikePrice,
      optionType: kind,
      tradingsymbol: contract.tradingsymbol ?? "",
      token: contract.token ?? "",
      lastPrice: quote.lastPrice,
      openInterest: quote.openInterest,
      volume: quote.volume,
      close: quote.close,
    });
  });
  rows.sort((a, b) => {
    const byStrike = a.strike.cmp(b.strike);
    if (byStrike !== 0) return byStrike;
    return a.optionType < b.optionType ? -1 : a.optionType > b.optionType ? 1 : 0;
  });
  return new ChainSnapshot(code, tradingsymbol, deps.now(), rows, missing);
}

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** Today 00:00 IST and `now`: the `historicalData()` window `buildup()` reads. */
function sinceOpenWindow(now: Date): { start: Date; end: Date } {
  const local = now.getTime() + IST_OFFSET_MS;
  const midnight = Math.floor(local / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  return { start: new Date(midnight), end: now };
}

/**
 * Buildup: the price change since the previous close (`lp − c`) and the open-interest change since
 * today's open (the sum of `intoi`); a missing piece is `null` (§11.3).
 */
export async function buildup(
  deps: DerivedDeps,
  exchange: OpenEnum<Exchange>,
  token: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<BuildupReading> {
  const code = exchangeCode(exchange);
  const quote = await deps.quote(code, token, options.signal);
  const { start, end } = sinceOpenWindow(deps.now());
  const candles = await deps.historicalData(code, token, start, end, options.signal);
  const last = quote.lastPrice;
  const close = quote.close;
  const priceChange = last !== null && close !== null ? last.minus(close) : null;
  const changes = candles.flatMap((c) => (c.intoi === null ? [] : [c.intoi]));
  const oiChange = changes.length === 0 ? null : changes.reduce((a, b) => a.plus(b), new D(0));
  return {
    state: classifyBuildup(priceChange, oiChange),
    priceChange,
    oiChange,
    basis: "since_open",
  };
}
