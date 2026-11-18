// The offline broker's REST side: an in-memory undici `Dispatcher` (Python: testing/_rest.py).
// Every call stays in the process: no socket is opened. `POST {OFFLINE_BASE_URL}/{Endpoint}` is
// answered from a `BrokerState`, and `GET {OFFLINE_SCRIPT_MASTER_URL}/{EXCH}_symbols.txt.zip` with
// a script master built from the added instruments. The URLs use the reserved `.invalid` host,
// so a client that is not wired to this dispatcher can never reach a real server.
import { STATUS_CODES } from "node:http";
import { Dispatcher, errors } from "undici";
import { strToU8, zipSync } from "fflate";
import { nextIstSixAm } from "../auth.js";
import type { ClientConfigInit } from "../config.js";
import { D, Decimal } from "../lib/decimal.js";
import { IST_OFFSET_MS } from "../lib/time.js";
import { Exchange } from "../enums.js";
import type { Drill } from "./drills.js";
import * as replies from "./replies.js";
import { text } from "./replies.js";
import type { Wire } from "./replies.js";
import { PLACE_MODES, type BrokerState } from "./state.js";

export const OFFLINE_HOST = "offline.tradesmart.invalid";
export const OFFLINE_BASE_URL = "https://offline.tradesmart.invalid/NorenWClientAPIv2";
export const OFFLINE_SCRIPT_MASTER_URL = "https://offline.tradesmart.invalid";
export const OFFLINE_AUTHORIZE_URL = "https://offline.tradesmart.invalid/authorize";

export const NO_DATA = 'Error Occurred : 5 "no data"';
export const SESSION_EXPIRED = "Session Expired :  Invalid Session Key"; // documented text (two spaces)
// The smallest backoff the SDK accepts: retries and stream reconnects keep their production
// count but never sleep (a `Retry-After` is clamped to the cap); only the order rate limit waits.
const NO_WAIT = 0.001;
// Streams send a heartbeat this often and detect a silent server after twice as long (1 s).
const HEARTBEAT = 0.5;
const BASE_PATH = "/NorenWClientAPIv2/";
const ZIP_SUFFIX = "_symbols.txt.zip";
// Script-master columns (the layout the SDK's instrument and option helpers read) and the
// instrument-row key each one comes from. The BFO file names `StrikePrice` `Strike`.
const SCRIPT_MASTER_COLUMNS: readonly (readonly [string, string])[] = [
  ["Exchange", "exch"],
  ["Token", "token"],
  ["LotSize", "ls"],
  ["Symbol", "symname"],
  ["TradingSymbol", "tsym"],
  ["Expiry", "exd"],
  ["Instrument", "instname"],
  ["OptionType", "optt"],
  ["StrikePrice", "strprc"],
  ["TickSize", "ti"],
];

/**
 * The client settings that point a client at the offline broker. Reads are retried as in
 * production (`maxRetries`) but the backoff is 1 ms, so a retried drill costs no real time; pass
 * `maxRetries: 0` to see a read drill's error. Streams reconnect after 1 ms and send a heartbeat
 * every 0.5 s, so a silent server is detected in about 1 s.
 */
export function offlineConfig(wsUrl: string, overrides: ClientConfigInit): ClientConfigInit {
  return {
    baseUrl: OFFLINE_BASE_URL,
    authorizeUrl: OFFLINE_AUTHORIZE_URL,
    scriptMasterBaseUrl: OFFLINE_SCRIPT_MASTER_URL,
    wsUrl,
    backoffBase: NO_WAIT,
    backoffCap: NO_WAIT,
    reconnectBackoffBase: NO_WAIT,
    reconnectBackoffCap: NO_WAIT,
    heartbeatInterval: HEARTBEAT,
    ...overrides,
  };
}

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

const encoder = new TextEncoder();

function json(body: unknown, status = 200): Reply {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: encoder.encode(JSON.stringify(body)),
  };
}

function notOk(message: string, now: Date, status = 200): Reply {
  return json(replies.notOk(message, now), status);
}

/** The `jData` JSON object of a form body, or `null` if there is none. */
function decode(content: Uint8Array): Wire | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
  for (const part of text.split("&")) {
    if (!part.startsWith("jData=")) continue;
    try {
      const data: unknown = JSON.parse(decodeURIComponent(part.slice("jData=".length)));
      return typeof data === "object" && data !== null && !Array.isArray(data)
        ? (data as Wire)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

const INTEGER_TEXT = /^[+-]?\d+$/;

/** A range bound in epoch seconds (`null` when absent); `RangeError` if not a whole number. */
function bound(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const raw = text(value).trim();
  if (raw === "") return null;
  if (!INTEGER_TEXT.test(raw)) throw new RangeError("not a whole number");
  return Number(raw);
}

/** A candle's `ssboe` in epoch seconds, or `null` when it has none (blank or `0`). */
function candleEpoch(row: Wire): number | null {
  const raw = text(row["ssboe"]).trim();
  const number = replies.toDecimal(raw === "" ? "0" : raw) ?? new D(0);
  return number.trunc().toNumber() || null;
}

const DAY_MS = 86_400_000;

/** The day of a daily candle (its `ssboe` is 00:00 UTC of that day) as a day number, or `null`. */
function candleDay(row: Wire): number | null {
  const at = candleEpoch(row);
  return at === null ? null : Math.floor(at / 86_400);
}

/** The IST day number of an epoch-seconds bound. */
const istDayOf = (seconds: number): number => Math.floor((seconds * 1000 + IST_OFFSET_MS) / DAY_MS);

/**
 * The rows whose `moment` is within `first`..`last` (both included; `null` is open), newest
 * first. Rows without a time are always kept, after the others, in order.
 */
function newestFirst(
  rows: Wire[],
  first: number | null,
  last: number | null,
  moment: (row: Wire) => number | null,
): Wire[] {
  const timed: [number, Wire][] = [];
  const untimed: Wire[] = [];
  for (const row of rows) {
    const at = moment(row);
    if (at === null) untimed.push(row);
    else if ((first === null || at >= first) && (last === null || at <= last))
      timed.push([at, row]);
  }
  timed.sort((a, b) => b[0] - a[0]); // stable: equal times keep their order
  return [...timed.map(([, row]) => row), ...untimed];
}

/** An HTML error page, as a gateway or proxy sends it (not JSON). */
function gatewayPage(status: number, title?: string): Reply {
  const heading = title ?? `${String(status)} ${statusText(status)}`.trim();
  return {
    status,
    headers: { "content-type": "text/html" },
    body: encoder.encode(`<html><body><h1>${heading}</h1></body></html>`),
  };
}

/** The reply of an armed drill (`connectError` / `timeoutAfterSend` raise instead). */
function drillReply(drill: Drill, now: Date): Reply {
  switch (drill.kind) {
    case "reject":
      return notOk(drill.message || "Rejected by OfflineBroker", now);
    case "rate_limit": {
      const reply = notOk("Too many requests", now, 429);
      if (drill.retryAfter !== null) reply.headers["retry-after"] = String(drill.retryAfter);
      return reply;
    }
    case "server_error": {
      const status = drill.status;
      return drill.json ? notOk("Internal Server Error", now, status) : gatewayPage(status);
    }
    case "bad_body":
      return gatewayPage(200, "502 Bad Gateway");
    case "session_expired":
      return notOk(SESSION_EXPIRED, now, 401);
    default:
      throw new RangeError(`unknown drill kind '${drill.kind}'`);
  }
}

type Route = (payload: Wire, now: Date) => Reply;

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Maps one HTTP request to the broker state. */
class Handler {
  readonly #state: BrokerState;
  readonly #routes: ReadonlyMap<string, Route>;

  constructor(state: BrokerState) {
    this.#state = state;
    this.#routes = new Map<string, Route>([
      ["GenAcsTok", (p, n) => this.#genAcsTok(p, n)],
      ["UserDetails", (p, n) => this.#userDetails(p, n)],
      ["Limits", (p, n) => this.#limits(p, n)],
      ["Holdings", () => this.#holdings()],
      ["PositionBook", (p, n) => this.#positions(p, n)],
      ["OrderBook", (p, n) => this.#orderBook(p, n)],
      ["SingleOrdHist", (p, n) => this.#orderHistory(p, n)],
      ["TradeBook", (p, n) => this.#tradeBook(p, n)],
      ["PlaceOrder", (p, n) => this.#place(p, n)],
      ["ModifyOrder", (p, n) => this.#modify(p, n)],
      ["CancelOrder", (p, n) => this.#cancel(p, n)],
      ["ExitSNOOrder", (p, n) => this.#exit(p, n)],
      ["PlaceGTTOrder", (p, n) => this.#placeGtt(p, n)],
      ["ModifyGTTOrder", (p, n) => this.#modifyGtt(p, n)],
      ["CancelGTTOrder", (p, n) => this.#cancelGtt(p, n)],
      ["GetPendingGTTOrder", (p, n) => this.#pendingGtts(p, n)],
      ["GetTrgOi", (p, n) => this.#triggeredGtts(p, n)],
      ["GetEnabledGTTs", (p, n) => json(replies.enabledGtts(n))],
      ["GetQuotes", (p, n) => this.#quote(p, n)],
      ["SearchScrip", (p, n) => this.#search(p, n)],
      ["GetSecurityInfo", (p, n) => this.#securityInfo(p, n)],
      ["GetOptionChain", (p, n) => this.#optionChain(p, n)],
      ["TPSeries", (p, n) => this.#tpSeries(p, n)],
      ["EODChartData", (p, n) => this.#eod(p, n)],
    ]);
  }

  handle(method: string, url: URL, body: Uint8Array): Reply {
    if (url.hostname === OFFLINE_HOST) {
      if (method === "POST" && url.pathname.startsWith(BASE_PATH)) {
        return this.#rest(body, url.pathname.slice(BASE_PATH.length));
      }
      if (method === "GET" && url.pathname.endsWith(ZIP_SUFFIX)) {
        return this.#scriptMaster(url.pathname.slice(1, -ZIP_SUFFIX.length));
      }
    }
    return {
      status: 404,
      headers: { "content-type": "text/plain" },
      body: encoder.encode("Not Found"),
    };
  }

  // --- REST ----------------------------------------------------------------------------

  #rest(content: Uint8Array, endpoint: string): Reply {
    const state = this.#state;
    const now = new Date();
    const payload = decode(content);
    if (payload === null) {
      // The SDK never sends this; an armed drill stays armed.
      state.record(endpoint, {});
      return notOk("Invalid Input : jData is not a JSON object", now);
    }
    const drill = state.takeDrill(endpoint);
    if (drill?.kind === "connect_error") {
      throw Object.assign(new Error("OfflineBroker drill: connect_error"), {
        code: "ECONNREFUSED",
        syscall: "connect",
        errno: -111,
      });
    }
    state.record(endpoint, payload);
    if (drill === null) return this.#dispatch(endpoint, payload, now);
    if (drill.kind === "timeout_after_send") {
      this.#dispatch(endpoint, payload, now); // the call takes effect; the reply is lost
      throw new errors.HeadersTimeoutError("OfflineBroker drill: timeout_after_send");
    }
    return drillReply(drill, now);
  }

  #dispatch(endpoint: string, payload: Wire, now: Date): Reply {
    if (this.#state.replies.has(endpoint)) {
      return json(structuredClone(this.#state.replies.get(endpoint)));
    }
    const route = this.#routes.get(endpoint);
    if (route === undefined) {
      return notOk(
        `OfflineBroker does not model ${endpoint}; set a reply with broker.setReply(...)`,
        now,
      );
    }
    return route(payload, now);
  }

  // --- login and account ---------------------------------------------------------------

  #genAcsTok(_payload: Wire, now: Date): Reply {
    const uid = this.#state.clientId;
    const uname = text(this.#state.user["uname"], "Offline User");
    const token = `offline-token-${randomHex()}`;
    return json({
      USERID: uid,
      access_token: token,
      expires_in: String(Math.floor(nextIstSixAm(now).getTime() / 1000)),
      refresh_token: `offline-refresh-${randomHex()}`,
      scope: "0",
      actid: uid,
      uname,
      prarr: [],
      exch_prd: [],
      stat: "Ok",
      susertoken: token,
      uid,
      brnchid: "HO",
      totp_set: "1",
      orarr: [],
      exarr: Object.values(Exchange),
      values: [],
      mws: {},
      brkname: "OFFLINE",
      lastaccesstime: String(Math.floor(now.getTime() / 1000)),
      lastpwdtime: "0",
    });
  }

  #userDetails(_payload: Wire, now: Date): Reply {
    return json(replies.userDetails(this.#state.clientId, { ...this.#state.user }, now));
  }

  #limits(_payload: Wire, now: Date): Reply {
    return json(replies.limits({ ...this.#state.funds }, now));
  }

  #holdings(): Reply {
    // Empty: `[]` (observed live).
    return json(this.#state.holdings.map((row) => replies.holdingRow(structuredClone(row))));
  }

  /** A book reply: the rows, or the documented "no data" `Not_Ok` when empty. */
  #rows(rows: Wire[], now: Date): Reply {
    return rows.length > 0 ? json(rows) : notOk(NO_DATA, now);
  }

  #positions(_payload: Wire, now: Date): Reply {
    return this.#rows(
      this.#state.positions.map((row) => ({ ...row })),
      now,
    );
  }

  // --- orders --------------------------------------------------------------------------

  #orderBook(_payload: Wire, now: Date): Reply {
    // newest first
    const rows = [...this.#state.orders].reverse().map((order) => replies.orderBookRow(order));
    return this.#rows(rows, now);
  }

  #orderHistory(payload: Wire, now: Date): Reply {
    const id = text(payload["norenordno"]);
    const rows = this.#state.orders
      .filter((order) => order.id === id)
      .flatMap((order) => order.history.map((row) => ({ ...row })));
    return this.#rows(rows, now);
  }

  #tradeBook(_payload: Wire, now: Date): Reply {
    return this.#rows(
      this.#state.trades.map((row) => ({ ...row })),
      now,
    );
  }

  #place(payload: Wire, now: Date): Reply {
    // A test misconfiguration, not a broker rejection.
    if (!(PLACE_MODES as readonly string[]).includes(this.#state.defaultPlace)) {
      throw new RangeError(
        `defaultPlace must be 'open', 'pending' or 'reject', not '${this.#state.defaultPlace}'`,
      );
    }
    try {
      return json(replies.placeAck(this.#state.place(payload).id, now));
    } catch (error) {
      return invalid(error, now);
    }
  }

  #modify(payload: Wire, now: Date): Reply {
    try {
      const [accepted, result] = this.#state.modify(payload);
      return accepted ? json(replies.orderAck(result, now)) : notOk(result, now);
    } catch (error) {
      return invalid(error, now);
    }
  }

  #cancel(payload: Wire, now: Date): Reply {
    const [accepted, result] = this.#state.cancelRequest(text(payload["norenordno"]));
    return accepted ? json(replies.orderAck(result, now)) : notOk(result, now);
  }

  #exit(payload: Wire, now: Date): Reply {
    const [accepted, result] = this.#state.exitRequest(text(payload["norenordno"]));
    return accepted ? json(replies.exitAck(now)) : notOk(result, now);
  }

  // --- GTT -----------------------------------------------------------------------------

  #placeGtt(payload: Wire, now: Date): Reply {
    try {
      return json(replies.gttAck("Oi created", this.#state.placeGtt(payload), now));
    } catch (error) {
      return invalid(error, now);
    }
  }

  #modifyGtt(payload: Wire, now: Date): Reply {
    try {
      const [accepted, result] = this.#state.modifyGtt(payload);
      return accepted ? json(replies.gttAck("Oi replaced", result, now)) : notOk(result, now);
    } catch (error) {
      return invalid(error, now);
    }
  }

  #cancelGtt(payload: Wire, now: Date): Reply {
    const [accepted, result] = this.#state.cancelGtt(text(payload["al_id"]));
    return accepted ? json(replies.gttAck("Oi delete success", result, now)) : notOk(result, now);
  }

  #gttRows(
    gtts: Wire[],
    build: (gtt: Wire, clientId: string, instrument: Wire | null) => Wire,
    now: Date,
  ): Reply {
    const state = this.#state;
    const rows = gtts.map((gtt) =>
      build(gtt, state.clientId, state.findInstrument(text(gtt["exch"]), text(gtt["tsym"]))),
    );
    return this.#rows(rows, now);
  }

  #pendingGtts(_payload: Wire, now: Date): Reply {
    return this.#gttRows(this.#state.gtts, replies.gttRow, now);
  }

  #triggeredGtts(_payload: Wire, now: Date): Reply {
    return this.#gttRows(this.#state.triggeredGtts, replies.triggeredGttRow, now);
  }

  // --- market data ---------------------------------------------------------------------

  #quote(payload: Wire, now: Date): Reply {
    const reply = this.#state.quote(text(payload["exch"]), text(payload["token"]));
    return reply === null ? notOk(NO_DATA, now) : json(reply);
  }

  #search(payload: Wire, now: Date): Reply {
    const needle = text(payload["stext"]).toLowerCase();
    const rows = [...this.#state.instruments.values()]
      .filter((row) => text(row["tsym"]).toLowerCase().includes(needle))
      .map((row) => ({ ...row }));
    if (rows.length === 0) return notOk("No Data :   ", now, 404); // documented: no match is HTTP 404
    return json(replies.searchScrip(rows));
  }

  #securityInfo(payload: Wire, now: Date): Reply {
    const exch = text(payload["exch"]);
    const token = text(payload["token"]);
    const row = [...this.#state.instruments.values()].find(
      (r) => r["exch"] === exch && r["token"] === token,
    );
    if (row === undefined) return notOk("Invalid Input :  Invalid Scrip token/exch", now, 400);
    return json(replies.securityInfo({ ...row }, now));
  }

  /**
   * `cnt` strikes below the mid strike and `cnt` at or above it, CE and PE, for the underlying
   * and expiry of `tsym`.
   */
  #optionChain(payload: Wire, now: Date): Reply {
    const exchange = text(payload["exch"]);
    const mid = replies.toDecimal(text(payload["strprc"]));
    const countText = text(payload["cnt"]).trim();
    if (mid === null || !INTEGER_TEXT.test(countText)) {
      return notOk("Invalid Input : strprc and cnt must be numbers", now);
    }
    const count = Math.max(Number(countText), 0);
    const anchor = this.#state.findInstrument(exchange, text(payload["tsym"]));
    if (anchor === null) return notOk(NO_DATA, now);
    const options: [Decimal, Wire][] = [];
    for (const row of this.#state.instruments.values()) {
      if (row["exch"] !== exchange) continue;
      const strike = replies.toDecimal(row["strprc"]);
      if (
        strike !== null &&
        (row["optt"] === "CE" || row["optt"] === "PE") &&
        row["symname"] === anchor["symname"] &&
        row["exd"] === anchor["exd"]
      ) {
        options.push([strike, row]);
      }
    }
    const strikes = [...new Map(options.map(([s]) => [s.toFixed(), s])).values()].sort((a, b) =>
      a.cmp(b),
    );
    const below = strikes.filter((s) => s.lt(mid));
    const chosen = new Set(
      [
        ...below.slice(Math.max(below.length - count, 0)),
        ...strikes.filter((s) => s.gte(mid)).slice(0, count),
      ].map((s) => s.toFixed()),
    );
    const picked = options
      .filter(([strike]) => chosen.has(strike.toFixed()))
      .sort((a, b) => a[0].cmp(b[0]) || text(a[1]["optt"]).localeCompare(text(b[1]["optt"])))
      .map(([, row]) => ({ ...row }));
    return picked.length > 0 ? json(replies.optionChain(picked)) : notOk(NO_DATA, now);
  }

  #candles(exchange: string, token: string): Wire[] {
    return structuredClone(this.#state.candles.get(`${exchange}\u0000${token}`) ?? []);
  }

  /** The candles from `st` to `et` (both included; all when absent), newest first. */
  #tpSeries(payload: Wire, now: Date): Reply {
    let start: number | null;
    let end: number | null;
    try {
      start = bound(payload["st"]);
      end = bound(payload["et"]);
    } catch {
      return notOk("Invalid Input : st and et must be epoch seconds", now);
    }
    const candles = this.#candles(text(payload["exch"]), text(payload["token"]));
    const rows = candles.map((candle) => replies.candleRow(candle));
    return this.#rows(newestFirst(rows, start, end, candleEpoch), now);
  }

  /** The daily candles of the IST days `from` to `to` (both included), newest first. */
  #eod(payload: Wire, now: Date): Reply {
    let start: number | null;
    let end: number | null;
    try {
      start = bound(payload["from"]);
      end = bound(payload["to"]);
    } catch {
      return notOk("Invalid Input : from and to must be epoch seconds", now);
    }
    const sym = text(payload["sym"]);
    const colon = sym.indexOf(":");
    const exchange = colon < 0 ? sym : sym.slice(0, colon);
    const symbol = colon < 0 ? "" : sym.slice(colon + 1);
    const instrument = this.#state.findInstrument(exchange, symbol);
    if (instrument === null) return json([]); // documented: no data is an empty list
    const records = this.#candles(exchange, text(instrument["token"])).map((candle) =>
      replies.eodRecord(candle),
    );
    const first = start === null ? null : istDayOf(start);
    const last = end === null ? null : istDayOf(end);
    return json(
      newestFirst(records, first, last, candleDay).map((record) => JSON.stringify(record)),
    );
  }

  // --- script master -------------------------------------------------------------------

  #scriptMaster(code: string): Reply {
    if (!(Object.values(Exchange) as string[]).includes(code)) {
      return {
        status: 404,
        headers: { "content-type": "text/plain" },
        body: encoder.encode("Not Found"),
      };
    }
    const rows = [...this.#state.instruments.values()].filter((row) => row["exch"] === code);
    // Production BFO names the strike column "Strike" (spec 8.3).
    const header = SCRIPT_MASTER_COLUMNS.map(([name]) =>
      code === "BFO" && name === "StrikePrice" ? "Strike" : name,
    );
    const lines = [header.join(",")];
    for (const row of rows) {
      lines.push(SCRIPT_MASTER_COLUMNS.map(([, key]) => csvCell(text(row[key]))).join(","));
    }
    const archive = zipSync({ [`${code}_symbols.txt`]: strToU8(`${lines.join("\n")}\n`) });
    return { status: 200, headers: { "content-type": "application/zip" }, body: archive };
  }
}

/** A bad test or request value as the documented `Invalid Input` refusal; other errors propagate. */
function invalid(error: unknown, now: Date): Reply {
  if (error instanceof RangeError) return notOk(`Invalid Input : ${error.message}`, now);
  throw error;
}

function randomHex(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

interface ResponseHandler {
  onRequestStart?: (controller: Controller, context: unknown) => void;
  onResponseStart?: (
    controller: Controller,
    status: number,
    headers: Record<string, string>,
    statusText: string,
  ) => void;
  onResponseData?: (controller: Controller, chunk: Buffer) => void;
  onResponseEnd?: (controller: Controller, trailers: Record<string, string>) => void;
  onResponseError?: (controller: Controller | null, error: Error) => void;
}

interface Controller {
  paused: boolean;
  rawHeaders: Buffer[] | null;
  rawTrailers: Buffer[] | null;
  readonly aborted: boolean;
  pause: () => void;
  resume: () => void;
  abort: (reason: Error) => void;
}

function bodyBytes(body: unknown): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array();
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  throw new TypeError("the offline broker accepts only text or byte request bodies");
}

/**
 * An undici `Dispatcher` that answers every request from the offline broker, in memory: no
 * socket, DNS or TLS. Pass it as `httpDispatcher`; `OfflineBroker.client()` does.
 */
export class OfflineDispatcher extends Dispatcher {
  readonly #handler: Handler;
  #closed = false;

  constructor(state: BrokerState) {
    super();
    this.#handler = new Handler(state);
  }

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    const target = handler as unknown as ResponseHandler;
    let aborted = false as boolean;
    const controller: Controller = {
      paused: false,
      rawHeaders: null,
      rawTrailers: null,
      get aborted() {
        return aborted;
      },
      pause() {
        this.paused = true;
      },
      resume() {
        this.paused = false;
      },
      abort(reason) {
        if (aborted) return;
        aborted = true;
        target.onResponseError?.(controller, reason);
      },
    };
    target.onRequestStart?.(controller, null);
    if (aborted) return true;
    queueMicrotask(() => {
      if (aborted) return;
      let reply: Reply;
      try {
        const url = new URL(String(options.origin) + options.path);
        reply = this.#handler.handle(options.method, url, bodyBytes(options.body));
      } catch (error) {
        aborted = true;
        target.onResponseError?.(controller, error as Error);
        return;
      }
      controller.rawHeaders = Object.entries(reply.headers).flatMap(([k, v]) => [
        Buffer.from(k),
        Buffer.from(v),
      ]);
      target.onResponseStart?.(controller, reply.status, reply.headers, statusText(reply.status));
      target.onResponseData?.(controller, Buffer.from(reply.body));
      target.onResponseEnd?.(controller, {});
    });
    return true;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get destroyed(): boolean {
    return this.#closed;
  }

  override close(): Promise<void>;
  override close(callback: () => void): void;
  override close(callback?: () => void): Promise<void> | void {
    this.#closed = true;
    if (callback === undefined) return Promise.resolve();
    queueMicrotask(callback);
  }

  override destroy(err?: Error | null): Promise<void>;
  override destroy(callback: () => void): void;
  override destroy(err: Error | null, callback: () => void): void;
  override destroy(first?: Error | null | (() => void), second?: () => void): Promise<void> | void {
    this.#closed = true;
    const callback = typeof first === "function" ? first : second;
    if (callback === undefined) return Promise.resolve();
    queueMicrotask(callback);
  }
}

function statusText(status: number): string {
  return STATUS_CODES[status] ?? "";
}
