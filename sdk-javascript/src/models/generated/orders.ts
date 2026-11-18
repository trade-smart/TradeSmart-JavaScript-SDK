// GENERATED from specifications/models.json by scripts/gen-models.ts — do not edit
import type { Decimal } from "../../lib/decimal.js";
import type { TradeSmartError } from "../../errors.js";
import { T, parseModel, type ModelSpec, type OpenEnum, type ParseContext } from "../base.js";
import { OrderStatus, OrderType, Product, TransactionType, Validity } from "./enums.js";

/** One order of `OrderBook`. Lenient record. */
export interface Order {
  /** Wire key `stat`. */
  readonly stat: string | null;
  /** Wire key `exch`. */
  readonly exchange: string | null;
  /** Wire key `tsym`. */
  readonly tradingsymbol: string | null;
  /** Wire key `uid`. */
  readonly userId: string | null;
  /** Wire key `actid`. */
  readonly accountId: string | null;
  /** Wire key `norenordno`. */
  readonly orderId: string | null;
  /** Wire key `prc`. */
  readonly price: Decimal | null;
  /** Wire key `qty`. */
  readonly quantity: number | null;
  /** Wire key `mkt_protection`. */
  readonly marketProtection: Decimal | null;
  /** Wire key `prd`. */
  readonly product: OpenEnum<Product> | null;
  /** Wire key `s_prdt_ali`. */
  readonly sPrdtAli: string | null;
  /** Wire key `status`. */
  readonly status: OpenEnum<OrderStatus> | null;
  /** Wire key `trantype`. */
  readonly transactionType: OpenEnum<TransactionType> | null;
  /** Wire key `prctyp`. */
  readonly orderType: OpenEnum<OrderType> | null;
  /** Wire key `fillshares`. */
  readonly filledQuantity: number | null;
  /** Wire key `avgprc`. */
  readonly averagePrice: Decimal | null;
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
  /** Wire key `ret`. */
  readonly validity: OpenEnum<Validity> | null;
  /** Wire key `bpprc`. */
  readonly bookProfitPrice: Decimal | null;
  /** Wire key `blprc`. */
  readonly bookLossPrice: Decimal | null;
  /** Wire key `trailprc`. */
  readonly trailPrice: Decimal | null;
  /** Wire key `amo`. */
  readonly amo: string | null;
  /** Wire key `pp`. */
  readonly pricePrecision: number | null;
  /** Wire key `ti`. */
  readonly tickSize: Decimal | null;
  /** Wire key `ls`. */
  readonly lotSize: number | null;
  /** Wire key `token`. */
  readonly token: string | null;
  /** Wire key `norentm`. */
  readonly norentm: Date | null;
  /** Wire key `ordenttm`. */
  readonly ordenttm: Date | null;
  /** Wire key `exch_tm`. */
  readonly exchTm: Date | null;
  /** Wire key `snonum`. */
  readonly snoNumber: string | null;
  /** Wire key `sno_fillid`. */
  readonly snoFillid: string | null;
  /** Wire key `prcftr`. */
  readonly prcftr: string | null;
  /** Wire key `mult`. */
  readonly mult: string | null;
  /** Wire key `dname`. */
  readonly dname: string | null;
  /** Wire key `cname`. */
  readonly cname: string | null;
  /** Wire key `kidid`. */
  readonly kidid: string | null;
  /** Wire key `rejby`. */
  readonly rejby: string | null;
  /** Wire key `src_uid`. */
  readonly srcUid: string | null;
  /** Wire key `ipaddr`. */
  readonly ipaddr: string | null;
  /** Wire key `instname`. */
  readonly instname: string | null;
  /** Wire key `ordersource`. */
  readonly ordersource: string | null;
  /** Wire key `symname`. */
  readonly symname: string | null;
  /** Wire key `rprc`. */
  readonly rprc: Decimal | null;
  /** Wire key `brnchid`. */
  readonly brnchid: string | null;
  /** Wire key `C`. */
  readonly C: string | null;
  /** Wire key `st_intrn`. */
  readonly stIntrn: string | null;
  /** Wire key `algo_id`. */
  readonly algoId: string | null;
  /** Wire key `rqty`. */
  readonly rqty: number | null;
  /** Wire key `ui_dev_code`. */
  readonly uiDevCode: string | null;
  /** Wire key `add_ord_id`. */
  readonly parentId: string | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `Order`. */
export const OrderSpec: ModelSpec = {
  name: "Order",
  fields: [
    { name: "stat", wire: "stat", type: T.str, lenient: true },
    { name: "exchange", wire: "exch", type: T.str, lenient: true },
    { name: "tradingsymbol", wire: "tsym", type: T.str, lenient: true },
    { name: "userId", wire: "uid", type: T.str, lenient: true },
    { name: "accountId", wire: "actid", type: T.str, lenient: true },
    { name: "orderId", wire: "norenordno", type: T.str, protected: true },
    { name: "price", wire: "prc", type: T.Price, lenient: true },
    { name: "quantity", wire: "qty", type: T.Quantity, lenient: true },
    { name: "marketProtection", wire: "mkt_protection", type: T.Price, lenient: true },
    { name: "product", wire: "prd", type: T.enum(Product), lenient: true },
    { name: "sPrdtAli", wire: "s_prdt_ali", type: T.str, lenient: true },
    { name: "status", wire: "status", type: T.enum(OrderStatus), protected: true },
    { name: "transactionType", wire: "trantype", type: T.enum(TransactionType), lenient: true },
    { name: "orderType", wire: "prctyp", type: T.enum(OrderType), lenient: true },
    { name: "filledQuantity", wire: "fillshares", type: T.Quantity, lenient: true },
    { name: "averagePrice", wire: "avgprc", type: T.Price, lenient: true },
    { name: "rejectReason", wire: "rejreason", type: T.str, lenient: true },
    { name: "exchangeOrderId", wire: "exchordid", type: T.str, lenient: true },
    { name: "cancelqty", wire: "cancelqty", type: T.Quantity, lenient: true },
    { name: "tag", wire: "remarks", type: T.str, lenient: true },
    { name: "disclosedQuantity", wire: "dscqty", type: T.Quantity, lenient: true },
    { name: "triggerPrice", wire: "trgprc", type: T.Price, lenient: true },
    { name: "validity", wire: "ret", type: T.enum(Validity), lenient: true },
    { name: "bookProfitPrice", wire: "bpprc", type: T.Price, lenient: true },
    { name: "bookLossPrice", wire: "blprc", type: T.Price, lenient: true },
    { name: "trailPrice", wire: "trailprc", type: T.Price, lenient: true },
    { name: "amo", wire: "amo", type: T.str, lenient: true },
    { name: "pricePrecision", wire: "pp", type: T.Quantity, lenient: true },
    { name: "tickSize", wire: "ti", type: T.Price, lenient: true },
    { name: "lotSize", wire: "ls", type: T.Quantity, lenient: true },
    { name: "token", wire: "token", type: T.str, lenient: true },
    { name: "norentm", wire: "norentm", type: T.ISTDateTime, lenient: true },
    { name: "ordenttm", wire: "ordenttm", type: T.EpochTime, lenient: true },
    { name: "exchTm", wire: "exch_tm", type: T.ISTDateTime, lenient: true },
    { name: "snoNumber", wire: "snonum", type: T.str, lenient: true },
    { name: "snoFillid", wire: "sno_fillid", type: T.str, lenient: true },
    { name: "prcftr", wire: "prcftr", type: T.str, lenient: true },
    { name: "mult", wire: "mult", type: T.str, lenient: true },
    { name: "dname", wire: "dname", type: T.str, lenient: true },
    { name: "cname", wire: "cname", type: T.str, lenient: true },
    { name: "kidid", wire: "kidid", type: T.str, lenient: true },
    { name: "rejby", wire: "rejby", type: T.str, lenient: true },
    { name: "srcUid", wire: "src_uid", type: T.str, lenient: true },
    { name: "ipaddr", wire: "ipaddr", type: T.str, lenient: true },
    { name: "instname", wire: "instname", type: T.str, lenient: true },
    { name: "ordersource", wire: "ordersource", type: T.str, lenient: true },
    { name: "symname", wire: "symname", type: T.str, lenient: true },
    { name: "rprc", wire: "rprc", type: T.Price, lenient: true },
    { name: "brnchid", wire: "brnchid", type: T.str, lenient: true },
    { name: "C", wire: "C", type: T.str, lenient: true },
    { name: "stIntrn", wire: "st_intrn", type: T.str, lenient: true },
    { name: "algoId", wire: "algo_id", type: T.str, lenient: true },
    { name: "rqty", wire: "rqty", type: T.Quantity, lenient: true },
    { name: "uiDevCode", wire: "ui_dev_code", type: T.str, lenient: true },
    { name: "parentId", wire: "add_ord_id", type: T.str, lenient: true },
  ],
};

/** Parse one `Order` wire record. */
export function parseOrder(wire: unknown, ctx?: ParseContext): Order {
  return parseModel(OrderSpec, wire, ctx) as Order;
}

/** One state transition of `SingleOrdHist` (an `Order` plus history-only fields). Lenient record. */
export interface OrderHistoryEntry {
  /** Wire key `stat`. */
  readonly stat: string | null;
  /** Wire key `exch`. */
  readonly exchange: string | null;
  /** Wire key `tsym`. */
  readonly tradingsymbol: string | null;
  /** Wire key `uid`. */
  readonly userId: string | null;
  /** Wire key `actid`. */
  readonly accountId: string | null;
  /** Wire key `norenordno`. */
  readonly orderId: string | null;
  /** Wire key `prc`. */
  readonly price: Decimal | null;
  /** Wire key `qty`. */
  readonly quantity: number | null;
  /** Wire key `mkt_protection`. */
  readonly marketProtection: Decimal | null;
  /** Wire key `prd`. */
  readonly product: OpenEnum<Product> | null;
  /** Wire key `s_prdt_ali`. */
  readonly sPrdtAli: string | null;
  /** Wire key `status`. */
  readonly status: OpenEnum<OrderStatus> | null;
  /** Wire key `trantype`. */
  readonly transactionType: OpenEnum<TransactionType> | null;
  /** Wire key `prctyp`. */
  readonly orderType: OpenEnum<OrderType> | null;
  /** Wire key `fillshares`. */
  readonly filledQuantity: number | null;
  /** Wire key `avgprc`. */
  readonly averagePrice: Decimal | null;
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
  /** Wire key `ret`. */
  readonly validity: OpenEnum<Validity> | null;
  /** Wire key `bpprc`. */
  readonly bookProfitPrice: Decimal | null;
  /** Wire key `blprc`. */
  readonly bookLossPrice: Decimal | null;
  /** Wire key `trailprc`. */
  readonly trailPrice: Decimal | null;
  /** Wire key `amo`. */
  readonly amo: string | null;
  /** Wire key `pp`. */
  readonly pricePrecision: number | null;
  /** Wire key `ti`. */
  readonly tickSize: Decimal | null;
  /** Wire key `ls`. */
  readonly lotSize: number | null;
  /** Wire key `token`. */
  readonly token: string | null;
  /** Wire key `norentm`. */
  readonly norentm: Date | null;
  /** Wire key `ordenttm`. */
  readonly ordenttm: Date | null;
  /** Wire key `exch_tm`. */
  readonly exchTm: Date | null;
  /** Wire key `snonum`. */
  readonly snoNumber: string | null;
  /** Wire key `sno_fillid`. */
  readonly snoFillid: string | null;
  /** Wire key `prcftr`. */
  readonly prcftr: string | null;
  /** Wire key `mult`. */
  readonly mult: string | null;
  /** Wire key `dname`. */
  readonly dname: string | null;
  /** Wire key `cname`. */
  readonly cname: string | null;
  /** Wire key `kidid`. */
  readonly kidid: string | null;
  /** Wire key `rejby`. */
  readonly rejby: string | null;
  /** Wire key `src_uid`. */
  readonly srcUid: string | null;
  /** Wire key `ipaddr`. */
  readonly ipaddr: string | null;
  /** Wire key `instname`. */
  readonly instname: string | null;
  /** Wire key `ordersource`. */
  readonly ordersource: string | null;
  /** Wire key `symname`. */
  readonly symname: string | null;
  /** Wire key `rprc`. */
  readonly rprc: Decimal | null;
  /** Wire key `brnchid`. */
  readonly brnchid: string | null;
  /** Wire key `C`. */
  readonly C: string | null;
  /** Wire key `st_intrn`. */
  readonly stIntrn: string | null;
  /** Wire key `algo_id`. */
  readonly algoId: string | null;
  /** Wire key `rqty`. */
  readonly rqty: number | null;
  /** Wire key `ui_dev_code`. */
  readonly uiDevCode: string | null;
  /** Wire key `add_ord_id`. */
  readonly parentId: string | null;
  /** Wire key `pan`. */
  readonly pan: string | null;
  /** Wire key `rpt`. */
  readonly rpt: string | null;
  /** Wire key `introp_exch`. */
  readonly intropExch: string | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `OrderHistoryEntry`. */
export const OrderHistoryEntrySpec: ModelSpec = {
  name: "OrderHistoryEntry",
  fields: [
    { name: "stat", wire: "stat", type: T.str, lenient: true },
    { name: "exchange", wire: "exch", type: T.str, lenient: true },
    { name: "tradingsymbol", wire: "tsym", type: T.str, lenient: true },
    { name: "userId", wire: "uid", type: T.str, lenient: true },
    { name: "accountId", wire: "actid", type: T.str, lenient: true },
    { name: "orderId", wire: "norenordno", type: T.str, protected: true },
    { name: "price", wire: "prc", type: T.Price, lenient: true },
    { name: "quantity", wire: "qty", type: T.Quantity, lenient: true },
    { name: "marketProtection", wire: "mkt_protection", type: T.Price, lenient: true },
    { name: "product", wire: "prd", type: T.enum(Product), lenient: true },
    { name: "sPrdtAli", wire: "s_prdt_ali", type: T.str, lenient: true },
    { name: "status", wire: "status", type: T.enum(OrderStatus), protected: true },
    { name: "transactionType", wire: "trantype", type: T.enum(TransactionType), lenient: true },
    { name: "orderType", wire: "prctyp", type: T.enum(OrderType), lenient: true },
    { name: "filledQuantity", wire: "fillshares", type: T.Quantity, lenient: true },
    { name: "averagePrice", wire: "avgprc", type: T.Price, lenient: true },
    { name: "rejectReason", wire: "rejreason", type: T.str, lenient: true },
    { name: "exchangeOrderId", wire: "exchordid", type: T.str, lenient: true },
    { name: "cancelqty", wire: "cancelqty", type: T.Quantity, lenient: true },
    { name: "tag", wire: "remarks", type: T.str, lenient: true },
    { name: "disclosedQuantity", wire: "dscqty", type: T.Quantity, lenient: true },
    { name: "triggerPrice", wire: "trgprc", type: T.Price, lenient: true },
    { name: "validity", wire: "ret", type: T.enum(Validity), lenient: true },
    { name: "bookProfitPrice", wire: "bpprc", type: T.Price, lenient: true },
    { name: "bookLossPrice", wire: "blprc", type: T.Price, lenient: true },
    { name: "trailPrice", wire: "trailprc", type: T.Price, lenient: true },
    { name: "amo", wire: "amo", type: T.str, lenient: true },
    { name: "pricePrecision", wire: "pp", type: T.Quantity, lenient: true },
    { name: "tickSize", wire: "ti", type: T.Price, lenient: true },
    { name: "lotSize", wire: "ls", type: T.Quantity, lenient: true },
    { name: "token", wire: "token", type: T.str, lenient: true },
    { name: "norentm", wire: "norentm", type: T.ISTDateTime, lenient: true },
    { name: "ordenttm", wire: "ordenttm", type: T.EpochTime, lenient: true },
    { name: "exchTm", wire: "exch_tm", type: T.ISTDateTime, lenient: true },
    { name: "snoNumber", wire: "snonum", type: T.str, lenient: true },
    { name: "snoFillid", wire: "sno_fillid", type: T.str, lenient: true },
    { name: "prcftr", wire: "prcftr", type: T.str, lenient: true },
    { name: "mult", wire: "mult", type: T.str, lenient: true },
    { name: "dname", wire: "dname", type: T.str, lenient: true },
    { name: "cname", wire: "cname", type: T.str, lenient: true },
    { name: "kidid", wire: "kidid", type: T.str, lenient: true },
    { name: "rejby", wire: "rejby", type: T.str, lenient: true },
    { name: "srcUid", wire: "src_uid", type: T.str, lenient: true },
    { name: "ipaddr", wire: "ipaddr", type: T.str, lenient: true },
    { name: "instname", wire: "instname", type: T.str, lenient: true },
    { name: "ordersource", wire: "ordersource", type: T.str, lenient: true },
    { name: "symname", wire: "symname", type: T.str, lenient: true },
    { name: "rprc", wire: "rprc", type: T.Price, lenient: true },
    { name: "brnchid", wire: "brnchid", type: T.str, lenient: true },
    { name: "C", wire: "C", type: T.str, lenient: true },
    { name: "stIntrn", wire: "st_intrn", type: T.str, lenient: true },
    { name: "algoId", wire: "algo_id", type: T.str, lenient: true },
    { name: "rqty", wire: "rqty", type: T.Quantity, lenient: true },
    { name: "uiDevCode", wire: "ui_dev_code", type: T.str, lenient: true },
    { name: "parentId", wire: "add_ord_id", type: T.str, lenient: true },
    { name: "pan", wire: "pan", type: T.str, lenient: true },
    { name: "rpt", wire: "rpt", type: T.str, lenient: true },
    { name: "intropExch", wire: "introp_exch", type: T.str, lenient: true },
  ],
};

/** Parse one `OrderHistoryEntry` wire record. */
export function parseOrderHistoryEntry(wire: unknown, ctx?: ParseContext): OrderHistoryEntry {
  return parseModel(OrderHistoryEntrySpec, wire, ctx) as OrderHistoryEntry;
}

/** One executed trade of `TradeBook`. Lenient record. */
export interface Trade {
  /** Wire key `stat`. */
  readonly stat: string | null;
  /** Wire key `uid`. */
  readonly userId: string | null;
  /** Wire key `actid`. */
  readonly accountId: string | null;
  /** Wire key `exch`. */
  readonly exchange: string | null;
  /** Wire key `tsym`. */
  readonly tradingsymbol: string | null;
  /** Wire key `norenordno`. */
  readonly orderId: string | null;
  /** Wire key `qty`. */
  readonly quantity: number | null;
  /** Wire key `prd`. */
  readonly product: OpenEnum<Product> | null;
  /** Wire key `s_prdt_ali`. */
  readonly sPrdtAli: string | null;
  /** Wire key `trantype`. */
  readonly transactionType: OpenEnum<TransactionType> | null;
  /** Wire key `prctyp`. */
  readonly orderType: OpenEnum<OrderType> | null;
  /** Wire key `fillshares`. */
  readonly filledQuantity: number | null;
  /** Wire key `avgprc`. */
  readonly averagePrice: Decimal | null;
  /** Wire key `exchordid`. */
  readonly exchangeOrderId: string | null;
  /** Wire key `remarks`. */
  readonly tag: string | null;
  /** Wire key `ret`. */
  readonly validity: OpenEnum<Validity> | null;
  /** Wire key `pp`. */
  readonly pricePrecision: number | null;
  /** Wire key `ti`. */
  readonly tickSize: Decimal | null;
  /** Wire key `ls`. */
  readonly lotSize: number | null;
  /** Wire key `cstFrm`. */
  readonly cstFrm: string | null;
  /** Wire key `fltm`. */
  readonly fltm: Date | null;
  /** Wire key `flid`. */
  readonly flid: string | null;
  /** Wire key `flqty`. */
  readonly flqty: number | null;
  /** Wire key `flprc`. */
  readonly flprc: Decimal | null;
  /** Wire key `ordersource`. */
  readonly ordersource: string | null;
  /** Wire key `token`. */
  readonly token: string | null;
  /** Wire key `norentm`. */
  readonly norentm: Date | null;
  /** Wire key `exch_tm`. */
  readonly exchTm: Date | null;
  /** Wire key `snoordt`. */
  readonly snoordt: string | null;
  /** Wire key `snonum`. */
  readonly snoNumber: string | null;
  /** Wire key `prc`. */
  readonly price: Decimal | null;
  /** Wire key `mult`. */
  readonly mult: string | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `Trade`. */
export const TradeSpec: ModelSpec = {
  name: "Trade",
  fields: [
    { name: "stat", wire: "stat", type: T.str, lenient: true },
    { name: "userId", wire: "uid", type: T.str, lenient: true },
    { name: "accountId", wire: "actid", type: T.str, lenient: true },
    { name: "exchange", wire: "exch", type: T.str, lenient: true },
    { name: "tradingsymbol", wire: "tsym", type: T.str, lenient: true },
    { name: "orderId", wire: "norenordno", type: T.str, protected: true },
    { name: "quantity", wire: "qty", type: T.Quantity, lenient: true },
    { name: "product", wire: "prd", type: T.enum(Product), lenient: true },
    { name: "sPrdtAli", wire: "s_prdt_ali", type: T.str, lenient: true },
    { name: "transactionType", wire: "trantype", type: T.enum(TransactionType), lenient: true },
    { name: "orderType", wire: "prctyp", type: T.enum(OrderType), lenient: true },
    { name: "filledQuantity", wire: "fillshares", type: T.Quantity, lenient: true },
    { name: "averagePrice", wire: "avgprc", type: T.Price, lenient: true },
    { name: "exchangeOrderId", wire: "exchordid", type: T.str, lenient: true },
    { name: "tag", wire: "remarks", type: T.str, lenient: true },
    { name: "validity", wire: "ret", type: T.enum(Validity), lenient: true },
    { name: "pricePrecision", wire: "pp", type: T.Quantity, lenient: true },
    { name: "tickSize", wire: "ti", type: T.Price, lenient: true },
    { name: "lotSize", wire: "ls", type: T.Quantity, lenient: true },
    { name: "cstFrm", wire: "cstFrm", type: T.str, lenient: true },
    { name: "fltm", wire: "fltm", type: T.ISTDateTime, lenient: true },
    { name: "flid", wire: "flid", type: T.str, lenient: true },
    { name: "flqty", wire: "flqty", type: T.Quantity, lenient: true },
    { name: "flprc", wire: "flprc", type: T.Price, lenient: true },
    { name: "ordersource", wire: "ordersource", type: T.str, lenient: true },
    { name: "token", wire: "token", type: T.str, lenient: true },
    { name: "norentm", wire: "norentm", type: T.ISTDateTime, lenient: true },
    { name: "exchTm", wire: "exch_tm", type: T.ISTDateTime, lenient: true },
    { name: "snoordt", wire: "snoordt", type: T.str, lenient: true },
    { name: "snoNumber", wire: "snonum", type: T.str, lenient: true },
    { name: "price", wire: "prc", type: T.Price, lenient: true },
    { name: "mult", wire: "mult", type: T.str, lenient: true },
  ],
};

/** Parse one `Trade` wire record. */
export function parseTrade(wire: unknown, ctx?: ParseContext): Trade {
  return parseModel(TradeSpec, wire, ctx) as Trade;
}

/** Result of `GetOrderMargin`. */
export interface OrderMargin {
  /** Wire key `stat`. */
  readonly stat: string | null;
  /** Wire key `request_time`. */
  readonly requestTime: Date | null;
  /** Wire key `remarks`. */
  readonly remarks: string | null;
  /** Wire key `cash`. */
  readonly cash: Decimal | null;
  /** Wire key `marginused`. */
  readonly marginused: Decimal | null;
  /** Wire key `ordermargin`. */
  readonly ordermargin: Decimal | null;
  /** Wire key `marginusedprev`. */
  readonly marginusedprev: Decimal | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `OrderMargin`. */
export const OrderMarginSpec: ModelSpec = {
  name: "OrderMargin",
  fields: [
    { name: "stat", wire: "stat", type: T.str },
    { name: "requestTime", wire: "request_time", type: T.ISTDateTime },
    { name: "remarks", wire: "remarks", type: T.str },
    { name: "cash", wire: "cash", type: T.Price },
    { name: "marginused", wire: "marginused", type: T.Price },
    { name: "ordermargin", wire: "ordermargin", type: T.Price },
    { name: "marginusedprev", wire: "marginusedprev", type: T.Price },
  ],
};

/** Parse one `OrderMargin` wire record. */
export function parseOrderMargin(wire: unknown, ctx?: ParseContext): OrderMargin {
  return parseModel(OrderMarginSpec, wire, ctx) as OrderMargin;
}

/** OMS acknowledgement of `PlaceOrder`, `ModifyOrder`, `CancelOrder` or `ExitSNOOrder`. */
export interface OrderAck {
  /** Wire key `stat`. */
  readonly stat: string | null;
  /** Wire key `norenordno`. */
  readonly orderId: string | null;
  /** Wire key `dmsg`. */
  readonly displayMessage: string | null;
  /** Wire key `request_time`. */
  readonly requestTime: Date | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `OrderAck`. */
export const OrderAckSpec: ModelSpec = {
  name: "OrderAck",
  fields: [
    { name: "stat", wire: "stat", type: T.str },
    { name: "orderId", wire: "norenordno", type: T.str },
    { name: "displayMessage", wire: "dmsg", type: T.str },
    { name: "requestTime", wire: "request_time", type: T.ISTDateTime },
  ],
};

/** Parse one `OrderAck` wire record. */
export function parseOrderAck(wire: unknown, ctx?: ParseContext): OrderAck {
  return parseModel(OrderAckSpec, wire, ctx) as OrderAck;
}

/** `place_sliced_order()` result: the planned slices and what was placed. */
export interface SlicedOrderResult {
  readonly requestedQuantity: number;
  readonly sliceQuantities: readonly number[];
  readonly orderIds: readonly string[];
  readonly placedQuantity: number;
  readonly unsentQuantity: number;
  readonly complete: boolean;
  readonly error: TradeSmartError | null;
}
