// Normal distribution and the Black-76 / Black-Scholes-Merton valuation core (sans-IO, pure).
// `erfc` is a port of the FreeBSD msun `s_erf.c` routine (the one libm and Python's `math.erfc`
// use), so the normal CDF agrees with the Python SDK to about 1e-15.

export const DAYS_PER_YEAR = 365;
export const D_CLAMP = 40;
export const MIN_YEARS = 1 / (365 * 24 * 60);
export const NEAR_EXPIRY_YEARS = 30 / (365 * 24 * 60);

const SQRT_2 = Math.sqrt(2);
const SQRT_2PI = Math.sqrt(2 * Math.PI);

const erx = 8.45062911510467529297e-1;
const pp0 = 1.28379167095512558561e-1;
const pp1 = -3.2504210724700149937e-1;
const pp2 = -2.84817495755985104766e-2;
const pp3 = -5.77027029648944159157e-3;
const pp4 = -2.3763016656650163e-5;
const qq1 = 3.97917223959155352819e-1;
const qq2 = 6.50222499887672944485e-2;
const qq3 = 5.08130628187576562776e-3;
const qq4 = 1.3249473800432164e-4;
const qq5 = -3.9602282787753681232e-6;
const pa0 = -2.36211856075265944077e-3;
const pa1 = 4.14856118683748331666e-1;
const pa2 = -3.72207876035701323847e-1;
const pa3 = 3.18346619901161753674e-1;
const pa4 = -1.10894694282396677476e-1;
const pa5 = 3.54783043256182359371e-2;
const pa6 = -2.166375594868790843e-3;
const qa1 = 1.06420880400844228286e-1;
const qa2 = 5.40397917702171048937e-1;
const qa3 = 7.18286544141962662868e-2;
const qa4 = 1.26171219808761642112e-1;
const qa5 = 1.36370839120290507362e-2;
const qa6 = 1.1984499846799107417e-2;
const ra0 = -9.86494403484714822705e-3;
const ra1 = -6.93858572707181764372e-1;
const ra2 = -1.05586262253232909814e1;
const ra3 = -6.23753324503260060396e1;
const ra4 = -1.62396669462573470355e2;
const ra5 = -1.84605092906711035994e2;
const ra6 = -8.12874355063065934246e1;
const ra7 = -9.81432934416914548592;
const sa1 = 1.96512716674392571292e1;
const sa2 = 1.376577541435190426e2;
const sa3 = 4.34565877475229228821e2;
const sa4 = 6.45387271733267880336e2;
const sa5 = 4.29008140027567833386e2;
const sa6 = 1.08635005541779435134e2;
const sa7 = 6.57024977031928170135;
const sa8 = -6.04244152148580987438e-2;
const rb0 = -9.86494292470009928597e-3;
const rb1 = -7.99283237680523006574e-1;
const rb2 = -1.77579549177547519889e1;
const rb3 = -1.60636384855821916062e2;
const rb4 = -6.37566443368389627722e2;
const rb5 = -1.02509513161107724954e3;
const rb6 = -4.83519191608651397019e2;
const sb1 = 3.03380607434824582924e1;
const sb2 = 3.25792512996573918826e2;
const sb3 = 1.53672958608443695994e3;
const sb4 = 3.19985821950859553908e3;
const sb5 = 2.55305040643316442583e3;
const sb6 = 4.74528541206955367215e2;
const sb7 = -2.24409524465858183362e1;

const view = new DataView(new ArrayBuffer(8));

/** The high 32 bits of a double (sign, exponent, top mantissa bits). */
function highWord(x: number): number {
  view.setFloat64(0, x);
  return view.getUint32(0);
}

/** `x` with the low 32 bits of its mantissa cleared. */
function clearLowWord(x: number): number {
  view.setFloat64(0, x);
  view.setUint32(4, 0);
  return view.getFloat64(0);
}

/** Complementary error function (msun `erfc`). */
export function erfc(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  const negative = (hx & 0x80000000) !== 0;
  if (ix >= 0x7ff00000) return negative ? 2 : 0;
  if (ix < 0x3feb0000) {
    // |x| < 0.84375
    if (ix < 0x3c700000) return 1 - x;
    const z = x * x;
    const r = pp0 + z * (pp1 + z * (pp2 + z * (pp3 + z * pp4)));
    const s = 1 + z * (qq1 + z * (qq2 + z * (qq3 + z * (qq4 + z * qq5))));
    const y = r / s;
    if (negative || ix < 0x3fd00000) return 1 - (x + x * y);
    return 0.5 - (x * y + (x - 0.5));
  }
  if (ix < 0x3ff40000) {
    // 0.84375 <= |x| < 1.25
    const s = Math.abs(x) - 1;
    const p = pa0 + s * (pa1 + s * (pa2 + s * (pa3 + s * (pa4 + s * (pa5 + s * pa6)))));
    const q = 1 + s * (qa1 + s * (qa2 + s * (qa3 + s * (qa4 + s * (qa5 + s * qa6)))));
    return negative ? 1 + (erx + p / q) : 1 - erx - p / q;
  }
  if (ix < 0x403c0000) {
    // 1.25 <= |x| < 28
    const ax = Math.abs(x);
    const s = 1 / (ax * ax);
    let r: number;
    let t: number;
    if (ix < 0x4006db6d) {
      r = ra0 + s * (ra1 + s * (ra2 + s * (ra3 + s * (ra4 + s * (ra5 + s * (ra6 + s * ra7))))));
      t =
        1 +
        s * (sa1 + s * (sa2 + s * (sa3 + s * (sa4 + s * (sa5 + s * (sa6 + s * (sa7 + s * sa8)))))));
    } else {
      if (negative && ix >= 0x40180000) return 2;
      r = rb0 + s * (rb1 + s * (rb2 + s * (rb3 + s * (rb4 + s * (rb5 + s * rb6)))));
      t = 1 + s * (sb1 + s * (sb2 + s * (sb3 + s * (sb4 + s * (sb5 + s * (sb6 + s * sb7))))));
    }
    const z = clearLowWord(ax);
    const q = Math.exp(-z * z - 0.5625) * Math.exp((z - ax) * (z + ax) + r / t);
    return negative ? 2 - q / ax : q / ax;
  }
  return negative ? 2 : 0;
}

/** Standard normal CDF, `0.5 * erfc(-x / sqrt(2))`. */
export function cdf(x: number): number {
  return 0.5 * erfc(-x / SQRT_2);
}

/** Standard normal density. */
export function pdf(x: number): number {
  return Math.exp((-x * x) / 2) / SQRT_2PI;
}

/**
 * `Math.exp(exponent)`; a result too large for a double (an absurd but finite rate or yield) is a
 * `RangeError(message())` (§10.3 "Rate and yield range"). A factor that underflows to 0 is kept.
 */
export function expOrRangeError(exponent: number, message: () => string): number {
  const factor = Math.exp(exponent);
  if (factor === Infinity) throw new RangeError(message());
  return factor;
}

/** `exp(-value * years)` for the parameter `name` (`rate` or `dividendYield`), checked for overflow. */
export function discount(name: string, value: number, years: number): number {
  return expOrRangeError(
    -value * years,
    () =>
      `${name} is out of range: exp(-${name} * years) overflows a float ` +
      `(${name}=${String(value)}, years=${String(years)})`,
  );
}

/** Python `max(-40, min(40, d))`: a NaN `d` keeps the first argument of `min`, so it becomes +40. */
function clamp(d: number): number {
  const upper = d < D_CLAMP ? d : D_CLAMP;
  return upper > -D_CLAMP ? upper : -D_CLAMP;
}

/** Python `math.copysign(40, x)`: the sign bit decides, so a NaN takes its own sign bit. */
function copysignClamp(x: number): number {
  return (highWord(x) & 0x80000000) !== 0 ? -D_CLAMP : D_CLAMP;
}

export interface RawValue {
  price: number;
  delta: number;
  gamma: number;
  /** Annual theta. */
  theta: number;
  /** Per 1.00 volatility. */
  vega: number;
  /** Per 1.00 rate. */
  rho: number;
}

/**
 * Price, delta, gamma, annual theta, raw vega and raw rho for `t` > 0 (already floored). Black-76 is
 * BSM with the carry equal to zero (`q = rate`) and rho holding the future fixed. If `sigma*sqrt(t)`
 * underflows to 0, `d1` takes its limit (+-40, or 0) and gamma becomes NaN; never a division error.
 */
export function value(
  underlying: number,
  strike: number,
  t: number,
  rate: number,
  vol: number,
  isCall: boolean,
  q: number,
  bsm: boolean,
): RawValue {
  const sqrtT = Math.sqrt(t);
  const sigT = vol * sqrtT;
  const discK = discount("rate", rate, t);
  const yieldRate = bsm ? q : rate;
  const discU = bsm ? discount("dividendYield", q, t) : discK;
  const drift = Math.log(underlying / strike) + (rate - yieldRate + 0.5 * vol * vol) * t;
  const limit = drift !== 0 ? copysignClamp(drift) : 0;
  const d1 = sigT > 0 ? clamp(drift / sigT) : limit;
  const d2 = clamp(d1 - sigT);
  const pdfD1 = pdf(d1);
  const uDisc = underlying * discU;
  const kDisc = strike * discK;
  const decay = (-uDisc * pdfD1 * vol) / (2 * sqrtT);
  let price: number;
  let delta: number;
  let theta: number;
  let rho: number;
  if (isCall) {
    const nd1 = cdf(d1);
    const nd2 = cdf(d2);
    price = uDisc * nd1 - kDisc * nd2;
    delta = discU * nd1;
    theta = decay - rate * kDisc * nd2 + yieldRate * uDisc * nd1;
    rho = kDisc * t * nd2;
  } else {
    const nmd1 = cdf(-d1);
    const nmd2 = cdf(-d2);
    price = kDisc * nmd2 - uDisc * nmd1;
    delta = -discU * nmd1;
    theta = decay + rate * kDisc * nmd2 - yieldRate * uDisc * nmd1;
    rho = -kDisc * t * nmd2;
  }
  if (!bsm) rho = -t * price;
  price = Math.max(price, 0);
  const gammaDenominator = underlying * sigT;
  const gamma = gammaDenominator > 0 ? (discU * pdfD1) / gammaDenominator : Number.NaN;
  const vega = uDisc * pdfD1 * sqrtT;
  return { price, delta, gamma, theta, vega, rho };
}
