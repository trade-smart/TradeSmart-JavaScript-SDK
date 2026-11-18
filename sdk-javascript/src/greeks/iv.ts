// Implied-volatility solver (sdk-behaviour.md §10.6): bracketed Newton with bisection fallback.

const IV_LOW = 1e-4;
const IV_HIGH = 5;
const IV_PRICE_TOL = 1e-8;
const IV_MAX_ITER = 200;

/** Model price and raw vega at a volatility. */
export type PriceVega = (vol: number) => readonly [price: number, vega: number];

/** Volatility in [1e-4, 5.0] whose price is within 1e-8 of `target`, else `null`. */
export function solveIv(target: number, priceVega: PriceVega): number | null {
  let lo = IV_LOW;
  let hi = IV_HIGH;
  const fLo = priceVega(lo)[0] - target;
  if (fLo > IV_PRICE_TOL) return null; // below the cheapest price any volatility in range gives
  if (Math.abs(fLo) <= IV_PRICE_TOL) return lo;
  const fHi = priceVega(hi)[0] - target;
  if (fHi < -IV_PRICE_TOL) return null; // above the dearest price any volatility in range gives
  if (Math.abs(fHi) <= IV_PRICE_TOL) return hi;
  let sigma = 0.3;
  for (let i = 0; i < IV_MAX_ITER; i++) {
    const [price, vega] = priceVega(sigma);
    const diff = price - target;
    if (diff > 0) hi = sigma;
    else lo = sigma;
    const newton = vega > 0 ? sigma - diff / vega : Number.NaN;
    const converged = Math.abs(diff) <= IV_PRICE_TOL;
    const inside = lo < newton && newton < hi;
    if (converged && !inside) return sigma;
    if (inside) {
      if (converged) {
        // One polishing Newton step, kept only if it still re-prices within tolerance.
        const polished = priceVega(newton)[0] - target;
        return Math.abs(polished) <= IV_PRICE_TOL ? newton : sigma;
      }
      sigma = newton;
    } else {
      sigma = 0.5 * (lo + hi);
    }
    if (hi - lo <= 1e-15 * hi) break;
  }
  const final = priceVega(sigma)[0] - target;
  return Math.abs(final) <= IV_PRICE_TOL ? sigma : null;
}
