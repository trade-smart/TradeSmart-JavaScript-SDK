// GENERATED from specifications/models.json by scripts/gen-models.ts — do not edit

export const Exchange = Object.freeze({
  NSE: "NSE",
  BSE: "BSE",
  NFO: "NFO",
  BFO: "BFO",
  CDS: "CDS",
  BCD: "BCD",
  MCX: "MCX",
} as const);
export type Exchange = (typeof Exchange)[keyof typeof Exchange];

export const TransactionType = Object.freeze({
  BUY: "B",
  SELL: "S",
} as const);
export type TransactionType = (typeof TransactionType)[keyof typeof TransactionType];

export const OrderType = Object.freeze({
  LIMIT: "LMT",
  MARKET: "MKT",
  SL: "SL-LMT",
  SL_M: "SL-MKT",
} as const);
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

export const Validity = Object.freeze({
  DAY: "DAY",
  IOC: "IOC",
  EOS: "EOS",
} as const);
export type Validity = (typeof Validity)[keyof typeof Validity];

export const Product = Object.freeze({
  CNC: "C",
  MIS: "I",
  NRML: "M",
  CO: "H",
  BO: "B",
  MTF: "F",
} as const);
export type Product = (typeof Product)[keyof typeof Product];

export const OrderStatus = Object.freeze({
  PENDING: "PENDING",
  OPEN: "OPEN",
  TRIGGER_PENDING: "TRIGGER_PENDING",
  COMPLETE: "COMPLETE",
  CANCELED: "CANCELED",
  REJECTED: "REJECTED",
} as const);
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const GttAlertType = Object.freeze({
  LTP_ABOVE: "LTP_A_O",
  LTP_BELOW: "LTP_B_O",
  CHANGE_PERCENT_ABOVE: "CH_PER_A_O",
  CHANGE_PERCENT_BELOW: "CH_PER_B_O",
  ATP_ABOVE: "ATP_A_O",
  ATP_BELOW: "ATP_B_O",
  OI_ABOVE: "OI_A_O",
  OI_BELOW: "OI_B_O",
  TOI_ABOVE: "TOI_A_O",
  TOI_BELOW: "TOI_B_O",
  HIGH_52W_ABOVE: "LTP_A_52HIGH_O",
  HIGH_52W_BELOW: "LTP_B_52HIGH_O",
  VOLUME_ABOVE: "VOLUME_A_O",
} as const);
export type GttAlertType = (typeof GttAlertType)[keyof typeof GttAlertType];

export const GttValidity = Object.freeze({
  DAY: "DAY",
  GTT: "GTT",
} as const);
export type GttValidity = (typeof GttValidity)[keyof typeof GttValidity];

/** Returned by the SDK, never sent: values are exact (case-sensitive). */
export const StreamState = Object.freeze({
  DISCONNECTED: "DISCONNECTED",
  CONNECTING: "CONNECTING",
  AUTHENTICATING: "AUTHENTICATING",
  CONNECTED: "CONNECTED",
  RECONNECTING: "RECONNECTING",
  CLOSED: "CLOSED",
} as const);
export type StreamState = (typeof StreamState)[keyof typeof StreamState];

/** Returned by the SDK, never sent: values are exact (case-sensitive). */
export const Buildup = Object.freeze({
  LONG_BUILDUP: "long_buildup",
  SHORT_BUILDUP: "short_buildup",
  LONG_UNWINDING: "long_unwinding",
  SHORT_COVERING: "short_covering",
  NEUTRAL: "neutral",
} as const);
export type Buildup = (typeof Buildup)[keyof typeof Buildup];

/** Request lookups of the wire enums: each accepted word (upper case) to its wire code (sdk-behaviour.md §7.3). */
export const ENUM_LOOKUP = {
  Exchange: {
    NSE: "NSE",
    BSE: "BSE",
    NFO: "NFO",
    BFO: "BFO",
    CDS: "CDS",
    BCD: "BCD",
    MCX: "MCX",
  },
  TransactionType: {
    B: "B",
    S: "S",
    BUY: "B",
    SELL: "S",
  },
  OrderType: {
    LMT: "LMT",
    MKT: "MKT",
    "SL-LMT": "SL-LMT",
    "SL-MKT": "SL-MKT",
    LIMIT: "LMT",
    MARKET: "MKT",
    SL: "SL-LMT",
    "SL-M": "SL-MKT",
    SLM: "SL-MKT",
  },
  Validity: {
    DAY: "DAY",
    IOC: "IOC",
    EOS: "EOS",
  },
  Product: {
    C: "C",
    I: "I",
    M: "M",
    H: "H",
    B: "B",
    F: "F",
    CNC: "C",
    MIS: "I",
    NRML: "M",
    CO: "H",
    BO: "B",
    MTF: "F",
  },
  OrderStatus: {
    PENDING: "PENDING",
    OPEN: "OPEN",
    TRIGGER_PENDING: "TRIGGER_PENDING",
    COMPLETE: "COMPLETE",
    CANCELED: "CANCELED",
    REJECTED: "REJECTED",
  },
  GttAlertType: {
    LTP_A_O: "LTP_A_O",
    LTP_B_O: "LTP_B_O",
    CH_PER_A_O: "CH_PER_A_O",
    CH_PER_B_O: "CH_PER_B_O",
    ATP_A_O: "ATP_A_O",
    ATP_B_O: "ATP_B_O",
    OI_A_O: "OI_A_O",
    OI_B_O: "OI_B_O",
    TOI_A_O: "TOI_A_O",
    TOI_B_O: "TOI_B_O",
    LTP_A_52HIGH_O: "LTP_A_52HIGH_O",
    LTP_B_52HIGH_O: "LTP_B_52HIGH_O",
    VOLUME_A_O: "VOLUME_A_O",
    LTP_ABOVE: "LTP_A_O",
    LTP_BELOW: "LTP_B_O",
    CHANGE_PERCENT_ABOVE: "CH_PER_A_O",
    CHANGE_PERCENT_BELOW: "CH_PER_B_O",
    ATP_ABOVE: "ATP_A_O",
    ATP_BELOW: "ATP_B_O",
    OI_ABOVE: "OI_A_O",
    OI_BELOW: "OI_B_O",
    TOI_ABOVE: "TOI_A_O",
    TOI_BELOW: "TOI_B_O",
    HIGH_52W_ABOVE: "LTP_A_52HIGH_O",
    HIGH_52W_BELOW: "LTP_B_52HIGH_O",
    VOLUME_ABOVE: "VOLUME_A_O",
  },
  GttValidity: {
    DAY: "DAY",
    GTT: "GTT",
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, string>>>>;
