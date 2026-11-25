// oco_rows.json: one OCO row of the pending or triggered GTT list parsed with the generated
// models, its legs, trigger list and sides compared with the reference SDK. A nested record that
// fails to parse is null as a whole (sdk-behaviour.md 2.9), never null field by field.
import { describe, expect, it } from "vitest";
import type { Decimal } from "../../src/lib/decimal.js";
import { JsonNumber } from "../../src/lib/json.js";
import { parseGtt, parseTriggeredGtt } from "../../src/models/generated/index.js";
import type { Gtt, OcoLegRow, OcoSide } from "../../src/models/generated/index.js";
import { isOco, ocoSides } from "../../src/models/oco.js";
import { decimalEqual, loadVector } from "./vectors.js";

interface Input {
  list: "pending" | "triggered";
  row: unknown;
}
interface LegJson {
  quantity: JsonNumber | null;
  price: string | null;
  trigger_price: string | null;
}
interface SideJson {
  leg: "first" | "second";
  trigger_value: string;
}
interface Expected {
  alert_id: string | null;
  is_oco: boolean;
  oco_first: LegJson | null;
  oco_second: LegJson | null;
  oco_triggers: { var_name: string | null; trigger_value: string | null }[] | null;
  stop_loss: SideJson | null;
  target: SideJson | null;
}

function expectDecimal(actual: Decimal | null, expected: string | null, where: string): void {
  if (expected === null) {
    expect(actual, where).toBeNull();
  } else {
    expect(actual, where).not.toBeNull();
    expect(decimalEqual(String(actual), expected), `${where}: ${String(actual)}`).toBe(true);
  }
}

function expectLeg(actual: OcoLegRow | null, expected: LegJson | null, where: string): void {
  if (expected === null) {
    expect(actual, where).toBeNull();
    return;
  }
  expect(actual, where).not.toBeNull();
  const leg = actual as OcoLegRow;
  expect(leg.quantity, `${where}.quantity`).toBe(
    expected.quantity === null ? null : Number(expected.quantity.text),
  );
  expectDecimal(leg.price, expected.price, `${where}.price`);
  expectDecimal(leg.triggerPrice, expected.trigger_price, `${where}.trigger_price`);
}

function expectSide(gtt: Gtt, actual: OcoSide | null, expected: SideJson | null, where: string) {
  if (expected === null) {
    expect(actual, where).toBeNull();
    return;
  }
  expect(actual, where).not.toBeNull();
  const side = actual as OcoSide;
  expect(side.leg, `${where}.leg`).toBe(expected.leg === "first" ? gtt.ocoFirst : gtt.ocoSecond);
  expectDecimal(side.triggerValue, expected.trigger_value, `${where}.trigger_value`);
}

describe("oco_rows.json", () => {
  for (const c of loadVector("oco_rows.json").cases) {
    it(c.name, () => {
      const input = c.input as Input;
      const expected = c.expected as Expected;
      const gtt: Gtt =
        input.list === "pending" ? parseGtt(input.row) : parseTriggeredGtt(input.row);
      expect(gtt.alertId).toBe(expected.alert_id);
      expect(isOco(gtt)).toBe(expected.is_oco);
      expectLeg(gtt.ocoFirst, expected.oco_first, "oco_first");
      expectLeg(gtt.ocoSecond, expected.oco_second, "oco_second");
      if (expected.oco_triggers === null) {
        expect(gtt.ocoTriggers).toBeNull();
      } else {
        const triggers = gtt.ocoTriggers ?? [];
        expect(triggers).toHaveLength(expected.oco_triggers.length);
        expected.oco_triggers.forEach((want, index) => {
          expect(triggers[index]?.varName).toBe(want.var_name);
          expectDecimal(
            triggers[index]?.triggerValue ?? null,
            want.trigger_value,
            `oco_triggers[${String(index)}]`,
          );
        });
      }
      const sides = ocoSides(gtt);
      expectSide(gtt, sides?.stopLoss ?? null, expected.stop_loss, "stop_loss");
      expectSide(gtt, sides?.target ?? null, expected.target, "target");
    });
  }
});
