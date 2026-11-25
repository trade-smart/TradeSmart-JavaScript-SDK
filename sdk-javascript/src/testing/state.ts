// Offline broker core: state, order lifecycle and drills; no I/O (Python: testing/_state.py).
// The REST adapter (and, in Task 8, the stream server) go through one `BrokerState`. Every order
// or position change is queued as a wire stream message (`om`, `pm`) and delivered to the
// listeners in order by `drain()`; a change made by a listener is queued behind the events
// already waiting. Every change is computed and checked first and applied last, so a failure
// changes nothing.
import { D, Decimal } from "../lib/decimal.js";
import { makeLog, noopLogger, type Logger } from "../lib/log.js";
import { redactObject } from "../lib/redact.js";
import { Product } from "../enums.js";
import { isDrill, type Drill } from "./drills.js";
import * as replies from "./replies.js";
import { text } from "./replies.js";
import type { DayInput, Numeric, Wire } from "./replies.js";

export type Listener = (message: Wire) => void;

export const OPEN_STATES = ["PENDING", "OPEN", "TRIGGER_PENDING"] as const;
const FILLABLE = ["OPEN", "TRIGGER_PENDING"] as const;
const NO_PRICE = ["MKT", "SL-MKT"];
export const PLACE_MODES = ["open", "pending", "reject"] as const;
export type PlaceMode = (typeof PLACE_MODES)[number];
const EXITABLE = ["H", "B"]; // ExitSNOOrder: cover and bracket orders only (documented)

// The documented required fields of PlaceGTTOrder / ModifyGTTOrder besides uid and actid.
const GTT_FIELDS = [
  "exch",
  "tsym",
  "ai_t",
  "d",
  "validity",
  "remarks",
  "trantype",
  "prctyp",
  "prd",
  "ret",
  "qty",
  "prc",
];

// An OCO's required fields (PlaceOCOOrder / ModifyOCOOrder) besides uid, the legs and the triggers.
const OCO_FIELDS = ["exch", "tsym", "ai_t", "validity"];
const OCO_LEGS = ["place_order_params", "place_order_params_leg2"];
const OCO_LEG_FIELDS = ["trantype", "prctyp", "prd", "ret", "qty", "prc"];
const OCO_ALERT_TYPES = ["LMT_BOS_O", "LMT_SOB_O"];
const OCO_NOT_TRIGGERED = "OCO triggering is not simulated: no fired OCO has been observed yet";

/** True for a stored alert that is an OCO (by its alert type). */
export function isOcoRow(alert: Wire): boolean {
  return OCO_ALERT_TYPES.includes(text(alert["ai_t"]));
}

// The order fields a triggered GTT places (its order book row also gets "add_ord_id").
const GTT_ORDER_FIELDS = [
  "exch",
  "tsym",
  "trantype",
  "prctyp",
  "prd",
  "ret",
  "qty",
  "prc",
  "trgprc",
  "dscqty",
  "remarks",
];

/**
 * An order the strategy sent, as the offline broker's order book holds it. `side` is `"B"` /
 * `"S"`; `orderType` and `product` are wire codes (`"LMT"`, `"M"`); `status` is one of `PENDING
 * OPEN TRIGGER_PENDING COMPLETE CANCELED REJECTED`. `payload` is the request as received
 * (secrets masked); `history` holds the `SingleOrdHist` rows, newest first.
 */
export interface OfflineOrder {
  id: string;
  exchange: string;
  symbol: string;
  side: string;
  quantity: number;
  price: Decimal | null;
  triggerPrice: Decimal | null;
  orderType: string;
  product: string;
  status: string;
  filledQuantity: number;
  averagePrice: Decimal | null;
  rejectReason: string | null;
  payload: Wire;
  history: Wire[];
}

/** One REST call the broker received: the endpoint and its decoded payload (secrets masked). */
export interface OfflineRequest {
  readonly endpoint: string;
  readonly payload: Wire;
}

/** The instrument options of `addInstrument`. */
export interface AddInstrumentOptions {
  lotSize?: number;
  tickSize?: Numeric;
  /** Instrument type, `"EQ"` by default. */
  instrument?: string;
  expiry?: DayInput | null;
  strike?: Numeric | null;
  optionType?: string | null;
  underlying?: string | null;
  /** More wire keys of the instrument, e.g. `{ frzqty: 1801 }` (the freeze quantity). */
  extra?: Readonly<Record<string, unknown>>;
}

/** A candle as the test gives it: friendly names (`open`, `close` ...) or wire keys, and `time`. */
export type CandleInput = Readonly<Record<string, unknown>>;

function isWire(value: unknown): value is Wire {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mask(payload: Wire): Wire {
  return redactObject({ ...payload }) as Wire;
}

/** `value` as a finite Decimal (`null` when absent or blank); a `RangeError` otherwise. */
function numberOf(value: unknown, name: string): Decimal | null {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
    return null;
  }
  const number = replies.toDecimal(value);
  if (number === null)
    throw new RangeError(`${name} must be a number, got ${text(value, typeof value)}`);
  return number;
}

/** `value` as an integer; whole-number text such as `"10.0"` is accepted. */
function whole(value: unknown, name: string): number {
  const number = numberOf(value, name) ?? new D(0);
  if (!number.isInteger()) {
    throw new RangeError(`${name} must be a whole number, got ${text(value, typeof value)}`);
  }
  return number.toNumber();
}

function orderPrice(orderType: string, value: unknown): Decimal | null {
  return NO_PRICE.includes(orderType) ? null : numberOf(value, "prc");
}

function workingStatus(orderType: string): string {
  return orderType.startsWith("SL") ? "TRIGGER_PENDING" : "OPEN";
}

/**
 * `fields` with friendly names mapped to wire keys and values as wire text. An unknown name or a
 * value that must be a number and is not throws `RangeError`, so a typo in a test fails at once
 * instead of being served and ignored.
 */
function checked(
  fields: Readonly<Record<string, unknown>>,
  friendly: Readonly<Record<string, string>>,
  known: ReadonlyMap<string, boolean>,
  what: string,
): Wire {
  const wire: Wire = {};
  for (const [name, value] of Object.entries(fields)) {
    const key = Object.hasOwn(friendly, name) ? (friendly[name] as string) : name;
    const numeric = known.get(key);
    if (numeric === undefined) {
      throw new RangeError(
        `unknown ${what} field '${name}'; use ${Object.keys(friendly).join(", ")} or the API's names`,
      );
    }
    if (numeric) numberOf(value, name);
    wire[key] = replies.wireValue(value);
  }
  return wire;
}

export function quoteFields(fields: Readonly<Record<string, unknown>>): Wire {
  return checked(fields, replies.QUOTE_FIELDS, replies.QUOTE_WIRE, "quote");
}

function checkCandle(candle: CandleInput): void {
  const stamp = candle["time"];
  const ok =
    stamp === undefined ||
    stamp === null ||
    typeof stamp === "string" ||
    stamp instanceof Date ||
    (typeof stamp === "object" && "date" in stamp);
  if (!ok) {
    throw new RangeError(
      `candle time must be a Date, { date } or text, got ${text(stamp, typeof stamp)}`,
    );
  }
  if (stamp instanceof Date || (typeof stamp === "object" && stamp !== null)) {
    replies.dayOf(stamp as DayInput); // a bad Date or day text fails at once
  }
  const rest = Object.fromEntries(Object.entries(candle).filter(([key]) => key !== "time"));
  checked(rest, replies.CANDLE_FIELDS, replies.CANDLE_WIRE, "candle");
}

const money = replies.priceText;
const average = replies.averageText;

/** Derive the net, average and realised values of a position from its buy/sell totals. */
function recomputePosition(row: Wire): void {
  const qty = (key: string): number => whole(row[key], key);
  const amount = (key: string): Decimal => numberOf(row[key], key) ?? new D(0);
  const avg = (total: Decimal, count: number): Decimal => (count > 0 ? total.div(count) : new D(0));

  const buyQty = qty("cfbuyqty") + qty("daybuyqty");
  const sellQty = qty("cfsellqty") + qty("daysellqty");
  const buyAmt = amount("cfbuyamt").plus(amount("daybuyamt"));
  const sellAmt = amount("cfsellamt").plus(amount("daysellamt"));
  const buyAvg = avg(buyAmt, buyQty);
  const sellAvg = avg(sellAmt, sellQty);
  const net = buyQty - sellQty;
  const netAvg = net > 0 ? buyAvg : net < 0 ? sellAvg : new D(0);
  Object.assign(row, {
    netqty: String(net),
    netavgprc: average(netAvg),
    dayavgprc: average(netAvg),
    bep: average(netAvg),
    daybuyavgprc: average(avg(amount("daybuyamt"), qty("daybuyqty"))),
    daysellavgprc: average(avg(amount("daysellamt"), qty("daysellqty"))),
    cfbuyavgprc: average(avg(amount("cfbuyamt"), qty("cfbuyqty"))),
    cfsellavgprc: average(avg(amount("cfsellamt"), qty("cfsellqty"))),
    totbuyamt: money(buyAmt),
    totsellamt: money(sellAmt),
    totbuyavgprc: average(buyAvg),
    totsellavgprc: average(sellAvg),
    rpnl: money(realised(buyAmt, buyQty, sellAmt, sellQty)),
  });
}

// The reference computes in Python's default Decimal context (28 significant digits, half-even)
// and shows the realised profit without rounding it; the same context gives the same text.
const REFERENCE_DECIMAL = Decimal.clone({
  precision: 28,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -30,
  toExpPos: 40,
});

function realised(buyAmt: Decimal, buyQty: number, sellAmt: Decimal, sellQty: number): Decimal {
  const avg = (total: Decimal, count: number): Decimal =>
    count > 0 ? new REFERENCE_DECIMAL(total).div(count) : new REFERENCE_DECIMAL(0);
  return avg(sellAmt, sellQty).minus(avg(buyAmt, buyQty)).times(Math.min(buyQty, sellQty));
}

const PRODUCT_NAMES = Object.keys(Product) as (keyof typeof Product)[];

/** The API's product code for a product name the client accepts (`"MIS"`) or a code. */
function productCode(value: unknown): string {
  const given = text(value);
  for (const name of PRODUCT_NAMES) {
    if (Product[name] === given || name === given) return Product[name];
  }
  throw new RangeError(
    `unknown product '${given}'; use ${PRODUCT_NAMES.join(", ")} or the API's code`,
  );
}

/** Check a test-given position row: quantities become whole-number text, amounts must parse. */
function normalisePosition(values: Wire): void {
  if ("prd" in values) values["prd"] = productCode(values["prd"]);
  for (const key of replies.POSITION_QTY) {
    if (key in values) values[key] = String(whole(values[key], key));
  }
  for (const key of replies.POSITION_AMOUNT) {
    if (key in values) numberOf(values[key], key);
  }
}

const keyOf = (exchange: string, token: string): string => `${exchange}\u0000${token}`;

/** Everything the offline broker knows; the test drives it, the strategy reads it. */
export class BrokerState {
  readonly clientId: string;
  defaultPlace: string = "open";
  defaultRejectMessage = "RMS:Rejected by OfflineBroker";
  readonly orders: OfflineOrder[] = [];
  readonly requests: OfflineRequest[] = [];
  trades: Wire[] = [];
  positions: Wire[] = [];
  readonly instruments = new Map<string, Wire>();
  readonly quotes = new Map<string, Wire>();
  readonly candles = new Map<string, Wire[]>();
  readonly funds: Wire = {};
  holdings: Wire[] = [];
  readonly user: Wire = {};
  readonly replies = new Map<string, unknown>();
  /** Pending GTTs (wire payloads plus `al_id`), in placement order. */
  gtts: Wire[] = [];
  /** Triggered GTTs with the time they fired (`norentm`, a `Date`). */
  triggeredGtts: Wire[] = [];
  /** Cancelled OCOs: `GetTrgOi` lists them with the row `stat` `CANCELLED` (F32, F35). */
  cancelledOcos: Wire[] = [];

  readonly #drills = new Map<string, Drill[]>();
  readonly #listeners: Listener[] = [];
  readonly #outbox: Wire[] = [];
  #draining = false;
  readonly #day: string;
  #orderSeq = 0;
  #fillSeq = 0;
  #gttSeq = 0;
  readonly #filledValue = new Map<string, Decimal>();

  /** The next stream connect-acknowledgement is `Not_Ok` (a drill; clears itself). */
  refuseLoginOnce = false;
  /** Stream heartbeats get no reply (a drill). */
  silenced = false;
  readonly #log: Logger;

  constructor(clientId = "OFFLINE01", log: Logger = noopLogger) {
    this.#log = makeLog(log, "tradesmart");
    this.clientId = clientId;
    this.#day = replies.idDay(new Date());
  }

  // --- setup ---------------------------------------------------------------------------

  addInstrument(exchange: string, token: string, symbol: string, o: AddInstrumentOptions): void {
    const row = replies.instrumentRow(exchange, token, symbol, {
      lotSize: o.lotSize ?? 1,
      tickSize: o.tickSize ?? "0.05",
      instrument: o.instrument ?? "EQ",
      expiry: o.expiry ?? null,
      strike: o.strike ?? null,
      optionType: o.optionType ?? null,
      underlying: o.underlying ?? null,
      extra: o.extra ?? {},
    });
    this.instruments.set(keyOf(exchange, token), row);
  }

  /** The instrument row with this trading symbol, or `null`. */
  findInstrument(exchange: string, symbol: string): Wire | null {
    for (const row of this.instruments.values()) {
      if (row["exch"] === exchange && row["tsym"] === symbol) return row;
    }
    return null;
  }

  setQuote(exchange: string, token: string, fields: Readonly<Record<string, unknown>>): void {
    const wire = quoteFields(fields);
    const key = keyOf(exchange, token);
    this.quotes.set(key, { ...this.quotes.get(key), ...wire });
  }

  /** Update the quote and push the change as touchline (`tf`) and depth (`df`) feeds. */
  tick(exchange: string, token: string, fields: Readonly<Record<string, unknown>>): void {
    const wire = quoteFields(fields);
    const key = keyOf(exchange, token);
    this.quotes.set(key, { ...this.quotes.get(key), ...wire });
    const now = new Date();
    this.#outbox.push(
      replies.touchlineFeed(exchange, token, wire, now),
      replies.depthFeed(exchange, token, wire, now),
    );
    this.drain();
  }

  /** The instrument row and the quote fields stored for `exchange|token` (copies). */
  snapshotOf(exchange: string, token: string): { instrument: Wire | null; fields: Wire } {
    const key = keyOf(exchange, token);
    const instrument = this.instruments.get(key);
    return {
      instrument: instrument === undefined ? null : { ...instrument },
      fields: { ...this.quotes.get(key) },
    };
  }

  /** The `GetQuotes` reply for an instrument, or `null` if no quote was set. */
  quote(exchange: string, token: string): Wire | null {
    const key = keyOf(exchange, token);
    const fields = this.quotes.get(key);
    if (fields === undefined) return null;
    return replies.quote(exchange, token, this.instruments.get(key) ?? null, fields, new Date());
  }

  /** An unknown field name or a non-number value throws before any candle changes. */
  setCandles(exchange: string, token: string, candles: Iterable<CandleInput>): void {
    const given = [...candles].map((candle) =>
      Object.fromEntries(
        Object.entries(candle).map(([k, v]) => [k, k === "time" ? v : replies.wireValue(v)]),
      ),
    );
    for (const candle of given) checkCandle(candle);
    this.candles.set(keyOf(exchange, token), given);
  }

  setFunds(wire: Readonly<Record<string, unknown>>): void {
    for (const [key, value] of Object.entries(wire)) this.funds[key] = replies.wireValue(value);
  }

  setHoldings(rows: Iterable<Readonly<Record<string, unknown>>>): void {
    this.holdings = [...rows].map((row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, replies.wireValue(v)])),
    );
  }

  /**
   * The starting positions (wire keys; at least `exch`, `tsym`, `prd`). A row with only `netqty` /
   * `netavgprc` is carried forward as a buy or sell. Anything invalid throws before any position
   * changes.
   */
  setPositions(rows: Iterable<Readonly<Record<string, unknown>>>): void {
    const positions: Wire[] = [];
    for (const given of rows) {
      const values: Wire = {};
      for (const [k, v] of Object.entries(given)) values[k] = replies.wireValue(v);
      normalisePosition(values);
      const row = this.#newPosition(
        text(values["exch"]),
        text(values["tsym"]),
        text(values["prd"]),
      );
      Object.assign(row, values);
      const carried = ["cfbuyqty", "cfsellqty", "daybuyqty", "daysellqty"];
      const net = whole(values["netqty"], "netqty");
      if (net !== 0 && !carried.some((key) => key in values)) {
        const side = net > 0 ? "buy" : "sell";
        const price = numberOf(values["netavgprc"], "netavgprc") ?? new D(0);
        row[`cf${side}qty`] = String(Math.abs(net));
        row[`cf${side}amt`] = money(price.times(Math.abs(net)));
      }
      recomputePosition(row);
      positions.push(row);
    }
    this.positions = positions;
  }

  setUser(wire: Readonly<Record<string, unknown>>): void {
    for (const [key, value] of Object.entries(wire)) this.user[key] = replies.wireValue(value);
  }

  setReply(endpoint: string, body: unknown): void {
    this.replies.set(endpoint, structuredClone(body));
  }

  // --- requests and drills -------------------------------------------------------------

  /** Record a REST call (secrets masked). */
  record(endpoint: string, payload: Wire): OfflineRequest {
    const request: OfflineRequest = Object.freeze({ endpoint, payload: mask(payload) });
    this.requests.push(request);
    return request;
  }

  /** Arm `drill` for the next call of `endpoint` (drills queue up per endpoint). */
  failNext(endpoint: string, drill: Drill): void {
    if (!isDrill(drill)) {
      throw new TypeError(
        "failNext needs a drill such as drills.reject('...') (call the function), not " +
          String(drill),
      );
    }
    const queue = this.#drills.get(endpoint) ?? [];
    queue.push(drill);
    this.#drills.set(endpoint, queue);
  }

  /** Remove and return the next drill armed for `endpoint`, or `null`. */
  takeDrill(endpoint: string): Drill | null {
    return this.#drills.get(endpoint)?.shift() ?? null;
  }

  // --- events --------------------------------------------------------------------------

  /** Call `fn` with every stream message (`om`, `pm`, and in Task 8 `tf`, `df`). */
  addListener(fn: Listener): void {
    this.#listeners.push(fn);
  }

  /** Queue a stream message for delivery by `drain()`. */
  enqueue(message: Wire): void {
    this.#outbox.push(message);
  }

  /**
   * Deliver queued events one by one, in the order the changes were made. A change made by a
   * listener is queued behind the events already waiting and delivered after them (a nested call
   * returns at once; the running drain delivers it).
   */
  drain(): void {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (let event = this.#outbox.shift(); event !== undefined; event = this.#outbox.shift()) {
        for (const fn of [...this.#listeners]) {
          try {
            fn(event);
          } catch (error) {
            // A failing listener never stops the broker or the other listeners; it is logged.
            const reason = error instanceof Error ? error.message : String(error);
            this.#log.debug(
              `OfflineBroker stream listener failed on a '${text(event["t"])}' message: ${reason}`,
            );
          }
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  // --- orders: strategy side -----------------------------------------------------------

  /** Book a new order as `defaultPlace` says (`open`, `pending` or `reject`). */
  place(payload: Wire): OfflineOrder {
    const order = this.#book(payload);
    this.drain();
    return order;
  }

  #book(payload: Wire): OfflineOrder {
    const orderType = text(payload["prctyp"]);
    for (const leg of ["blprc", "bpprc", "trailprc"]) numberOf(payload[leg], leg);
    const order: OfflineOrder = {
      id: `${this.#day}${String(this.#orderSeq + 1).padStart(8, "0")}`,
      exchange: text(payload["exch"]),
      symbol: text(payload["tsym"]),
      side: text(payload["trantype"]),
      quantity: whole(payload["qty"], "qty"),
      price: orderPrice(orderType, payload["prc"]),
      triggerPrice: numberOf(payload["trgprc"], "trgprc"),
      orderType,
      product: text(payload["prd"]),
      status: "PENDING",
      filledQuantity: 0,
      averagePrice: null,
      rejectReason: null,
      payload: mask(payload),
      history: [],
    };
    const now = new Date();
    const steps = [this.#rows(order, "NewAck", now)];
    let final: Partial<OfflineOrder> = {};
    if (this.defaultPlace === "open") {
      final = { status: workingStatus(orderType) };
      steps.push(this.#rows({ ...order, ...final }, "New", now));
    } else if (this.defaultPlace === "reject") {
      final = { status: "REJECTED", rejectReason: this.defaultRejectMessage };
      steps.push(this.#rows({ ...order, ...final }, "Rejected", now));
    }
    this.#orderSeq += 1;
    Object.assign(order, final);
    order.history = steps.map(([row]) => row).reverse();
    this.orders.push(order);
    for (const [, message] of steps) this.#outbox.push(message);
    return order;
  }

  /** Apply a `ModifyOrder`: `[true, order id]` or `[false, reason]`. */
  modify(payload: Wire): [boolean, string] {
    const orderId = text(payload["norenordno"]);
    const order = this.#find(orderId);
    if (order === null) return [false, "Order not found to Modify"];
    if (!(OPEN_STATES as readonly string[]).includes(order.status)) {
      return [false, "order is not open to modify"];
    }
    const orderType = text(payload["prctyp"], order.orderType);
    const changes: Partial<OfflineOrder> = { orderType };
    if ("qty" in payload) {
      const quantity = whole(payload["qty"], "qty");
      if (quantity <= order.filledQuantity) {
        return [
          false,
          `quantity must be more than the filled quantity ${String(order.filledQuantity)}`,
        ];
      }
      changes.quantity = quantity;
    }
    if ("prc" in payload || NO_PRICE.includes(orderType)) {
      changes.price = orderPrice(orderType, payload["prc"]);
    }
    if ("trgprc" in payload) changes.triggerPrice = numberOf(payload["trgprc"], "trgprc");
    else if (!orderType.startsWith("SL")) changes.triggerPrice = null;
    if (orderType !== order.orderType && order.status !== "PENDING") {
      changes.status = workingStatus(orderType);
    }
    this.#update(order, "Replaced", changes);
    this.drain();
    return [true, orderId];
  }

  /** Apply a `CancelOrder`: `[true, order id]` or `[false, reason]`. */
  cancelRequest(orderId: string): [boolean, string] {
    const order = this.#find(orderId);
    if (order === null) return [false, "Order not found to Cancel"];
    if (!(OPEN_STATES as readonly string[]).includes(order.status)) {
      return [false, "order is not open to cancel"];
    }
    this.#update(order, "Canceled", { status: "CANCELED" });
    this.drain();
    return [true, orderId];
  }

  /**
   * Apply an `ExitSNOOrder`: `[true, order id]` or `[false, reason]`. Only a cover (`H`) or
   * bracket (`B`) order can be exited (documented); the broker cancels it (assumed: it models no
   * SNO legs, so the test fills any square-off itself).
   */
  exitRequest(orderId: string): [boolean, string] {
    const order = this.#find(orderId);
    if (order === null) return [false, "Order not found to Exit"];
    if (!EXITABLE.includes(order.product)) return [false, "order is not a cover or bracket order"];
    if (!(OPEN_STATES as readonly string[]).includes(order.status)) {
      return [false, "order is not open to exit"];
    }
    this.#update(order, "Canceled", { status: "CANCELED" });
    this.drain();
    return [true, orderId];
  }

  // --- GTTs ----------------------------------------------------------------------------

  /** The GTT's fields from a Place / Modify payload; `RangeError` if one is unusable. */
  static #gttFields(payload: Wire): Wire {
    const missing = GTT_FIELDS.filter((key) => text(payload[key]).trim() === "");
    if (missing.length > 0) throw new RangeError(`${missing.join(", ")} required`);
    numberOf(payload["d"], "d");
    numberOf(payload["prc"], "prc");
    numberOf(payload["trgprc"], "trgprc");
    whole(payload["qty"], "qty");
    return Object.fromEntries(
      Object.entries(mask(payload)).filter(([key]) => key !== "uid" && key !== "al_id"),
    );
  }

  /** Store a `PlaceGTTOrder` as a pending GTT and return its alert id. */
  placeGtt(payload: Wire): string {
    const fields = BrokerState.#gttFields(payload);
    this.#gttSeq += 1;
    const alertId = `${this.#day}${String(this.#gttSeq).padStart(8, "0")}`;
    this.gtts.push({ al_id: alertId, ...fields });
    return alertId;
  }

  /** Apply a `ModifyGTTOrder`: `[true, alert id]` or `[false, reason]`. */
  modifyGtt(payload: Wire): [boolean, string] {
    const alertId = text(payload["al_id"]);
    const fields = BrokerState.#gttFields(payload);
    const gtt = this.#pendingGtt(alertId);
    if (gtt === null || isOcoRow(gtt)) return [false, "GTT not found to Modify"];
    if (fields["ai_t"] !== gtt["ai_t"]) return [false, "ai_t cannot be modified"]; // documented
    this.gtts[this.gtts.indexOf(gtt)] = { al_id: alertId, ...fields };
    return [true, alertId];
  }

  /** Apply a `CancelGTTOrder`: `[true, alert id]` or `[false, reason]`. */
  cancelGtt(alertId: string): [boolean, string] {
    const gtt = this.#pendingGtt(alertId);
    if (gtt === null || isOcoRow(gtt)) return [false, "GTT not found to Cancel"];
    this.gtts.splice(this.gtts.indexOf(gtt), 1);
    return [true, alertId];
  }

  /**
   * Fire a pending GTT: place its order (`add_ord_id` = the alert id) as `place` does, list the GTT
   * as triggered and return the new order id.
   */
  triggerGtt(alertId: string): string {
    const gtt = this.#pendingGtt(alertId);
    if (gtt !== null && isOcoRow(gtt)) throw new Error(OCO_NOT_TRIGGERED);
    if (gtt === null) throw new RangeError(`no pending GTT with alert id '${alertId}'`);
    const orderPayload: Wire = {};
    for (const key of GTT_ORDER_FIELDS) if (key in gtt) orderPayload[key] = gtt[key];
    Object.assign(orderPayload, { uid: this.clientId, actid: this.clientId, add_ord_id: alertId });
    const order = this.#book(orderPayload); // checks first: a failure changes nothing
    this.gtts.splice(this.gtts.indexOf(gtt), 1);
    this.triggeredGtts.push({ ...gtt, norentm: new Date() });
    this.drain();
    return order.id;
  }

  // --- OCOs (stored beside the GTTs, in `gtts`) -----------------------------------------

  /** The OCO's fields from a Place / Modify payload; `RangeError` if one is unusable. */
  static #ocoFields(payload: Wire): Wire {
    // The checks and messages of the reference broker, in its order, one problem at a time.
    const missing = OCO_FIELDS.filter((key) => text(payload[key]).trim() === "");
    if (missing.length > 0) throw new RangeError(`${missing.join(", ")} required`);
    if (!OCO_ALERT_TYPES.includes(text(payload["ai_t"]))) {
      throw new RangeError(`ai_t must be one of ${OCO_ALERT_TYPES.join(", ")}`);
    }
    const triggers = payload["oivariable"];
    const noTriggers = "oivariable required: one trigger each for x and y";
    if (!Array.isArray(triggers) || triggers.length !== 2) throw new RangeError(noTriggers);
    const seen = new Set<unknown>();
    for (const item of triggers as unknown[]) {
      const slot = isWire(item) ? item : null;
      const name = slot?.["var_name"];
      const number = slot === null ? null : numberOf(slot["d"], "d");
      if ((name !== "x" && name !== "y") || seen.has(name) || number === null) {
        throw new RangeError(noTriggers);
      }
      seen.add(name);
    }
    for (const key of OCO_LEGS) {
      const leg = payload[key];
      if (!isWire(leg)) throw new RangeError(`${key} required`);
      const absent = OCO_LEG_FIELDS.filter((field) => text(leg[field]).trim() === "");
      if (absent.length > 0) throw new RangeError(`${key}: ${absent.join(", ")} required`);
      numberOf(leg["prc"], "prc");
      numberOf(leg["trgprc"], "trgprc");
      whole(leg["qty"], "qty");
    }
    return Object.fromEntries(
      Object.entries(mask(payload)).filter(([key]) => key !== "uid" && key !== "al_id"),
    );
  }

  /** Store a `PlaceOCOOrder` as a pending OCO and return its alert id. */
  placeOco(payload: Wire): string {
    const fields = BrokerState.#ocoFields(payload);
    this.#gttSeq += 1;
    const alertId = `${this.#day}${String(this.#gttSeq).padStart(8, "0")}`;
    this.gtts.push({ al_id: alertId, ...fields, norentm: new Date() });
    return alertId;
  }

  /** Apply a `ModifyOCOOrder`: `true` when the alert is a pending OCO (`Invalid Oi` otherwise). */
  modifyOco(payload: Wire): boolean {
    const alertId = text(payload["al_id"]);
    const fields = BrokerState.#ocoFields(payload);
    const oco = this.#pendingGtt(alertId);
    if (oco === null || !isOcoRow(oco)) return false;
    this.gtts[this.gtts.indexOf(oco)] = { al_id: alertId, ...fields, norentm: oco["norentm"] };
    return true;
  }

  /** Apply a `CancelOCOOrder`: `true` when the alert is a pending OCO (`Invalid Oi` otherwise). */
  cancelOco(alertId: string): boolean {
    const oco = this.#pendingGtt(alertId);
    if (oco === null || !isOcoRow(oco)) return false;
    this.gtts.splice(this.gtts.indexOf(oco), 1);
    this.cancelledOcos.push(oco);
    return true;
  }

  #pendingGtt(alertId: string): Wire | null {
    return this.gtts.find((gtt) => gtt["al_id"] === alertId) ?? null;
  }

  // --- orders: test side ---------------------------------------------------------------

  /** PENDING -> OPEN (TRIGGER_PENDING for a stop order). */
  accept(orderId: string): void {
    const order = this.#require(orderId, ["PENDING"], "accept");
    this.#update(order, "New", { status: workingStatus(order.orderType) });
    this.drain();
  }

  /** Reject an open order with `message` as the reason. */
  reject(orderId: string, message: string): void {
    const order = this.#require(orderId, OPEN_STATES, "reject");
    this.#update(order, "Rejected", { status: "REJECTED", rejectReason: message });
    this.drain();
  }

  /** Cancel an open order (as the exchange would). */
  cancel(orderId: string): void {
    const order = this.#require(orderId, OPEN_STATES, "cancel");
    this.#update(order, "Canceled", { status: "CANCELED" });
    this.drain();
  }

  /** TRIGGER_PENDING -> OPEN. */
  trigger(orderId: string): void {
    const order = this.#require(orderId, ["TRIGGER_PENDING"], "trigger");
    this.#update(order, "New", { status: "OPEN" });
    this.drain();
  }

  /** Fill `quantity` (default: all that is open) at `price`; partials accumulate. */
  fill(orderId: string, price: Numeric, quantity?: number): void {
    const order = this.#require(orderId, FILLABLE, "fill");
    const remaining = order.quantity - order.filledQuantity;
    const count = quantity ?? remaining;
    if (!Number.isInteger(count) || count < 1 || count > remaining) {
      throw new RangeError(`fill quantity must be 1 to ${String(remaining)}, got ${String(count)}`);
    }
    const fillPrice = numberOf(price, "price");
    if (fillPrice === null) throw new RangeError("fill needs a price");
    const filled = order.filledQuantity + count;
    const value = (this.#filledValue.get(order.id) ?? new D(0)).plus(fillPrice.times(count));
    const changes: Partial<OfflineOrder> = {
      filledQuantity: filled,
      averagePrice: value.div(filled),
      status: filled === order.quantity ? "COMPLETE" : "OPEN",
    };
    const fillId = String(this.#fillSeq + 1);
    const now = new Date();
    const filledOrder = { ...order, ...changes };
    const [row, om] = this.#rows(filledOrder, "Fill", now, {
      id: fillId,
      quantity: count,
      price: fillPrice,
    });
    const trade = replies.tradeRow(
      filledOrder,
      this.clientId,
      this.findInstrument(order.exchange, order.symbol),
      now,
      fillId,
      count,
      fillPrice,
    );
    const [existing, position] = this.#positionAfterFill(order, count, fillPrice);
    const pm = replies.positionUpdate(position);
    // Everything is computed: apply it.
    this.#fillSeq += 1;
    this.#filledValue.set(order.id, value);
    Object.assign(order, changes);
    order.history.unshift(row);
    this.trades.push(trade);
    if (existing === null) this.positions.push(position);
    else this.positions[this.positions.indexOf(existing)] = position;
    this.#outbox.push(om, pm);
    this.drain();
  }

  // --- helpers -------------------------------------------------------------------------

  #find(orderId: string): OfflineOrder | null {
    return this.orders.find((order) => order.id === orderId) ?? null;
  }

  #require(orderId: string, states: readonly string[], action: string): OfflineOrder {
    const order = this.#find(orderId);
    if (order === null) throw new RangeError(`no order with id '${orderId}'`);
    if (!states.includes(order.status)) {
      throw new RangeError(
        `cannot ${action} order ${orderId}: it is ${order.status}, not ${states.join(" or ")}`,
      );
    }
    return order;
  }

  /** The history row and the `om` message for the order in this state (no change made). */
  #rows(
    order: OfflineOrder,
    report: string,
    when: Date,
    fill: replies.FillInfo | null = null,
  ): [Wire, Wire] {
    const instrument = this.findInstrument(order.exchange, order.symbol);
    return [
      replies.historyRow(order, this.clientId, instrument, when, report),
      replies.orderUpdate(order, this.clientId, when, report, fill),
    ];
  }

  /** Build the rows for `changes` first, then apply them and queue the `om`. */
  #update(order: OfflineOrder, report: string, changes: Partial<OfflineOrder>): void {
    const [row, message] = this.#rows({ ...order, ...changes }, report, new Date());
    Object.assign(order, changes);
    order.history.unshift(row);
    this.#outbox.push(message);
  }

  #newPosition(exchange: string, symbol: string, product: string): Wire {
    const instrument = this.findInstrument(exchange, symbol);
    const token = typeof instrument?.["token"] === "string" ? instrument["token"] : "";
    return replies.positionRow(this.clientId, exchange, token, symbol, product, instrument);
  }

  /** The order's position row (or `null` if new) and its new values; nothing changed. */
  #positionAfterFill(order: OfflineOrder, count: number, price: Decimal): [Wire | null, Wire] {
    const existing =
      this.positions.find(
        (r) =>
          r["exch"] === order.exchange && r["tsym"] === order.symbol && r["prd"] === order.product,
      ) ?? null;
    const row =
      existing === null
        ? this.#newPosition(order.exchange, order.symbol, order.product)
        : { ...existing };
    const side = order.side === "B" ? "buy" : "sell";
    const qtyKey = `day${side}qty`;
    const amountKey = `day${side}amt`;
    row[qtyKey] = String(whole(row[qtyKey], qtyKey) + count);
    const amount = new D(row[amountKey] as string);
    row[amountKey] = money(amount.plus(price.times(count)));
    recomputePosition(row);
    return [existing, row];
  }
}
