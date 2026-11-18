// read_payloads.json: the read methods drive the real client through an undici MockAgent that
// records the request (sdk-behaviour.md §2.3, §7.3). Each case pins the endpoint, the exact body
// bytes and, for rejected arguments, the wire keys named by the RequestValidationError.
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

/** A vector argument as a JavaScript value (numbers by their exact text; times as inputs). */
function arg(value: unknown): unknown {
  if (value instanceof JsonNumber) return Number(value.text);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (typeof o["datetime"] === "string") {
      // An offset-less datetime has no JavaScript form; the rejected string stands for it (§7.3).
      return /(Z|[+-]\d\d:\d\d)$/.test(o["datetime"]) ? new Date(o["datetime"]) : o["datetime"];
    }
    if (typeof o["date"] === "string") return { date: o["date"] };
  }
  return value;
}

const CALLS: Record<string, (s: Scripted, a: Args) => Promise<unknown>> = {
  profile: (s) => s.client.profile(),
  margins: (s) => s.client.margins(),
  positions: (s) => s.client.positions(),
  holdings: (s, a) =>
    s.client.holdings(a["product"] === undefined ? {} : { product: a["product"] as string }),
  orders: (s) => s.client.orders(),
  order_history: (s, a) => s.client.orderHistory(a["order_id"] as string),
  trades: (s) => s.client.trades(),
  search_instruments: (s, a) => s.client.searchInstruments(a["text"] as string),
  quote: (s, a) => s.client.quote(a["exchange"] as string, a["token"] as string),
  security_info: (s, a) => s.client.securityInfo(a["exchange"] as string, a["token"] as string),
  option_chain: (s, a) =>
    s.client.optionChain(
      a["exchange"] as string,
      a["tradingsymbol"] as string,
      a["strike_price"] as string,
      a["count"] as number,
    ),
  historical_data: (s, a) =>
    s.client.historicalData(a["exchange"] as string, a["token"] as string, {
      ...(a["from_date"] === undefined ? {} : { fromDate: a["from_date"] as never }),
      ...(a["to_date"] === undefined ? {} : { toDate: a["to_date"] as never }),
      ...(a["interval"] === undefined ? {} : { interval: a["interval"] as number }),
    }),
  daily_history: (s, a) =>
    s.client.dailyHistory(
      a["exchange"] as string,
      a["tradingsymbol"] as string,
      a["from_date"] as never,
      a["to_date"] as never,
    ),
  pending_gtts: (s) => s.client.pendingGtts(),
  triggered_gtts: (s) => s.client.triggeredGtts(),
  gtt_alert_types: (s) => s.client.gttAlertTypes(),
};

const NO_DATA = '{"stat":"Not_Ok","emsg":"Error Occurred : 5 \\"no data\\""}';

const open: Scripted[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.agent.close();
});

describe("read_payloads.json", () => {
  for (const c of loadVector("read_payloads.json").cases) {
    it(c.name, async () => {
      const input = c.input as { call: string; arguments: Args };
      const expected = c.expected as Expected;
      // The reply does not matter for the payload; the call may fail after the request is sent.
      const s = scriptedClient([{ body: NO_DATA }]);
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
        const fields = (error as RequestValidationError).errors.flatMap((i) => [...i.loc]).sort();
        expect(fields).toEqual(expected.fields);
        expect(s.sends).toBe(0);
        return;
      }
      await run(s, args).catch(() => undefined);
      expect(s.paths[0]).toBe(`${new URL(BASE_URL).pathname}/${String(expected.endpoint)}`);
      expect(s.bodies[0]).toBe(expected.body);
    });
  }
});
