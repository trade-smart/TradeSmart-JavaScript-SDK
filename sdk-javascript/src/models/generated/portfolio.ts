// GENERATED from specifications/models.json by scripts/gen-models.ts — do not edit
import type { Decimal } from "../../lib/decimal.js";
import { T, parseModel, type ModelSpec, type OpenEnum, type ParseContext } from "../base.js";
import { Product } from "./enums.js";

/** One exchange listing (`exch_tsym` element) of a holding. */
export interface HoldingInstrument {
  /** Wire key `exch`. */
  readonly exchange: string | null;
  /** Wire key `tsym`. */
  readonly tradingsymbol: string | null;
  /** Wire key `token`. */
  readonly token: string | null;
  /** Wire key `pp`. */
  readonly pricePrecision: number | null;
  /** Wire key `ti`. */
  readonly tickSize: Decimal | null;
  /** Wire key `ls`. */
  readonly lotSize: number | null;
  /** Wire key `lp`. */
  readonly lastPrice: Decimal | null;
  /** Wire key `cname`. */
  readonly cname: string | null;
  /** Wire key `dname`. */
  readonly dname: string | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `HoldingInstrument`. */
export const HoldingInstrumentSpec: ModelSpec = {
  name: "HoldingInstrument",
  fields: [
    { name: "exchange", wire: "exch", type: T.str },
    { name: "tradingsymbol", wire: "tsym", type: T.str },
    { name: "token", wire: "token", type: T.str },
    { name: "pricePrecision", wire: "pp", type: T.Quantity },
    { name: "tickSize", wire: "ti", type: T.Price },
    { name: "lotSize", wire: "ls", type: T.Quantity },
    { name: "lastPrice", wire: "lp", type: T.Price },
    { name: "cname", wire: "cname", type: T.str },
    { name: "dname", wire: "dname", type: T.str },
  ],
};

/** Parse one `HoldingInstrument` wire record. */
export function parseHoldingInstrument(wire: unknown, ctx?: ParseContext): HoldingInstrument {
  return parseModel(HoldingInstrumentSpec, wire, ctx) as HoldingInstrument;
}

/** One holding record of `Holdings`. Lenient record. */
export interface Holding {
  /** Wire key `stat`. */
  readonly stat: string | null;
  /** Wire key `exch_tsym`. */
  readonly instruments: readonly HoldingInstrument[] | null;
  /** Wire key `holdqty`. */
  readonly holdqty: number | null;
  /** Wire key `dpqty`. */
  readonly dpqty: number | null;
  /** Wire key `npoadqty`. */
  readonly npoadqty: number | null;
  /** Wire key `brkcolqty`. */
  readonly brkcolqty: number | null;
  /** Wire key `colqty`. */
  readonly colqty: number | null;
  /** Wire key `benqty`. */
  readonly benqty: number | null;
  /** Wire key `unplgdqty`. */
  readonly unplgdqty: number | null;
  /** Wire key `btstqty`. */
  readonly btstqty: number | null;
  /** Wire key `btstcolqty`. */
  readonly btstcolqty: number | null;
  /** Wire key `usedqty`. */
  readonly usedqty: number | null;
  /** Wire key `upldprc`. */
  readonly upldprc: Decimal | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `Holding`. */
export const HoldingSpec: ModelSpec = {
  name: "Holding",
  fields: [
    { name: "stat", wire: "stat", type: T.str, lenient: true },
    {
      name: "instruments",
      wire: "exch_tsym",
      type: T.list(T.model(parseHoldingInstrument)),
      lenient: true,
    },
    { name: "holdqty", wire: "holdqty", type: T.Quantity, lenient: true },
    { name: "dpqty", wire: "dpqty", type: T.Quantity, lenient: true },
    { name: "npoadqty", wire: "npoadqty", type: T.Quantity, lenient: true },
    { name: "brkcolqty", wire: "brkcolqty", type: T.Quantity, lenient: true },
    { name: "colqty", wire: "colqty", type: T.Quantity, lenient: true },
    { name: "benqty", wire: "benqty", type: T.Quantity, lenient: true },
    { name: "unplgdqty", wire: "unplgdqty", type: T.Quantity, lenient: true },
    { name: "btstqty", wire: "btstqty", type: T.Quantity, lenient: true },
    { name: "btstcolqty", wire: "btstcolqty", type: T.Quantity, lenient: true },
    { name: "usedqty", wire: "usedqty", type: T.Quantity, lenient: true },
    { name: "upldprc", wire: "upldprc", type: T.Price, lenient: true },
  ],
};

/** Parse one `Holding` wire record. */
export function parseHolding(wire: unknown, ctx?: ParseContext): Holding {
  return parseModel(HoldingSpec, wire, ctx) as Holding;
}

/** Result of `Limits`. */
export interface Limits {
  /** Wire key `stat`. */
  readonly stat: string | null;
  /** Wire key `request_time`. */
  readonly requestTime: Date | null;
  /** Wire key `actid`. */
  readonly accountId: string | null;
  /** Wire key `prd`. */
  readonly product: OpenEnum<Product> | null;
  /** Wire key `seg`. */
  readonly seg: string | null;
  /** Wire key `exch`. */
  readonly exchange: string | null;
  /** Wire key `prfname`. */
  readonly prfname: string | null;
  /** Wire key `remarks_text`. */
  readonly remarksText: string | null;
  /** Wire key `rpnl`. */
  readonly realizedPnl: Decimal | null;
  /** Wire key `cash`. */
  readonly cash: Decimal | null;
  /** Wire key `payin`. */
  readonly payin: Decimal | null;
  /** Wire key `payout`. */
  readonly payout: Decimal | null;
  /** Wire key `remarks_amt`. */
  readonly remarksAmt: Decimal | null;
  /** Wire key `cac_daycash`. */
  readonly cacDaycash: Decimal | null;
  /** Wire key `brkcollamt`. */
  readonly brkcollamt: Decimal | null;
  /** Wire key `unclearedcash`. */
  readonly unclearedcash: Decimal | null;
  /** Wire key `daycash`. */
  readonly daycash: Decimal | null;
  /** Wire key `marginused`. */
  readonly marginused: Decimal | null;
  /** Wire key `mtomcurper`. */
  readonly mtomcurper: Decimal | null;
  /** Wire key `cbu`. */
  readonly cbu: Decimal | null;
  /** Wire key `csc`. */
  readonly csc: Decimal | null;
  /** Wire key `unmtom`. */
  readonly unmtom: Decimal | null;
  /** Wire key `marprt`. */
  readonly marprt: Decimal | null;
  /** Wire key `span`. */
  readonly span: Decimal | null;
  /** Wire key `expo`. */
  readonly expo: Decimal | null;
  /** Wire key `premium`. */
  readonly premium: Decimal | null;
  /** Wire key `varelm`. */
  readonly varelm: Decimal | null;
  /** Wire key `grexpo`. */
  readonly grexpo: Decimal | null;
  /** Wire key `greexpo_d`. */
  readonly greexpoD: Decimal | null;
  /** Wire key `scripbskmar`. */
  readonly scripbskmar: Decimal | null;
  /** Wire key `addscripbskmrg`. */
  readonly addscripbskmrg: Decimal | null;
  /** Wire key `brokerage`. */
  readonly brokerage: Decimal | null;
  /** Wire key `collateral`. */
  readonly collateral: Decimal | null;
  /** Wire key `cash_coll`. */
  readonly cashColl: Decimal | null;
  /** Wire key `grcoll`. */
  readonly grcoll: Decimal | null;
  /** Wire key `turnoverlmt`. */
  readonly turnoverlmt: Decimal | null;
  /** Wire key `pendordvallmt`. */
  readonly pendordvallmt: Decimal | null;
  /** Wire key `aux_daycash`. */
  readonly auxDaycash: Decimal | null;
  /** Wire key `aux_brkcollamt`. */
  readonly auxBrkcollamt: Decimal | null;
  /** Wire key `aux_unclearedcash`. */
  readonly auxUnclearedcash: Decimal | null;
  /** Wire key `blk_amt`. */
  readonly blkAmt: Decimal | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `Limits`. */
export const LimitsSpec: ModelSpec = {
  name: "Limits",
  fields: [
    { name: "stat", wire: "stat", type: T.str },
    { name: "requestTime", wire: "request_time", type: T.ISTDateTime },
    { name: "accountId", wire: "actid", type: T.str },
    { name: "product", wire: "prd", type: T.enum(Product) },
    { name: "seg", wire: "seg", type: T.str },
    { name: "exchange", wire: "exch", type: T.str },
    { name: "prfname", wire: "prfname", type: T.str },
    { name: "remarksText", wire: "remarks_text", type: T.str },
    { name: "realizedPnl", wire: "rpnl", type: T.Price },
    { name: "cash", wire: "cash", type: T.Price },
    { name: "payin", wire: "payin", type: T.Price },
    { name: "payout", wire: "payout", type: T.Price },
    { name: "remarksAmt", wire: "remarks_amt", type: T.Price },
    { name: "cacDaycash", wire: "cac_daycash", type: T.Price },
    { name: "brkcollamt", wire: "brkcollamt", type: T.Price },
    { name: "unclearedcash", wire: "unclearedcash", type: T.Price },
    { name: "daycash", wire: "daycash", type: T.Price },
    { name: "marginused", wire: "marginused", type: T.Price },
    { name: "mtomcurper", wire: "mtomcurper", type: T.Price },
    { name: "cbu", wire: "cbu", type: T.Price },
    { name: "csc", wire: "csc", type: T.Price },
    { name: "unmtom", wire: "unmtom", type: T.Price },
    { name: "marprt", wire: "marprt", type: T.Price },
    { name: "span", wire: "span", type: T.Price },
    { name: "expo", wire: "expo", type: T.Price },
    { name: "premium", wire: "premium", type: T.Price },
    { name: "varelm", wire: "varelm", type: T.Price },
    { name: "grexpo", wire: "grexpo", type: T.Price },
    { name: "greexpoD", wire: "greexpo_d", type: T.Price },
    { name: "scripbskmar", wire: "scripbskmar", type: T.Price },
    { name: "addscripbskmrg", wire: "addscripbskmrg", type: T.Price },
    { name: "brokerage", wire: "brokerage", type: T.Price },
    { name: "collateral", wire: "collateral", type: T.Price },
    { name: "cashColl", wire: "cash_coll", type: T.Price },
    { name: "grcoll", wire: "grcoll", type: T.Price },
    { name: "turnoverlmt", wire: "turnoverlmt", type: T.Price },
    { name: "pendordvallmt", wire: "pendordvallmt", type: T.Price },
    { name: "auxDaycash", wire: "aux_daycash", type: T.Price },
    { name: "auxBrkcollamt", wire: "aux_brkcollamt", type: T.Price },
    { name: "auxUnclearedcash", wire: "aux_unclearedcash", type: T.Price },
    { name: "blkAmt", wire: "blk_amt", type: T.Price },
  ],
};

/** Parse one `Limits` wire record. */
export function parseLimits(wire: unknown, ctx?: ParseContext): Limits {
  return parseModel(LimitsSpec, wire, ctx) as Limits;
}

/** One open position of `PositionBook`. Lenient record. */
export interface Position {
  /** Wire key `stat`. */
  readonly stat: string | null;
  /** Wire key `request_time`. */
  readonly requestTime: Date | null;
  /** Wire key `exch`. */
  readonly exchange: string | null;
  /** Wire key `tsym`. */
  readonly tradingsymbol: string | null;
  /** Wire key `token`. */
  readonly token: string | null;
  /** Wire key `uid`. */
  readonly userId: string | null;
  /** Wire key `actid`. */
  readonly accountId: string | null;
  /** Wire key `prd`. */
  readonly product: OpenEnum<Product> | null;
  /** Wire key `s_prdt_ali`. */
  readonly sPrdtAli: string | null;
  /** Wire key `netqty`. */
  readonly netQuantity: number | null;
  /** Wire key `lp`. */
  readonly lastPrice: Decimal | null;
  /** Wire key `rpnl`. */
  readonly realizedPnl: Decimal | null;
  /** Wire key `pp`. */
  readonly pricePrecision: number | null;
  /** Wire key `ti`. */
  readonly tickSize: Decimal | null;
  /** Wire key `ls`. */
  readonly lotSize: number | null;
  /** Wire key `instname`. */
  readonly instname: string | null;
  /** Wire key `dname`. */
  readonly dname: string | null;
  /** Wire key `cname`. */
  readonly cname: string | null;
  /** Wire key `daybuyqty`. */
  readonly daybuyqty: number | null;
  /** Wire key `daysellqty`. */
  readonly daysellqty: number | null;
  /** Wire key `cfbuyqty`. */
  readonly cfbuyqty: number | null;
  /** Wire key `cfsellqty`. */
  readonly cfsellqty: number | null;
  /** Wire key `openbuyqty`. */
  readonly openbuyqty: number | null;
  /** Wire key `opensellqty`. */
  readonly opensellqty: number | null;
  /** Wire key `netavgprc`. */
  readonly netavgprc: Decimal | null;
  /** Wire key `dayavgprc`. */
  readonly dayavgprc: Decimal | null;
  /** Wire key `daybuyavgprc`. */
  readonly daybuyavgprc: Decimal | null;
  /** Wire key `daysellavgprc`. */
  readonly daysellavgprc: Decimal | null;
  /** Wire key `daybuyamt`. */
  readonly daybuyamt: Decimal | null;
  /** Wire key `daysellamt`. */
  readonly daysellamt: Decimal | null;
  /** Wire key `cforgavgprc`. */
  readonly cforgavgprc: Decimal | null;
  /** Wire key `cfbuyavgprc`. */
  readonly cfbuyavgprc: Decimal | null;
  /** Wire key `cfsellavgprc`. */
  readonly cfsellavgprc: Decimal | null;
  /** Wire key `cfbuyamt`. */
  readonly cfbuyamt: Decimal | null;
  /** Wire key `cfsellamt`. */
  readonly cfsellamt: Decimal | null;
  /** Wire key `totbuyamt`. */
  readonly totbuyamt: Decimal | null;
  /** Wire key `totsellamt`. */
  readonly totsellamt: Decimal | null;
  /** Wire key `totbuyavgprc`. */
  readonly totbuyavgprc: Decimal | null;
  /** Wire key `totsellavgprc`. */
  readonly totsellavgprc: Decimal | null;
  /** Wire key `bep`. */
  readonly bep: Decimal | null;
  /** Wire key `openbuyamt`. */
  readonly openbuyamt: Decimal | null;
  /** Wire key `opensellamt`. */
  readonly opensellamt: Decimal | null;
  /** Wire key `openbuyavgprc`. */
  readonly openbuyavgprc: Decimal | null;
  /** Wire key `opensellavgprc`. */
  readonly opensellavgprc: Decimal | null;
  /** Wire key `mult`. */
  readonly mult: Decimal | null;
  /** Wire key `prcftr`. */
  readonly prcftr: Decimal | null;
  /** Wire key `upldprc`. */
  readonly upldprc: Decimal | null;
  /** Wire key `netupldprc`. */
  readonly netupldprc: Decimal | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `Position`. */
export const PositionSpec: ModelSpec = {
  name: "Position",
  fields: [
    { name: "stat", wire: "stat", type: T.str, lenient: true },
    { name: "requestTime", wire: "request_time", type: T.ISTDateTime, lenient: true },
    { name: "exchange", wire: "exch", type: T.str, lenient: true },
    { name: "tradingsymbol", wire: "tsym", type: T.str, lenient: true },
    { name: "token", wire: "token", type: T.str, lenient: true },
    { name: "userId", wire: "uid", type: T.str, lenient: true },
    { name: "accountId", wire: "actid", type: T.str, lenient: true },
    { name: "product", wire: "prd", type: T.enum(Product), lenient: true },
    { name: "sPrdtAli", wire: "s_prdt_ali", type: T.str, lenient: true },
    { name: "netQuantity", wire: "netqty", type: T.Quantity, lenient: true },
    { name: "lastPrice", wire: "lp", type: T.Price, lenient: true },
    { name: "realizedPnl", wire: "rpnl", type: T.Price, lenient: true },
    { name: "pricePrecision", wire: "pp", type: T.Quantity, lenient: true },
    { name: "tickSize", wire: "ti", type: T.Price, lenient: true },
    { name: "lotSize", wire: "ls", type: T.Quantity, lenient: true },
    { name: "instname", wire: "instname", type: T.str, lenient: true },
    { name: "dname", wire: "dname", type: T.str, lenient: true },
    { name: "cname", wire: "cname", type: T.str, lenient: true },
    { name: "daybuyqty", wire: "daybuyqty", type: T.Quantity, lenient: true },
    { name: "daysellqty", wire: "daysellqty", type: T.Quantity, lenient: true },
    { name: "cfbuyqty", wire: "cfbuyqty", type: T.Quantity, lenient: true },
    { name: "cfsellqty", wire: "cfsellqty", type: T.Quantity, lenient: true },
    { name: "openbuyqty", wire: "openbuyqty", type: T.Quantity, lenient: true },
    { name: "opensellqty", wire: "opensellqty", type: T.Quantity, lenient: true },
    { name: "netavgprc", wire: "netavgprc", type: T.Price, lenient: true },
    { name: "dayavgprc", wire: "dayavgprc", type: T.Price, lenient: true },
    { name: "daybuyavgprc", wire: "daybuyavgprc", type: T.Price, lenient: true },
    { name: "daysellavgprc", wire: "daysellavgprc", type: T.Price, lenient: true },
    { name: "daybuyamt", wire: "daybuyamt", type: T.Price, lenient: true },
    { name: "daysellamt", wire: "daysellamt", type: T.Price, lenient: true },
    { name: "cforgavgprc", wire: "cforgavgprc", type: T.Price, lenient: true },
    { name: "cfbuyavgprc", wire: "cfbuyavgprc", type: T.Price, lenient: true },
    { name: "cfsellavgprc", wire: "cfsellavgprc", type: T.Price, lenient: true },
    { name: "cfbuyamt", wire: "cfbuyamt", type: T.Price, lenient: true },
    { name: "cfsellamt", wire: "cfsellamt", type: T.Price, lenient: true },
    { name: "totbuyamt", wire: "totbuyamt", type: T.Price, lenient: true },
    { name: "totsellamt", wire: "totsellamt", type: T.Price, lenient: true },
    { name: "totbuyavgprc", wire: "totbuyavgprc", type: T.Price, lenient: true },
    { name: "totsellavgprc", wire: "totsellavgprc", type: T.Price, lenient: true },
    { name: "bep", wire: "bep", type: T.Price, lenient: true },
    { name: "openbuyamt", wire: "openbuyamt", type: T.Price, lenient: true },
    { name: "opensellamt", wire: "opensellamt", type: T.Price, lenient: true },
    { name: "openbuyavgprc", wire: "openbuyavgprc", type: T.Price, lenient: true },
    { name: "opensellavgprc", wire: "opensellavgprc", type: T.Price, lenient: true },
    { name: "mult", wire: "mult", type: T.Price, lenient: true },
    { name: "prcftr", wire: "prcftr", type: T.Price, lenient: true },
    { name: "upldprc", wire: "upldprc", type: T.Price, lenient: true },
    { name: "netupldprc", wire: "netupldprc", type: T.Price, lenient: true },
  ],
};

/** Parse one `Position` wire record. */
export function parsePosition(wire: unknown, ctx?: ParseContext): Position {
  return parseModel(PositionSpec, wire, ctx) as Position;
}
