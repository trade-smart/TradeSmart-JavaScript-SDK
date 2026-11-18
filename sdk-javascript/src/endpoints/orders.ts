// Order writes `PlaceOrder`, `ModifyOrder`, `CancelOrder`, `ExitSNOOrder` and the order read
// `GetOrderMargin` (sdk-behaviour.md §2.3, §2.4, §5.4), mirroring
// sdk-python/src/tradesmart/endpoints/orders.py and models/orders.py. Each builder validates every
// parameter first (one `RequestValidationError` with every failed check, nothing sent) and returns
// the call spec. The writes are state-changing: never retried; an `Ok` acknowledgement that cannot
// be read is `OrderStatusUnknownError` (the server accepted the request).
import type { Decimal } from "decimal.js";
import { OrderStatusUnknownError } from "../errors.js";
import type { Exchange, OrderType, Product, TransactionType, Validity } from "../enums.js";
import type { CallSpec } from "../lib/call.js";
import type { ClassifyResult } from "../lib/classify.js";
import { JsonNumber } from "../lib/json.js";
import { redactedBody } from "../lib/redact.js";
import { checkParams, checkPriceRules, orderPrice, Validator } from "../lib/validate.js";
import type { OpenEnum } from "../models/base.js";
import {
  parseOrderAck,
  parseOrderMargin,
  type OrderAck,
  type OrderMargin,
} from "../models/generated/orders.js";
import { objectDecoder, readSpec } from "./base.js";

/** A price: a `Decimal`, decimal text (sent with its own digits) or a finite number. */
export type PriceInput = Decimal | string | number;

/** Parameters of `placeOrder()` (sdk-behaviour.md §2.4). */
export interface PlaceOrderParams {
  exchange: OpenEnum<Exchange>;
  tradingsymbol: string;
  /** In the exchange's trade units (NFO: units, not lots); a whole number of at least 1. */
  quantity: number;
  transactionType: OpenEnum<TransactionType>;
  product: OpenEnum<Product>;
  orderType: OpenEnum<OrderType>;
  /** Required for LMT / SL-LMT (> 0); MKT / SL-MKT without one send `0`. */
  price?: PriceInput | null | undefined;
  /** Required (> 0) for SL-LMT / SL-MKT only. */
  triggerPrice?: PriceInput | null | undefined;
  /** Default `DAY`. */
  validity?: OpenEnum<Validity> | undefined;
  disclosedQuantity?: number | null | undefined;
  /** After-market order; always sent (`Yes` / `No`), default false. */
  amo?: boolean | undefined;
  /** Sent as `remarks`: a unique tag finds the order in `orders()` after an unknown outcome. */
  tag?: string | null | undefined;
  /** CO / BO only (required for both). */
  bookLossPrice?: PriceInput | null | undefined;
  /** BO only (required). */
  bookProfitPrice?: PriceInput | null | undefined;
  /** CO / BO only. */
  trailPrice?: PriceInput | null | undefined;
  marketProtection?: PriceInput | null | undefined;
  /** Overrides `ClientConfig.algoId` for this order; sent last as `algo_id`. */
  algoId?: string | null | undefined;
}

/** Parameters of `modifyOrder()` (sdk-behaviour.md §2.4). */
export interface ModifyOrderParams {
  exchange: OpenEnum<Exchange>;
  tradingsymbol: string;
  quantity: number;
  /** Required for LMT / SL-LMT; `null` for MKT / SL-MKT sends `0`. */
  price: PriceInput | null | undefined;
  orderType: OpenEnum<OrderType>;
  product: OpenEnum<Product>;
  triggerPrice?: PriceInput | null | undefined;
  /** Sent as `ret` only when given. */
  validity?: OpenEnum<Validity> | null | undefined;
  tag?: string | null | undefined;
  bookLossPrice?: PriceInput | null | undefined;
  bookProfitPrice?: PriceInput | null | undefined;
  trailPrice?: PriceInput | null | undefined;
  algoId?: string | null | undefined;
}

/** Parameters of `orderMargin()` (a read: nothing is placed). */
export interface OrderMarginParams {
  exchange: OpenEnum<Exchange>;
  tradingsymbol: string;
  quantity: number;
  price: PriceInput;
  product: OpenEnum<Product>;
  transactionType: OpenEnum<TransactionType>;
  orderType: OpenEnum<OrderType>;
  triggerPrice?: PriceInput | null | undefined;
  bookLossPrice?: PriceInput | null | undefined;
  orderId?: string | null | undefined;
  snoNumber?: string | null | undefined;
}

const PLACE_KEYS: readonly string[] = [
  "exchange",
  "tradingsymbol",
  "quantity",
  "transactionType",
  "product",
  "orderType",
  "price",
  "triggerPrice",
  "validity",
  "disclosedQuantity",
  "amo",
  "tag",
  "bookLossPrice",
  "bookProfitPrice",
  "trailPrice",
  "marketProtection",
  "algoId",
];
const MODIFY_KEYS: readonly string[] = [
  "exchange",
  "tradingsymbol",
  "quantity",
  "price",
  "orderType",
  "product",
  "triggerPrice",
  "validity",
  "tag",
  "bookLossPrice",
  "bookProfitPrice",
  "trailPrice",
  "algoId",
];
const MARGIN_KEYS: readonly string[] = [
  "exchange",
  "tradingsymbol",
  "quantity",
  "price",
  "product",
  "transactionType",
  "orderType",
  "triggerPrice",
  "bookLossPrice",
  "orderId",
  "snoNumber",
];

/** What an order write resolves to: the method's id and the ack's order id for the outcome line. */
export interface OrderResult {
  readonly id: string;
  /** The ack's `norenordno` (the outcome line falls back to the payload's). */
  readonly ackId: string | null;
}

type Pairs = [string, string][];

function push(pairs: Pairs, key: string, value: string | null): void {
  if (value !== null) pairs.push([key, value]);
}

/** `algo_id`: the per-call value, else the config's; a given value must be a non-blank string. */
function algoId(v: Validator, perCall: unknown, config: string | null): string | null {
  const value = perCall ?? config;
  return value === null ? null : v.nonBlank(value, "algo_id");
}

/**
 * The cover / bracket leg rules (Python `_check_trigger_and_legs`): the legs only on CO / BO,
 * `bpprc` only on BO.
 */
function checkLegs(
  v: Validator,
  product: string | null,
  legs: Readonly<Record<"blprc" | "bpprc" | "trailprc", unknown>>,
): void {
  if (product === null) return;
  const given = (key: "blprc" | "bpprc" | "trailprc"): boolean =>
    legs[key] !== null && legs[key] !== undefined && v.ok(key);
  if (
    product !== "H" &&
    product !== "B" &&
    (given("blprc") || given("bpprc") || given("trailprc"))
  ) {
    v.rule("book_loss_price, book_profit_price and trail_price apply to cover/bracket orders only");
  } else if (given("bpprc") && product !== "B") {
    v.rule("book_profit_price applies to bracket orders only");
  }
}

function unknownAck(endpoint: string, body: unknown): OrderStatusUnknownError {
  return new OrderStatusUnknownError(
    endpoint,
    `${endpoint} was accepted by the server (stat Ok) but the acknowledgement could not be ` +
      "parsed or carried no order number; check orders()/order_history() before acting",
    { httpStatus: null, body: redactedBody(body) },
  );
}

/** The `OrderAck` of an accepted request; an unreadable one is `OrderStatusUnknownError`. */
function readAck(endpoint: string, result: ClassifyResult): OrderAck {
  const body = result.kind === "ok" ? result.body : null;
  let ack: OrderAck | null = null;
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    try {
      ack = parseOrderAck(body, { endpoint });
    } catch {
      ack = null; // reported below: the server accepted the request
    }
  }
  if (ack === null) throw unknownAck(endpoint, body);
  return ack;
}

/** A non-blank text or integer ack field, trimmed (Python `_ack_text`), else `null`. */
function ackText(value: unknown): string | null {
  let text: string | null = null;
  if (typeof value === "string") text = value;
  else if (value instanceof JsonNumber && /^-?\d+$/.test(value.text)) text = value.text;
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function writeSpec(
  endpoint: string,
  payload: Pairs,
  decode: (result: ClassifyResult) => OrderResult,
  signal: AbortSignal | undefined,
): CallSpec<OrderResult> {
  return {
    endpoint,
    payload,
    stateChanging: true,
    expect: "object",
    allowEmpty: false,
    rateGroup: endpoint === "PlaceOrder" ? "orders" : null,
    decode,
    ackId: (result) => result.ackId,
    signal,
  };
}

/**
 * The `PlaceOrder` call. Wire keys in this order (optional ones only when given): `uid, actid,
 * exch, tsym, qty, prc, trgprc, dscqty, prd, trantype, prctyp, ret, amo, remarks, ordersource,
 * blprc, bpprc, trailprc, mkt_protection, algo_id`; `amo` always, `ordersource` always `API`.
 * Returns the ack's `norenordno` as received (not trimmed).
 */
export function placeOrderCall(
  uid: string,
  params: PlaceOrderParams,
  configAlgoId: string | null,
  signal?: AbortSignal,
): CallSpec<OrderResult> {
  const p = checkParams("placeOrder", params, PLACE_KEYS);
  const v = new Validator();
  const exch = v.enumCode("Exchange", p["exchange"], "exch");
  const tsym = v.text(p["tradingsymbol"], "tsym");
  const qty = v.integer(p["quantity"], "qty", 1);
  const prctyp = v.enumCode("OrderType", p["orderType"], "prctyp");
  const prc = orderPrice(v, p["price"], prctyp);
  const trgprc = v.price(p["triggerPrice"], "trgprc", { required: false });
  const dscqty = v.optionalInteger(p["disclosedQuantity"], "dscqty", 0);
  const prd = v.enumCode("Product", p["product"], "prd");
  const trantype = v.enumCode("TransactionType", p["transactionType"], "trantype");
  const ret = v.enumCode("Validity", p["validity"] ?? "DAY", "ret");
  const amo = v.bool(p["amo"], "amo", false);
  const remarks = v.optionalText(p["tag"], "remarks");
  const blprc = v.price(p["bookLossPrice"], "blprc", { required: false });
  const bpprc = v.price(p["bookProfitPrice"], "bpprc", { required: false });
  const trailprc = v.price(p["trailPrice"], "trailprc", { required: false });
  const mkt = v.price(p["marketProtection"], "mkt_protection", { required: false });
  const algo = algoId(v, p["algoId"], configAlgoId);

  // Cross-field rules, in the order of Python's PlaceOrderRequest._check_rules.
  checkPriceRules(v, prctyp, prc, trgprc);
  if (qty !== null && dscqty !== null && dscqty > qty) {
    v.rule("disclosed_quantity cannot exceed quantity");
  }
  // `blprc` / `bpprc` are null here when not given (an invalid one failed its own check).
  if (prd === "H" && v.ok("blprc") && blprc === null) {
    v.rule("book_loss_price is required for cover orders");
  }
  if (prd === "B" && v.ok("blprc") && v.ok("bpprc") && (blprc === null || bpprc === null)) {
    v.rule("book_loss_price and book_profit_price are required for bracket orders");
  }
  checkLegs(v, prd, {
    blprc: p["bookLossPrice"],
    bpprc: p["bookProfitPrice"],
    trailprc: p["trailPrice"],
  });
  if (prd === "F" && exch === "MCX") v.rule("MTF is not offered for MCX");
  v.throwIfInvalid();

  const payload: Pairs = [
    ["uid", uid],
    ["actid", uid],
    ["exch", exch as string],
    ["tsym", tsym as string],
    ["qty", String(qty)],
    ["prc", (prc as { text: string }).text],
  ];
  push(payload, "trgprc", trgprc?.text ?? null);
  push(payload, "dscqty", dscqty === null ? null : String(dscqty));
  payload.push(
    ["prd", prd as string],
    ["trantype", trantype as string],
    ["prctyp", prctyp as string],
    ["ret", ret as string],
    ["amo", amo === true ? "Yes" : "No"],
  );
  push(payload, "remarks", remarks);
  payload.push(["ordersource", "API"]);
  push(payload, "blprc", blprc?.text ?? null);
  push(payload, "bpprc", bpprc?.text ?? null);
  push(payload, "trailprc", trailprc?.text ?? null);
  push(payload, "mkt_protection", mkt?.text ?? null);
  push(payload, "algo_id", algo);

  return writeSpec(
    "PlaceOrder",
    payload,
    (result) => {
      const ack = readAck("PlaceOrder", result);
      const id = ack.orderId;
      if (id === null || id.trim() === "") {
        throw unknownAck("PlaceOrder", result.kind === "ok" ? result.body : null);
      }
      return { id, ackId: id };
    },
    signal,
  );
}

/**
 * The `ModifyOrder` call. Wire keys: `uid, actid, exch, norenordno, tsym, qty, prc, prctyp, prd,
 * trgprc, ret, remarks, ordersource, blprc, bpprc, trailprc, algo_id` (no `amo`; `ret` only when
 * `validity` is given). Returns the ack's `norenordno`, else its `result`, else `orderId`
 * (trimmed; a blank one is skipped).
 */
export function modifyOrderCall(
  uid: string,
  orderId: unknown,
  params: ModifyOrderParams,
  configAlgoId: string | null,
  signal?: AbortSignal,
): CallSpec<OrderResult> {
  const p = checkParams("modifyOrder", params, MODIFY_KEYS);
  const v = new Validator();
  const exch = v.enumCode("Exchange", p["exchange"], "exch");
  const norenordno = v.nonEmpty(orderId, "norenordno");
  const tsym = v.text(p["tradingsymbol"], "tsym");
  const qty = v.integer(p["quantity"], "qty", 1);
  const prctyp = v.enumCode("OrderType", p["orderType"], "prctyp");
  const prc = orderPrice(v, p["price"], prctyp);
  const prd = v.enumCode("Product", p["product"], "prd");
  const trgprc = v.price(p["triggerPrice"], "trgprc", { required: false });
  const validity = p["validity"];
  const ret =
    validity === undefined || validity === null ? null : v.enumCode("Validity", validity, "ret");
  const remarks = v.optionalText(p["tag"], "remarks");
  const blprc = v.price(p["bookLossPrice"], "blprc", { required: false });
  const bpprc = v.price(p["bookProfitPrice"], "bpprc", { required: false });
  const trailprc = v.price(p["trailPrice"], "trailprc", { required: false });
  const algo = algoId(v, p["algoId"], configAlgoId);

  checkPriceRules(v, prctyp, prc, trgprc);
  checkLegs(v, prd, {
    blprc: p["bookLossPrice"],
    bpprc: p["bookProfitPrice"],
    trailprc: p["trailPrice"],
  });
  v.throwIfInvalid();

  const id = norenordno as string;
  const payload: Pairs = [
    ["uid", uid],
    ["actid", uid],
    ["exch", exch as string],
    ["norenordno", id],
    ["tsym", tsym as string],
    ["qty", String(qty)],
    ["prc", (prc as { text: string }).text],
    ["prctyp", prctyp as string],
    ["prd", prd as string],
  ];
  push(payload, "trgprc", trgprc?.text ?? null);
  push(payload, "ret", ret);
  push(payload, "remarks", remarks);
  payload.push(["ordersource", "API"]);
  push(payload, "blprc", blprc?.text ?? null);
  push(payload, "bpprc", bpprc?.text ?? null);
  push(payload, "trailprc", trailprc?.text ?? null);
  push(payload, "algo_id", algo);

  return writeSpec(
    "ModifyOrder",
    payload,
    (result) => {
      const ack = readAck("ModifyOrder", result);
      const body = result.kind === "ok" ? (result.body as Record<string, unknown>) : {};
      const fromResult = Object.hasOwn(body, "result") ? ackText(body["result"]) : null;
      return { id: ackText(ack.orderId) ?? fromResult ?? id, ackId: ack.orderId };
    },
    signal,
  );
}

/** The `CancelOrder` call (`uid`, `norenordno`); returns `orderId`. */
export function cancelOrderCall(
  uid: string,
  orderId: unknown,
  signal?: AbortSignal,
): CallSpec<OrderResult> {
  const v = new Validator();
  const norenordno = v.nonEmpty(orderId, "norenordno");
  v.throwIfInvalid();
  const id = norenordno as string;
  return writeSpec(
    "CancelOrder",
    [
      ["uid", uid],
      ["norenordno", id],
    ],
    (result) => ({ id, ackId: readAck("CancelOrder", result).orderId }),
    signal,
  );
}

/** The `ExitSNOOrder` call (`uid`, `norenordno`, `prd` H or B); returns `orderId`. */
export function exitOrderCall(
  uid: string,
  orderId: unknown,
  product: unknown,
  signal?: AbortSignal,
): CallSpec<OrderResult> {
  const v = new Validator();
  const norenordno = v.nonEmpty(orderId, "norenordno");
  const prd = v.enumCode("Product", product, "prd");
  if (prd !== null && prd !== "H" && prd !== "B") {
    v.rule("product must be CO (H, cover) or BO (B, bracket)");
  }
  v.throwIfInvalid();
  const id = norenordno as string;
  return writeSpec(
    "ExitSNOOrder",
    [
      ["uid", uid],
      ["norenordno", id],
      ["prd", prd as string],
    ],
    (result) => ({ id, ackId: readAck("ExitSNOOrder", result).orderId }),
    signal,
  );
}

/**
 * The `GetOrderMargin` call (a read: retried, no outcome line). Wire keys `uid, actid, exch,
 * tsym, qty, prc, prd, trantype, prctyp[, trgprc, blprc, norenordno, snonum]`; `price` is
 * required (no market default) and every order type is accepted.
 */
export function orderMarginCall(
  uid: string,
  params: OrderMarginParams,
  signal?: AbortSignal,
): CallSpec<OrderMargin> {
  const p = checkParams("orderMargin", params, MARGIN_KEYS);
  const v = new Validator();
  const exch = v.enumCode("Exchange", p["exchange"], "exch");
  const tsym = v.text(p["tradingsymbol"], "tsym");
  const qty = v.integer(p["quantity"], "qty", 1);
  const prc = v.price(p["price"], "prc", { required: true });
  const prd = v.enumCode("Product", p["product"], "prd");
  const trantype = v.enumCode("TransactionType", p["transactionType"], "trantype");
  const prctyp = v.enumCode("OrderType", p["orderType"], "prctyp");
  const trgprc = v.price(p["triggerPrice"], "trgprc", { required: false });
  const blprc = v.price(p["bookLossPrice"], "blprc", { required: false });
  const norenordno = v.optionalText(p["orderId"], "norenordno");
  const snonum = v.optionalText(p["snoNumber"], "snonum");
  v.throwIfInvalid();

  const payload: Pairs = [
    ["uid", uid],
    ["actid", uid],
    ["exch", exch as string],
    ["tsym", tsym as string],
    ["qty", String(qty)],
    ["prc", (prc as { text: string }).text],
    ["prd", prd as string],
    ["trantype", trantype as string],
    ["prctyp", prctyp as string],
  ];
  push(payload, "trgprc", trgprc?.text ?? null);
  push(payload, "blprc", blprc?.text ?? null);
  push(payload, "norenordno", norenordno);
  push(payload, "snonum", snonum);
  return readSpec({
    endpoint: "GetOrderMargin",
    payload,
    decode: objectDecoder(parseOrderMargin, "GetOrderMargin"),
    signal,
  });
}
