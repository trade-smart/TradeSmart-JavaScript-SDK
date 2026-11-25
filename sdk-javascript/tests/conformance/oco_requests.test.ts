// oco_requests.json: the typed OCO methods drive the real client through an undici MockAgent that
// records the request (sdk-behaviour.md §2.9). A payload case pins the endpoint and the exact body
// text (the vector's key order is part of the contract, so the expected payload is encoded as
// written and compared as text); a refusal pins the error type and the one `loc` path (nothing sent).
import { afterEach, describe, expect, it } from "vitest";
import { RequestValidationError } from "../../src/errors.js";
import { JsonNumber } from "../../src/lib/json.js";
import { BASE_URL, scriptedClient, type Scripted } from "../helpers/scripted-client.js";
import { loadVector } from "./vectors.js";

type Args = Record<string, unknown>;
interface Input {
  method: string;
  uid: string;
  alert_id?: unknown;
  params: Args;
}
interface Expected {
  endpoint?: string;
  payload?: unknown;
  error?: string;
  loc?: unknown[];
}

/** A vector value as a JavaScript value: numbers by their exact text, objects recursively. */
function plain(value: unknown): unknown {
  if (value instanceof JsonNumber) return Number(value.text);
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [camelKey(k), plain(v)]));
  }
  return value;
}

function camelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** The vector's expected payload as the body text: compact JSON in the given key order. */
function bodyOf(payload: unknown): string {
  const json = JSON.stringify(payload, (_k, v: unknown) => (v instanceof JsonNumber ? v.text : v))
    .replaceAll("%", "%25")
    .replaceAll("&", "%26")
    .replaceAll("+", "%2B");
  return `jData=${json}`;
}

const WORDS: Record<string, string> = {
  place_oco: "OI created",
  modify_oco: "OI replaced",
  cancel_oco: "OI deleted",
};

const open: Scripted[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.agent.close();
});

describe("oco_requests.json", () => {
  for (const c of loadVector("oco_requests.json").cases) {
    it(c.name, async () => {
      const input = c.input as Input;
      const expected = c.expected as Expected;
      const ack = `{"stat":"${String(WORDS[input.method])}","al_id":"26111800000001"}`;
      const s = scriptedClient([{ body: ack }], { clientId: input.uid });
      open.push(s);
      const params = plain(input.params) as never;
      const alertId = plain(input.alert_id) as never;
      const run = (): Promise<unknown> => {
        switch (input.method) {
          case "place_oco":
            return s.client.placeOco(params);
          case "modify_oco":
            return s.client.modifyOco(alertId, params);
          case "cancel_oco":
            return s.client.cancelOco(alertId);
        }
        throw new Error(`no mapping for ${input.method}`);
      };

      if (expected.error !== undefined) {
        const error = await run().then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(RequestValidationError);
        expect((error as Error).name).toBe(expected.error);
        const locs = (error as RequestValidationError).errors.map((i) => [...i.loc]);
        expect(locs).toEqual([plain(expected.loc)]);
        expect(s.sends).toBe(0);
        return;
      }
      await run();
      expect(s.paths[0]).toBe(`${new URL(BASE_URL).pathname}/${String(expected.endpoint)}`);
      expect(s.bodies[0]).toBe(bodyOf(expected.payload));
      expect(s.sends).toBe(1);
    });
  }
});
