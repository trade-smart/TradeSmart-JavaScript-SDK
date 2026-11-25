// GENERATED from specifications/models.json by scripts/gen-models.ts — do not edit
import { T, parseModel, type ModelSpec, type OpenEnum, type ParseContext } from "../base.js";
import { Product } from "./enums.js";

/** One enabled product with the exchanges it is available on. Nested record: a field that fails to parse fails the parent's field (null when that field is lenient). */
export interface ProductInfo {
  /** Wire key `prd`. */
  readonly product: OpenEnum<Product> | null;
  /** Wire key `s_prdt_ali`. */
  readonly sPrdtAli: string | null;
  /** Wire key `exch`. */
  readonly exch: readonly string[] | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `ProductInfo`. */
export const ProductInfoSpec: ModelSpec = {
  name: "ProductInfo",
  fields: [
    { name: "product", wire: "prd", type: T.enum(Product) },
    { name: "sPrdtAli", wire: "s_prdt_ali", type: T.str },
    { name: "exch", wire: "exch", type: T.list(T.str) },
  ],
};

/** Parse one `ProductInfo` wire record. */
export function parseProductInfo(wire: unknown, ctx?: ParseContext): ProductInfo {
  return parseModel(ProductInfoSpec, wire, ctx) as ProductInfo;
}

/** Result of `UserDetails`. */
export interface UserDetails {
  /** Wire key `uid`. */
  readonly userId: string | null;
  /** Wire key `actid`. */
  readonly accountId: string | null;
  /** Wire key `uname`. */
  readonly uname: string | null;
  /** Wire key `email`. */
  readonly email: string | null;
  /** Wire key `m_num`. */
  readonly mNum: string | null;
  /** Wire key `brkname`. */
  readonly brkname: string | null;
  /** Wire key `brnchid`. */
  readonly brnchid: string | null;
  /** Wire key `uprev`. */
  readonly uprev: string | null;
  /** Wire key `access_type`. */
  readonly accessType: readonly string[] | null;
  /** Wire key `exarr`. */
  readonly exarr: readonly string[] | null;
  /** Wire key `orarr`. */
  readonly orarr: readonly string[] | null;
  /** Wire key `prarr`. */
  readonly prarr: readonly ProductInfo[] | null;
  /** Wire key `request_time`. */
  readonly requestTime: Date | null;
  /** Wire key `stat`. */
  readonly stat: string | null;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `UserDetails`. */
export const UserDetailsSpec: ModelSpec = {
  name: "UserDetails",
  fields: [
    { name: "userId", wire: "uid", type: T.str },
    { name: "accountId", wire: "actid", type: T.str },
    { name: "uname", wire: "uname", type: T.str },
    { name: "email", wire: "email", type: T.str },
    { name: "mNum", wire: "m_num", type: T.str },
    { name: "brkname", wire: "brkname", type: T.str },
    { name: "brnchid", wire: "brnchid", type: T.str },
    { name: "uprev", wire: "uprev", type: T.str },
    { name: "accessType", wire: "access_type", type: T.list(T.str) },
    { name: "exarr", wire: "exarr", type: T.list(T.str) },
    { name: "orarr", wire: "orarr", type: T.list(T.str) },
    { name: "prarr", wire: "prarr", type: T.list(T.model(parseProductInfo)) },
    { name: "requestTime", wire: "request_time", type: T.ISTDateTime },
    { name: "stat", wire: "stat", type: T.str },
  ],
};

/** Parse one `UserDetails` wire record. */
export function parseUserDetails(wire: unknown, ctx?: ParseContext): UserDetails {
  return parseModel(UserDetailsSpec, wire, ctx) as UserDetails;
}
