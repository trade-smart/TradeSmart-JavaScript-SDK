// request_names.json: the low-level `request()` (sdk-behaviour.md §2.5): the name rules through
// `canonicalEndpoint`, and the exact body, the `uid` default, the wire values and the `null`
// TypeError through the real client (`TradeSmart.request`) on an undici MockAgent.
import { afterEach, describe, expect, it } from "vitest";
import { canonicalEndpoint } from "../../src/lib/names.js";
import { ConfigurationError } from "../../src/errors.js";
import { JsonNumber } from "../../src/lib/json.js";
import { scriptedClient, type Scripted } from "../helpers/scripted-client.js";
import { loadVector } from "./vectors.js";

interface Input {
  endpoint: string;
  expect: "object" | "list";
  payload: [string, unknown][];
  state_changing: boolean;
}
interface Expected {
  error?: string;
  allow_empty?: boolean;
  body?: string;
  endpoint?: string;
  expect?: string;
  rate_group?: "place_order" | "quotes" | "tpseries" | null;
  requires_ack_id?: string | null;
  state_changing?: boolean;
  success_stats?: string[];
}

const RATE_GROUPS = { place_order: "orders", quotes: "quotes", tpseries: "tpseries" } as const;

/** The vector's JSON values as a JavaScript caller passes them (numbers as `number`). */
function callerValue(value: unknown): unknown {
  return value instanceof JsonNumber ? Number(value.text) : value;
}

const open: Scripted[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.agent.close();
});

describe("request_names.json", () => {
  const vector = loadVector("request_names.json");
  for (const c of vector.cases) {
    it(c.name, async () => {
      const input = c.input as Input;
      const expected = c.expected as Expected;
      const s = scriptedClient([{ body: '{"stat":"Ok"}' }]);
      open.push(s);
      const payload = Object.fromEntries(
        input.payload.map(([key, value]) => [key, callerValue(value)]),
      ) as Record<string, string>;
      const call = s.client.request(input.endpoint, payload, {
        stateChanging: input.state_changing,
        expect: input.expect,
      });
      if (expected.error === "ConfigurationError") {
        expect(() => canonicalEndpoint(input.endpoint)).toThrow(ConfigurationError);
        await expect(call).rejects.toThrow(ConfigurationError);
        expect(s.sends).toBe(0);
        return;
      }
      if (expected.error === "TypeError") {
        await expect(call).rejects.toThrow(TypeError);
        expect(s.sends).toBe(0);
        return;
      }
      await call.catch(() => undefined); // the reply is not what this vector checks
      const info = canonicalEndpoint(input.endpoint);
      expect(info.endpoint).toBe(expected.endpoint);
      expect(input.state_changing || info.stateChanging).toBe(expected.state_changing);
      const group = expected.rate_group ? RATE_GROUPS[expected.rate_group] : null;
      expect(info.rateGroup).toBe(group);
      expect([...info.successWords]).toEqual(expected.success_stats);
      expect(info.requiresAckId).toBe(expected.requires_ack_id);
      expect(s.hits).toBe(1);
      expect(s.bodies[0]).toBe(expected.body);
    });
  }
});
