// Reply builders of the offline broker (Python: testing/_replies.py). Pure functions returning
// wire records with the documented field names; every builder's key set includes the keys of the
// matching file in specifications/test-fixtures/, so the broker cannot drift from the shapes the
// SDK is tested against. Prices and money are `Decimal`, never `number`.
import { D, Decimal, decimalFromText } from "../lib/decimal.js";
import { IST_OFFSET_MS } from "../lib/time.js";
import { CandleSpec, DailyCandleSpec, DepthFeedSpec, QuoteSpec } from "../models/index.js";
import type { ModelSpec } from "../models/index.js";
import type { OfflineOrder } from "./state.js";

/** A wire record: JSON-shaped, string keys. */
export type Wire = Record<string, unknown>;

/** A number as the test sets it: text, a JavaScript number, a bigint or a `Decimal`. */
export type Numeric = string | number | bigint | Decimal;

/** A calendar day: a `Date` (its IST day) or `{ date: "YYYY-MM-DD" }`. */
export type DayInput = Date | { readonly date: string };

export const PRODUCT_ALIAS: Readonly<Record<string, string>> = {
  C: "CNC",
  I: "MIS",
  M: "NRML",
  H: "CO",
  B: "BO",
  F: "MTF",
};

export const SEGMENT: Readonly<Record<string, string>> = {
  NSE: "EQT",
  BSE: "EQT",
  NFO: "DER",
  BFO: "DER",
  CDS: "FX",
  BCD: "FX",
  MCX: "COM",
};

/** Friendly `setQuote` / `tick` names and their wire keys. */
export const QUOTE_FIELDS: Readonly<Record<string, string>> = {
  lastPrice: "lp",
  open: "o",
  high: "h",
  low: "l",
  close: "c",
  volume: "v",
  oi: "oi",
  changePercent: "pc",
  bid: "bp1",
  ask: "sp1",
  bidQty: "bq1",
  askQty: "sq1",
};

/** Friendly `setCandles` names and their wire keys. */
export const CANDLE_FIELDS: Readonly<Record<string, string>> = {
  open: "into",
  high: "inth",
  low: "intl",
  close: "intc",
  volume: "intv",
  oi: "intoi",
  vwap: "intvwap",
};

const NUMERIC_KINDS = new Set(["Price", "StreamPrice", "Volume", "Quantity", "EpochTime"]);

/** Wire key -> whether its value is a number, from the SDK models that parse the reply. */
function wireKeys(...specs: ModelSpec[]): Map<string, boolean> {
  const keys = new Map<string, boolean>();
  for (const spec of specs) {
    for (const field of spec.fields) {
      const numeric = NUMERIC_KINDS.has(field.type.kind);
      keys.set(field.wire, (keys.get(field.wire) ?? false) || numeric);
    }
  }
  return keys;
}

// Keys `setQuote` / `tick` accept besides the friendly names (never the message identity).
const NOT_QUOTE_KEYS = new Set(["t", "e", "tk", "ssboe"]);
export const QUOTE_WIRE: ReadonlyMap<string, boolean> = (() => {
  const keys = new Map(
    [...wireKeys(QuoteSpec, DepthFeedSpec)].filter(([key]) => !NOT_QUOTE_KEYS.has(key)),
  );
  for (const key of ["lut", "ft"]) keys.set(key, true); // epoch seconds: numbers too
  for (const key of Object.values(QUOTE_FIELDS)) keys.set(key, true);
  return keys;
})();

// Keys `setCandles` accepts besides the friendly names (`time` is checked on its own).
export const CANDLE_WIRE: ReadonlyMap<string, boolean> = (() => {
  const keys = wireKeys(CandleSpec, DailyCandleSpec);
  keys.set("ssboe", true);
  keys.delete("time");
  return keys;
})();

const DEPTH = ["bp", "sp"].flatMap((side) => [1, 2, 3, 4, 5].map((n) => `${side}${String(n)}`));
const DEPTH_QTY = ["bq", "sq", "bo", "so"].flatMap((side) =>
  [1, 2, 3, 4, 5].map((n) => `${side}${String(n)}`),
);

// --- value formatting ----------------------------------------------------------------------

/** The value as a finite Decimal, or `null` when it is not a number (text, number, bigint, Decimal). */
export function toDecimal(value: unknown): Decimal | null {
  if (typeof value === "string") return decimalFromText(value);
  if (typeof value === "number" || typeof value === "bigint") return decimalFromText(String(value));
  if (Decimal.isDecimal(value)) return value.isFinite() ? new D(value) : null;
  return null;
}

/** A scalar as wire text (plain decimal text for numbers); lists, objects and `null` unchanged. */
export function wireValue(value: unknown): unknown {
  if (typeof value === "string" || value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value;
  if (Decimal.isDecimal(value)) return new D(value).toFixed();
  if (typeof value === "number") return new D(value).toFixed();
  if (typeof value === "object") return value;
  return text(value);
}

/** A price with at least two decimals (`101.5` -> `101.50`); `empty` for `null`. */
export function priceText(value: Decimal | null, empty = "0.00"): string {
  if (value === null) return empty;
  return value.decimalPlaces() > 2 ? value.toFixed() : value.toFixed(2);
}

/** An average price rounded half-up to two decimals, as the API shows averages. */
export function averageText(value: Decimal | null, empty = "0.00"): string {
  if (value === null) return empty;
  return value.toFixed(2, Decimal.ROUND_HALF_UP);
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function istParts(when: Date): Parts {
  const t = new Date(when.getTime() + IST_OFFSET_MS);
  return {
    y: t.getUTCFullYear(),
    mo: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    h: t.getUTCHours(),
    mi: t.getUTCMinutes(),
    s: t.getUTCSeconds(),
  };
}

const clock = (p: Parts): string => `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
const dayText = (p: Parts): string => `${pad(p.d)}-${pad(p.mo)}-${String(p.y)}`;

/** The IST day (`YYMMDD`) used in the synthetic order and alert ids. */
export function idDay(when: Date): string {
  const p = istParts(when);
  return `${pad(p.y % 100)}${pad(p.mo)}${pad(p.d)}`;
}

/** `HH:MM:SS dd-mm-YYYY` in IST (`request_time`, `norentm`). */
export function requestTime(when: Date): string {
  const p = istParts(when);
  return `${clock(p)} ${dayText(p)}`;
}

/** `dd-mm-YYYY HH:MM:SS` in IST (`fltm`, `exch_tm`). */
export function fillTime(when: Date): string {
  const p = istParts(when);
  return `${dayText(p)} ${clock(p)}`;
}

/** Epoch seconds as text. */
export function epoch(when: Date): string {
  return String(Math.floor(when.getTime() / 1000));
}

const DAY_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;

interface Day {
  y: number;
  mo: number;
  d: number;
}

/** The calendar day of a `DayInput`; `RangeError` when `{ date }` is not a real `YYYY-MM-DD` day. */
export function dayOf(day: DayInput): Day {
  if (day instanceof Date) {
    if (Number.isNaN(day.getTime())) throw new RangeError("a day must be a valid Date");
    const p = istParts(day);
    return { y: p.y, mo: p.mo, d: p.d };
  }
  const m = typeof day.date === "string" ? DAY_TEXT.exec(day.date) : null;
  if (m === null) throw new RangeError('a day must be a Date or { date: "YYYY-MM-DD" }');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new RangeError('a day must be a Date or { date: "YYYY-MM-DD" }');
  }
  return { y, mo, d };
}

const dmy = (p: Day): string => `${pad(p.d)}-${MONTHS[p.mo - 1] as string}-${String(p.y)}`;

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** Instrument fields every record repeats, with defaults for an instrument never added. */
function base(instrument: Wire | null | undefined): Wire {
  const inst = instrument ?? {};
  return {
    token: str(inst["token"], ""),
    pp: str(inst["pp"], "2"),
    ls: str(inst["ls"], "1"),
    ti: str(inst["ti"], "0.05"),
    instname: str(inst["instname"], ""),
    symname: str(inst["symname"], ""),
    cname: str(inst["cname"], ""),
    dname: str(inst["dname"], ""),
    mult: "1",
    prcftr: "1.000000",
  };
}

// --- instruments ---------------------------------------------------------------------------

export interface InstrumentArgs {
  lotSize: number;
  tickSize: Numeric;
  instrument: string;
  expiry: DayInput | null;
  strike: Numeric | null;
  optionType: string | null;
  underlying: string | null;
  extra: Readonly<Record<string, unknown>>;
}

/** An instrument as a `SearchScrip` match (also used for chains and the script master). */
export function instrumentRow(
  exchange: string,
  token: string,
  symbol: string,
  args: InstrumentArgs,
): Wire {
  const tick = toDecimal(args.tickSize);
  if (tick === null) {
    throw new RangeError(`tickSize must be a number, got ${text(args.tickSize)}`);
  }
  const row: Wire = {
    exch: exchange,
    token,
    tsym: symbol,
    cname: symbol,
    dname: symbol,
    instname: args.instrument,
    symname: args.underlying ?? symbol.split("-")[0],
    seg: segment(exchange),
    pp: String(Math.max(2, tick.decimalPlaces())),
    ls: String(args.lotSize),
    ti: tick.toFixed(),
  };
  if (args.optionType !== null) row["optt"] = args.optionType;
  else if (args.instrument.toUpperCase().startsWith("FUT")) row["optt"] = "XX";
  if (args.strike !== null) {
    const strike = toDecimal(args.strike);
    if (strike === null) {
      throw new RangeError(`strike must be a number, got ${text(args.strike)}`);
    }
    row["strprc"] = priceText(strike);
  }
  if (args.expiry !== null) row["exd"] = dmy(dayOf(args.expiry));
  for (const [key, value] of Object.entries(args.extra)) row[key] = wireValue(value);
  return row;
}

/** `SearchScrip` reply. */
export function searchScrip(rows: readonly Wire[]): Wire {
  return { stat: "Ok", values: rows.map((row) => ({ ...row })) };
}

const CHAIN_KEYS = [
  "exch",
  "token",
  "tsym",
  "optt",
  "pp",
  "ls",
  "ti",
  "strprc",
  "instname",
  "cname",
];

/** One `GetOptionChain` contract. */
export function optionChainRow(instrument: Wire): Wire {
  const row: Wire = {};
  for (const key of CHAIN_KEYS) row[key] = instrument[key];
  row["dname"] = instrument["dname"];
  return row;
}

/** `GetOptionChain` reply. */
export function optionChain(rows: readonly Wire[]): Wire {
  return { stat: "Ok", values: rows.map(optionChainRow) };
}

/** `GetSecurityInfo` reply (values the test did not set are empty). */
export function securityInfo(instrument: Wire, when: Date): Wire {
  return {
    request_time: requestTime(when),
    stat: "Ok",
    isin: "",
    issue_d: "",
    listing_d: "",
    uc: "",
    lc: "",
    prcftr_d: "(1 / 1 ) * (1 / 1)",
    frzqty: "",
    ...base(instrument),
    ...instrument,
  };
}

// --- market data ---------------------------------------------------------------------------

/** `GetQuotes` reply: the instrument, zero defaults, then the fields the test set. */
export function quote(
  exchange: string,
  token: string,
  instrument: Wire | null,
  fields: Wire,
  when: Date,
): Wire {
  const p = istParts(when);
  const reply: Wire = {
    request_time: requestTime(when),
    stat: "Ok",
    exch: exchange,
    tsym: str(instrument?.["tsym"], ""),
    seg: segment(exchange),
    isin: "",
    lut: epoch(when),
    uc: "",
    lc: "",
    wk52_h: "",
    wk52_l: "",
    toi: "0",
    issuecap: "",
    cutof_all: "false",
    prcftr_d: "(1 / 1 ) * (1 / 1)",
    ltq: "0",
    ltt: clock(p),
    ltd: dayText(p),
    tbq: "0",
    tsq: "0",
  };
  const shared = base(instrument);
  delete shared["prcftr"];
  delete shared["dname"];
  Object.assign(reply, shared);
  reply["token"] = token;
  for (const key of ["lp", "c", "h", "l", "ap", "o", ...DEPTH]) reply[key] = "0.00";
  for (const key of ["v", "oi", ...DEPTH_QTY]) reply[key] = "0";
  return Object.assign(reply, fields);
}

function isDay(value: unknown): value is { readonly date: string } {
  return typeof value === "object" && value !== null && !(value instanceof Date) && "date" in value;
}

/** One `TPSeries` candle from friendly names (`time` a `Date`, a day or text) or wire keys. */
export function candleRow(candle: Readonly<Record<string, unknown>>): Wire {
  const row: Wire = { stat: "Ok", intvwap: "0.00", intv: "0", intoi: "0" };
  for (const [key, value] of Object.entries(candle)) {
    if (key !== "time") row[CANDLE_FIELDS[key] ?? key] = wireValue(value);
  }
  const stamp = candle["time"];
  if (stamp instanceof Date || isDay(stamp)) {
    let instant: Date;
    if (stamp instanceof Date) instant = stamp;
    else {
      const day = dayOf(stamp);
      instant = new Date(Date.UTC(day.y, day.mo - 1, day.d) - IST_OFFSET_MS);
    }
    row["time"] = fillTime(instant);
    row["ssboe"] = epoch(instant);
  } else {
    row["time"] = typeof stamp === "string" ? stamp : "";
    row["ssboe"] ??= "0";
  }
  row["v"] ??= row["intv"];
  row["oi"] ??= row["intoi"];
  return row;
}

/** One `EODChartData` candle before encoding (`ssboe` is 00:00 UTC of the day). */
export function eodRecord(candle: Readonly<Record<string, unknown>>): Wire {
  const row: Wire = {};
  for (const [key, value] of Object.entries(candle)) {
    if (key !== "time") row[CANDLE_FIELDS[key] ?? key] = wireValue(value);
  }
  const stamp = candle["time"];
  if (stamp instanceof Date || isDay(stamp)) {
    const day = dayOf(stamp);
    row["time"] = dmy(day);
    row["ssboe"] = String(Date.UTC(day.y, day.mo - 1, day.d) / 1000);
  } else {
    row["time"] = typeof stamp === "string" ? stamp : "";
    row["ssboe"] ??= "0";
  }
  return row;
}

// --- account -------------------------------------------------------------------------------

const LIMITS_ZERO = [
  "cash",
  "payin",
  "payout",
  "brkcollamt",
  "unclearedcash",
  "aux_daycash",
  "aux_brkcollamt",
  "aux_unclearedcash",
  "daycash",
  "turnoverlmt",
  "pendordvallmt",
  "remarks_amt",
  "blk_amt",
  "cac_daycash",
];

/** `Limits` reply: zero defaults, then the values the test set. */
export function limits(funds: Wire, when: Date): Wire {
  const reply: Wire = { request_time: requestTime(when), stat: "Ok", prfname: "OFFLINE" };
  for (const key of LIMITS_ZERO) reply[key] = "0.00";
  reply["remarks_text"] = "";
  return Object.assign(reply, funds);
}

const HOLDING_ZERO = [
  "holdqty",
  "dpqty",
  "npoadqty",
  "brkcolqty",
  "colqty",
  "benqty",
  "unplgdqty",
  "btstqty",
  "btstcolqty",
  "usedqty",
];

/** One `Holdings` record: zero defaults, then the test's wire fields. */
export function holdingRow(row: Wire): Wire {
  const record: Wire = { stat: "Ok", exch_tsym: [] };
  for (const key of HOLDING_ZERO) record[key] = "0";
  record["upldprc"] = "0.00";
  for (const [key, value] of Object.entries(row)) record[key] = wireValue(value);
  return record;
}

/** `UserDetails` reply for the synthetic account, then the fields the test set. */
export function userDetails(clientId: string, user: Wire, when: Date): Wire {
  const exchanges = ["NSE", "NFO", "CDS", "MCX", "BSE", "BFO", "BCD"];
  return {
    request_time: requestTime(when),
    uname: "Offline User",
    m_num: "",
    email: "offline.user@example.invalid",
    access_type: ["API"],
    exarr: exchanges,
    prarr: ["C", "I", "M", "H", "B"].map((prd) => ({
      prd,
      s_prdt_ali: PRODUCT_ALIAS[prd],
      exch: exchanges,
    })),
    orarr: ["MKT", "LMT", "SL-LMT", "SL-MKT"],
    brkname: "OFFLINE",
    uid: clientId,
    brnchid: "HO",
    actid: clientId,
    uprev: "INVESTOR",
    stat: "Ok",
    ...user,
  };
}

// --- orders --------------------------------------------------------------------------------

/** `PlaceOrder` acknowledgement. */
export function placeAck(orderId: string, when: Date): Wire {
  return { request_time: requestTime(when), stat: "Ok", norenordno: orderId };
}

/** `ModifyOrder` / `CancelOrder` acknowledgement (live shape). */
export function orderAck(orderId: string, when: Date): Wire {
  return { stat: "Ok", request_time: requestTime(when), result: orderId };
}

/** `ExitSNOOrder` acknowledgement (the documented success example). */
export function exitAck(when: Date): Wire {
  return { request_time: requestTime(when), stat: "Ok", dmsg: "success" };
}

/** A `Not_Ok` reply. */
export function notOk(message: string, when: Date): Wire {
  return { stat: "Not_Ok", request_time: requestTime(when), emsg: message };
}

/** A synthetic exchange order number derived from the order id. */
export function exchangeOrderId(order: OfflineOrder): string {
  return `11${order.id}`;
}

function payloadText(order: OfflineOrder, key: string, fallback: string): string {
  const value = order.payload[key];
  return value === undefined || value === null ? fallback : text(value);
}

/** One `OrderBook` record of the order as it is now; `when` is its last change. */
export function orderRow(
  order: OfflineOrder,
  clientId: string,
  instrument: Wire | null,
  when: Date,
): Wire {
  const payload = order.payload;
  const first = order.history.at(-1);
  const placed = first === undefined ? epoch(when) : first["ordenttm"];
  const row: Wire = {
    stat: "Ok",
    norenordno: order.id,
    kidid: "1",
    uid: clientId,
    actid: clientId,
    exch: order.exchange,
    tsym: order.symbol,
    rejby: order.status === "REJECTED" ? "RMS" : "",
    src_uid: "",
    qty: String(order.quantity),
    ipaddr: "127.0.0.1",
    ordenttm: placed,
    trantype: order.side,
    prctyp: order.orderType,
    ret: payloadText(order, "ret", "DAY"),
    rejreason: order.rejectReason ?? "",
    ordersource: "API",
    prc: priceText(order.price),
    dscqty: payloadText(order, "dscqty", "0"),
    rprc: "0.00",
    brnchid: "HO",
    C: "C",
    s_prdt_ali: alias(order.product),
    prd: order.product,
    status: order.status,
    st_intrn: order.status,
    norentm: requestTime(when),
    remarks: payloadText(order, "remarks", ""),
    rqty: "0",
    ui_dev_code: `${clientId}_API`,
    ...base(instrument),
  };
  for (const key of ["blprc", "bpprc", "trailprc"]) {
    // bracket/cover order legs, only when sent
    const leg = payload[key];
    if (leg !== undefined && leg !== null && leg !== "") row[key] = priceText(toDecimal(leg));
  }
  if (order.triggerPrice !== null) row["trgprc"] = priceText(order.triggerPrice);
  if (order.status !== "PENDING" && order.status !== "REJECTED") {
    row["exchordid"] = exchangeOrderId(order);
  }
  if (order.filledQuantity > 0) {
    row["fillshares"] = String(order.filledQuantity);
    row["avgprc"] = averageText(order.averagePrice);
  }
  const addOrdId = payload["add_ord_id"];
  if (addOrdId !== undefined && addOrdId !== null && addOrdId !== "") {
    row["add_ord_id"] = text(addOrdId); // an order a triggered GTT placed: the GTT (alert) id
  }
  if (order.status === "CANCELED") row["cancelqty"] = String(order.quantity - order.filledQuantity);
  return row;
}

/** One `SingleOrdHist` record: the order as it is now, plus the report type. */
export function historyRow(
  order: OfflineOrder,
  clientId: string,
  instrument: Wire | null,
  when: Date,
  report: string,
): Wire {
  const row = orderRow(order, clientId, instrument, when);
  row["rpt"] = report;
  row["pan"] = "";
  row["introp_exch"] = segment(order.exchange);
  return row;
}

const HISTORY_ONLY = new Set(["rpt", "pan", "introp_exch"]);

/** The `OrderBook` record of an order: its latest history row without history-only keys. */
export function orderBookRow(order: OfflineOrder): Wire {
  const latest = order.history[0] as Wire;
  return Object.fromEntries(Object.entries(latest).filter(([key]) => !HISTORY_ONLY.has(key)));
}

/** One `TradeBook` record for one fill of the order. */
export function tradeRow(
  order: OfflineOrder,
  clientId: string,
  instrument: Wire | null,
  when: Date,
  fillId: string,
  quantity: number,
  price: Decimal,
): Wire {
  const shared = base(instrument);
  return {
    stat: "Ok",
    uid: clientId,
    actid: clientId,
    exch: order.exchange,
    tsym: order.symbol,
    norenordno: order.id,
    qty: String(order.quantity),
    prd: order.product,
    s_prdt_ali: alias(order.product),
    trantype: order.side,
    prctyp: order.orderType,
    fillshares: String(order.filledQuantity),
    avgprc: averageText(order.averagePrice),
    exchordid: exchangeOrderId(order),
    remarks: payloadText(order, "remarks", ""),
    ret: payloadText(order, "ret", "DAY"),
    cstFrm: "C",
    fltm: fillTime(when),
    flid: fillId,
    flqty: String(quantity),
    flprc: priceText(price),
    ordersource: "API",
    norentm: requestTime(when),
    exch_tm: fillTime(when),
    prc: priceText(order.price),
    token: shared["token"],
    pp: shared["pp"],
    ti: shared["ti"],
    ls: shared["ls"],
    mult: shared["mult"],
  };
}

/** A fill as the stream message carries it: fill id, quantity, price. */
export interface FillInfo {
  id: string;
  quantity: number;
  price: Decimal;
}

/** Stream `om` message for a change of the order. */
export function orderUpdate(
  order: OfflineOrder,
  clientId: string,
  when: Date,
  report: string,
  fill: FillInfo | null,
): Wire {
  return {
    t: "om",
    norenordno: order.id,
    uid: clientId,
    actid: clientId,
    exch: order.exchange,
    tsym: order.symbol,
    qty: String(order.quantity),
    prc: priceText(order.price),
    pcode: order.product,
    status: order.status,
    reporttype: report,
    trantype: order.side,
    prctyp: order.orderType,
    ret: payloadText(order, "ret", "DAY"),
    fillshares: String(order.filledQuantity),
    avgprc: averageText(order.averagePrice, ""),
    fltm: fill === null ? "" : fillTime(when),
    flid: fill === null ? "" : fill.id,
    flqty: fill === null ? "" : String(fill.quantity),
    flprc: fill === null ? "" : priceText(fill.price, ""),
    rejreason: order.rejectReason ?? "",
    exchordid:
      order.status === "PENDING" || order.status === "REJECTED" ? "" : exchangeOrderId(order),
    cancelqty: order.status === "CANCELED" ? String(order.quantity - order.filledQuantity) : "0",
    remarks: payloadText(order, "remarks", ""),
    dscqty: payloadText(order, "dscqty", "0"),
    trgprc: priceText(order.triggerPrice),
    exch_tm: fillTime(when),
    amo: "No",
    tm: epoch(when),
    ntm: String(BigInt(when.getTime()) * 1_000_000n),
  };
}

// --- positions -----------------------------------------------------------------------------

export const POSITION_QTY = [
  "netqty",
  "daybuyqty",
  "daysellqty",
  "cfbuyqty",
  "cfsellqty",
  "openbuyqty",
  "opensellqty",
];

export const POSITION_AMOUNT = [
  "netavgprc",
  "dayavgprc",
  "daybuyavgprc",
  "daysellavgprc",
  "daybuyamt",
  "daysellamt",
  "cforgavgprc",
  "cfbuyavgprc",
  "cfsellavgprc",
  "cfbuyamt",
  "cfsellamt",
  "totbuyamt",
  "totsellamt",
  "totbuyavgprc",
  "totsellavgprc",
  "lp",
  "rpnl",
  "bep",
  "openbuyamt",
  "opensellamt",
  "openbuyavgprc",
  "opensellavgprc",
  "upldprc",
  "netupldprc",
];

/** A flat `PositionBook` record (all quantities and amounts zero). */
export function positionRow(
  clientId: string,
  exchange: string,
  token: string,
  symbol: string,
  product: string,
  instrument: Wire | null,
): Wire {
  const shared = base(instrument);
  const row: Wire = {
    stat: "Ok",
    exch: exchange,
    tsym: symbol,
    token: token || shared["token"],
    uid: clientId,
    actid: clientId,
    prd: product,
    s_prdt_ali: alias(product),
  };
  for (const key of POSITION_QTY) row[key] = "0";
  for (const key of POSITION_AMOUNT) row[key] = "0.00";
  for (const key of ["mult", "pp", "prcftr", "ti", "ls", "instname", "dname", "cname"]) {
    row[key] = shared[key];
  }
  return row;
}

const POSITION_UPDATE_KEYS = [
  "exch",
  "token",
  "tsym",
  "uid",
  "actid",
  "prd",
  "daybuyqty",
  "daysellqty",
  "daybuyamt",
  "daysellamt",
  "cfbuyqty",
  "cfsellqty",
  "cfbuyamt",
  "cfsellamt",
  "openbuyqty",
  "opensellqty",
  "openbuyamt",
  "opensellamt",
  "rpnl",
  "netqty",
  "totbuyamt",
  "totsellamt",
  "totbuyavgprc",
  "totsellavgprc",
];

/** Stream `pm` message for a position record. */
export function positionUpdate(row: Wire): Wire {
  const message: Wire = { t: "pm" };
  for (const key of POSITION_UPDATE_KEYS) message[key] = row[key];
  message["buyavgprc"] = row["totbuyavgprc"];
  message["sellavgprc"] = row["totsellavgprc"];
  message["child_orders"] = [{ exch: row["exch"], tsym: row["tsym"], netqty: row["netqty"] }];
  return message;
}

// --- GTT -----------------------------------------------------------------------------------

/** `GetEnabledGTTs`: the alert families of the documented example. */
export const GTT_ALERT_FAMILIES = ["ATP", "LTP"];

/** `PlaceGTTOrder` / `ModifyGTTOrder` / `CancelGTTOrder` acknowledgement (documented). */
export function gttAck(word: string, alertId: string, when: Date): Wire {
  return { request_time: requestTime(when), stat: word, al_id: alertId };
}

function decimalOf(value: unknown): Decimal {
  return toDecimal(value) as Decimal;
}

/** One `GetPendingGTTOrder` record (the documented example's keys; `qty` a number). */
export function gttRow(gtt: Wire, clientId: string, instrument: Wire | null): Wire {
  const shared = base(instrument);
  const product = String(gtt["prd"]);
  const row: Wire = {
    stat: "Ok",
    ai_t: gtt["ai_t"],
    al_id: gtt["al_id"],
    tsym: gtt["tsym"],
    exch: gtt["exch"],
    token: shared["token"],
    remarks: gtt["remarks"],
    validity: gtt["validity"],
    pp: shared["pp"],
    ls: shared["ls"],
    actid: clientId,
    trantype: gtt["trantype"],
    prctyp: gtt["prctyp"],
    qty: decimalOf(gtt["qty"]).trunc().toNumber(),
    prc: priceText(decimalOf(gtt["prc"])),
    prd: product,
    s_prdt_ali: alias(product),
    ret: gtt["ret"],
    ordersource: "API",
    d: priceText(decimalOf(gtt["d"])),
  };
  const trgprc = gtt["trgprc"];
  if (trgprc !== undefined && trgprc !== null && text(trgprc).trim() !== "") {
    row["trgprc"] = priceText(decimalOf(trgprc));
  }
  return row;
}

/** One `GetTrgOi` record: the pending record plus the trigger time and the flags. */
export function triggeredGttRow(gtt: Wire, clientId: string, instrument: Wire | null): Wire {
  const row = gttRow(gtt, clientId, instrument);
  row["norentm"] = requestTime(gtt["norentm"] as Date);
  row["sms_flag"] = "0";
  row["email_flag"] = "0";
  row["push_flag"] = "0";
  return row;
}

/** `GetEnabledGTTs` reply (documented; `request_time` as `DDMMYYYYHHMMSS`). */
export function enabledGtts(when: Date): Wire {
  const p = istParts(when);
  return {
    stat: "Ok",
    request_time: `${pad(p.d)}${pad(p.mo)}${String(p.y)}${pad(p.h)}${pad(p.mi)}${pad(p.s)}`,
    ai_ts: GTT_ALERT_FAMILIES.map((family) => ({ ai_t: family })),
  };
}

/**
 * A value as text: a string as is, a number, bigint, boolean or Decimal by its plain text, and
 * `fallback` for `null`, `undefined` and any object (never `[object Object]`).
 */
export function text(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  if (Decimal.isDecimal(value)) return new D(value).toFixed();
  return fallback;
}

const alias = (product: string): string => PRODUCT_ALIAS[product] ?? product;
const segment = (exchange: string): string => SEGMENT[exchange] ?? "";

// --- stream --------------------------------------------------------------------------------

/** Stream connect acknowledgement (`s="OK"` as observed live). */
export function connectAck(uid: string, ok: boolean): Wire {
  return { t: "ak", uid, s: ok ? "OK" : "Not_Ok" };
}

/** Stream heartbeat acknowledgement. */
export function heartbeatAck(when: Date): Wire {
  return { t: "hk", ft: epoch(when) };
}

function snapshot(
  kind: string,
  exchange: string,
  token: string,
  instrument: Wire | null,
  fields: Wire,
  when: Date,
): Wire {
  const shared = base(instrument);
  const message: Wire = {
    t: kind,
    e: exchange,
    tk: token,
    ts: str(instrument?.["tsym"], ""),
    pp: shared["pp"],
    ti: shared["ti"],
    ls: shared["ls"],
    pc: "0.00",
    poi: "0",
    toi: "0",
    ft: epoch(when),
  };
  for (const key of ["lp", "o", "h", "l", "c", "ap", "bp1", "sp1"]) message[key] = "0.00";
  for (const key of ["v", "oi", "bq1", "sq1"]) message[key] = "0";
  if (kind === "dk") {
    for (const key of DEPTH) message[key] ??= "0.00";
    for (const key of DEPTH_QTY) message[key] ??= "0";
    Object.assign(message, { cp: "0.00", ltt: "", ltq: "0", tbq: "0", tsq: "0" });
    Object.assign(message, { lc: "0.00", uc: "0.00", "52h": "0.00", "52l": "0.00" });
  }
  for (const [key, value] of Object.entries(fields)) {
    if (key !== "tsym" && key !== "token") message[key] = value;
  }
  message["t"] = kind;
  return message;
}

/** Stream `tk`: the touchline subscription acknowledgement with the current quote. */
export function touchlineAck(
  exchange: string,
  token: string,
  instrument: Wire | null,
  fields: Wire,
  when: Date,
): Wire {
  return snapshot("tk", exchange, token, instrument, fields, when);
}

/** Stream `dk`: the depth subscription acknowledgement with the current quote. */
export function depthAck(
  exchange: string,
  token: string,
  instrument: Wire | null,
  fields: Wire,
  when: Date,
): Wire {
  return snapshot("dk", exchange, token, instrument, fields, when);
}

/** Stream `tf`: only the changed fields besides `t` / `e` / `tk` / `ft`. */
export function touchlineFeed(exchange: string, token: string, fields: Wire, when: Date): Wire {
  return { t: "tf", e: exchange, tk: token, ...fields, ft: epoch(when) };
}

/** Stream `df`: only the changed fields besides `t` / `e` / `tk` / `ft`. */
export function depthFeed(exchange: string, token: string, fields: Wire, when: Date): Wire {
  return { t: "df", e: exchange, tk: token, ...fields, ft: epoch(when) };
}
