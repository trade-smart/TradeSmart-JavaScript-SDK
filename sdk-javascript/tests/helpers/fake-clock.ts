// A deterministic `Clock` for tests: time moves only when a sleep or `advance` moves it.
import type { Clock } from "../../src/lib/ratelimit.js";

interface Timer {
  due: number;
  resolve: () => void;
}

export class FakeClock implements Clock {
  /** Current virtual time in milliseconds. */
  time = 0;
  /** Every requested sleep, in milliseconds, in order. */
  readonly sleeps: number[] = [];
  private readonly timers: Timer[] = [];

  /** `auto`: a sleep completes at once and moves the time forward by its length. */
  constructor(private readonly auto = true) {}

  now(): number {
    return this.time;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    // The abort reason is whatever the caller passed to abort(); it is re-raised unchanged.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    if (signal?.aborted === true) return Promise.reject(signal.reason);
    this.sleeps.push(ms);
    return new Promise<void>((resolve, reject) => {
      if (this.auto) {
        this.time += ms;
        resolve();
        return;
      }
      const timer: Timer = { due: this.time + ms, resolve };
      this.timers.push(timer);
      signal?.addEventListener(
        "abort",
        () => {
          const i = this.timers.indexOf(timer);
          if (i >= 0) this.timers.splice(i, 1);
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  /** Move the time forward and complete the sleeps that are due. */
  advance(ms: number): void {
    this.time += ms;
    for (const timer of [...this.timers]) {
      if (timer.due <= this.time) {
        this.timers.splice(this.timers.indexOf(timer), 1);
        timer.resolve();
      }
    }
  }

  get pending(): number {
    return this.timers.length;
  }
}
