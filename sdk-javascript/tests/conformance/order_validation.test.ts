// order_validation.json: the typed order and GTT methods drive the real client through an undici
// MockAgent that records the request (sdk-behaviour.md §2.3, §2.4, §2.8). Each case pins the
// endpoint and the exact body bytes (wire key order, `amo` always on PlaceOrder, `ordersource`,
// `algo_id` last) or, for rejected arguments, the wire keys named by the RequestValidationError
// (nothing sent).
import { afterEach, describe, expect, it } from "vitest";
import { RequestValidationError } from "../../src/errors.js";
import { JsonNumber } from "../../src/lib/json.js";
import { BASE_URL, scriptedClient, type Scripted } from "../helpers/scripted-client.js";
import { loadVector } from "./vectors.js";

type Args = Record<string, unknown>;
interface Expected {
  body?: string;
  endpoint?: string;
  error?: string;
  fields?: string[];
}

/** A vector argument as a JavaScript value (numbers by their exact text). */
function arg(value: unknown): unknown {
  return value instanceof JsonNumber ? Number(value.text) : value;
}

/** `snake_case` argument names to the camelCase parameter names. */
function camel(args: Args): Args {
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => [
      k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase()),
      v,
    ]),
  );
}

function without(args: Args, key: string): Args {
  return Object.fromEntries(Object.entries(args).filter(([k]) => k !== key));
}

// The parameter objects are passed as the vector gives them: the methods check every value at
// run time, so the casts only silence the static types.
const CALLS: Record<string, (s: Scripted, a: Args) => Promise<unknown>> = {
  place_order: (s, a) => s.client.placeOrder(camel(a) as never),
  modify_order: (s, a) =>
    s.client.modifyOrder(a["order_id"] as string, camel(without(a, "order_id")) as never),
  cancel_order: (s, a) => s.client.cancelOrder(a["order_id"] as string),
  exit_order: (s, a) => s.client.exitOrder(a["order_id"] as string, a["product"] as string),
  order_margin: (s, a) => s.client.orderMargin(camel(a) as never),
  place_gtt: (s, a) => s.client.placeGtt(camel(a) as never),
  modify_gtt: (s, a) =>
    s.client.modifyGtt(a["alert_id"] as string, camel(without(a, "alert_id")) as never),
  cancel_gtt: (s, a) => s.client.cancelGtt(a["alert_id"] as string),
};

/** Argument keys whose values must never appear in an error's text (§4.1). */
const QUIET = [
  "price",
  "trigger_price",
  "trigger_value",
  "tradingsymbol",
  "tag",
  "algo_id",
  "order_id",
  "alert_id",
  "book_loss_price",
  "book_profit_price",
  "trail_price",
  "market_protection",
];

const ACK = '{"stat":"Ok","norenordno":"26111000000001"}';

const open: Scripted[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.agent.close();
});

describe("order_validation.json", () => {
  for (const c of loadVector("order_validation.json").cases) {
    it(c.name, async () => {
      const input = c.input as { call: string; arguments: Args };
      const expected = c.expected as Expected;
      // The reply does not matter for the payload; the call may fail after the request is sent.
      const s = scriptedClient([{ body: ACK }]);
      open.push(s);
      const run = CALLS[input.call];
      if (run === undefined) throw new Error(`no mapping for ${input.call}`);
      const args = Object.fromEntries(Object.entries(input.arguments).map(([k, v]) => [k, arg(v)]));

      if (expected.error !== undefined) {
        const error = await run(s, args).then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(RequestValidationError);
        const issues = (error as RequestValidationError).errors;
        const fields = issues.flatMap((i) => [...i.loc]).sort();
        expect(fields).toEqual(expected.fields);
        expect(issues.length).toBeGreaterThan(0);
        expect(s.sends).toBe(0);
        const texts = [(error as Error).message, ...issues.map((i) => i.msg)].join("\n");
        for (const key of QUIET) {
          const value = args[key];
          if (typeof value === "string" && value.trim().length >= 2) {
            expect(texts).not.toContain(value);
          }
        }
        return;
      }
      await run(s, args).catch(() => undefined);
      expect(s.paths[0]).toBe(`${new URL(BASE_URL).pathname}/${String(expected.endpoint)}`);
      expect(s.bodies[0]).toBe(expected.body);
      expect(s.sends).toBe(1);
    });
  }
});
