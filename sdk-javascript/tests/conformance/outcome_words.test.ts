// outcome_words.json: the order outcome log (logger tradesmart.orders) of one call, driven through
// the real client and an undici MockAgent (sdk-behaviour.md §5.6; design §7.8). The vector's
// `KeyboardInterrupt` is an abort fired from `onSent`: the call rejects with the abort reason.
import { afterEach, describe, expect, it } from "vitest";
import {
  errorName,
  invoke,
  POOL_TIMEOUT_CONFIG,
  scriptedClient,
  type Reply,
  type Scripted,
} from "../helpers/scripted-client.js";
import { loadVector } from "./vectors.js";
import { JsonNumber } from "../../src/lib/json.js";

interface Input {
  call: string;
  closed: boolean;
  invalid_parameters: boolean;
  order_rate_limit_max_wait: JsonNumber;
  prior_orders: JsonNumber;
  rate_limit_mode: "wait" | "raise";
  replies: { status?: JsonNumber; body?: string; failure?: string }[];
  token: "valid" | "none" | "expired";
}
interface Expected {
  error: string | null;
  info: string | null;
  requests: JsonNumber;
  warning: string | null;
}

const ACK = '{"stat":"Ok","norenordno":"26111000000001","request_time":"10:00:00 10-11-2026"}';
const open: Scripted[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.agent.close();
});

describe("outcome_words.json", () => {
  for (const c of loadVector("outcome_words.json").cases) {
    it(c.name, async () => {
      const input = c.input as Input;
      const expected = c.expected as Expected;
      const prior = Number(input.prior_orders.text);
      const replies: Reply[] = [
        ...Array.from({ length: prior }, () => ({ body: ACK })),
        ...input.replies.map((r) => ({
          ...(r.status === undefined ? {} : { status: Number(r.status.text) }),
          ...(r.body === undefined ? {} : { body: r.body }),
          ...(r.failure === undefined ? {} : { failure: r.failure }),
        })),
      ];
      // A pool-wait timeout is real: the only permit is held, so the SDK's wait times out.
      const pool = replies.some((r) => r.failure === "pool_timeout");
      const s = scriptedClient(pool ? [{ body: ACK }] : replies, {
        token: input.token,
        config: {
          rateLimitMode: input.rate_limit_mode,
          orderRateLimitMaxWait: Number(input.order_rate_limit_max_wait.text),
          ...(pool ? POOL_TIMEOUT_CONFIG : {}),
        },
      });
      open.push(s);
      // The prior orders share one instant with the call (the FakeClock only moves on a sleep).
      for (let i = 0; i < prior; i += 1) await invoke(s, "place_order");
      const before = s.sends;
      if (input.closed) await s.client.close();
      s.lines.length = 0;

      const hold = pool ? s.holdPermit() : null;
      let error: string | null = null;
      try {
        await invoke(s, input.call, {
          invalid: input.invalid_parameters,
          signal: s.interrupt.signal,
        });
      } catch (e) {
        error = errorName(s, e);
      }
      hold?.release();
      await hold?.done;

      const orders = s.lines.filter((l) => l.ctx?.logger === "tradesmart.orders");
      const info = orders.filter((l) => l.level === "info").map((l) => l.msg);
      const warning = orders.filter((l) => l.level === "warn").map((l) => l.msg);
      expect(info.length).toBeLessThanOrEqual(1);
      expect(warning.length).toBeLessThanOrEqual(1);
      for (const line of info) expect(line).toMatch(/ in \d+ ms$/);
      expect(info[0]?.replace(/ in \d+ ms$/, "") ?? null).toBe(expected.info);
      expect(warning[0] ?? null).toBe(expected.warning);
      expect(error).toBe(expected.error);
      expect(s.sends - before).toBe(Number(expected.requests.text));
    });
  }
});
