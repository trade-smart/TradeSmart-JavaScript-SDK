// OCO endpoints (sdk-behaviour.md §2.9, §3.2, §4.2.1), mirroring the Python SDK's
// `endpoints/oco.py`: the writes `PlaceOCOOrder`, `ModifyOCOOrder`, `CancelOCOOrder`. Order calls:
// never retried, success only on the documented word with a non-blank `al_id` (checked by the
// classifier), an ambiguous outcome is `OrderStatusUnknownError` pointing to `pendingGtts()`.
// The body is nested: `oivariable` is a list of `{var_name, d}` objects and each leg a plain
// object whose key insertion order is the contract order (none of the keys is integer-like).
import { RequestValidationError, type ValidationIssue } from "../errors.js";
import type {
  Exchange,
  GttValidity,
  OrderType,
  Product,
  TransactionType,
  Validity,
} from "../enums.js";
import type { CallSpec } from "../lib/call.js";
import type { WirePayload, WireValue } from "../lib/codec.js";
import { decimalFromText, type PlainDecimal } from "../lib/decimal.js";
import { checkParams, MARKET_TYPES, orderPrice, STOP_TYPES, Validator } from "../lib/validate.js";
import type { OpenEnum } from "../models/base.js";
import { gttWriteSpec } from "./gtt.js";
import type { PriceInput } from "./orders.js";

/** One side of an OCO: the trigger watched and the order sent when it is reached (§2.9). */
export interface OcoLeg {
  /** Sent as the leg's `oivariable` item `d`: a finite number greater than 0, digits kept. */
  triggerValue: PriceInput;
  /** The order price: required (> 0) for LIMIT / SL, `0` when omitted on MARKET / SL_M. */
  price?: PriceInput | null | undefined;
  /** LIMIT (default), MARKET, SL or SL_M (or the wire codes). */
  orderType?: OpenEnum<OrderType> | undefined;
  /** The trigger price of the order itself: required for SL / SL_M, refused for the others. */
  triggerPrice?: PriceInput | null | undefined;
}

/** Parameters of `placeOco()` (sdk-behaviour.md §2.9). */
export interface PlaceOcoParams {
  /** NSE, NFO, BSE, BFO or MCX. */
  exchange: OpenEnum<Exchange>;
  tradingsymbol: string;
  /** BUY closes a short (stop-loss trigger above the target trigger); SELL a long (below it). */
  transactionType: OpenEnum<TransactionType>;
  /** In the exchange's trade units, a whole multiple of the lot size (MCX too). */
  quantity: number;
  /** CNC, NRML or CO. */
  product: OpenEnum<Product>;
  /** Always sent as slot `x` / `place_order_params`. */
  stopLoss: OcoLeg;
  /** Always sent as slot `y` / `place_order_params_leg2`. */
  target: OcoLeg;
  /** Optional, non-blank when given, sent as each leg's `remarks`. */
  tag?: string | null | undefined;
  /** The orders' validity, sent as each leg's `ret`; default `DAY`. */
  validity?: OpenEnum<Validity> | undefined;
  /** The OCO's own validity, sent as `validity`: `GTT` (default) or `DAY`. */
  alertValidity?: OpenEnum<GttValidity> | undefined;
}

/** Parameters of `modifyOco()`: every field again; `validity` and `alertValidity` are required. */
export interface ModifyOcoParams extends Omit<PlaceOcoParams, "validity" | "alertValidity"> {
  validity: OpenEnum<Validity>;
  alertValidity: OpenEnum<GttValidity>;
}

const PLACE_KEYS: readonly string[] = [
  "exchange",
  "tradingsymbol",
  "transactionType",
  "quantity",
  "product",
  "stopLoss",
  "target",
  "tag",
  "validity",
  "alertValidity",
];
const LEG_KEYS: readonly string[] = ["triggerValue", "price", "orderType", "triggerPrice"];

/** The exchanges and products an OCO accepts (as a GTT). */
const OCO_EXCHANGES: ReadonlySet<string> = new Set(["NSE", "NFO", "BSE", "BFO", "MCX"]);
const OCO_PRODUCTS: ReadonlySet<string> = new Set(["C", "M", "H"]);

const STOP_LOSS = { key: "place_order_params", index: 0 } as const;
const TARGET = { key: "place_order_params_leg2", index: 1 } as const;
type Slot = typeof STOP_LOSS | typeof TARGET;

interface Shared {
  tsym: string | null;
  exch: string | null;
  trantype: string | null;
  prd: string | null;
  ret: string | null;
  qty: number | null;
  remarks: string | null;
  uid: string;
}

function absent(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

function prefixed(
  issues: readonly ValidationIssue[],
  prefix: (string | number)[],
): ValidationIssue[] {
  return issues.map((issue) => ({ ...issue, loc: [...prefix, ...issue.loc] }));
}

interface ShapedLeg {
  trigger: PlainDecimal | null;
  /** The leg's wire object, or `null` when any check failed. */
  wire: Record<string, string> | null;
}

/** Validate one leg; failures are added to `issues` under their wire path. */
function shapeLeg(
  method: "placeOco" | "modifyOco",
  issues: ValidationIssue[],
  slot: Slot,
  value: unknown,
  shared: Shared,
): ShapedLeg {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push({ type: "model_type", loc: [slot.key], msg: "must be an object" });
    return { trigger: null, wire: null };
  }
  const leg = checkParams(`${method} leg`, value, LEG_KEYS);

  const tv = new Validator();
  let trigger = tv.price(leg["triggerValue"], "d", { required: true });
  if (trigger !== null && trigger.sign <= 0) {
    tv.fail("d", "greater_than", "must be greater than 0");
    trigger = null;
  }
  issues.push(...prefixed(tv.issues, ["oivariable", slot.index]));

  const lv = new Validator();
  const prctyp = lv.enumCode("OrderType", leg["orderType"] ?? "LIMIT", "prctyp");
  const prc = orderPrice(lv, leg["price"], prctyp);
  const trgprc = lv.price(leg["triggerPrice"], "trgprc", { required: false });
  if (prctyp !== null) {
    if (prc !== null && lv.ok("prc") && !MARKET_TYPES.has(prctyp) && prc.sign <= 0) {
      lv.fail("prc", "greater_than", "must be greater than 0 for limit and stop-loss limit orders");
    }
    if (lv.ok("trgprc")) {
      if (STOP_TYPES.has(prctyp)) {
        if (trgprc === null || trgprc.sign <= 0) {
          lv.fail(
            "trgprc",
            "missing",
            "is required and must be greater than 0 for stop-loss orders",
          );
        }
      } else if (trgprc !== null) {
        lv.fail("trgprc", "value_error", "applies to stop-loss orders (SL, SL_M) only");
      }
    }
  }
  issues.push(...prefixed(lv.issues, [slot.key]));
  if (
    lv.issues.length > 0 ||
    tv.issues.length > 0 ||
    shared.tsym === null ||
    shared.exch === null ||
    shared.trantype === null ||
    shared.prd === null ||
    shared.ret === null ||
    shared.qty === null ||
    prctyp === null ||
    prc === null
  ) {
    return { trigger, wire: null };
  }
  const wire: Record<string, string> = {
    tsym: shared.tsym,
    exch: shared.exch,
    trantype: shared.trantype,
    prctyp,
    prd: shared.prd,
    ret: shared.ret,
    actid: shared.uid,
    uid: shared.uid,
    qty: String(shared.qty),
    prc: prc.text,
    ordersource: "API",
  };
  if (trgprc !== null) wire["trgprc"] = trgprc.text;
  if (shared.remarks !== null) wire["remarks"] = shared.remarks;
  return { trigger, wire };
}

type Pairs = [string, WireValue][];

/** The OCO fields after `uid` (and `al_id`): `tsym, exch, validity, ai_t, oivariable, legs`. */
function ocoFields(
  uid: string,
  p: Readonly<Record<string, unknown>>,
  defaults: { validity?: string; alertValidity?: string },
  issues: ValidationIssue[],
  method: "placeOco" | "modifyOco",
): Pairs | null {
  const v = new Validator();
  let exch = v.enumCode("Exchange", p["exchange"], "exch");
  if (exch !== null && !OCO_EXCHANGES.has(exch)) {
    exch = v.fail("exch", "value_error", "an OCO is offered on NSE, NFO, BSE, BFO and MCX only");
  }
  const tsym = v.text(p["tradingsymbol"], "tsym");
  const trantype = v.enumCode("TransactionType", p["transactionType"], "trantype");
  let prd = v.enumCode("Product", p["product"], "prd");
  if (prd !== null && !OCO_PRODUCTS.has(prd)) {
    prd = v.fail(
      "prd",
      "value_error",
      "an OCO order's product must be CNC, NRML or CO (not MIS, BO or MTF)",
    );
  }
  const qty = v.integer(p["quantity"], "qty", 1);
  const ret = v.enumCode("Validity", p["validity"] ?? defaults.validity, "ret");
  const validity = v.enumCode(
    "GttValidity",
    p["alertValidity"] ?? defaults.alertValidity,
    "validity",
  );
  const remarks = absent(p["tag"]) ? null : v.nonBlank(p["tag"], "remarks");
  issues.push(...v.issues);

  const shared: Shared = { tsym, exch, trantype, prd, ret, qty, remarks, uid };
  const stop = shapeLeg(method, issues, STOP_LOSS, p["stopLoss"], shared);
  const target = shapeLeg(method, issues, TARGET, p["target"], shared);

  // The side check (only when both triggers are valid numbers): the web terminal's rule.
  if (stop.trigger !== null && target.trigger !== null && trantype !== null) {
    const sl = decimalFromText(stop.trigger.text);
    const tg = decimalFromText(target.trigger.text);
    if (sl !== null && tg !== null) {
      const ok = trantype === "B" ? sl.greaterThan(tg) : sl.lessThan(tg);
      if (!ok) {
        issues.push({
          type: "value_error",
          loc: ["oivariable"],
          msg:
            trantype === "B"
              ? "a BUY OCO needs the stop-loss trigger above the target trigger"
              : "a SELL OCO needs the stop-loss trigger below the target trigger",
        });
      }
    }
  }
  if (issues.length > 0 || stop.wire === null || target.wire === null) return null;
  return [
    ["tsym", tsym as string],
    ["exch", exch as string],
    ["validity", validity as string],
    ["ai_t", trantype === "B" ? "LMT_BOS_O" : "LMT_SOB_O"],
    [
      "oivariable",
      [
        { var_name: "x", d: (stop.trigger as PlainDecimal).text },
        { var_name: "y", d: (target.trigger as PlainDecimal).text },
      ],
    ],
    [STOP_LOSS.key, stop.wire],
    [TARGET.key, target.wire],
  ];
}

function throwAll(issues: ValidationIssue[]): void {
  if (issues.length > 0) throw new RequestValidationError(issues);
}

/** The `PlaceOCOOrder` call (`uid` + the OCO fields); resolves to the ack's `al_id`. */
export function placeOcoCall(
  uid: string,
  params: PlaceOcoParams,
  signal?: AbortSignal,
): CallSpec<string> {
  const p = checkParams("placeOco", params, PLACE_KEYS);
  const issues: ValidationIssue[] = [];
  const fields = ocoFields(uid, p, { validity: "DAY", alertValidity: "GTT" }, issues, "placeOco");
  throwAll(issues);
  const payload: WirePayload = [["uid", uid], ...(fields as Pairs)];
  return gttWriteSpec("PlaceOCOOrder", payload, signal);
}

/** The `ModifyOCOOrder` call (`uid, al_id` + every OCO field again). */
export function modifyOcoCall(
  uid: string,
  alertId: unknown,
  params: ModifyOcoParams,
  signal?: AbortSignal,
): CallSpec<string> {
  const p = checkParams("modifyOco", params, PLACE_KEYS);
  const issues: ValidationIssue[] = [];
  const idv = new Validator();
  const alId = idv.nonBlank(alertId, "al_id");
  issues.push(...idv.issues);
  const fields = ocoFields(uid, p, {}, issues, "modifyOco");
  throwAll(issues);
  const payload: WirePayload = [["uid", uid], ["al_id", alId as string], ...(fields as Pairs)];
  return gttWriteSpec("ModifyOCOOrder", payload, signal);
}

/** The `CancelOCOOrder` call (`uid`, `al_id`). */
export function cancelOcoCall(
  uid: string,
  alertId: unknown,
  signal?: AbortSignal,
): CallSpec<string> {
  const v = new Validator();
  const alId = v.nonBlank(alertId, "al_id");
  v.throwIfInvalid();
  return gttWriteSpec(
    "CancelOCOOrder",
    [
      ["uid", uid],
      ["al_id", alId as string],
    ],
    signal,
  );
}
