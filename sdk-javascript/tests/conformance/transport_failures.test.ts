// transport_failures.json: a failure while a request is being sent, per kind and per call, driven
// through the real client and an undici MockAgent (sdk-behaviour.md §5.1, §5.2). `requests` counts
// the requests that reached the transport: a write is sent once and never retried; a read is
// retried for NetworkError and RequestTimeoutError (3 attempts with max_retries 2), but never for
// an error raised by the caller's own dispatcher. `pool_timeout` is real: the only permit is held
// (maxConnections 1) so the SDK's pool wait times out; `keyboard_interrupt` is an abort fired from
// `onSent` that rejects with the abort reason.
import { afterEach, describe, expect, it } from "vitest";
import {
  errorName,
  invoke,
  POOL_TIMEOUT_CONFIG,
  scriptedClient,
  type Scripted,
} from "../helpers/scripted-client.js";
import type { JsonNumber } from "../../src/lib/json.js";
import { loadVector } from "./vectors.js";

interface Input {
  call: string;
  failure: string;
}
interface Expected {
  error: string;
  requests: JsonNumber;
}

const open: Scripted[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.agent.close();
});

describe("transport_failures.json", () => {
  for (const c of loadVector("transport_failures.json").cases) {
    it(c.name, async () => {
      const input = c.input as Input;
      const expected = c.expected as Expected;
      const pool = input.failure === "pool_timeout";
      const s = scriptedClient([pool ? { body: "{}" } : { failure: input.failure }], {
        config: pool ? POOL_TIMEOUT_CONFIG : {},
      });
      open.push(s);
      const hold = pool ? s.holdPermit() : null;
      let error: string | null = null;
      try {
        await invoke(s, input.call, { signal: s.interrupt.signal });
      } catch (e) {
        error = errorName(s, e);
      }
      hold?.release();
      await hold?.done;
      expect(error).toBe(expected.error);
      expect(s.sends).toBe(Number(expected.requests.text));
      // Nothing reaches the server while the pool wait times out.
      expect(s.hits).toBe(pool ? 0 : s.sends);
    });
  }
});
