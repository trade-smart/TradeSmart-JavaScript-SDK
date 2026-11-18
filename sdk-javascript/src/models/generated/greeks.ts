// GENERATED from specifications/models.json by scripts/gen-models.ts — do not edit

/** Immutable option valuation result. */
export interface Greeks {
  readonly price: number | null;
  readonly iv: number | null;
  readonly delta: number | null;
  readonly gamma: number | null;
  readonly theta: number | null;
  readonly vega: number | null;
  readonly rho: number | null;
  readonly status: string;
  readonly yearsToExpiry: number;
}

/** `option_greeks()` result: the Greeks plus every input used, so it can be explained. */
export interface OptionGreeks {
  readonly price: number | null;
  readonly iv: number | null;
  readonly delta: number | null;
  readonly gamma: number | null;
  readonly theta: number | null;
  readonly vega: number | null;
  readonly rho: number | null;
  readonly status: string;
  readonly yearsToExpiry: number;
  readonly optionTradingsymbol: string;
  readonly optionPrice: number | null;
  readonly underlyingTradingsymbol: string | null;
  readonly underlyingPrice: number | null;
  readonly forward: number | null;
  readonly sameExpiryFuture: boolean | null;
  readonly model: string;
  readonly rate: number;
  readonly dividendYield: number;
  readonly expiry: Date;
  readonly calculatedAt: Date;
}
