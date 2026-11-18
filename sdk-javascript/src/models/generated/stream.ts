// GENERATED from specifications/models.json by scripts/gen-models.ts — do not edit
import type { Decimal } from "../../lib/decimal.js";
import {
  T,
  parseModel,
  type ModelParser,
  type ModelSpec,
  type OpenEnum,
  type ParseContext,
} from "../base.js";
import { OrderStatus, OrderType, Product, TransactionType, Validity } from "./enums.js";

/** Base of every inbound stream message; `t` is the task type. */
export interface StreamMessage {
  /** Wire key `t`. */
  readonly t: string;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `StreamMessage`. */
export const StreamMessageSpec: ModelSpec = {
  name: "StreamMessage",
  fields: [{ name: "t", wire: "t", type: T.str, nullable: false, default: "" }],
};

/** Parse one `StreamMessage` wire record. */
export function parseStreamMessage(wire: unknown, ctx?: ParseContext): StreamMessage {
  return parseModel(StreamMessageSpec, wire, ctx) as StreamMessage;
}

/** `ak`: connect acknowledgement (`s` is `Ok` / `Not_Ok`). */
export interface ConnectAck {
  /** Wire key `t`. */
  readonly t: string;
  /** Wire key `uid`. */
  readonly userId: string | null;
  /** Wire key `s`. */
  readonly status: string | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `ConnectAck`. */
export const ConnectAckSpec: ModelSpec = {
  name: "ConnectAck",
  fields: [
    { name: "t", wire: "t", type: T.str, nullable: false, default: "" },
    { name: "userId", wire: "uid", type: T.str },
    { name: "status", wire: "s", type: T.str },
  ],
};

/** Parse one `ConnectAck` wire record. */
export function parseConnectAck(wire: unknown, ctx?: ParseContext): ConnectAck {
  return parseModel(ConnectAckSpec, wire, ctx) as ConnectAck;
}

/** `tk`: touchline subscription acknowledgement. */
export interface TouchlineAck {
  /** Wire key `t`. */
  readonly t: string;
  /** Wire key `e`. */
  readonly exchange: string | null;
  /** Wire key `tk`. */
  readonly token: string | null;
  /** Wire key `ts`. */
  readonly tradingsymbol: string | null;
  /** Wire key `pp`. */
  readonly pricePrecision: number | null;
  /** Wire key `ti`. */
  readonly tickSize: Decimal | null;
  /** Wire key `ls`. */
  readonly lotSize: number | null;
  /** Wire key `lp`. */
  readonly lastPrice: Decimal | null;
  /** Wire key `pc`. */
  readonly percentChange: string | null;
  /** Wire key `v`. */
  readonly volume: Decimal | null;
  /** Wire key `o`. */
  readonly open: Decimal | null;
  /** Wire key `h`. */
  readonly high: Decimal | null;
  /** Wire key `l`. */
  readonly low: Decimal | null;
  /** Wire key `c`. */
  readonly close: Decimal | null;
  /** Wire key `ap`. */
  readonly averageTradePrice: Decimal | null;
  /** Wire key `oi`. */
  readonly openInterest: Decimal | null;
  /** Wire key `poi`. */
  readonly poi: Decimal | null;
  /** Wire key `toi`. */
  readonly toi: Decimal | null;
  /** Wire key `bq1`. */
  readonly bq1: number | null;
  /** Wire key `bp1`. */
  readonly bp1: Decimal | null;
  /** Wire key `sq1`. */
  readonly sq1: number | null;
  /** Wire key `sp1`. */
  readonly sp1: Decimal | null;
  /** Wire key `ft`. */
  readonly ft: Date | null;
  /** Wire key `ord_msg`. */
  readonly ordMsg: string | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `TouchlineAck`. */
export const TouchlineAckSpec: ModelSpec = {
  name: "TouchlineAck",
  fields: [
    { name: "t", wire: "t", type: T.str, nullable: false, default: "" },
    { name: "exchange", wire: "e", type: T.str },
    { name: "token", wire: "tk", type: T.str },
    { name: "tradingsymbol", wire: "ts", type: T.str },
    { name: "pricePrecision", wire: "pp", type: T.Quantity },
    { name: "tickSize", wire: "ti", type: T.Price },
    { name: "lotSize", wire: "ls", type: T.Quantity },
    { name: "lastPrice", wire: "lp", type: T.StreamPrice },
    { name: "percentChange", wire: "pc", type: T.str },
    { name: "volume", wire: "v", type: T.Price },
    { name: "open", wire: "o", type: T.StreamPrice },
    { name: "high", wire: "h", type: T.StreamPrice },
    { name: "low", wire: "l", type: T.StreamPrice },
    { name: "close", wire: "c", type: T.StreamPrice },
    { name: "averageTradePrice", wire: "ap", type: T.StreamPrice },
    { name: "openInterest", wire: "oi", type: T.Price },
    { name: "poi", wire: "poi", type: T.Price },
    { name: "toi", wire: "toi", type: T.Price },
    { name: "bq1", wire: "bq1", type: T.Quantity },
    { name: "bp1", wire: "bp1", type: T.StreamPrice },
    { name: "sq1", wire: "sq1", type: T.Quantity },
    { name: "sp1", wire: "sp1", type: T.StreamPrice },
    { name: "ft", wire: "ft", type: T.EpochTime },
    { name: "ordMsg", wire: "ord_msg", type: T.str },
  ],
};

/** Parse one `TouchlineAck` wire record. */
export function parseTouchlineAck(wire: unknown, ctx?: ParseContext): TouchlineAck {
  return parseModel(TouchlineAckSpec, wire, ctx) as TouchlineAck;
}

/** `tf`: touchline update (only changed fields besides `t`/`e`/`tk`). */
export interface TouchlineFeed {
  /** Wire key `t`. */
  readonly t: string;
  /** Wire key `e`. */
  readonly exchange: string | null;
  /** Wire key `tk`. */
  readonly token: string | null;
  /** Wire key `ts`. */
  readonly tradingsymbol: string | null;
  /** Wire key `pp`. */
  readonly pricePrecision: number | null;
  /** Wire key `ti`. */
  readonly tickSize: Decimal | null;
  /** Wire key `ls`. */
  readonly lotSize: number | null;
  /** Wire key `lp`. */
  readonly lastPrice: Decimal | null;
  /** Wire key `pc`. */
  readonly percentChange: string | null;
  /** Wire key `v`. */
  readonly volume: Decimal | null;
  /** Wire key `o`. */
  readonly open: Decimal | null;
  /** Wire key `h`. */
  readonly high: Decimal | null;
  /** Wire key `l`. */
  readonly low: Decimal | null;
  /** Wire key `c`. */
  readonly close: Decimal | null;
  /** Wire key `ap`. */
  readonly averageTradePrice: Decimal | null;
  /** Wire key `oi`. */
  readonly openInterest: Decimal | null;
  /** Wire key `poi`. */
  readonly poi: Decimal | null;
  /** Wire key `toi`. */
  readonly toi: Decimal | null;
  /** Wire key `bq1`. */
  readonly bq1: number | null;
  /** Wire key `bp1`. */
  readonly bp1: Decimal | null;
  /** Wire key `sq1`. */
  readonly sq1: number | null;
  /** Wire key `sp1`. */
  readonly sp1: Decimal | null;
  /** Wire key `ft`. */
  readonly ft: Date | null;
  /** Wire key `ord_msg`. */
  readonly ordMsg: string | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `TouchlineFeed`. */
export const TouchlineFeedSpec: ModelSpec = {
  name: "TouchlineFeed",
  fields: [
    { name: "t", wire: "t", type: T.str, nullable: false, default: "" },
    { name: "exchange", wire: "e", type: T.str },
    { name: "token", wire: "tk", type: T.str },
    { name: "tradingsymbol", wire: "ts", type: T.str },
    { name: "pricePrecision", wire: "pp", type: T.Quantity },
    { name: "tickSize", wire: "ti", type: T.Price },
    { name: "lotSize", wire: "ls", type: T.Quantity },
    { name: "lastPrice", wire: "lp", type: T.StreamPrice },
    { name: "percentChange", wire: "pc", type: T.str },
    { name: "volume", wire: "v", type: T.Price },
    { name: "open", wire: "o", type: T.StreamPrice },
    { name: "high", wire: "h", type: T.StreamPrice },
    { name: "low", wire: "l", type: T.StreamPrice },
    { name: "close", wire: "c", type: T.StreamPrice },
    { name: "averageTradePrice", wire: "ap", type: T.StreamPrice },
    { name: "openInterest", wire: "oi", type: T.Price },
    { name: "poi", wire: "poi", type: T.Price },
    { name: "toi", wire: "toi", type: T.Price },
    { name: "bq1", wire: "bq1", type: T.Quantity },
    { name: "bp1", wire: "bp1", type: T.StreamPrice },
    { name: "sq1", wire: "sq1", type: T.Quantity },
    { name: "sp1", wire: "sp1", type: T.StreamPrice },
    { name: "ft", wire: "ft", type: T.EpochTime },
    { name: "ordMsg", wire: "ord_msg", type: T.str },
  ],
};

/** Parse one `TouchlineFeed` wire record. */
export function parseTouchlineFeed(wire: unknown, ctx?: ParseContext): TouchlineFeed {
  return parseModel(TouchlineFeedSpec, wire, ctx) as TouchlineFeed;
}

/** `dk`: depth subscription acknowledgement. */
export interface DepthAck {
  /** Wire key `t`. */
  readonly t: string;
  /** Wire key `e`. */
  readonly exchange: string | null;
  /** Wire key `tk`. */
  readonly token: string | null;
  /** Wire key `ts`. */
  readonly tradingsymbol: string | null;
  /** Wire key `pp`. */
  readonly pricePrecision: number | null;
  /** Wire key `ti`. */
  readonly tickSize: Decimal | null;
  /** Wire key `ls`. */
  readonly lotSize: number | null;
  /** Wire key `lp`. */
  readonly lastPrice: Decimal | null;
  /** Wire key `pc`. */
  readonly percentChange: string | null;
  /** Wire key `v`. */
  readonly volume: Decimal | null;
  /** Wire key `o`. */
  readonly open: Decimal | null;
  /** Wire key `h`. */
  readonly high: Decimal | null;
  /** Wire key `l`. */
  readonly low: Decimal | null;
  /** Wire key `c`. */
  readonly close: Decimal | null;
  /** Wire key `ap`. */
  readonly averageTradePrice: Decimal | null;
  /** Wire key `oi`. */
  readonly openInterest: Decimal | null;
  /** Wire key `poi`. */
  readonly poi: Decimal | null;
  /** Wire key `toi`. */
  readonly toi: Decimal | null;
  /** Wire key `bq1`. */
  readonly bq1: number | null;
  /** Wire key `bp1`. */
  readonly bp1: Decimal | null;
  /** Wire key `sq1`. */
  readonly sq1: number | null;
  /** Wire key `sp1`. */
  readonly sp1: Decimal | null;
  /** Wire key `ft`. */
  readonly ft: Date | null;
  /** Wire key `ord_msg`. */
  readonly ordMsg: string | null;
  /** Wire key `cp`. */
  readonly cp: Decimal | null;
  /** Wire key `ltt`. */
  readonly ltt: string | null;
  /** Wire key `ltq`. */
  readonly ltq: number | null;
  /** Wire key `tbq`. */
  readonly tbq: number | null;
  /** Wire key `tsq`. */
  readonly tsq: number | null;
  /** Wire key `bp2`. */
  readonly bp2: Decimal | null;
  /** Wire key `bp3`. */
  readonly bp3: Decimal | null;
  /** Wire key `bp4`. */
  readonly bp4: Decimal | null;
  /** Wire key `bp5`. */
  readonly bp5: Decimal | null;
  /** Wire key `sp2`. */
  readonly sp2: Decimal | null;
  /** Wire key `sp3`. */
  readonly sp3: Decimal | null;
  /** Wire key `sp4`. */
  readonly sp4: Decimal | null;
  /** Wire key `sp5`. */
  readonly sp5: Decimal | null;
  /** Wire key `bq2`. */
  readonly bq2: number | null;
  /** Wire key `bq3`. */
  readonly bq3: number | null;
  /** Wire key `bq4`. */
  readonly bq4: number | null;
  /** Wire key `bq5`. */
  readonly bq5: number | null;
  /** Wire key `sq2`. */
  readonly sq2: number | null;
  /** Wire key `sq3`. */
  readonly sq3: number | null;
  /** Wire key `sq4`. */
  readonly sq4: number | null;
  /** Wire key `sq5`. */
  readonly sq5: number | null;
  /** Wire key `bo1`. */
  readonly bo1: number | null;
  /** Wire key `bo2`. */
  readonly bo2: number | null;
  /** Wire key `bo3`. */
  readonly bo3: number | null;
  /** Wire key `bo4`. */
  readonly bo4: number | null;
  /** Wire key `bo5`. */
  readonly bo5: number | null;
  /** Wire key `so1`. */
  readonly so1: number | null;
  /** Wire key `so2`. */
  readonly so2: number | null;
  /** Wire key `so3`. */
  readonly so3: number | null;
  /** Wire key `so4`. */
  readonly so4: number | null;
  /** Wire key `so5`. */
  readonly so5: number | null;
  /** Wire key `lc`. */
  readonly lc: Decimal | null;
  /** Wire key `uc`. */
  readonly uc: Decimal | null;
  /** Wire key `52h`. */
  readonly high52w: Decimal | null;
  /** Wire key `52l`. */
  readonly low52w: Decimal | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `DepthAck`. */
export const DepthAckSpec: ModelSpec = {
  name: "DepthAck",
  fields: [
    { name: "t", wire: "t", type: T.str, nullable: false, default: "" },
    { name: "exchange", wire: "e", type: T.str },
    { name: "token", wire: "tk", type: T.str },
    { name: "tradingsymbol", wire: "ts", type: T.str },
    { name: "pricePrecision", wire: "pp", type: T.Quantity },
    { name: "tickSize", wire: "ti", type: T.Price },
    { name: "lotSize", wire: "ls", type: T.Quantity },
    { name: "lastPrice", wire: "lp", type: T.StreamPrice },
    { name: "percentChange", wire: "pc", type: T.str },
    { name: "volume", wire: "v", type: T.Price },
    { name: "open", wire: "o", type: T.StreamPrice },
    { name: "high", wire: "h", type: T.StreamPrice },
    { name: "low", wire: "l", type: T.StreamPrice },
    { name: "close", wire: "c", type: T.StreamPrice },
    { name: "averageTradePrice", wire: "ap", type: T.StreamPrice },
    { name: "openInterest", wire: "oi", type: T.Price },
    { name: "poi", wire: "poi", type: T.Price },
    { name: "toi", wire: "toi", type: T.Price },
    { name: "bq1", wire: "bq1", type: T.Quantity },
    { name: "bp1", wire: "bp1", type: T.StreamPrice },
    { name: "sq1", wire: "sq1", type: T.Quantity },
    { name: "sp1", wire: "sp1", type: T.StreamPrice },
    { name: "ft", wire: "ft", type: T.EpochTime },
    { name: "ordMsg", wire: "ord_msg", type: T.str },
    { name: "cp", wire: "cp", type: T.Price },
    { name: "ltt", wire: "ltt", type: T.str },
    { name: "ltq", wire: "ltq", type: T.Quantity },
    { name: "tbq", wire: "tbq", type: T.Quantity },
    { name: "tsq", wire: "tsq", type: T.Quantity },
    { name: "bp2", wire: "bp2", type: T.StreamPrice },
    { name: "bp3", wire: "bp3", type: T.StreamPrice },
    { name: "bp4", wire: "bp4", type: T.StreamPrice },
    { name: "bp5", wire: "bp5", type: T.StreamPrice },
    { name: "sp2", wire: "sp2", type: T.StreamPrice },
    { name: "sp3", wire: "sp3", type: T.StreamPrice },
    { name: "sp4", wire: "sp4", type: T.StreamPrice },
    { name: "sp5", wire: "sp5", type: T.StreamPrice },
    { name: "bq2", wire: "bq2", type: T.Quantity },
    { name: "bq3", wire: "bq3", type: T.Quantity },
    { name: "bq4", wire: "bq4", type: T.Quantity },
    { name: "bq5", wire: "bq5", type: T.Quantity },
    { name: "sq2", wire: "sq2", type: T.Quantity },
    { name: "sq3", wire: "sq3", type: T.Quantity },
    { name: "sq4", wire: "sq4", type: T.Quantity },
    { name: "sq5", wire: "sq5", type: T.Quantity },
    { name: "bo1", wire: "bo1", type: T.Quantity },
    { name: "bo2", wire: "bo2", type: T.Quantity },
    { name: "bo3", wire: "bo3", type: T.Quantity },
    { name: "bo4", wire: "bo4", type: T.Quantity },
    { name: "bo5", wire: "bo5", type: T.Quantity },
    { name: "so1", wire: "so1", type: T.Quantity },
    { name: "so2", wire: "so2", type: T.Quantity },
    { name: "so3", wire: "so3", type: T.Quantity },
    { name: "so4", wire: "so4", type: T.Quantity },
    { name: "so5", wire: "so5", type: T.Quantity },
    { name: "lc", wire: "lc", type: T.StreamPrice },
    { name: "uc", wire: "uc", type: T.StreamPrice },
    { name: "high52w", wire: "52h", type: T.StreamPrice },
    { name: "low52w", wire: "52l", type: T.StreamPrice },
  ],
};

/** Parse one `DepthAck` wire record. */
export function parseDepthAck(wire: unknown, ctx?: ParseContext): DepthAck {
  return parseModel(DepthAckSpec, wire, ctx) as DepthAck;
}

/** `df`: depth update (only changed fields besides `t`/`e`/`tk`). */
export interface DepthFeed {
  /** Wire key `t`. */
  readonly t: string;
  /** Wire key `e`. */
  readonly exchange: string | null;
  /** Wire key `tk`. */
  readonly token: string | null;
  /** Wire key `ts`. */
  readonly tradingsymbol: string | null;
  /** Wire key `pp`. */
  readonly pricePrecision: number | null;
  /** Wire key `ti`. */
  readonly tickSize: Decimal | null;
  /** Wire key `ls`. */
  readonly lotSize: number | null;
  /** Wire key `lp`. */
  readonly lastPrice: Decimal | null;
  /** Wire key `pc`. */
  readonly percentChange: string | null;
  /** Wire key `v`. */
  readonly volume: Decimal | null;
  /** Wire key `o`. */
  readonly open: Decimal | null;
  /** Wire key `h`. */
  readonly high: Decimal | null;
  /** Wire key `l`. */
  readonly low: Decimal | null;
  /** Wire key `c`. */
  readonly close: Decimal | null;
  /** Wire key `ap`. */
  readonly averageTradePrice: Decimal | null;
  /** Wire key `oi`. */
  readonly openInterest: Decimal | null;
  /** Wire key `poi`. */
  readonly poi: Decimal | null;
  /** Wire key `toi`. */
  readonly toi: Decimal | null;
  /** Wire key `bq1`. */
  readonly bq1: number | null;
  /** Wire key `bp1`. */
  readonly bp1: Decimal | null;
  /** Wire key `sq1`. */
  readonly sq1: number | null;
  /** Wire key `sp1`. */
  readonly sp1: Decimal | null;
  /** Wire key `ft`. */
  readonly ft: Date | null;
  /** Wire key `ord_msg`. */
  readonly ordMsg: string | null;
  /** Wire key `cp`. */
  readonly cp: Decimal | null;
  /** Wire key `ltt`. */
  readonly ltt: string | null;
  /** Wire key `ltq`. */
  readonly ltq: number | null;
  /** Wire key `tbq`. */
  readonly tbq: number | null;
  /** Wire key `tsq`. */
  readonly tsq: number | null;
  /** Wire key `bp2`. */
  readonly bp2: Decimal | null;
  /** Wire key `bp3`. */
  readonly bp3: Decimal | null;
  /** Wire key `bp4`. */
  readonly bp4: Decimal | null;
  /** Wire key `bp5`. */
  readonly bp5: Decimal | null;
  /** Wire key `sp2`. */
  readonly sp2: Decimal | null;
  /** Wire key `sp3`. */
  readonly sp3: Decimal | null;
  /** Wire key `sp4`. */
  readonly sp4: Decimal | null;
  /** Wire key `sp5`. */
  readonly sp5: Decimal | null;
  /** Wire key `bq2`. */
  readonly bq2: number | null;
  /** Wire key `bq3`. */
  readonly bq3: number | null;
  /** Wire key `bq4`. */
  readonly bq4: number | null;
  /** Wire key `bq5`. */
  readonly bq5: number | null;
  /** Wire key `sq2`. */
  readonly sq2: number | null;
  /** Wire key `sq3`. */
  readonly sq3: number | null;
  /** Wire key `sq4`. */
  readonly sq4: number | null;
  /** Wire key `sq5`. */
  readonly sq5: number | null;
  /** Wire key `bo1`. */
  readonly bo1: number | null;
  /** Wire key `bo2`. */
  readonly bo2: number | null;
  /** Wire key `bo3`. */
  readonly bo3: number | null;
  /** Wire key `bo4`. */
  readonly bo4: number | null;
  /** Wire key `bo5`. */
  readonly bo5: number | null;
  /** Wire key `so1`. */
  readonly so1: number | null;
  /** Wire key `so2`. */
  readonly so2: number | null;
  /** Wire key `so3`. */
  readonly so3: number | null;
  /** Wire key `so4`. */
  readonly so4: number | null;
  /** Wire key `so5`. */
  readonly so5: number | null;
  /** Wire key `lc`. */
  readonly lc: Decimal | null;
  /** Wire key `uc`. */
  readonly uc: Decimal | null;
  /** Wire key `52h`. */
  readonly high52w: Decimal | null;
  /** Wire key `52l`. */
  readonly low52w: Decimal | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `DepthFeed`. */
export const DepthFeedSpec: ModelSpec = {
  name: "DepthFeed",
  fields: [
    { name: "t", wire: "t", type: T.str, nullable: false, default: "" },
    { name: "exchange", wire: "e", type: T.str },
    { name: "token", wire: "tk", type: T.str },
    { name: "tradingsymbol", wire: "ts", type: T.str },
    { name: "pricePrecision", wire: "pp", type: T.Quantity },
    { name: "tickSize", wire: "ti", type: T.Price },
    { name: "lotSize", wire: "ls", type: T.Quantity },
    { name: "lastPrice", wire: "lp", type: T.StreamPrice },
    { name: "percentChange", wire: "pc", type: T.str },
    { name: "volume", wire: "v", type: T.Price },
    { name: "open", wire: "o", type: T.StreamPrice },
    { name: "high", wire: "h", type: T.StreamPrice },
    { name: "low", wire: "l", type: T.StreamPrice },
    { name: "close", wire: "c", type: T.StreamPrice },
    { name: "averageTradePrice", wire: "ap", type: T.StreamPrice },
    { name: "openInterest", wire: "oi", type: T.Price },
    { name: "poi", wire: "poi", type: T.Price },
    { name: "toi", wire: "toi", type: T.Price },
    { name: "bq1", wire: "bq1", type: T.Quantity },
    { name: "bp1", wire: "bp1", type: T.StreamPrice },
    { name: "sq1", wire: "sq1", type: T.Quantity },
    { name: "sp1", wire: "sp1", type: T.StreamPrice },
    { name: "ft", wire: "ft", type: T.EpochTime },
    { name: "ordMsg", wire: "ord_msg", type: T.str },
    { name: "cp", wire: "cp", type: T.Price },
    { name: "ltt", wire: "ltt", type: T.str },
    { name: "ltq", wire: "ltq", type: T.Quantity },
    { name: "tbq", wire: "tbq", type: T.Quantity },
    { name: "tsq", wire: "tsq", type: T.Quantity },
    { name: "bp2", wire: "bp2", type: T.StreamPrice },
    { name: "bp3", wire: "bp3", type: T.StreamPrice },
    { name: "bp4", wire: "bp4", type: T.StreamPrice },
    { name: "bp5", wire: "bp5", type: T.StreamPrice },
    { name: "sp2", wire: "sp2", type: T.StreamPrice },
    { name: "sp3", wire: "sp3", type: T.StreamPrice },
    { name: "sp4", wire: "sp4", type: T.StreamPrice },
    { name: "sp5", wire: "sp5", type: T.StreamPrice },
    { name: "bq2", wire: "bq2", type: T.Quantity },
    { name: "bq3", wire: "bq3", type: T.Quantity },
    { name: "bq4", wire: "bq4", type: T.Quantity },
    { name: "bq5", wire: "bq5", type: T.Quantity },
    { name: "sq2", wire: "sq2", type: T.Quantity },
    { name: "sq3", wire: "sq3", type: T.Quantity },
    { name: "sq4", wire: "sq4", type: T.Quantity },
    { name: "sq5", wire: "sq5", type: T.Quantity },
    { name: "bo1", wire: "bo1", type: T.Quantity },
    { name: "bo2", wire: "bo2", type: T.Quantity },
    { name: "bo3", wire: "bo3", type: T.Quantity },
    { name: "bo4", wire: "bo4", type: T.Quantity },
    { name: "bo5", wire: "bo5", type: T.Quantity },
    { name: "so1", wire: "so1", type: T.Quantity },
    { name: "so2", wire: "so2", type: T.Quantity },
    { name: "so3", wire: "so3", type: T.Quantity },
    { name: "so4", wire: "so4", type: T.Quantity },
    { name: "so5", wire: "so5", type: T.Quantity },
    { name: "lc", wire: "lc", type: T.StreamPrice },
    { name: "uc", wire: "uc", type: T.StreamPrice },
    { name: "high52w", wire: "52h", type: T.StreamPrice },
    { name: "low52w", wire: "52l", type: T.StreamPrice },
  ],
};

/** Parse one `DepthFeed` wire record. */
export function parseDepthFeed(wire: unknown, ctx?: ParseContext): DepthFeed {
  return parseModel(DepthFeedSpec, wire, ctx) as DepthFeed;
}

/** `om`: order update feed. Lenient record. */
export interface OrderUpdate {
  /** Wire key `t`. */
  readonly t: string;
  /** Wire key `norenordno`. */
  readonly orderId: string | null;
  /** Wire key `uid`. */
  readonly userId: string | null;
  /** Wire key `actid`. */
  readonly accountId: string | null;
  /** Wire key `exch`. */
  readonly exchange: string | null;
  /** Wire key `tsym`. */
  readonly tradingsymbol: string | null;
  /** Wire key `qty`. */
  readonly quantity: number | null;
  /** Wire key `prc`. */
  readonly price: Decimal | null;
  /** Wire key `pcode`. */
  readonly pcode: string | null;
  /** Wire key `status`. */
  readonly status: OpenEnum<OrderStatus> | null;
  /** Wire key `reporttype`. */
  readonly reporttype: string | null;
  /** Wire key `trantype`. */
  readonly transactionType: OpenEnum<TransactionType> | null;
  /** Wire key `prctyp`. */
  readonly orderType: OpenEnum<OrderType> | null;
  /** Wire key `ret`. */
  readonly validity: OpenEnum<Validity> | null;
  /** Wire key `fillshares`. */
  readonly filledQuantity: number | null;
  /** Wire key `avgprc`. */
  readonly averagePrice: Decimal | null;
  /** Wire key `fltm`. */
  readonly fltm: string | null;
  /** Wire key `flid`. */
  readonly flid: string | null;
  /** Wire key `flqty`. */
  readonly flqty: number | null;
  /** Wire key `flprc`. */
  readonly flprc: Decimal | null;
  /** Wire key `rejreason`. */
  readonly rejectReason: string | null;
  /** Wire key `exchordid`. */
  readonly exchangeOrderId: string | null;
  /** Wire key `cancelqty`. */
  readonly cancelqty: number | null;
  /** Wire key `remarks`. */
  readonly tag: string | null;
  /** Wire key `dscqty`. */
  readonly disclosedQuantity: number | null;
  /** Wire key `trgprc`. */
  readonly triggerPrice: Decimal | null;
  /** Wire key `snonum`. */
  readonly snoNumber: string | null;
  /** Wire key `snoordt`. */
  readonly snoordt: string | null;
  /** Wire key `blprc`. */
  readonly bookLossPrice: Decimal | null;
  /** Wire key `bpprc`. */
  readonly bookProfitPrice: Decimal | null;
  /** Wire key `trailprc`. */
  readonly trailPrice: Decimal | null;
  /** Wire key `exch_tm`. */
  readonly exchTm: Date | null;
  /** Wire key `amo`. */
  readonly amo: string | null;
  /** Wire key `tm`. */
  readonly tm: string | null;
  /** Wire key `ntm`. */
  readonly ntm: string | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `OrderUpdate`. */
export const OrderUpdateSpec: ModelSpec = {
  name: "OrderUpdate",
  fields: [
    { name: "t", wire: "t", type: T.str, nullable: false, lenient: true, default: "" },
    { name: "orderId", wire: "norenordno", type: T.str, protected: true },
    { name: "userId", wire: "uid", type: T.str, lenient: true },
    { name: "accountId", wire: "actid", type: T.str, lenient: true },
    { name: "exchange", wire: "exch", type: T.str, lenient: true },
    { name: "tradingsymbol", wire: "tsym", type: T.str, lenient: true },
    { name: "quantity", wire: "qty", type: T.Quantity, lenient: true },
    { name: "price", wire: "prc", type: T.StreamPrice, lenient: true },
    { name: "pcode", wire: "pcode", type: T.str, lenient: true },
    { name: "status", wire: "status", type: T.enum(OrderStatus), protected: true },
    { name: "reporttype", wire: "reporttype", type: T.str, lenient: true },
    { name: "transactionType", wire: "trantype", type: T.enum(TransactionType), lenient: true },
    { name: "orderType", wire: "prctyp", type: T.enum(OrderType), lenient: true },
    { name: "validity", wire: "ret", type: T.enum(Validity), lenient: true },
    { name: "filledQuantity", wire: "fillshares", type: T.Quantity, lenient: true },
    { name: "averagePrice", wire: "avgprc", type: T.StreamPrice, lenient: true },
    { name: "fltm", wire: "fltm", type: T.str, lenient: true },
    { name: "flid", wire: "flid", type: T.str, lenient: true },
    { name: "flqty", wire: "flqty", type: T.Quantity, lenient: true },
    { name: "flprc", wire: "flprc", type: T.StreamPrice, lenient: true },
    { name: "rejectReason", wire: "rejreason", type: T.str, lenient: true },
    { name: "exchangeOrderId", wire: "exchordid", type: T.str, lenient: true },
    { name: "cancelqty", wire: "cancelqty", type: T.Quantity, lenient: true },
    { name: "tag", wire: "remarks", type: T.str, lenient: true },
    { name: "disclosedQuantity", wire: "dscqty", type: T.Quantity, lenient: true },
    { name: "triggerPrice", wire: "trgprc", type: T.StreamPrice, lenient: true },
    { name: "snoNumber", wire: "snonum", type: T.str, lenient: true },
    { name: "snoordt", wire: "snoordt", type: T.str, lenient: true },
    { name: "bookLossPrice", wire: "blprc", type: T.Price, lenient: true },
    { name: "bookProfitPrice", wire: "bpprc", type: T.Price, lenient: true },
    { name: "trailPrice", wire: "trailprc", type: T.Price, lenient: true },
    { name: "exchTm", wire: "exch_tm", type: T.ISTDateTime, lenient: true },
    { name: "amo", wire: "amo", type: T.str, lenient: true },
    { name: "tm", wire: "tm", type: T.str, lenient: true },
    { name: "ntm", wire: "ntm", type: T.str, lenient: true },
  ],
};

/** Parse one `OrderUpdate` wire record. */
export function parseOrderUpdate(wire: unknown, ctx?: ParseContext): OrderUpdate {
  return parseModel(OrderUpdateSpec, wire, ctx) as OrderUpdate;
}

/** `pk`: position subscription acknowledgement. Lenient record. */
export interface PositionAck {
  /** Wire key `t`. */
  readonly t: string;
  /** Wire key `uid`. */
  readonly userId: string | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `PositionAck`. */
export const PositionAckSpec: ModelSpec = {
  name: "PositionAck",
  fields: [
    { name: "t", wire: "t", type: T.str, nullable: false, lenient: true, default: "" },
    { name: "userId", wire: "uid", type: T.str, lenient: true },
  ],
};

/** Parse one `PositionAck` wire record. */
export function parsePositionAck(wire: unknown, ctx?: ParseContext): PositionAck {
  return parseModel(PositionAckSpec, wire, ctx) as PositionAck;
}

/** `pm`: position feed. Lenient record. */
export interface PositionUpdate {
  /** Wire key `t`. */
  readonly t: string;
  /** Wire key `exch`. */
  readonly exchange: string | null;
  /** Wire key `token`. */
  readonly token: string | null;
  /** Wire key `tsym`. */
  readonly tradingsymbol: string | null;
  /** Wire key `uid`. */
  readonly userId: string | null;
  /** Wire key `actid`. */
  readonly accountId: string | null;
  /** Wire key `prd`. */
  readonly product: OpenEnum<Product> | null;
  /** Wire key `daybuyqty`. */
  readonly daybuyqty: number | null;
  /** Wire key `daysellqty`. */
  readonly daysellqty: number | null;
  /** Wire key `daybuyamt`. */
  readonly daybuyamt: Decimal | null;
  /** Wire key `daysellamt`. */
  readonly daysellamt: Decimal | null;
  /** Wire key `cfbuyqty`. */
  readonly cfbuyqty: number | null;
  /** Wire key `cfsellqty`. */
  readonly cfsellqty: number | null;
  /** Wire key `cfbuyamt`. */
  readonly cfbuyamt: Decimal | null;
  /** Wire key `cfsellamt`. */
  readonly cfsellamt: Decimal | null;
  /** Wire key `openbuyqty`. */
  readonly openbuyqty: number | null;
  /** Wire key `opensellqty`. */
  readonly opensellqty: number | null;
  /** Wire key `openbuyamt`. */
  readonly openbuyamt: Decimal | null;
  /** Wire key `opensellamt`. */
  readonly opensellamt: Decimal | null;
  /** Wire key `buyavgprc`. */
  readonly buyavgprc: Decimal | null;
  /** Wire key `sellavgprc`. */
  readonly sellavgprc: Decimal | null;
  /** Wire key `rpnl`. */
  readonly realizedPnl: Decimal | null;
  /** Wire key `netqty`. */
  readonly netQuantity: number | null;
  /** Wire key `totbuyamt`. */
  readonly totbuyamt: Decimal | null;
  /** Wire key `totsellamt`. */
  readonly totsellamt: Decimal | null;
  /** Wire key `totbuyavgprc`. */
  readonly totbuyavgprc: Decimal | null;
  /** Wire key `totsellavgprc`. */
  readonly totsellavgprc: Decimal | null;
  /** Wire key `child_orders`. */
  readonly childOrders: readonly Readonly<Record<string, unknown>>[] | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `PositionUpdate`. */
export const PositionUpdateSpec: ModelSpec = {
  name: "PositionUpdate",
  fields: [
    { name: "t", wire: "t", type: T.str, nullable: false, lenient: true, default: "" },
    { name: "exchange", wire: "exch", type: T.str, lenient: true },
    { name: "token", wire: "token", type: T.str, lenient: true },
    { name: "tradingsymbol", wire: "tsym", type: T.str, lenient: true },
    { name: "userId", wire: "uid", type: T.str, lenient: true },
    { name: "accountId", wire: "actid", type: T.str, lenient: true },
    { name: "product", wire: "prd", type: T.enum(Product), lenient: true },
    { name: "daybuyqty", wire: "daybuyqty", type: T.Quantity, lenient: true },
    { name: "daysellqty", wire: "daysellqty", type: T.Quantity, lenient: true },
    { name: "daybuyamt", wire: "daybuyamt", type: T.Price, lenient: true },
    { name: "daysellamt", wire: "daysellamt", type: T.Price, lenient: true },
    { name: "cfbuyqty", wire: "cfbuyqty", type: T.Quantity, lenient: true },
    { name: "cfsellqty", wire: "cfsellqty", type: T.Quantity, lenient: true },
    { name: "cfbuyamt", wire: "cfbuyamt", type: T.Price, lenient: true },
    { name: "cfsellamt", wire: "cfsellamt", type: T.Price, lenient: true },
    { name: "openbuyqty", wire: "openbuyqty", type: T.Quantity, lenient: true },
    { name: "opensellqty", wire: "opensellqty", type: T.Quantity, lenient: true },
    { name: "openbuyamt", wire: "openbuyamt", type: T.Price, lenient: true },
    { name: "opensellamt", wire: "opensellamt", type: T.Price, lenient: true },
    { name: "buyavgprc", wire: "buyavgprc", type: T.Price, lenient: true },
    { name: "sellavgprc", wire: "sellavgprc", type: T.Price, lenient: true },
    { name: "realizedPnl", wire: "rpnl", type: T.Price, lenient: true },
    { name: "netQuantity", wire: "netqty", type: T.Quantity, lenient: true },
    { name: "totbuyamt", wire: "totbuyamt", type: T.Price, lenient: true },
    { name: "totsellamt", wire: "totsellamt", type: T.Price, lenient: true },
    { name: "totbuyavgprc", wire: "totbuyavgprc", type: T.Price, lenient: true },
    { name: "totsellavgprc", wire: "totsellavgprc", type: T.Price, lenient: true },
    { name: "childOrders", wire: "child_orders", type: T.list(T.object), lenient: true },
  ],
};

/** Parse one `PositionUpdate` wire record. */
export function parsePositionUpdate(wire: unknown, ctx?: ParseContext): PositionUpdate {
  return parseModel(PositionUpdateSpec, wire, ctx) as PositionUpdate;
}

/** `uk` / `udk` / `uok` / `upk`: unsubscribe acknowledgement. */
export interface UnsubscribeAck {
  /** Wire key `t`. */
  readonly t: string;
  /** Wire key `k`. */
  readonly k: string | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `UnsubscribeAck`. */
export const UnsubscribeAckSpec: ModelSpec = {
  name: "UnsubscribeAck",
  fields: [
    { name: "t", wire: "t", type: T.str, nullable: false, default: "" },
    { name: "k", wire: "k", type: T.str },
  ],
};

/** Parse one `UnsubscribeAck` wire record. */
export function parseUnsubscribeAck(wire: unknown, ctx?: ParseContext): UnsubscribeAck {
  return parseModel(UnsubscribeAckSpec, wire, ctx) as UnsubscribeAck;
}

/** `hk`: heartbeat acknowledgement (`ft` in seconds). */
export interface HeartbeatAck {
  /** Wire key `t`. */
  readonly t: string;
  /** Wire key `ft`. */
  readonly ft: Date | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `HeartbeatAck`. */
export const HeartbeatAckSpec: ModelSpec = {
  name: "HeartbeatAck",
  fields: [
    { name: "t", wire: "t", type: T.str, nullable: false, default: "" },
    { name: "ft", wire: "ft", type: T.EpochTime },
  ],
};

/** Parse one `HeartbeatAck` wire record. */
export function parseHeartbeatAck(wire: unknown, ctx?: ParseContext): HeartbeatAck {
  return parseModel(HeartbeatAckSpec, wire, ctx) as HeartbeatAck;
}

/** A message that is not valid JSON, has an unknown `t`, or failed validation. */
export interface UnknownMessage {
  /** Wire key `t`. */
  readonly t: string;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `UnknownMessage`. */
export const UnknownMessageSpec: ModelSpec = {
  name: "UnknownMessage",
  fields: [{ name: "t", wire: "t", type: T.str, nullable: false, default: "" }],
};

/** Parse one `UnknownMessage` wire record. */
export function parseUnknownMessage(wire: unknown, ctx?: ParseContext): UnknownMessage {
  return parseModel(UnknownMessageSpec, wire, ctx) as UnknownMessage;
}

/** Parser of each stream message type (`t`). */
export const STREAM_MESSAGE_PARSERS: Readonly<Record<string, ModelParser>> = Object.freeze({
  ak: parseConnectAck,
  tk: parseTouchlineAck,
  tf: parseTouchlineFeed,
  dk: parseDepthAck,
  df: parseDepthFeed,
  om: parseOrderUpdate,
  pk: parsePositionAck,
  pm: parsePositionUpdate,
  uk: parseUnsubscribeAck,
  udk: parseUnsubscribeAck,
  uok: parseUnsubscribeAck,
  upk: parseUnsubscribeAck,
  hk: parseHeartbeatAck,
});
