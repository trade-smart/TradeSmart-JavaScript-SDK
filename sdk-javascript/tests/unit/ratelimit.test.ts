import { describe, expect, it } from "vitest";
import { ClientConfig } from "../../src/config.js";
import { RateLimitError } from "../../src/errors.js";
import { RateLimiter, systemClock } from "../../src/lib/ratelimit.js";
import { FakeClock } from "../helpers/fake-clock.js";

function limiter(clock: FakeClock, opts: Parameters<typeof ClientConfig.create>[0] = {}) {
  return new RateLimiter(ClientConfig.create(opts), clock);
}

async function caught(p: Promise<void>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("RateLimiter", () => {
  it("lets 10 orders through at once, the 11th waits at most 1 s", async () => {
    const clock = new FakeClock();
    const rl = limiter(clock);
    for (let i = 0; i < 10; i++) await rl.acquire("orders", "PlaceOrder");
    expect(clock.sleeps).toEqual([]);
    await rl.acquire("orders", "PlaceOrder");
    expect(clock.sleeps).toEqual([1000]);
    expect(clock.time).toBe(1000);
  });

  it("waits only for the rest of the window", async () => {
    const clock = new FakeClock();
    const rl = limiter(clock);
    for (let i = 0; i < 10; i++) await rl.acquire("orders", "PlaceOrder");
    clock.time = 400;
    await rl.acquire("orders", "PlaceOrder");
    expect(clock.sleeps).toEqual([600]);
  });

  it("raises RateLimitError for the 201st order in a minute", async () => {
    const clock = new FakeClock();
    const rl = limiter(clock);
    for (let i = 0; i < 200; i++) {
      await rl.acquire("orders", "PlaceOrder");
      clock.time += 150; // 10 per second never trips; 200 calls span 30 s
    }
    const err = await caught(rl.acquire("orders", "PlaceOrder"));
    expect(err).toBeInstanceOf(RateLimitError);
    const e = err as RateLimitError;
    expect(e.message).toBe("client-side rate limit for place_order (200 per minute)");
    expect(e.endpoint).toBe("PlaceOrder");
    expect(e.httpStatus).toBeNull();
    expect(e.retryAfter).not.toBeNull();
    expect(e.retryAfter as number).toBeGreaterThan(1);
  });

  it("raise mode raises at once with the second window", async () => {
    const clock = new FakeClock();
    const rl = limiter(clock, { rateLimitMode: "raise" });
    for (let i = 0; i < 10; i++) await rl.acquire("orders", "PlaceOrder");
    const err = (await caught(rl.acquire("orders", "PlaceMultiOrder"))) as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.message).toBe("client-side rate limit for place_order (10 per second)");
    expect(err.endpoint).toBe("PlaceMultiOrder");
    expect(err.retryAfter).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("a refused call is not recorded", async () => {
    const clock = new FakeClock();
    const rl = limiter(clock, { rateLimitMode: "raise" });
    for (let i = 0; i < 10; i++) await rl.acquire("orders", "PlaceOrder");
    for (let i = 0; i < 5; i++) await caught(rl.acquire("orders", "PlaceOrder"));
    clock.time = 1000;
    for (let i = 0; i < 10; i++) await rl.acquire("orders", "PlaceOrder");
  });

  it("honours order_rate_limit_per_second and the max wait", async () => {
    const clock = new FakeClock();
    const rl = limiter(clock, { orderRateLimitPerSecond: 1, orderRateLimitMaxWait: 0.5 });
    await rl.acquire("orders", "PlaceOrder");
    const err = (await caught(rl.acquire("orders", "PlaceOrder"))) as RateLimitError;
    expect(err.message).toBe("client-side rate limit for place_order (1 per second)");
    expect(err.retryAfter).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("a wait exactly equal to the max wait is allowed", async () => {
    const clock = new FakeClock();
    const rl = limiter(clock, { orderRateLimitPerSecond: 1, orderRateLimitMaxWait: 1 });
    await rl.acquire("orders", "PlaceOrder");
    await rl.acquire("orders", "PlaceOrder");
    expect(clock.sleeps).toEqual([1000]);
  });

  it("quotes allow 100 per second and wait for the 101st", async () => {
    const clock = new FakeClock();
    const rl = limiter(clock);
    for (let i = 0; i < 100; i++) await rl.acquire("quotes", "GetQuotes");
    expect(clock.sleeps).toEqual([]);
    await rl.acquire("quotes", "GetQuotes");
    expect(clock.sleeps).toEqual([1000]);
  });

  it("quotes name their group in the message", async () => {
    const clock = new FakeClock();
    const rl = limiter(clock, { rateLimitMode: "raise" });
    for (let i = 0; i < 100; i++) await rl.acquire("quotes", "GetQuotes");
    const err = (await caught(rl.acquire("quotes", "GetQuotes"))) as RateLimitError;
    expect(err.message).toBe("client-side rate limit for quotes (100 per second)");
  });

  it("tpseries is limited on its own", async () => {
    const clock = new FakeClock();
    const rl = limiter(clock, { rateLimitMode: "raise" });
    for (let i = 0; i < 100; i++) await rl.acquire("tpseries", "TPSeries");
    await rl.acquire("quotes", "GetQuotes");
    const err = (await caught(rl.acquire("tpseries", "TPSeries"))) as RateLimitError;
    expect(err.message).toBe("client-side rate limit for tpseries (100 per second)");
  });

  it("a group without limits passes", async () => {
    const clock = new FakeClock();
    const rl = limiter(clock);
    for (let i = 0; i < 500; i++) await rl.acquire(null, "Limits");
    expect(clock.sleeps).toEqual([]);
  });

  it("rejects with the abort reason when aborted before the call, recording nothing", async () => {
    const clock = new FakeClock();
    const rl = limiter(clock);
    const ac = new AbortController();
    const reason = new Error("stop");
    ac.abort(reason);
    expect(await caught(rl.acquire("orders", "PlaceOrder", ac.signal))).toBe(reason);
    for (let i = 0; i < 10; i++) await rl.acquire("orders", "PlaceOrder");
    expect(clock.sleeps).toEqual([]);
  });

  it("rejects with the abort reason during a wait and leaves the windows unchanged", async () => {
    const clock = new FakeClock(false);
    const rl = limiter(clock);
    for (let i = 0; i < 10; i++) await rl.acquire("orders", "PlaceOrder");
    const ac = new AbortController();
    const pending = caught(rl.acquire("orders", "PlaceOrder", ac.signal));
    await Promise.resolve();
    expect(clock.pending).toBe(1);
    const reason = new Error("stop");
    ac.abort(reason);
    expect(await pending).toBe(reason);
    expect(clock.pending).toBe(0);
    clock.advance(1000);
    for (let i = 0; i < 10; i++) await rl.acquire("orders", "PlaceOrder");
    expect(clock.sleeps).toEqual([1000]);
  });

  it("systemClock is monotonic and sleeps", async () => {
    const a = systemClock.now();
    await systemClock.sleep(5);
    expect(systemClock.now()).toBeGreaterThanOrEqual(a + 4);
    const ac = new AbortController();
    const reason = new Error("x");
    const p = caught(systemClock.sleep(10_000, ac.signal));
    ac.abort(reason);
    expect(await p).toBe(reason);
  });
});
