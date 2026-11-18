// success_words.json: every case classified directly, and the GTT write cases (object replies)
// also through the typed methods (placeGtt, modifyGtt, cancelGtt) on the real client: a typed GTT
// write succeeds only on its word with a non-blank `al_id` and returns that `al_id` exactly as
// sent; anything else is the case's error, after exactly one request (never retried).
import { afterEach, describe, expect, it } from "vitest";
import { JsonNumber } from "../../src/lib/json.js";
import { scriptedClient, type Scripted } from "../helpers/scripted-client.js";
import { loadVector } from "./vectors.js";
import { runClassifyCase } from "./classify-case.js";

const GTT = {
  exchange: "NSE",
  tradingsymbol: "INFY-EQ",
  alertType: "LTP_B_O",
  triggerValue: "1500",
  alertValidity: "GTT",
  tag: "Buy INFY below 1500",
  transactionType: "B",
  orderType: "LMT",
  product: "C",
  validity: "DAY",
  quantity: 1,
  price: "1500",
} as const;
const ALERT_ID = "26111200000010";

const TYPED: Record<string, (s: Scripted) => Promise<string>> = {
  PlaceGTTOrder: (s) => s.client.placeGtt(GTT),
  ModifyGTTOrder: (s) => s.client.modifyGtt(ALERT_ID, GTT),
  CancelGTTOrder: (s) => s.client.cancelGtt(ALERT_ID),
};

interface Input {
  body: string;
  endpoint: string;
  expect: "object" | "list";
  http_status: JsonNumber;
}
interface Expected {
  error?: string;
  returns?: unknown;
}

const open: Scripted[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.agent.close();
});

describe("success_words.json", () => {
  const vector = loadVector("success_words.json");
  for (const c of vector.cases) {
    it(c.name, () => {
      runClassifyCase(c, true);
    });
  }

  describe("typed GTT writes", () => {
    const typed = vector.cases.filter((c) => {
      const input = c.input as Input;
      return TYPED[input.endpoint] !== undefined && input.expect === "object";
    });
    it("covers the three GTT writes", () => {
      const endpoints = new Set(typed.map((c) => (c.input as Input).endpoint));
      expect([...endpoints].sort()).toEqual(["CancelGTTOrder", "ModifyGTTOrder", "PlaceGTTOrder"]);
    });
    for (const c of typed) {
      it(c.name, async () => {
        const input = c.input as Input;
        const expected = c.expected as Expected;
        const s = scriptedClient([{ status: Number(input.http_status.text), body: input.body }]);
        open.push(s);
        const call = TYPED[input.endpoint];
        if (call === undefined) throw new Error(`no typed call for ${input.endpoint}`);
        const outcome = await call(s).then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error: error as Error }),
        );
        expect(s.sends).toBe(1);
        if (expected.error === undefined) {
          expect(outcome.error).toBeNull();
          const returns = expected.returns as Record<string, unknown>;
          expect(outcome.value).toBe(returns["al_id"]);
        } else {
          expect(outcome.error?.name).toBe(expected.error);
        }
      });
    }
  });
});
