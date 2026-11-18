// Read retries (sdk-behaviour.md §5.1): which errors are retried, the delay and `Retry-After`.
// State-changing calls are never retried; the caller passes `stateChanging` from the endpoint rules.
import type { ClientConfig } from "../config.js";
import { NetworkError, RateLimitError, RequestTimeoutError, ServerError } from "../errors.js";

/** The next retry's delay in seconds; `rng` returns a uniform value in [0, 1) (injectable for tests). */
export class RetryPolicy {
  readonly maxRetries: number;
  readonly base: number;
  readonly cap: number;
  private readonly rng: () => number;

  constructor(options: { maxRetries: number; base: number; cap: number; rng?: () => number }) {
    this.maxRetries = options.maxRetries;
    this.base = options.base;
    this.cap = options.cap;
    this.rng = options.rng ?? Math.random;
  }

  /** True only for a read whose error is a retryable kind, while `attempt` (0-based) < `maxRetries`. */
  shouldRetry(attempt: number, error: unknown, stateChanging: boolean): boolean {
    if (stateChanging || attempt >= this.maxRetries) return false;
    return (
      error instanceof NetworkError ||
      error instanceof RequestTimeoutError ||
      error instanceof RateLimitError ||
      error instanceof ServerError
    );
  }

  /**
   * Seconds to wait before retry number `attempt` (0-based). A finite `retryAfter` gives
   * `max(0, min(cap, retryAfter))` with no jitter; otherwise `min(cap, base * 2^attempt)` times a
   * uniform factor in [0.5, 1).
   */
  delay(attempt: number, retryAfter: number | null = null): number {
    if (retryAfter !== null && Number.isFinite(retryAfter)) {
      return Math.max(0, Math.min(this.cap, retryAfter));
    }
    return Math.min(this.cap, this.base * 2 ** attempt) * (0.5 + this.rng() / 2);
  }
}

/** A policy from the configuration. */
export function retryPolicy(cfg: ClientConfig, rng?: () => number): RetryPolicy {
  return new RetryPolicy({
    maxRetries: cfg.maxRetries,
    base: cfg.backoffBase,
    cap: cfg.backoffCap,
    ...(rng === undefined ? {} : { rng }),
  });
}

/** The back-off delays (seconds, no `Retry-After`) of the retries of one read call. */
export function retryDelays(cfg: ClientConfig, rng?: () => number): number[] {
  const policy = retryPolicy(cfg, rng);
  return Array.from({ length: cfg.maxRetries }, (_, attempt) => policy.delay(attempt));
}

const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * A `Retry-After` header as seconds: a finite decimal number (sign kept, surrounding white space
 * ignored). An HTTP date, `nan`, `inf` or anything else gives `null`. `now` is accepted for
 * the HTTP-date form, which the contract ignores.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- part of the contract signature
export function parseRetryAfter(header: string | null, _now: Date): number | null {
  if (header === null) return null;
  const text = header.trim();
  if (!DECIMAL.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** The header counts only on an HTTP 429; any other status leaves `retryAfter` null. */
export function retryAfterForStatus(
  httpStatus: number,
  header: string | null,
  now: Date,
): number | null {
  return httpStatus === 429 ? parseRetryAfter(header, now) : null;
}
