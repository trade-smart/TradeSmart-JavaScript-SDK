import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { D as Decimal } from "../../src/lib/decimal.js";
import { parseJsonLossless } from "../../src/lib/json.js";
import { isOco, ocoSides, parseGtt, parseTriggeredGtt } from "../../src/models/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, "../../../specifications/test-fixtures");

function rows(name: string): Record<string, unknown>[] {
  return parseJsonLossless(readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as Record<
    string,
    unknown
  >[];
}

const pending = rows("pending_gtts_success.json").map((row) => parseGtt(row));
const plain = pending[0];
const buy = pending.find((g) => g.alertType === "LMT_BOS_O");
const sell = pending.find((g) => g.alertType === "LMT_SOB_O");
if (plain === undefined || buy === undefined || sell === undefined) throw new Error("fixture rows");

function wireOf(type: string, x: string, y: string): Record<string, unknown> {
  return {
    stat: "Ok",
    al_id: "1",
    ai_t: type,
    place_order_params: { trantype: "B", qty: 1, prc: "10.00" },
    place_order_params_leg2: { trantype: "B", qty: 2, prc: "20.00" },
    oivariable: [
      { var_name: "x", d: x },
      { var_name: "y", d: y },
    ],
  };
}

describe("OCO rows", () => {
  it("parses the legs and triggers of a BUY row (stop-loss in x)", () => {
    expect(buy.ocoFirst?.quantity).toBe(1);
    expect(buy.ocoSecond?.price).toEqual(new Decimal("1160.00"));
    expect(buy.ocoTriggers?.map((t) => t.varName)).toEqual(["x", "y"]);
    expect(buy.ocoTriggers?.[0]?.triggerValue).toEqual(new Decimal("1430.00"));
  });

  it("is null on a plain GTT and isOco is false", () => {
    expect(plain.ocoFirst).toBeNull();
    expect(plain.ocoTriggers).toBeNull();
    expect(isOco(plain)).toBe(false);
    expect(ocoSides(plain)).toBeNull();
  });

  it("ocoSides returns frozen sides", () => {
    const sides = ocoSides(buy);
    expect(Object.isFrozen(sides?.stopLoss)).toBe(true);
    expect(Object.isFrozen(sides?.target)).toBe(true);
  });

  it("OCO_BUY: the higher trigger (x) is the stop-loss", () => {
    expect(isOco(buy)).toBe(true);
    const sides = ocoSides(buy);
    expect(sides?.stopLoss.triggerValue).toEqual(new Decimal("1430.00"));
    expect(sides?.stopLoss.leg).toBe(buy.ocoFirst);
    expect(sides?.target.triggerValue).toEqual(new Decimal("1170.00"));
    expect(sides?.target.leg).toBe(buy.ocoSecond);
  });

  it("OCO_SELL: the lower trigger (y) is the stop-loss, the target is in x", () => {
    expect(isOco(sell)).toBe(true);
    const sides = ocoSides(sell);
    expect(sides?.stopLoss.triggerValue).toEqual(new Decimal("1170.00"));
    expect(sides?.stopLoss.leg).toBe(sell.ocoSecond);
    expect(sides?.target.triggerValue).toEqual(new Decimal("1430.00"));
    expect(sides?.target.leg).toBe(sell.ocoFirst);
  });

  it("works on triggered rows, including a CANCELLED one", () => {
    const triggered = rows("triggered_gtts_success.json").map((row) => parseTriggeredGtt(row));
    const cancelled = triggered.filter((g) => isOco(g));
    expect(cancelled.length).toBeGreaterThanOrEqual(2);
    for (const row of cancelled) expect(ocoSides(row)).not.toBeNull();
  });

  it("pairs triggers by var_name, not by array position", () => {
    const wire = wireOf("LMT_BOS_O", "5.00", "9.00");
    wire.oivariable = [
      { var_name: "y", d: "9.00" },
      { var_name: "x", d: "5.00" },
    ];
    const sides = ocoSides(parseGtt(wire));
    expect(sides?.stopLoss.triggerValue).toEqual(new Decimal("9.00"));
    expect(sides?.stopLoss.leg.quantity).toBe(2);
    expect(sides?.target.leg.quantity).toBe(1);
  });

  it("ignores the leg trantype", () => {
    const wire = wireOf("LMT_SOB_O", "5.00", "9.00");
    const sides = ocoSides(parseGtt(wire));
    expect(sides?.stopLoss.triggerValue).toEqual(new Decimal("5.00"));
  });

  it.each([
    ["equal triggers", wireOf("LMT_BOS_O", "5.00", "5.00")],
    [
      "a missing trigger",
      { ...wireOf("LMT_BOS_O", "5.00", "9.00"), oivariable: [{ var_name: "x", d: "5.00" }] },
    ],
    ["a missing leg", { ...wireOf("LMT_BOS_O", "5.00", "9.00"), place_order_params_leg2: null }],
    ["a missing trigger value", wireOf("LMT_BOS_O", "5.00", "")],
    ["a non-OCO code", wireOf("LMT_B_O", "5.00", "9.00")],
    [
      "a repeated x",
      {
        ...wireOf("LMT_BOS_O", "5.00", "9.00"),
        oivariable: [
          { var_name: "x", d: "5.00" },
          { var_name: "x", d: "7.00" },
          { var_name: "y", d: "9.00" },
        ],
      },
    ],
    [
      "a repeated y",
      {
        ...wireOf("LMT_BOS_O", "5.00", "9.00"),
        oivariable: [
          { var_name: "x", d: "5.00" },
          { var_name: "y", d: "9.00" },
          { var_name: "y", d: "3.00" },
        ],
      },
    ],
  ])("ocoSides is null for %s", (_name, wire) => {
    expect(ocoSides(parseGtt(wire))).toBeNull();
  });
});
