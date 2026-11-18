// GENERATED from specifications/models.json by scripts/gen-models.ts — do not edit
import type { Decimal } from "../../lib/decimal.js";
import { T, parseModel, type ModelSpec, type ParseContext } from "../base.js";

/** One match of `SearchScrip`. */
export interface ScripMatch {
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
  /** Wire key `weekly`. */
  readonly weekly: string | null;
  /** Wire key `nontrd`. */
  readonly nontrd: string | null;
  /** Wire key `dname`. */
  readonly dname: string | null;
  /** Wire key `cname`. */
  readonly cname: string | null;
  /** Wire key `optt`. */
  readonly optt: string | null;
  /** Wire key `instname`. */
  readonly instname: string | null;
  /** Wire key `symname`. */
  readonly symname: string | null;
  /** Wire key `seg`. */
  readonly seg: string | null;
  /** Wire key `exd`. */
  readonly exd: string | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `ScripMatch`. */
export const ScripMatchSpec: ModelSpec = {
  name: "ScripMatch",
  fields: [
    { name: "exchange", wire: "exch", type: T.str },
    { name: "tradingsymbol", wire: "tsym", type: T.str },
    { name: "token", wire: "token", type: T.str },
    { name: "pricePrecision", wire: "pp", type: T.Quantity },
    { name: "tickSize", wire: "ti", type: T.Price },
    { name: "lotSize", wire: "ls", type: T.Quantity },
    { name: "weekly", wire: "weekly", type: T.str },
    { name: "nontrd", wire: "nontrd", type: T.str },
    { name: "dname", wire: "dname", type: T.str },
    { name: "cname", wire: "cname", type: T.str },
    { name: "optt", wire: "optt", type: T.str },
    { name: "instname", wire: "instname", type: T.str },
    { name: "symname", wire: "symname", type: T.str },
    { name: "seg", wire: "seg", type: T.str },
    { name: "exd", wire: "exd", type: T.str },
  ],
};

/** Parse one `ScripMatch` wire record. */
export function parseScripMatch(wire: unknown, ctx?: ParseContext): ScripMatch {
  return parseModel(ScripMatchSpec, wire, ctx) as ScripMatch;
}

/** Result of `GetQuotes` (flat snapshot incl. five depth levels). */
export interface Quote {
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
  /** Wire key `pp`. */
  readonly pricePrecision: number | null;
  /** Wire key `ls`. */
  readonly lotSize: number | null;
  /** Wire key `ti`. */
  readonly tickSize: Decimal | null;
  /** Wire key `mult`. */
  readonly mult: string | null;
  /** Wire key `sptprc`. */
  readonly sptprc: Decimal | null;
  /** Wire key `lut`. */
  readonly feedTime: Date | null;
  /** Wire key `lp`. */
  readonly lastPrice: Decimal | null;
  /** Wire key `uc`. */
  readonly uc: Decimal | null;
  /** Wire key `lc`. */
  readonly lc: Decimal | null;
  /** Wire key `wk52_h`. */
  readonly wk52H: Decimal | null;
  /** Wire key `wk52_l`. */
  readonly wk52L: Decimal | null;
  /** Wire key `oi`. */
  readonly openInterest: Decimal | null;
  /** Wire key `toi`. */
  readonly toi: Decimal | null;
  /** Wire key `strprc`. */
  readonly strprc: Decimal | null;
  /** Wire key `cname`. */
  readonly cname: string | null;
  /** Wire key `symname`. */
  readonly symname: string | null;
  /** Wire key `seg`. */
  readonly seg: string | null;
  /** Wire key `exd`. */
  readonly exd: string | null;
  /** Wire key `instname`. */
  readonly instname: string | null;
  /** Wire key `optt`. */
  readonly optt: string | null;
  /** Wire key `isin`. */
  readonly isin: string | null;
  /** Wire key `prcftr_d`. */
  readonly prcftrD: string | null;
  /** Wire key `nav`. */
  readonly nav: Decimal | null;
  /** Wire key `o`. */
  readonly open: Decimal | null;
  /** Wire key `c`. */
  readonly close: Decimal | null;
  /** Wire key `h`. */
  readonly high: Decimal | null;
  /** Wire key `l`. */
  readonly low: Decimal | null;
  /** Wire key `v`. */
  readonly volume: Decimal | null;
  /** Wire key `ap`. */
  readonly averageTradePrice: Decimal | null;
  /** Wire key `ltq`. */
  readonly ltq: number | null;
  /** Wire key `ltt`. */
  readonly ltt: string | null;
  /** Wire key `ltd`. */
  readonly ltd: string | null;
  /** Wire key `tbq`. */
  readonly tbq: number | null;
  /** Wire key `tsq`. */
  readonly tsq: number | null;
  /** Wire key `bp1`. */
  readonly bp1: Decimal | null;
  /** Wire key `bp2`. */
  readonly bp2: Decimal | null;
  /** Wire key `bp3`. */
  readonly bp3: Decimal | null;
  /** Wire key `bp4`. */
  readonly bp4: Decimal | null;
  /** Wire key `bp5`. */
  readonly bp5: Decimal | null;
  /** Wire key `sp1`. */
  readonly sp1: Decimal | null;
  /** Wire key `sp2`. */
  readonly sp2: Decimal | null;
  /** Wire key `sp3`. */
  readonly sp3: Decimal | null;
  /** Wire key `sp4`. */
  readonly sp4: Decimal | null;
  /** Wire key `sp5`. */
  readonly sp5: Decimal | null;
  /** Wire key `bq1`. */
  readonly bq1: number | null;
  /** Wire key `bq2`. */
  readonly bq2: number | null;
  /** Wire key `bq3`. */
  readonly bq3: number | null;
  /** Wire key `bq4`. */
  readonly bq4: number | null;
  /** Wire key `bq5`. */
  readonly bq5: number | null;
  /** Wire key `sq1`. */
  readonly sq1: number | null;
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
  /** Wire key `und_exch`. */
  readonly undExch: string | null;
  /** Wire key `und_tk`. */
  readonly undTk: string | null;
  /** Wire key `ord_msg`. */
  readonly ordMsg: string | null;
  /** Wire key `scrip_base_prc`. */
  readonly scripBasePrc: Decimal | null;
  /** Wire key `issuecap`. */
  readonly issuecap: Decimal | null;
  /** Wire key `e_date`. */
  readonly eDate: string | null;
  /** Wire key `cutof_all`. */
  readonly cutofAll: string | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `Quote`. */
export const QuoteSpec: ModelSpec = {
  name: "Quote",
  fields: [
    { name: "stat", wire: "stat", type: T.str },
    { name: "requestTime", wire: "request_time", type: T.ISTDateTime },
    { name: "exchange", wire: "exch", type: T.str },
    { name: "tradingsymbol", wire: "tsym", type: T.str },
    { name: "token", wire: "token", type: T.str },
    { name: "pricePrecision", wire: "pp", type: T.Quantity },
    { name: "lotSize", wire: "ls", type: T.Quantity },
    { name: "tickSize", wire: "ti", type: T.Price },
    { name: "mult", wire: "mult", type: T.str },
    { name: "sptprc", wire: "sptprc", type: T.Price },
    { name: "feedTime", wire: "lut", type: T.EpochTime },
    { name: "lastPrice", wire: "lp", type: T.Price },
    { name: "uc", wire: "uc", type: T.Price },
    { name: "lc", wire: "lc", type: T.Price },
    { name: "wk52H", wire: "wk52_h", type: T.Price },
    { name: "wk52L", wire: "wk52_l", type: T.Price },
    { name: "openInterest", wire: "oi", type: T.Price },
    { name: "toi", wire: "toi", type: T.Price },
    { name: "strprc", wire: "strprc", type: T.Price },
    { name: "cname", wire: "cname", type: T.str },
    { name: "symname", wire: "symname", type: T.str },
    { name: "seg", wire: "seg", type: T.str },
    { name: "exd", wire: "exd", type: T.str },
    { name: "instname", wire: "instname", type: T.str },
    { name: "optt", wire: "optt", type: T.str },
    { name: "isin", wire: "isin", type: T.str },
    { name: "prcftrD", wire: "prcftr_d", type: T.str },
    { name: "nav", wire: "nav", type: T.Price },
    { name: "open", wire: "o", type: T.Price },
    { name: "close", wire: "c", type: T.Price },
    { name: "high", wire: "h", type: T.Price },
    { name: "low", wire: "l", type: T.Price },
    { name: "volume", wire: "v", type: T.Price },
    { name: "averageTradePrice", wire: "ap", type: T.Price },
    { name: "ltq", wire: "ltq", type: T.Quantity },
    { name: "ltt", wire: "ltt", type: T.str },
    { name: "ltd", wire: "ltd", type: T.str },
    { name: "tbq", wire: "tbq", type: T.Quantity },
    { name: "tsq", wire: "tsq", type: T.Quantity },
    { name: "bp1", wire: "bp1", type: T.Price },
    { name: "bp2", wire: "bp2", type: T.Price },
    { name: "bp3", wire: "bp3", type: T.Price },
    { name: "bp4", wire: "bp4", type: T.Price },
    { name: "bp5", wire: "bp5", type: T.Price },
    { name: "sp1", wire: "sp1", type: T.Price },
    { name: "sp2", wire: "sp2", type: T.Price },
    { name: "sp3", wire: "sp3", type: T.Price },
    { name: "sp4", wire: "sp4", type: T.Price },
    { name: "sp5", wire: "sp5", type: T.Price },
    { name: "bq1", wire: "bq1", type: T.Quantity },
    { name: "bq2", wire: "bq2", type: T.Quantity },
    { name: "bq3", wire: "bq3", type: T.Quantity },
    { name: "bq4", wire: "bq4", type: T.Quantity },
    { name: "bq5", wire: "bq5", type: T.Quantity },
    { name: "sq1", wire: "sq1", type: T.Quantity },
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
    { name: "undExch", wire: "und_exch", type: T.str },
    { name: "undTk", wire: "und_tk", type: T.str },
    { name: "ordMsg", wire: "ord_msg", type: T.str },
    { name: "scripBasePrc", wire: "scrip_base_prc", type: T.Price },
    { name: "issuecap", wire: "issuecap", type: T.Price },
    { name: "eDate", wire: "e_date", type: T.str },
    { name: "cutofAll", wire: "cutof_all", type: T.str },
  ],
};

/** Parse one `Quote` wire record. */
export function parseQuote(wire: unknown, ctx?: ParseContext): Quote {
  return parseModel(QuoteSpec, wire, ctx) as Quote;
}

/** Result of `GetSecurityInfo` (accepts wire keys `symname` and `symnam`). */
export interface SecurityInfo {
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
  /** Wire key `cname`. */
  readonly cname: string | null;
  /** Wire key `symname`. */
  readonly symname: string | null;
  /** Wire key `seg`. */
  readonly seg: string | null;
  /** Wire key `exd`. */
  readonly exd: string | null;
  /** Wire key `instname`. */
  readonly instname: string | null;
  /** Wire key `strprc`. */
  readonly strprc: Decimal | null;
  /** Wire key `optt`. */
  readonly optt: string | null;
  /** Wire key `isin`. */
  readonly isin: string | null;
  /** Wire key `ti`. */
  readonly tickSize: Decimal | null;
  /** Wire key `ls`. */
  readonly lotSize: number | null;
  /** Wire key `pp`. */
  readonly pricePrecision: number | null;
  /** Wire key `mult`. */
  readonly mult: string | null;
  /** Wire key `gp_nd`. */
  readonly gpNd: string | null;
  /** Wire key `prcunt`. */
  readonly prcunt: string | null;
  /** Wire key `prcqqty`. */
  readonly prcqqty: number | null;
  /** Wire key `trdunt`. */
  readonly trdunt: string | null;
  /** Wire key `delunt`. */
  readonly delunt: string | null;
  /** Wire key `frzqty`. */
  readonly frzqty: number | null;
  /** Wire key `gsmind`. */
  readonly gsmind: string | null;
  /** Wire key `elmbmrg`. */
  readonly elmbmrg: Decimal | null;
  /** Wire key `elmsmrg`. */
  readonly elmsmrg: Decimal | null;
  /** Wire key `addbmrg`. */
  readonly addbmrg: Decimal | null;
  /** Wire key `addsmrg`. */
  readonly addsmrg: Decimal | null;
  /** Wire key `splbmrg`. */
  readonly splbmrg: Decimal | null;
  /** Wire key `splsmrg`. */
  readonly splsmrg: Decimal | null;
  /** Wire key `delmrg`. */
  readonly delmrg: Decimal | null;
  /** Wire key `tenmrg`. */
  readonly tenmrg: Decimal | null;
  /** Wire key `tenstrd`. */
  readonly tenstrd: string | null;
  /** Wire key `tenendd`. */
  readonly tenendd: string | null;
  /** Wire key `exestrd`. */
  readonly exestrd: string | null;
  /** Wire key `exeendd`. */
  readonly exeendd: string | null;
  /** Wire key `mkt_t`. */
  readonly mktT: string | null;
  /** Wire key `issue_d`. */
  readonly issueD: string | null;
  /** Wire key `listing_d`. */
  readonly listingD: string | null;
  /** Wire key `last_trd_d`. */
  readonly lastTrdD: string | null;
  /** Wire key `elmmrg`. */
  readonly elmmrg: Decimal | null;
  /** Wire key `varmrg`. */
  readonly varmrg: Decimal | null;
  /** Wire key `expmrg`. */
  readonly expmrg: Decimal | null;
  /** Wire key `prcftr_d`. */
  readonly prcftrD: string | null;
  /** Wire key `prcftr`. */
  readonly prcftr: Decimal | null;
  /** Wire key `weekly`. */
  readonly weekly: string | null;
  /** Wire key `nontrd`. */
  readonly nontrd: string | null;
  /** Wire key `dname`. */
  readonly dname: string | null;
  /** Wire key `uc`. */
  readonly uc: Decimal | null;
  /** Wire key `lc`. */
  readonly lc: Decimal | null;
  /** Wire key `ord_msg`. */
  readonly ordMsg: string | null;
  /** Wire key `exptime`. */
  readonly exptime: string | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `SecurityInfo`. */
export const SecurityInfoSpec: ModelSpec = {
  name: "SecurityInfo",
  fields: [
    { name: "stat", wire: "stat", type: T.str },
    { name: "requestTime", wire: "request_time", type: T.ISTDateTime },
    { name: "exchange", wire: "exch", type: T.str },
    { name: "tradingsymbol", wire: "tsym", type: T.str },
    { name: "token", wire: "token", type: T.str },
    { name: "cname", wire: "cname", type: T.str },
    { name: "symname", wire: "symname", type: T.str },
    { name: "seg", wire: "seg", type: T.str },
    { name: "exd", wire: "exd", type: T.str },
    { name: "instname", wire: "instname", type: T.str },
    { name: "strprc", wire: "strprc", type: T.Price },
    { name: "optt", wire: "optt", type: T.str },
    { name: "isin", wire: "isin", type: T.str },
    { name: "tickSize", wire: "ti", type: T.Price },
    { name: "lotSize", wire: "ls", type: T.Quantity },
    { name: "pricePrecision", wire: "pp", type: T.Quantity },
    { name: "mult", wire: "mult", type: T.str },
    { name: "gpNd", wire: "gp_nd", type: T.str },
    { name: "prcunt", wire: "prcunt", type: T.str },
    { name: "prcqqty", wire: "prcqqty", type: T.Quantity },
    { name: "trdunt", wire: "trdunt", type: T.str },
    { name: "delunt", wire: "delunt", type: T.str },
    { name: "frzqty", wire: "frzqty", type: T.Quantity },
    { name: "gsmind", wire: "gsmind", type: T.str },
    { name: "elmbmrg", wire: "elmbmrg", type: T.Price },
    { name: "elmsmrg", wire: "elmsmrg", type: T.Price },
    { name: "addbmrg", wire: "addbmrg", type: T.Price },
    { name: "addsmrg", wire: "addsmrg", type: T.Price },
    { name: "splbmrg", wire: "splbmrg", type: T.Price },
    { name: "splsmrg", wire: "splsmrg", type: T.Price },
    { name: "delmrg", wire: "delmrg", type: T.Price },
    { name: "tenmrg", wire: "tenmrg", type: T.Price },
    { name: "tenstrd", wire: "tenstrd", type: T.str },
    { name: "tenendd", wire: "tenendd", type: T.str },
    { name: "exestrd", wire: "exestrd", type: T.str },
    { name: "exeendd", wire: "exeendd", type: T.str },
    { name: "mktT", wire: "mkt_t", type: T.str },
    { name: "issueD", wire: "issue_d", type: T.str },
    { name: "listingD", wire: "listing_d", type: T.str },
    { name: "lastTrdD", wire: "last_trd_d", type: T.str },
    { name: "elmmrg", wire: "elmmrg", type: T.Price },
    { name: "varmrg", wire: "varmrg", type: T.Price },
    { name: "expmrg", wire: "expmrg", type: T.Price },
    { name: "prcftrD", wire: "prcftr_d", type: T.str },
    { name: "prcftr", wire: "prcftr", type: T.Price },
    { name: "weekly", wire: "weekly", type: T.str },
    { name: "nontrd", wire: "nontrd", type: T.str },
    { name: "dname", wire: "dname", type: T.str },
    { name: "uc", wire: "uc", type: T.Price },
    { name: "lc", wire: "lc", type: T.Price },
    { name: "ordMsg", wire: "ord_msg", type: T.str },
    { name: "exptime", wire: "exptime", type: T.str },
  ],
};

/** Parse one `SecurityInfo` wire record. */
export function parseSecurityInfo(wire: unknown, ctx?: ParseContext): SecurityInfo {
  return parseModel(SecurityInfoSpec, wire, ctx) as SecurityInfo;
}

/** One contract of `GetOptionChain`. */
export interface OptionContract {
  /** Wire key `exch`. */
  readonly exchange: string | null;
  /** Wire key `tsym`. */
  readonly tradingsymbol: string | null;
  /** Wire key `token`. */
  readonly token: string | null;
  /** Wire key `optt`. */
  readonly optionType: string | null;
  /** Wire key `strprc`. */
  readonly strikePrice: Decimal | null;
  /** Wire key `pp`. */
  readonly pricePrecision: number | null;
  /** Wire key `ti`. */
  readonly tickSize: Decimal | null;
  /** Wire key `ls`. */
  readonly lotSize: number | null;
  /** Wire key `instname`. */
  readonly instname: string | null;
  /** Wire key `cname`. */
  readonly cname: string | null;
  /** Wire key `dname`. */
  readonly dname: string | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `OptionContract`. */
export const OptionContractSpec: ModelSpec = {
  name: "OptionContract",
  fields: [
    { name: "exchange", wire: "exch", type: T.str },
    { name: "tradingsymbol", wire: "tsym", type: T.str },
    { name: "token", wire: "token", type: T.str },
    { name: "optionType", wire: "optt", type: T.str },
    { name: "strikePrice", wire: "strprc", type: T.Price },
    { name: "pricePrecision", wire: "pp", type: T.Quantity },
    { name: "tickSize", wire: "ti", type: T.Price },
    { name: "lotSize", wire: "ls", type: T.Quantity },
    { name: "instname", wire: "instname", type: T.str },
    { name: "cname", wire: "cname", type: T.str },
    { name: "dname", wire: "dname", type: T.str },
  ],
};

/** Parse one `OptionContract` wire record. */
export function parseOptionContract(wire: unknown, ctx?: ParseContext): OptionContract {
  return parseModel(OptionContractSpec, wire, ctx) as OptionContract;
}

/** One intraday candle of `TPSeries`. */
export interface Candle {
  /** Wire key `stat`. */
  readonly stat: string | null;
  /** Wire key `time`. */
  readonly time: Date | null;
  /** Wire key `ssboe`. */
  readonly ssboe: Date | null;
  /** Wire key `into`. */
  readonly into: Decimal | null;
  /** Wire key `inth`. */
  readonly inth: Decimal | null;
  /** Wire key `intl`. */
  readonly intl: Decimal | null;
  /** Wire key `intc`. */
  readonly intc: Decimal | null;
  /** Wire key `intvwap`. */
  readonly intvwap: Decimal | null;
  /** Wire key `intv`. */
  readonly intv: Decimal | null;
  /** Wire key `v`. */
  readonly volume: Decimal | null;
  /** Wire key `intoi`. */
  readonly intoi: Decimal | null;
  /** Wire key `oi`. */
  readonly openInterest: Decimal | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `Candle`. */
export const CandleSpec: ModelSpec = {
  name: "Candle",
  fields: [
    { name: "stat", wire: "stat", type: T.str },
    { name: "time", wire: "time", type: T.ISTDateTime },
    { name: "ssboe", wire: "ssboe", type: T.EpochTime },
    { name: "into", wire: "into", type: T.Price },
    { name: "inth", wire: "inth", type: T.Price },
    { name: "intl", wire: "intl", type: T.Price },
    { name: "intc", wire: "intc", type: T.Price },
    { name: "intvwap", wire: "intvwap", type: T.Price },
    { name: "intv", wire: "intv", type: T.Price },
    { name: "volume", wire: "v", type: T.Price },
    { name: "intoi", wire: "intoi", type: T.Price },
    { name: "openInterest", wire: "oi", type: T.Price },
  ],
};

/** Parse one `Candle` wire record. */
export function parseCandle(wire: unknown, ctx?: ParseContext): Candle {
  return parseModel(CandleSpec, wire, ctx) as Candle;
}

/** One daily candle of `EODChartData`. */
export interface DailyCandle {
  /** Wire key `stat`. */
  readonly stat: string | null;
  /** Wire key `time`. */
  readonly time: Date | null;
  /** Wire key `ssboe`. */
  readonly ssboe: Date | null;
  /** Wire key `into`. */
  readonly into: Decimal | null;
  /** Wire key `inth`. */
  readonly inth: Decimal | null;
  /** Wire key `intl`. */
  readonly intl: Decimal | null;
  /** Wire key `intc`. */
  readonly intc: Decimal | null;
  /** Wire key `intv`. */
  readonly intv: Decimal | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `DailyCandle`. */
export const DailyCandleSpec: ModelSpec = {
  name: "DailyCandle",
  fields: [
    { name: "stat", wire: "stat", type: T.str },
    { name: "time", wire: "time", type: T.ISTDateTime },
    { name: "ssboe", wire: "ssboe", type: T.EpochTime },
    { name: "into", wire: "into", type: T.Price },
    { name: "inth", wire: "inth", type: T.Price },
    { name: "intl", wire: "intl", type: T.Price },
    { name: "intc", wire: "intc", type: T.Price },
    { name: "intv", wire: "intv", type: T.Price },
  ],
};

/** Parse one `DailyCandle` wire record. */
export function parseDailyCandle(wire: unknown, ctx?: ParseContext): DailyCandle {
  return parseModel(DailyCandleSpec, wire, ctx) as DailyCandle;
}
