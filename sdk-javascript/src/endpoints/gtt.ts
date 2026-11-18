// GTT endpoints (sdk-behaviour.md §2.3, §2.8, §4.2.1), mirroring
// sdk-python/src/tradesmart/endpoints/gtt.py and models/gtt.py: the writes `PlaceGTTOrder`,
// `ModifyGTTOrder`, `CancelGTTOrder` (order calls: never retried, success only on the documented
// word with a non-blank `al_id`, checked by the classifier; an ambiguous outcome is
// `OrderStatusUnknownError` pointing to `pendingGtts()`) and the reads `GetPendingGTTOrder`,
// `GetTrgOi`, `GetEnabledGTTs`. No `ordersource`, `amo` or `algo_id` is sent on a GTT write.
import { OrderStatusUnknownError, ResponseParseError } from "../errors.js";
import type {
  Exchange,
  GttAlertType,
  GttValidity,
  OrderType,
  Product,
  TransactionType,
  Validity,
} from "../enums.js";
import type { CallSpec } from "../lib/call.js";
import type { ClassifyResult } from "../lib/classify.js";
import { redactedBody } from "../lib/redact.js";
import { checkParams, checkPriceRules, orderPrice, Validator } from "../lib/validate.js";
import type { OpenEnum } from "../models/base.js";
import {
  parseGtt,
  parseTriggeredGtt,
  type Gtt,
  type TriggeredGtt,
} from "../models/generated/gtt.js";
import { listDecoder, readSpec } from "./base.js";
import type { PriceInput } from "./orders.js";

/** Parameters of `placeGtt()` (sdk-behaviour.md §2.8). */
export interface PlaceGttParams {
  /** NSE, NFO, BSE, BFO or MCX. */
  exchange: OpenEnum<Exchange>;
  tradingsymbol: string;
  /** Sent as `ai_t`: one of the 13 `GttAlertType` codes (or its member name). */
  alertType: OpenEnum<GttAlertType>;
  /** Sent as `d`: the value the alert watches for; any finite number (a % change may be negative). */
  triggerValue: PriceInput;
  /** In the exchange's trade units, a whole multiple of the lot size (MCX too). */
  quantity: number;
  transactionType: OpenEnum<TransactionType>;
  /** CNC, NRML or CO (a CO GTT needs no book loss price). */
  product: OpenEnum<Product>;
  orderType: OpenEnum<OrderType>;
  /** Required, non-blank, sent as `remarks`: finds the GTT in `pendingGtts()` after an unknown outcome. */
  tag: string;
  price?: PriceInput | null | undefined;
  triggerPrice?: PriceInput | null | undefined;
  /** The order's validity, sent as `ret`; default `DAY`. */
  validity?: OpenEnum<Validity> | undefined;
  /** The GTT's own validity, sent as `validity`: `GTT` (default) or `DAY`. */
  alertValidity?: OpenEnum<GttValidity> | undefined;
  disclosedQuantity?: number | null | undefined;
}

/**
 * Parameters of `modifyGtt()`: every field again. `validity` and `alertValidity` have no
 * defaults (a default would silently change a `DAY` GTT or an `EOS` / `IOC` order).
 */
export interface ModifyGttParams extends Omit<PlaceGttParams, "validity" | "alertValidity"> {
  validity: OpenEnum<Validity>;
  alertValidity: OpenEnum<GttValidity>;
}

const PLACE_KEYS: readonly string[] = [
  "exchange",
  "tradingsymbol",
  "alertType",
  "triggerValue",
  "quantity",
  "transactionType",
  "product",
  "orderType",
  "tag",
  "price",
  "triggerPrice",
  "validity",
  "alertValidity",
  "disclosedQuantity",
];

/** The exchanges and products the GTT docs list (CDS, BCD, MIS, BO and MTF are refused). */
const GTT_EXCHANGES: ReadonlySet<string> = new Set(["NSE", "NFO", "BSE", "BFO", "MCX"]);
const GTT_PRODUCTS: ReadonlySet<string> = new Set(["C", "M", "H"]);

type Pairs = [string, string][];

/**
 * The GTT order fields after `al_id` (wire order `exch, tsym, ai_t, d, validity, remarks,
 * trantype, prctyp, prd, ret, qty, prc[, trgprc][, dscqty]`), validated with every failure
 * collected into `v`; `null` when a check failed.
 */
function gttFields(
  v: Validator,
  p: Readonly<Record<string, unknown>>,
  defaults: { validity?: string; alertValidity?: string },
): Pairs | null {
  let exch = v.enumCode("Exchange", p["exchange"], "exch");
  if (exch !== null && !GTT_EXCHANGES.has(exch)) {
    exch = v.fail("exch", "value_error", "a GTT is offered on NSE, NFO, BSE, BFO and MCX only");
  }
  const tsym = v.text(p["tradingsymbol"], "tsym");
  const aiT = v.enumCode("GttAlertType", p["alertType"], "ai_t");
  const d = v.price(p["triggerValue"], "d", { required: true, signed: true });
  const validity = v.enumCode(
    "GttValidity",
    p["alertValidity"] ?? defaults.alertValidity,
    "validity",
  );
  const remarks = v.nonBlank(p["tag"], "remarks");
  const trantype = v.enumCode("TransactionType", p["transactionType"], "trantype");
  const prctyp = v.enumCode("OrderType", p["orderType"], "prctyp");
  let prd = v.enumCode("Product", p["product"], "prd");
  if (prd !== null && !GTT_PRODUCTS.has(prd)) {
    prd = v.fail(
      "prd",
      "value_error",
      "a GTT order's product must be CNC, NRML or CO (not MIS, BO or MTF)",
    );
  }
  const ret = v.enumCode("Validity", p["validity"] ?? defaults.validity, "ret");
  const qty = v.integer(p["quantity"], "qty", 1);
  const prc = orderPrice(v, p["price"], prctyp);
  const trgprc = v.price(p["triggerPrice"], "trgprc", { required: false });
  const dscqty = v.optionalInteger(p["disclosedQuantity"], "dscqty", 0);

  // Cross-field rules of Python's _GttRules._check_rules (no cover / bracket legs on a GTT).
  checkPriceRules(v, prctyp, prc, trgprc);
  if (qty !== null && dscqty !== null && dscqty > qty) {
    v.rule("disclosed_quantity cannot exceed quantity");
  }
  if (v.issues.length > 0) return null;

  const pairs: Pairs = [
    ["exch", exch as string],
    ["tsym", tsym as string],
    ["ai_t", aiT as string],
    ["d", (d as { text: string }).text],
    ["validity", validity as string],
    ["remarks", remarks as string],
    ["trantype", trantype as string],
    ["prctyp", prctyp as string],
    ["prd", prd as string],
    ["ret", ret as string],
    ["qty", String(qty)],
    ["prc", (prc as { text: string }).text],
  ];
  if (trgprc !== null) pairs.push(["trgprc", trgprc.text]);
  if (dscqty !== null) pairs.push(["dscqty", String(dscqty)]);
  return pairs;
}

/** The `al_id` of an accepted GTT write, exactly as sent; anything unusable is an unknown outcome. */
function alertIdDecoder(endpoint: string): (result: ClassifyResult) => string {
  return (result) => {
    const body = result.kind === "ok" ? result.body : null;
    const alertId =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)["al_id"]
        : undefined;
    if (typeof alertId === "string" && alertId.trim() !== "") return alertId;
    throw new OrderStatusUnknownError(
      endpoint,
      `${endpoint} was accepted by the server but the acknowledgement carried no alert id; ` +
        "check pending_gtts() before acting",
      { httpStatus: null, body: redactedBody(body) },
    );
  };
}

function gttWriteSpec(
  endpoint: string,
  payload: Pairs,
  signal: AbortSignal | undefined,
): CallSpec<string> {
  return {
    endpoint,
    payload,
    stateChanging: true,
    expect: "object",
    allowEmpty: false,
    rateGroup: null,
    decode: alertIdDecoder(endpoint),
    ackId: (alertId) => alertId,
    signal,
  };
}

/** The `PlaceGTTOrder` call (`uid, actid` + the GTT fields); resolves to the ack's `al_id`. */
export function placeGttCall(
  uid: string,
  params: PlaceGttParams,
  signal?: AbortSignal,
): CallSpec<string> {
  const p = checkParams("placeGtt", params, PLACE_KEYS);
  const v = new Validator();
  const fields = gttFields(v, p, { validity: "DAY", alertValidity: "GTT" });
  v.throwIfInvalid();
  return gttWriteSpec(
    "PlaceGTTOrder",
    [["uid", uid], ["actid", uid], ...(fields as Pairs)],
    signal,
  );
}

/** The `ModifyGTTOrder` call (`uid, actid, al_id` + every GTT field again). */
export function modifyGttCall(
  uid: string,
  alertId: unknown,
  params: ModifyGttParams,
  signal?: AbortSignal,
): CallSpec<string> {
  const p = checkParams("modifyGtt", params, PLACE_KEYS);
  const v = new Validator();
  const alId = v.nonBlank(alertId, "al_id");
  const fields = gttFields(v, p, {});
  v.throwIfInvalid();
  return gttWriteSpec(
    "ModifyGTTOrder",
    [["uid", uid], ["actid", uid], ["al_id", alId as string], ...(fields as Pairs)],
    signal,
  );
}

/** The `CancelGTTOrder` call (`uid`, `al_id`; no `actid`, as documented). */
export function cancelGttCall(
  uid: string,
  alertId: unknown,
  signal?: AbortSignal,
): CallSpec<string> {
  const v = new Validator();
  const alId = v.nonBlank(alertId, "al_id");
  v.throwIfInvalid();
  return gttWriteSpec(
    "CancelGTTOrder",
    [
      ["uid", uid],
      ["al_id", alId as string],
    ],
    signal,
  );
}

/** The `GetPendingGTTOrder` call (`uid` only, as documented). */
export function pendingGttsCall(uid: string, signal?: AbortSignal): CallSpec<readonly Gtt[]> {
  return readSpec({
    endpoint: "GetPendingGTTOrder",
    payload: [["uid", uid]],
    expect: "list",
    allowEmpty: true,
    decode: listDecoder(parseGtt, "GetPendingGTTOrder"),
    signal,
  });
}

/** The `GetTrgOi` call (`uid` and `actid`, as documented). */
export function triggeredGttsCall(
  uid: string,
  signal?: AbortSignal,
): CallSpec<readonly TriggeredGtt[]> {
  return readSpec({
    endpoint: "GetTrgOi",
    payload: [
      ["uid", uid],
      ["actid", uid],
    ],
    expect: "list",
    allowEmpty: true,
    decode: listDecoder(parseTriggeredGtt, "GetTrgOi"),
    signal,
  });
}

function badAlertTypes(body: unknown): ResponseParseError {
  return new ResponseParseError(
    "GetEnabledGTTs: ai_ts must be a list of objects with a text ai_t",
    {
      endpoint: "GetEnabledGTTs",
      httpStatus: null,
      body: redactedBody(body),
    },
  );
}

/**
 * The `ai_ts[].ai_t` values (alert families such as `LTP`), in the server's order. The empty
 * signal and a bare `[]` are no families; an `Ok` object without `ai_ts` has none.
 */
function decodeAlertTypes(result: ClassifyResult): readonly string[] {
  if (result.kind === "empty") return Object.freeze([]);
  const body = result.body;
  if (Array.isArray(body) && body.length === 0) return Object.freeze([]);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw badAlertTypes(body);
  const items = (body as Record<string, unknown>)["ai_ts"];
  if (items === undefined || items === null) return Object.freeze([]);
  if (!Array.isArray(items)) throw badAlertTypes(body);
  const families = (items as unknown[]).map((item) => {
    const family =
      typeof item === "object" && item !== null && !Array.isArray(item)
        ? (item as Record<string, unknown>)["ai_t"]
        : undefined;
    if (typeof family !== "string") throw badAlertTypes(body);
    return family;
  });
  return Object.freeze(families);
}

/** The `GetEnabledGTTs` call (`uid` only, as documented). */
export function gttAlertTypesCall(uid: string, signal?: AbortSignal): CallSpec<readonly string[]> {
  return readSpec({
    endpoint: "GetEnabledGTTs",
    payload: [["uid", uid]],
    allowEmpty: true,
    decode: decodeAlertTypes,
    signal,
  });
}
