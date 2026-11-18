// `tradesmart/greeks`: option Greeks and implied volatility (estimates computed by the SDK).
//
// Black-76 on a future's price (the default) and Black-Scholes-Merton on spot with a continuous
// dividend yield. Conventions: `years` is calendar time in years of 365 days; `rate` and
// `dividendYield` are annual and continuously compounded (0.065 = 6.5 %); theta is per calendar
// day, vega per 0.01 volatility, rho per 0.01 rate. Time to expiry is floored at one minute inside
// the formulas (`yearsToExpiry` reports the real value); any non-finite value becomes `null`.
// These are model estimates and must not be the sole basis of risk decisions.
import type { Greeks } from "../models/generated/greeks.js";
import { solveIv } from "./iv.js";
import { DAYS_PER_YEAR, MIN_YEARS, NEAR_EXPIRY_YEARS, discount, value } from "./math.js";

export type { Greeks } from "../models/generated/greeks.js";
export { MIN_YEARS, NEAR_EXPIRY_YEARS };

/** Default risk-free rate: 6.5 % a year, continuously compounded. */
export const DEFAULT_RATE = 0.065;
/** Default dividend yield (annual, continuous); used by Black-Scholes-Merton only. */
export const DEFAULT_DIVIDEND_YIELD = 0;

export type GreeksStatus =
  "ok" | "near_expiry" | "expired" | "no_price" | "price_at_or_below_intrinsic";
export type OptionSide = "CE" | "CALL" | "PE" | "PUT";
export type PricingModel = "black76" | "bsm";

// ----- argument checks -----

/** A JavaScript number (not a boolean, bigint, string or object); `RangeError` naming the parameter otherwise. */
function num(v: unknown, name: string): number {
  if (typeof v !== "number") {
    throw new RangeError(`${name} must be a number, got ${describe(v)}`);
  }
  return v;
}

function describe(v: unknown): string {
  if (typeof v === "bigint") return `${v.toString()}n`;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  return v === null || v === undefined ? String(v) : "a non-number value";
}

function numOrNull(v: unknown, name: string): number | null {
  return v === null || v === undefined ? null : num(v, name);
}

function requirePositive(name: string, v: number): void {
  if (!(Number.isFinite(v) && v > 0)) {
    throw new RangeError(`${name} must be a positive finite number, got ${String(v)}`);
  }
}

function requireFinite(name: string, v: number): void {
  if (!Number.isFinite(v))
    throw new RangeError(`${name} must be a finite number, got ${String(v)}`);
}

function isCall(optionType: unknown): boolean {
  const kind = typeof optionType === "string" ? optionType.trim().toUpperCase() : "";
  if (kind === "CE" || kind === "CALL") return true;
  if (kind === "PE" || kind === "PUT") return false;
  throw new RangeError(`optionType must be 'CE'/'CALL' or 'PE'/'PUT', got ${describe(optionType)}`);
}

function isBsm(model: unknown): boolean {
  const name = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (name !== "black76" && name !== "bsm") {
    throw new RangeError(`model must be 'black76' or 'bsm', got ${describe(model)}`);
  }
  return name === "bsm";
}

function finite(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

function liveStatus(years: number): GreeksStatus {
  return years < NEAR_EXPIRY_YEARS ? "near_expiry" : "ok";
}

// ----- at-expiry results -----

function atExpiry(
  underlying: number,
  strike: number,
  call: boolean,
  years: number,
  price: number,
  status: GreeksStatus,
): Greeks {
  let delta: number;
  if (underlying > strike) delta = call ? 1 : 0;
  else if (underlying < strike) delta = call ? 0 : -1;
  else delta = call ? 0.5 : -0.5;
  return {
    price: finite(price),
    iv: null,
    delta,
    gamma: 0,
    theta: 0,
    vega: 0,
    rho: 0,
    status,
    yearsToExpiry: years,
  };
}

function expired(underlying: number, strike: number, call: boolean, years: number): Greeks {
  const intrinsic = call ? Math.max(underlying - strike, 0) : Math.max(strike - underlying, 0);
  return atExpiry(underlying, strike, call, years, intrinsic, "expired");
}

function modelGreeks(
  underlying: number,
  strike: number,
  years: number,
  rate: number,
  vol: number,
  call: boolean,
  q: number,
  bsm: boolean,
): Greeks {
  if (years <= 0) return expired(underlying, strike, call, years);
  const t = Math.max(years, MIN_YEARS);
  const v = value(underlying, strike, t, rate, vol, call, q, bsm);
  return {
    price: finite(v.price),
    iv: finite(vol),
    delta: finite(v.delta),
    gamma: finite(v.gamma),
    theta: finite(v.theta / DAYS_PER_YEAR),
    vega: finite(v.vega * 0.01),
    rho: finite(v.rho * 0.01),
    status: liveStatus(years),
    yearsToExpiry: years,
  };
}

// ----- public API -----

/**
 * Black-76 price and Greeks for a European option on a future (`forward` is the future's price).
 * `delta` and `gamma` are with respect to the future; `rho` holds it fixed. `years <= 0` returns
 * the at-expiry result (`status: "expired"`). Invalid input throws `RangeError`.
 */
export function black76(
  forward: number,
  strike: number,
  years: number,
  rate: number,
  volatility: number,
  optionType: OptionSide,
): Greeks {
  const f = num(forward, "forward");
  const k = num(strike, "strike");
  const t = num(years, "years");
  const r = num(rate, "rate");
  const vol = num(volatility, "volatility");
  const call = isCall(optionType);
  requirePositive("forward", f);
  requirePositive("strike", k);
  requireFinite("years", t);
  requireFinite("rate", r);
  requirePositive("volatility", vol);
  return modelGreeks(f, k, t, r, vol, call, 0, false);
}

/**
 * Black-Scholes-Merton price and Greeks on spot with a continuous `dividendYield`.
 * `years <= 0` returns the at-expiry result (`status: "expired"`).
 */
export function blackScholes(
  spot: number,
  strike: number,
  years: number,
  rate: number,
  volatility: number,
  optionType: OptionSide,
  options: { dividendYield?: number } = {},
): Greeks {
  const s = num(spot, "spot");
  const k = num(strike, "strike");
  const t = num(years, "years");
  const r = num(rate, "rate");
  const vol = num(volatility, "volatility");
  const q = num(options.dividendYield ?? DEFAULT_DIVIDEND_YIELD, "dividendYield");
  const call = isCall(optionType);
  requirePositive("spot", s);
  requirePositive("strike", k);
  requireFinite("years", t);
  requireFinite("rate", r);
  requireFinite("dividendYield", q);
  requirePositive("volatility", vol);
  return modelGreeks(s, k, t, r, vol, call, q, true);
}

/**
 * Volatility (0.01 %-500 %) that reproduces `optionPrice` within 1e-8, else `null`. `underlying`
 * is the future's price for `"black76"` and spot for `"bsm"`. `null` for a non-positive or
 * non-finite price, an expired option (`years <= 0`), or a price no volatility in range gives.
 */
export function impliedVolatility(
  optionPrice: number,
  underlying: number,
  strike: number,
  years: number,
  rate: number,
  optionType: OptionSide,
  options: { model?: PricingModel; dividendYield?: number } = {},
): number | null {
  const price = num(optionPrice, "optionPrice");
  const u = num(underlying, "underlying");
  const k = num(strike, "strike");
  const t = num(years, "years");
  const r = num(rate, "rate");
  const q = num(options.dividendYield ?? DEFAULT_DIVIDEND_YIELD, "dividendYield");
  const call = isCall(optionType);
  const bsm = isBsm(options.model ?? "black76");
  requirePositive("underlying", u);
  requirePositive("strike", k);
  requireFinite("years", t);
  requireFinite("rate", r);
  requireFinite("dividendYield", q);
  return solve(price, u, k, t, r, call, q, bsm);
}

function solve(
  price: number,
  u: number,
  k: number,
  years: number,
  rate: number,
  call: boolean,
  q: number,
  bsm: boolean,
): number | null {
  if (!(Number.isFinite(price) && price > 0) || years <= 0) return null;
  const t = Math.max(years, MIN_YEARS);
  const sigma = solveIv(price, (vol) => {
    const v = value(u, k, t, rate, vol, call, q, bsm);
    return [v.price, v.vega] as const;
  });
  return sigma === null ? null : finite(sigma);
}

/**
 * Implied volatility and Greeks from a traded option price, with the expiry-day rules of
 * sdk-behaviour.md §10.5 (status precedence: no underlying, expired, no price, at or below
 * intrinsic or no volatility found, near expiry, ok). `underlying` is the future's price for
 * `"black76"` and spot for `"bsm"`; `tickSize` widens the intrinsic test by half a tick.
 */
export function greeksFromPrice(
  optionPrice: number | null,
  underlying: number | null,
  strike: number,
  years: number,
  rate: number,
  optionType: OptionSide,
  options: { model?: PricingModel; dividendYield?: number; tickSize?: number } = {},
): Greeks {
  const price = numOrNull(optionPrice, "optionPrice");
  const u = numOrNull(underlying, "underlying");
  const k = num(strike, "strike");
  const t = num(years, "years");
  const r = num(rate, "rate");
  const q = num(options.dividendYield ?? DEFAULT_DIVIDEND_YIELD, "dividendYield");
  const tick = num(options.tickSize ?? 0, "tickSize");
  const call = isCall(optionType);
  const bsm = isBsm(options.model ?? "black76");
  requirePositive("strike", k);
  requireFinite("years", t);
  requireFinite("rate", r);
  requireFinite("dividendYield", q);
  requireFinite("tickSize", tick);

  const noPrice: Greeks = {
    price: null,
    iv: null,
    delta: null,
    gamma: null,
    theta: null,
    vega: null,
    rho: null,
    status: "no_price",
    yearsToExpiry: t,
  };
  if (u === null || !(Number.isFinite(u) && u > 0)) return noPrice;
  if (t <= 0) return expired(u, k, call, t);
  if (price === null || !(Number.isFinite(price) && price > 0)) return noPrice;

  const floored = Math.max(t, MIN_YEARS);
  const discK = discount("rate", r, floored);
  const discU = bsm ? discount("dividendYield", q, floored) : discK;
  const forwardValue = u * discU - k * discK;
  const intrinsic = call ? Math.max(forwardValue, 0) : Math.max(-forwardValue, 0);

  let iv: number | null = null;
  if (price > intrinsic + Math.max(tick, 0) / 2) iv = solve(price, u, k, t, r, call, q, bsm);
  if (iv === null) return atExpiry(u, k, call, t, price, "price_at_or_below_intrinsic");
  const result = modelGreeks(u, k, t, r, iv, call, q, bsm);
  return { ...result, price, yearsToExpiry: t };
}
