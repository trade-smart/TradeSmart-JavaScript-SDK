// `orderRoomWait`: the read-only query "seconds until n more orders fit the per-minute window"
// (Python: RateLimiter.wait_for(n, 60.0)); it records nothing.
import { describe, expect, it } from "vitest";
import { ClientConfig } from "../../src/config.js";
import { RateLimiter } from "../../src/lib/ratelimit.js";
import { FakeClock } from "../helpers/fake-clock.js";

describe("RateLimiter.orderRoomWait", () => {
  it("is 0 on an empty window and records nothing", async () => {
    const clock = new FakeClock();
    const rl = new RateLimiter(
      ClientConfig.create({ orderRateLimitPerMinute: 5, orderRateLimitPerSecond: 5 }),
      clock,
    );
    expect(rl.orderRoomWait(5)).toBe(0);
    expect(rl.orderRoomWait(5)).toBe(0);
    for (let i = 0; i < 5; i++) await rl.acquire("orders", "PlaceOrder");
  });

  it("is the time until enough stamps leave the rolling minute, in seconds", async () => {
    const clock = new FakeClock();
    const rl = new RateLimiter(
      ClientConfig.create({ orderRateLimitPerMinute: 5, orderRateLimitPerSecond: 5 }),
      clock,
    );
    for (let i = 0; i < 4; i++) {
      await rl.acquire("orders", "PlaceOrder");
      clock.time += 1000; // stamps at 0, 1000, 2000, 3000; now 4000
    }
    expect(rl.orderRoomWait(1)).toBe(0);
    expect(rl.orderRoomWait(2)).toBeCloseTo(56, 6); // stamp 0 expires at 60000
    expect(rl.orderRoomWait(4)).toBeCloseTo(58, 6); // stamps 0..2 must expire
  });

  it("ignores stamps outside the minute and is Infinity above the window's count", async () => {
    const clock = new FakeClock();
    const rl = new RateLimiter(
      ClientConfig.create({ orderRateLimitPerMinute: 3, orderRateLimitPerSecond: 3 }),
      clock,
    );
    await rl.acquire("orders", "PlaceOrder");
    clock.time = 60_000;
    expect(rl.orderRoomWait(3)).toBe(0);
    expect(rl.orderRoomWait(4)).toBe(Number.POSITIVE_INFINITY);
  });
});
