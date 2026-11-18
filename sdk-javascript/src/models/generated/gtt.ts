// GENERATED from specifications/models.json by scripts/gen-models.ts — do not edit
import type { Decimal } from "../../lib/decimal.js";
import { T, parseModel, type ModelSpec, type OpenEnum, type ParseContext } from "../base.js";
import {
  GttAlertType,
  GttValidity,
  OrderType,
  Product,
  TransactionType,
  Validity,
} from "./enums.js";

/** One pending GTT of `GetPendingGTTOrder`. Lenient record. */
export interface Gtt {
  /** Wire key `stat`. */
  readonly stat: string | null;
  /** Wire key `al_id`. */
  readonly alertId: string | null;
  /** Wire key `ai_t`. */
  readonly alertType: OpenEnum<GttAlertType> | null;
  /** Wire key `d`. */
  readonly triggerValue: Decimal | null;
  /** Wire key `validity`. */
  readonly alertValidity: OpenEnum<GttValidity> | null;
  /** Wire key `exch`. */
  readonly exchange: string | null;
  /** Wire key `tsym`. */
  readonly tradingsymbol: string | null;
  /** Wire key `token`. */
  readonly token: string | null;
  /** Wire key `remarks`. */
  readonly tag: string | null;
  /** Wire key `trantype`. */
  readonly transactionType: OpenEnum<TransactionType> | null;
  /** Wire key `prctyp`. */
  readonly orderType: OpenEnum<OrderType> | null;
  /** Wire key `prd`. */
  readonly product: OpenEnum<Product> | null;
  /** Wire key `s_prdt_ali`. */
  readonly sPrdtAli: string | null;
  /** Wire key `ret`. */
  readonly validity: OpenEnum<Validity> | null;
  /** Wire key `actid`. */
  readonly accountId: string | null;
  /** Wire key `qty`. */
  readonly quantity: number | null;
  /** Wire key `prc`. */
  readonly price: Decimal | null;
  /** Wire key `trgprc`. */
  readonly triggerPrice: Decimal | null;
  /** Wire key `pp`. */
  readonly pricePrecision: number | null;
  /** Wire key `ls`. */
  readonly lotSize: number | null;
  /** Wire key `ordersource`. */
  readonly ordersource: string | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `Gtt`. */
export const GttSpec: ModelSpec = {
  name: "Gtt",
  fields: [
    { name: "stat", wire: "stat", type: T.str, lenient: true },
    { name: "alertId", wire: "al_id", type: T.str, protected: true },
    { name: "alertType", wire: "ai_t", type: T.enum(GttAlertType), lenient: true },
    { name: "triggerValue", wire: "d", type: T.Price, lenient: true },
    { name: "alertValidity", wire: "validity", type: T.enum(GttValidity), lenient: true },
    { name: "exchange", wire: "exch", type: T.str, lenient: true },
    { name: "tradingsymbol", wire: "tsym", type: T.str, lenient: true },
    { name: "token", wire: "token", type: T.str, lenient: true },
    { name: "tag", wire: "remarks", type: T.str, lenient: true },
    { name: "transactionType", wire: "trantype", type: T.enum(TransactionType), lenient: true },
    { name: "orderType", wire: "prctyp", type: T.enum(OrderType), lenient: true },
    { name: "product", wire: "prd", type: T.enum(Product), lenient: true },
    { name: "sPrdtAli", wire: "s_prdt_ali", type: T.str, lenient: true },
    { name: "validity", wire: "ret", type: T.enum(Validity), lenient: true },
    { name: "accountId", wire: "actid", type: T.str, lenient: true },
    { name: "quantity", wire: "qty", type: T.Quantity, lenient: true },
    { name: "price", wire: "prc", type: T.Price, lenient: true },
    { name: "triggerPrice", wire: "trgprc", type: T.Price, lenient: true },
    { name: "pricePrecision", wire: "pp", type: T.Quantity, lenient: true },
    { name: "lotSize", wire: "ls", type: T.Quantity, lenient: true },
    { name: "ordersource", wire: "ordersource", type: T.str, lenient: true },
  ],
};

/** Parse one `Gtt` wire record. */
export function parseGtt(wire: unknown, ctx?: ParseContext): Gtt {
  return parseModel(GttSpec, wire, ctx) as Gtt;
}

/** One triggered GTT of `GetTrgOi` (its order was sent; see `Order.parent_id`). Lenient record. */
export interface TriggeredGtt {
  /** Wire key `stat`. */
  readonly stat: string | null;
  /** Wire key `al_id`. */
  readonly alertId: string | null;
  /** Wire key `ai_t`. */
  readonly alertType: OpenEnum<GttAlertType> | null;
  /** Wire key `d`. */
  readonly triggerValue: Decimal | null;
  /** Wire key `validity`. */
  readonly alertValidity: OpenEnum<GttValidity> | null;
  /** Wire key `exch`. */
  readonly exchange: string | null;
  /** Wire key `tsym`. */
  readonly tradingsymbol: string | null;
  /** Wire key `token`. */
  readonly token: string | null;
  /** Wire key `remarks`. */
  readonly tag: string | null;
  /** Wire key `trantype`. */
  readonly transactionType: OpenEnum<TransactionType> | null;
  /** Wire key `prctyp`. */
  readonly orderType: OpenEnum<OrderType> | null;
  /** Wire key `prd`. */
  readonly product: OpenEnum<Product> | null;
  /** Wire key `s_prdt_ali`. */
  readonly sPrdtAli: string | null;
  /** Wire key `ret`. */
  readonly validity: OpenEnum<Validity> | null;
  /** Wire key `actid`. */
  readonly accountId: string | null;
  /** Wire key `qty`. */
  readonly quantity: number | null;
  /** Wire key `prc`. */
  readonly price: Decimal | null;
  /** Wire key `trgprc`. */
  readonly triggerPrice: Decimal | null;
  /** Wire key `pp`. */
  readonly pricePrecision: number | null;
  /** Wire key `ls`. */
  readonly lotSize: number | null;
  /** Wire key `ordersource`. */
  readonly ordersource: string | null;
  /** Wire key `norentm`. */
  readonly norentm: Date | null;
  /** Wire key `sms_flag`. */
  readonly smsFlag: string | null;
  /** Wire key `email_flag`. */
  readonly emailFlag: string | null;
  /** Wire key `push_flag`. */
  readonly pushFlag: string | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `TriggeredGtt`. */
export const TriggeredGttSpec: ModelSpec = {
  name: "TriggeredGtt",
  fields: [
    { name: "stat", wire: "stat", type: T.str, lenient: true },
    { name: "alertId", wire: "al_id", type: T.str, protected: true },
    { name: "alertType", wire: "ai_t", type: T.enum(GttAlertType), lenient: true },
    { name: "triggerValue", wire: "d", type: T.Price, lenient: true },
    { name: "alertValidity", wire: "validity", type: T.enum(GttValidity), lenient: true },
    { name: "exchange", wire: "exch", type: T.str, lenient: true },
    { name: "tradingsymbol", wire: "tsym", type: T.str, lenient: true },
    { name: "token", wire: "token", type: T.str, lenient: true },
    { name: "tag", wire: "remarks", type: T.str, lenient: true },
    { name: "transactionType", wire: "trantype", type: T.enum(TransactionType), lenient: true },
    { name: "orderType", wire: "prctyp", type: T.enum(OrderType), lenient: true },
    { name: "product", wire: "prd", type: T.enum(Product), lenient: true },
    { name: "sPrdtAli", wire: "s_prdt_ali", type: T.str, lenient: true },
    { name: "validity", wire: "ret", type: T.enum(Validity), lenient: true },
    { name: "accountId", wire: "actid", type: T.str, lenient: true },
    { name: "quantity", wire: "qty", type: T.Quantity, lenient: true },
    { name: "price", wire: "prc", type: T.Price, lenient: true },
    { name: "triggerPrice", wire: "trgprc", type: T.Price, lenient: true },
    { name: "pricePrecision", wire: "pp", type: T.Quantity, lenient: true },
    { name: "lotSize", wire: "ls", type: T.Quantity, lenient: true },
    { name: "ordersource", wire: "ordersource", type: T.str, lenient: true },
    { name: "norentm", wire: "norentm", type: T.ISTDateTime, lenient: true },
    { name: "smsFlag", wire: "sms_flag", type: T.str, lenient: true },
    { name: "emailFlag", wire: "email_flag", type: T.str, lenient: true },
    { name: "pushFlag", wire: "push_flag", type: T.str, lenient: true },
  ],
};

/** Parse one `TriggeredGtt` wire record. */
export function parseTriggeredGtt(wire: unknown, ctx?: ParseContext): TriggeredGtt {
  return parseModel(TriggeredGttSpec, wire, ctx) as TriggeredGtt;
}
