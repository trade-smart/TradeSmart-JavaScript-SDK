// Client-side sliding-window rate limits (sdk-behaviour.md §3.4). Time comes from the injected
// `Clock` only, so tests drive it deterministically.
import type { ClientConfig } from "../config.js";
import { RateLimitError } from "../errors.js";
import type { RateGroup } from "./names.js";

/** Time source: `now` in milliseconds (monotonic), `sleep` in milliseconds. */
export interface Clock {
  now(): number;
  /** Resolve after `ms`; reject with `signal.reason` when the signal aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The real clock: monotonic time, timer-based sleeps. */
export const systemClock: Clock = {
  now: () => performance.now(),
  sleep(ms, signal) {
    // The abort reason is whatever the caller passed to abort(); it is re-raised unchanged.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    if (signal?.aborted === true) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};

/** `[count, window in milliseconds]`. */
type Window = readonly [number, number];

/** The group name used in messages (§3.4: the orders group is `place_order`). */
const GROUP_NAMES: Readonly<Record<RateGroup, string>> = {
  orders: "place_order",
  quotes: "quotes",
  tpseries: "tpseries",
};

function describeWindow(window: Window | null): string {
  if (window === null) return "";
  const [count, ms] = window;
  const seconds = ms / 1000;
  const unit = seconds === 1 ? "second" : seconds === 60 ? "minute" : `${String(seconds)} seconds`;
  return ` (${String(count)} per ${unit})`;
}

/** One sliding-window limiter over several `[count, ms]` windows. */
class Limiter {
  private readonly stamps: number[] = [];
  private readonly longest: number;

  constructor(
    private readonly windows: readonly Window[],
    private readonly clock: Clock,
  ) {
    this.longest = Math.max(0, ...windows.map(([count]) => count));
  }

  now(): number {
    return this.clock.now();
  }

  /**
   * Milliseconds until `n` more calls fit the window of `windowMs` (0: now); records nothing.
   * `Infinity` when `n` is more than that window's count.
   */
  waitFor(n: number, windowMs: number): number {
    const window = this.windows.find(([, ms]) => ms === windowMs);
    if (window === undefined)
      throw new RangeError(`no rate limit with a window of ${String(windowMs)} ms`);
    const allowed = window[0];
    if (n > allowed) return Number.POSITIVE_INFINITY;
    const now = this.clock.now();
    const active = this.stamps.filter((stamp) => now - stamp < windowMs);
    const mustExpire = active.length - (allowed - n);
    if (mustExpire <= 0) return 0;
    return Math.max(0, (active[mustExpire - 1] as number) + windowMs - now);
  }

  /** Record a call and return `[0, null]`, or the milliseconds to wait and the refusing window (recording nothing). */
  tryAcquire(): [number, Window | null] {
    const now = this.clock.now();
    let wait = 0;
    let refusing: Window | null = null;
    for (const window of this.windows) {
      const [count, ms] = window;
      if (this.stamps.length < count) continue;
      const oldest = this.stamps[this.stamps.length - count] as number;
      if (now - oldest < ms) {
        const needed = oldest + ms - now;
        if (needed > wait) {
          wait = needed;
          refusing = window;
        }
      }
    }
    if (wait > 0) return [wait, refusing];
    this.stamps.push(now);
    if (this.stamps.length > this.longest) this.stamps.shift();
    return [0, null];
  }
}

/** The per-client limiter: one sliding-window `Limiter` per group, created from the config. */
export class RateLimiter {
  private readonly limiters: Readonly<Record<RateGroup, Limiter>>;
  private readonly mode: "wait" | "raise";
  private readonly ordersMaxWaitMs: number;

  constructor(
    cfg: ClientConfig,
    private readonly clock: Clock,
  ) {
    this.mode = cfg.rateLimitMode;
    this.ordersMaxWaitMs = cfg.orderRateLimitMaxWait * 1000;
    const quoteWindows: readonly Window[] = [
      [100, 1000],
      [1000, 60_000],
    ];
    this.limiters = {
      orders: new Limiter(
        [
          [cfg.orderRateLimitPerSecond, 1000],
          [cfg.orderRateLimitPerMinute, 60_000],
        ],
        clock,
      ),
      quotes: new Limiter(quoteWindows, clock),
      tpseries: new Limiter(quoteWindows, clock),
    };
  }

  /**
   * Seconds until `n` more orders fit the per-minute window (0: now). Read only: nothing is
   * recorded. `Infinity` when `n` is more than the window's count.
   */
  orderRoomWait(n: number): number {
    return this.limiters.orders.waitFor(n, 60_000) / 1000;
  }

  /**
   * Take a slot in `group` (`null`: no limit), waiting for it in `wait` mode. Called before every
   * attempt, retries included. Raises `RateLimitError` (nothing sent) when in `raise` mode or when
   * the orders wait would exceed `order_rate_limit_max_wait`. An aborted `signal` rejects with its
   * reason and records nothing.
   */
  async acquire(group: RateGroup | null, endpoint: string, signal?: AbortSignal): Promise<void> {
    if (group === null) return;
    const limiter = this.limiters[group];
    const deadline = group === "orders" ? limiter.now() + this.ordersMaxWaitMs : null;
    for (;;) {
      if (signal?.aborted === true) throw signal.reason;
      const [wait, window] = limiter.tryAcquire();
      if (wait <= 0) return;
      if (this.mode === "raise" || (deadline !== null && limiter.now() + wait > deadline)) {
        throw new RateLimitError(
          `client-side rate limit for ${GROUP_NAMES[group]}${describeWindow(window)}`,
          {
            endpoint,
            httpStatus: null,
            retryAfter: wait / 1000,
          },
        );
      }
      await this.clock.sleep(wait, signal);
    }
  }
}
