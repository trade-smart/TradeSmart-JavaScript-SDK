// Account reads: `Holdings`, `Limits`, `PositionBook`, `OrderBook`, `SingleOrdHist`, `TradeBook`
// (sdk-behaviour.md §2.3), mirroring sdk-python/src/tradesmart/endpoints/{portfolio,orders}.py.
// The GTT reads live with the GTT writes in gtt.ts.
import { resolveEnum } from "../enums.js";
import type { CallSpec } from "../lib/call.js";
import {
  parseOrder,
  parseOrderHistoryEntry,
  parseTrade,
  type Order,
  type OrderHistoryEntry,
  type Trade,
} from "../models/generated/orders.js";
import {
  parseHolding,
  parseLimits,
  parsePosition,
  type Holding,
  type Limits,
  type Position,
} from "../models/generated/portfolio.js";
import { listDecoder, objectDecoder, readSpec, requireStr } from "./base.js";

/** The `Holdings` call; `product` (default `CNC`) is a word in any case or the wire code. */
export function holdingsCall(
  uid: string,
  product: unknown,
  signal?: AbortSignal,
): CallSpec<readonly Holding[]> {
  return readSpec({
    endpoint: "Holdings",
    payload: [
      ["uid", uid],
      ["actid", uid],
      ["prd", resolveEnum("Product", product ?? "CNC", "prd")],
    ],
    expect: "list",
    allowEmpty: true,
    decode: listDecoder(parseHolding, "Holdings"),
    signal,
  });
}

/** The `Limits` call. */
export function limitsCall(uid: string, signal?: AbortSignal): CallSpec<Limits> {
  return readSpec({
    endpoint: "Limits",
    payload: [
      ["uid", uid],
      ["actid", uid],
    ],
    decode: objectDecoder(parseLimits, "Limits"),
    signal,
  });
}

/** The `PositionBook` call. */
export function positionsCall(uid: string, signal?: AbortSignal): CallSpec<readonly Position[]> {
  return readSpec({
    endpoint: "PositionBook",
    payload: [
      ["uid", uid],
      ["actid", uid],
    ],
    expect: "list",
    allowEmpty: true,
    decode: listDecoder(parsePosition, "PositionBook"),
    signal,
  });
}

/** The `OrderBook` call (the docs and examples send `uid` only). */
export function orderBookCall(uid: string, signal?: AbortSignal): CallSpec<readonly Order[]> {
  return readSpec({
    endpoint: "OrderBook",
    payload: [["uid", uid]],
    expect: "list",
    allowEmpty: true,
    decode: listDecoder(parseOrder, "OrderBook"),
    signal,
  });
}

/** The `SingleOrdHist` call. */
export function orderHistoryCall(
  uid: string,
  orderId: unknown,
  signal?: AbortSignal,
): CallSpec<readonly OrderHistoryEntry[]> {
  return readSpec({
    endpoint: "SingleOrdHist",
    payload: [
      ["uid", uid],
      ["norenordno", requireStr(orderId, "norenordno")],
    ],
    expect: "list",
    allowEmpty: true,
    decode: listDecoder(parseOrderHistoryEntry, "SingleOrdHist"),
    signal,
  });
}

/** The `TradeBook` call. */
export function tradeBookCall(uid: string, signal?: AbortSignal): CallSpec<readonly Trade[]> {
  return readSpec({
    endpoint: "TradeBook",
    payload: [
      ["uid", uid],
      ["actid", uid],
    ],
    expect: "list",
    allowEmpty: true,
    decode: listDecoder(parseTrade, "TradeBook"),
    signal,
  });
}
