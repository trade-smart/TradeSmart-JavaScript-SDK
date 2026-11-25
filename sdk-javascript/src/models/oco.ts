// Read-only helpers for OCO rows (sdk-behaviour.md §2.9 "Reading back").
import type { Decimal } from "../lib/decimal.js";
import { GttAlertType, type Gtt, type OcoLegRow, type OcoSide } from "./generated/index.js";

/** True when the row's `alertType` is one of the two OCO codes. */
export function isOco(gtt: Gtt): boolean {
  return gtt.alertType === GttAlertType.OCO_BUY || gtt.alertType === GttAlertType.OCO_SELL;
}

function triggerOf(gtt: Gtt, slot: string): Decimal | null {
  // A repeated slot is ambiguous: refuse to guess (null) rather than take the first.
  const items = (gtt.ocoTriggers ?? []).filter((trigger) => trigger.varName === slot);
  return items.length === 1 ? (items[0]?.triggerValue ?? null) : null;
}

/**
 * The stop-loss and target sides of an OCO row, or `null`. The side is decided by `alertType`
 * (`OCO_BUY`: the leg with the higher trigger is the stop-loss; `OCO_SELL`: the lower one), never
 * by the leg's slot or `trantype`. Triggers are paired with legs by `var_name` (`x` = first leg,
 * `y` = second), never by position. A plain GTT row, equal triggers or anything missing gives `null`.
 */
export function ocoSides(gtt: Gtt): { stopLoss: OcoSide; target: OcoSide } | null {
  if (!isOco(gtt)) return null;
  const first: OcoLegRow | null = gtt.ocoFirst;
  const second: OcoLegRow | null = gtt.ocoSecond;
  const x = triggerOf(gtt, "x");
  const y = triggerOf(gtt, "y");
  if (first === null || second === null || x === null || y === null) return null;
  if (x.equals(y)) return null;
  const a: OcoSide = Object.freeze({ leg: first, triggerValue: x });
  const b: OcoSide = Object.freeze({ leg: second, triggerValue: y });
  const firstIsHigher = x.greaterThan(y);
  const buy = gtt.alertType === GttAlertType.OCO_BUY;
  return buy === firstIsHigher ? { stopLoss: a, target: b } : { stopLoss: b, target: a };
}
