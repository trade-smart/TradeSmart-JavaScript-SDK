import { describe, expect, it } from "vitest";
import { findOption, selectFuture } from "../../src/lib/option-contracts.js";
import type { ScriptMasterRow } from "../../src/instruments/parse.js";
import { JsonNumber } from "../../src/lib/json.js";
import { decimalEqual, loadVector } from "./vectors.js";

interface Input {
  function: "find_option" | "select_future";
  rows: ScriptMasterRow[];
  tradingsymbol?: string;
  option?: { exchange: string; expiry: string; symbol: string; tradingsymbol: string };
}

describe("contract_selection.json", () => {
  const vector = loadVector("contract_selection.json");
  it("has cases", () => {
    expect(vector.cases.length).toBeGreaterThan(0);
  });
  for (const c of vector.cases) {
    it(c.name, () => {
      const i = c.input as Input;
      const expected = c.expected as Record<string, unknown>;
      const run = () =>
        i.function === "find_option"
          ? findOption(i.rows, i.tradingsymbol as string)
          : selectFuture(i.rows, i.option as NonNullable<Input["option"]>);
      if (expected["error"] !== undefined) {
        expect(run).toThrow(RangeError);
        return;
      }
      const got = run();
      if (i.function === "select_future") {
        expect(got).toEqual({
          tradingsymbol: expected["tradingsymbol"],
          token: expected["token"],
          expiry: expected["expiry"],
          sameExpiry: expected["same_expiry"],
        });
        return;
      }
      const info = got as ReturnType<typeof findOption>;
      expect(info.exchange).toBe(expected["exchange"]);
      expect(info.tradingsymbol).toBe(expected["tradingsymbol"]);
      expect(info.token).toBe(expected["token"]);
      expect(info.symbol).toBe(expected["symbol"]);
      expect(info.expiry).toBe(expected["expiry"]);
      expect(info.optionType).toBe(expected["option_type"]);
      // Python keeps the strike's text ("24000.00"); a Decimal cannot, so `strikeText` does.
      expect(info.strikeText).toBe(expected["strike"]);
      expect(decimalEqual(info.strike.toFixed(), expected["strike"] as string)).toBe(true);
      if (expected["tick_size"] === null) expect(info.tickSize).toBeNull();
      else {
        expect(info.tickSize).not.toBeNull();
        expect(
          decimalEqual(
            (info.tickSize as { toFixed(): string }).toFixed(),
            expected["tick_size"] as string,
          ),
        ).toBe(true);
      }
      expect(info.lotSize).toBe(
        expected["lot_size"] === null ? null : Number((expected["lot_size"] as JsonNumber).text),
      );
    });
  }
});
