// The JavaScript live-order driver (specifications/live-driver.md): a child process the live-order
// matrix (sdk-python/tests/live_orders/uat_matrix) starts to execute its state-changing calls with
// this SDK. JSON lines in on stdin, JSON lines out on stdout (nothing else is ever written
// there), redacted logs on stderr.
//
// What this file never does: hold or re-implement a gate (the harness decides whether an order
// may be sent), send a call the harness did not ask for, send two calls for one request, retry,
// batch, or look an order up after an ambiguous reply. One request is exactly one SDK call.
// It refuses to start without the harness's per-run nonce and both order opt-ins, before any
// client exists. Static imports are Node built-ins and `decimal.js` (loaded before the checks run:
// it makes no call and holds no state); the built SDK (`../../dist/index.js`) is imported
// dynamically, only after the start-up checks pass. Run it with Node's native type stripping
// (`node driver.ts`): only erasable TypeScript syntax is used. It writes no token, secret key,
// checksum or auth code anywhere; the one account id it writes is the handshake's `client_id`.
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Decimal } from "decimal.js";
import type { Dispatcher } from "undici";
import type { ClientConfigInit, SlicedOrderResult, TradeSmart } from "../../src/index.js";

export const PROTOCOL = 2;
export const NONCE_ENV = "TRADESMART_LIVE_DRIVER_RUN";
export const SDK_NAME = "javascript";

export type Env = Readonly<Record<string, string | undefined>>;
type Json = Record<string, unknown>;

// --------------------------------------------------------------------------- redaction

const MASK = "***";
const MIN_SECRET = 4; // shorter values could match ordinary text
const SECRET_ENV_NAME = /TOKEN|SECRET|KEY|PASSWORD|CHECKSUM|AUTH|CODE|ACCOUNT|CLIENT_ID/i;
const BEARER = /Bearer\s+\S+/gi;
const SECRET_PAIR =
  /((?:access[_-]?token|susertoken|refresh[_-]?token|app[_-]?key|secret[_-]?key|api[_-]?secret|checksum|authorization|password|jkey)["']?\s*[:=]\s*)(["']?)[^\s,;}"']+/gi;
const SECRET_KEYS = new Set([
  "susertoken",
  "access_token",
  "accesstoken",
  "refresh_token",
  "secret_key",
  "app_key",
  "api_secret",
  "checksum",
  "jkey",
  "password",
  "authorization",
]);
const ACCOUNT_KEYS = new Set(["client_id", "user_id", "account_id", "uid", "actid"]);

/** A function that masks bearer tokens, secret `key: value` pairs and every known secret value. */
export function redactor(secrets: readonly string[]): (text: string) => string {
  const values = [...new Set(secrets.map((s) => s.trim()).filter((s) => s.length >= MIN_SECRET))]
    .sort((a, b) => b.length - a.length)
    .map((value) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"));
  return (text: string): string => {
    let out = text.replace(BEARER, `Bearer ${MASK}`).replace(SECRET_PAIR, `$1$2${MASK}`);
    for (const value of values) out = out.replace(value, MASK);
    return out;
  };
}

/** The secret values of an environment (names like TOKEN, KEY, SECRET, ACCOUNT, CLIENT_ID). */
export function envSecrets(env: Env): string[] {
  const found: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && SECRET_ENV_NAME.test(name)) found.push(value);
  }
  return found;
}

const MAX_DEPTH = 40;

/** A wire body with the account-id keys removed at any depth and secret-named values masked. */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "<nested too deeply>";
  if (Array.isArray(value)) return (value as unknown[]).map((item) => scrub(item, depth + 1));
  if (typeof value !== "object" || value === null) return value;
  const out: Json = {};
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (ACCOUNT_KEYS.has(lower)) continue;
    out[key] = SECRET_KEYS.has(lower) ? MASK : scrub(item, depth + 1);
  }
  return out;
}

// --------------------------------------------------------------------------- the wire capture

const WRITE_ENDPOINTS = new Set([
  "PlaceOrder",
  "ModifyOrder",
  "CancelOrder",
  "ExitSNOOrder",
  "PlaceGTTOrder",
  "ModifyGTTOrder",
  "CancelGTTOrder",
  "PlaceOCOOrder",
  "ModifyOCOOrder",
  "CancelOCOOrder",
  "GenAcsTok",
]);

export interface WireEntry {
  endpoint: string;
  status: number;
  /** The response body as UTF-8 text, as the SDK received it. */
  text: string;
}

export interface WireMark {
  entries: number;
  dispatched: number;
  writes: number;
}

/**
 * The response bodies of the requests one client sent, in order. The SDK returns only the order
 * id of a successful write; the protocol needs the wire body beside it, so the driver's client is
 * built on a dispatcher that records each response (`captureDispatcher`). Nothing is added: the
 * recording makes no request of its own.
 */
export class WireCapture {
  readonly entries: WireEntry[] = [];
  /** Requests handed to the dispatcher (counted before they are answered). */
  dispatched = 0;
  /** Of those, the state-changing ones (what "nothing was sent" is judged by). */
  writesDispatched = 0;

  mark(): WireMark {
    return {
      entries: this.entries.length,
      dispatched: this.dispatched,
      writes: this.writesDispatched,
    };
  }

  since(mark: WireMark): { entries: WireEntry[]; writesSent: boolean } {
    return {
      entries: this.entries.slice(mark.entries),
      writesSent: this.writesDispatched !== mark.writes,
    };
  }
}

function endpointOf(requestPath: string): string {
  const clean = requestPath.split("?")[0] ?? "";
  return clean.slice(clean.lastIndexOf("/") + 1);
}

/**
 * `inner` with every response body recorded in `capture`. The body is read once and handed on
 * unchanged (the SDK's own read gets the same bytes); status and headers pass through. The SDK
 * uses only `request`, `closed` and `destroyed`; `dispatch`, `close` and `destroy` delegate.
 */
export function captureDispatcher(inner: Dispatcher, capture: WireCapture): Dispatcher {
  const wrapper = {
    request: async (options: Dispatcher.RequestOptions): Promise<Dispatcher.ResponseData> => {
      const endpoint = endpointOf(options.path);
      capture.dispatched += 1;
      if (WRITE_ENDPOINTS.has(endpoint)) capture.writesDispatched += 1;
      const response = await inner.request(options);
      const bytes = new Uint8Array(await response.body.arrayBuffer());
      capture.entries.push({
        endpoint,
        status: response.statusCode,
        text: new TextDecoder("utf-8").decode(bytes),
      });
      const body = {
        arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(bytes.slice().buffer),
        dump: (): Promise<void> => Promise.resolve(),
      };
      return { ...response, body } as unknown as Dispatcher.ResponseData;
    },
    dispatch: (options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean =>
      inner.dispatch(options, handler),
    close: (): Promise<void> => inner.close(),
    get closed(): boolean {
      return (inner as { closed?: boolean }).closed === true;
    },
    get destroyed(): boolean {
      return (inner as { destroyed?: boolean }).destroyed === true;
    },
  };
  return wrapper as unknown as Dispatcher;
}

// --------------------------------------------------------------------------- value encoding

const camel = (name: string): string =>
  name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
const snake = (name: string): string => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// Arguments that are prices or other exact decimals: strings become exact `Decimal`s, never floats.
const DECIMAL_ARGS = new Set([
  "price",
  "trigger_price",
  "book_loss_price",
  "book_profit_price",
  "trail_price",
  "market_protection",
  "trigger_value",
  "strike_price",
  "underlying_price",
  "spot_price",
]);

/** An argument the harness sent that cannot be converted: nothing is called. */
class ArgumentError extends Error {}

function toDecimal(name: string, text: string): Decimal {
  try {
    const value = new Decimal(text.trim());
    if (value.isFinite()) return value;
  } catch {
    // fall through to the refusal below
  }
  throw new ArgumentError(`${name} is not a decimal number`);
}

/** The SDK's parameter object from snake_case arguments: camelCase keys, nulls left out. */
function params(args: Json, drop: readonly string[] = []): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined || drop.includes(key)) continue;
    out[camel(key)] =
      DECIMAL_ARGS.has(key) && typeof value === "string" ? toDecimal(key, value) : value;
  }
  return out;
}

/** An OCO leg (`{trigger_value, price, order_type, trigger_price}`) as the SDK's `OcoLeg`. */
function ocoLeg(name: string, value: unknown): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArgumentError(`${name} must be an object`);
  }
  return params(value as Json);
}

/** The SDK's OCO parameter object: both legs converted, the rest as for any call. */
function ocoParams(args: Json, drop: readonly string[] = []): Json {
  const out = params(args, [...drop, "stop_loss", "target"]);
  out["stopLoss"] = ocoLeg("stop_loss", args["stop_loss"]);
  out["target"] = ocoLeg("target", args["target"]);
  return out;
}

function text(args: Json, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value === "") {
    throw new ArgumentError(`${name} must be a non-empty string`);
  }
  return value;
}

function ist(date: Date): string {
  const shifted = new Date(date.getTime() + 330 * 60_000);
  const iso = shifted.toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ, as IST wall time
  const millis = iso.slice(19, 23) === ".000" ? "" : iso.slice(19, 23);
  return `${iso.slice(0, 19)}${millis}+05:30`;
}

function timeInput(name: string, value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new ArgumentError(`${name} must be a date or an instant`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) throw new ArgumentError(`${name} is not an ISO 8601 time`);
  return when;
}

function isDecimal(value: object): value is Decimal {
  return Decimal.isDecimal(value);
}

/** A value in the protocol's encoding: contract (snake_case) names, Decimals as strings, IST times. */
function encode(value: unknown, keepKeys = false, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : ist(value);
  if (Array.isArray(value))
    return (value as unknown[]).map((item) => encode(item, keepKeys, depth + 1));
  if (typeof value !== "object") return null;
  if (isDecimal(value)) return value.toFixed();
  if (value.constructor.name === "JsonNumber") return (value as { text: string }).text;
  const out: Json = {};
  for (const [key, item] of Object.entries(value)) {
    // `raw` and `extra` hold wire keys: kept as the wire has them.
    out[keepKeys ? key : snake(key)] = encode(
      item,
      keepKeys || key === "raw" || key === "extra",
      depth + 1,
    );
  }
  return out;
}

// --------------------------------------------------------------------------- errors

const API_ERRORS = new Set([
  "APIError",
  "AuthenticationError",
  "RateLimitError",
  "NotFoundError",
  "ServerError",
  "OrderRejectedError",
]);
const PLAIN_ERRORS = new Set(["NetworkError", "RequestTimeoutError", "ConfigurationError"]);

/** What the driver could not put in a reply after the SDK answered (a missing wire body). */
class Unreplyable extends Error {}

interface Context {
  method: string;
  write: boolean;
  capture: WireCapture;
  mark: WireMark;
  redact: (text: string) => string;
}

function bodyValue(body: string | null): unknown {
  if (body === null) return null;
  try {
    return scrub(JSON.parse(body));
  } catch {
    return body;
  }
}

function field(error: object, name: string): unknown {
  return (error as Record<string, unknown>)[name];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function statusOf(error: object): number | null {
  const status = field(error, "httpStatus");
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function validationFields(error: object): string[] {
  const issues = field(error, "errors");
  if (!Array.isArray(issues)) return [];
  const names = (issues as { loc?: unknown }[]).map((issue) =>
    Array.isArray(issue.loc) ? (issue.loc as unknown[]).join(".") : "",
  );
  return [...new Set(names.filter((n) => n !== ""))].sort();
}

/** The contract name an SDK error maps to, or `null` when the SDK does not name it. */
function contractName(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const name = error.name;
  if (
    API_ERRORS.has(name) ||
    PLAIN_ERRORS.has(name) ||
    name === "OrderStatusUnknownError" ||
    name === "ResponseParseError" ||
    name === "RequestValidationError"
  ) {
    return name;
  }
  return null;
}

/** The error object of a reply (`live-driver.md`, "Reply"): the contract name and its fields. */
function errorObject(error: unknown, ctx: Context): Json {
  let type = contractName(error);
  if (type === null) {
    if (error instanceof ArgumentError) type = "ValueError";
    else if (
      (error instanceof RangeError || error instanceof TypeError) &&
      !ctx.capture.since(ctx.mark).writesSent
    ) {
      type = "ValueError"; // refused before any state-changing request was sent
    } else type = ctx.write ? "OrderStatusUnknownError" : "NetworkError";
  }
  const obj = error ?? {};
  let message = ctx.redact(errorMessage(error));
  if (message === "") message = type;
  if (contractName(error) === null && !(error instanceof ArgumentError)) {
    message = ctx.redact(`${errorName(error)}: ${message}`);
  }
  let raw: unknown = null;
  let stat: string | null = null;
  let emsg: string | null = null;
  let slicedResult: unknown = null;
  if (API_ERRORS.has(type)) {
    raw = scrub(field(obj, "raw") ?? null);
    emsg = str(field(obj, "emsg"));
    stat =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? str((raw as Json)["stat"])
        : null;
  } else if (type === "OrderStatusUnknownError" || type === "ResponseParseError") {
    raw = bodyValue(str(field(obj, "body")));
    if (typeof raw === "string") raw = ctx.redact(raw);
    stat =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? str((raw as Json)["stat"])
        : null;
  }
  const out: Json = {
    type,
    message,
    stat,
    emsg: emsg === null ? null : ctx.redact(emsg),
    http_status: contractName(error) === null ? null : statusOf(obj),
    raw,
    sliced_result: null,
    fields: type === "RequestValidationError" ? validationFields(obj) : [],
  };
  if (type === "RateLimitError") {
    // "sent: false" only when the SDK's own limiter refused before anything went out (it has no
    // HTTP status); the server's 429 carries one.
    out["sent"] = statusOf(obj) !== null;
    out["http_status"] = statusOf(obj);
  }
  if (ctx.method === "place_sliced_order") {
    const partial = field(obj, "slicedResult");
    if (partial !== null && partial !== undefined) slicedResult = partial;
  }
  if (slicedResult !== null) {
    try {
      out["sliced_result"] = slicedObject(slicedResult as SlicedOrderResult, ctx);
    } catch {
      // The placed slices cannot be backed by their wire bodies: say so, never guess.
      out["type"] = "OrderStatusUnknownError";
      out["message"] = ctx.redact("the partial sliced result could not be backed by wire bodies");
    }
  }
  return out;
}

/** A `place_sliced_order` result object with the wire body of every placed slice. */
function slicedObject(result: SlicedOrderResult, ctx: Context): Json {
  const placed = ctx.capture
    .since(ctx.mark)
    .entries.filter((entry) => entry.endpoint === "PlaceOrder");
  const ids = result.orderIds;
  if (placed.length < ids.length) throw new Unreplyable("fewer wire bodies than placed slices");
  const slices = ids.map((id, i) => {
    const entry = placed[i] as WireEntry;
    const body = parseObject(entry.text);
    if (body === undefined) throw new Unreplyable("a slice's wire body is not JSON");
    return { order_id: id, raw: body, http_status: entry.status };
  });
  return {
    requested_quantity: result.requestedQuantity,
    slice_quantities: [...result.sliceQuantities],
    order_ids: [...ids],
    placed_quantity: result.placedQuantity,
    unsent_quantity: result.unsentQuantity,
    complete: result.complete,
    error: result.error === null ? null : errorObject(result.error, { ...ctx, write: true }),
    slices,
  };
}

function parseObject(body: string): unknown {
  try {
    return scrub(JSON.parse(body));
  } catch {
    return undefined;
  }
}

// --------------------------------------------------------------------------- the methods

interface Outcome {
  result: unknown;
  raw?: unknown;
  http_status?: number | null;
}

type Call = (client: TradeSmart, args: Json, ctx: Context) => Promise<Outcome>;

/** A state-changing call whose success reply carries the wire body of its one request. */
function write(endpoint: string, call: (client: TradeSmart, args: Json) => Promise<string>): Call {
  return async (client, args, ctx) => {
    const id = await call(client, args);
    const entries = ctx.capture.since(ctx.mark).entries.filter((e) => e.endpoint === endpoint);
    const only = entries[0];
    if (entries.length !== 1 || only === undefined) {
      throw new Unreplyable(`the wire body of ${ctx.method} was not captured exactly once`);
    }
    const body = parseObject(only.text);
    if (body === undefined) throw new Unreplyable(`the wire body of ${ctx.method} is not JSON`);
    return { result: id, raw: body, http_status: only.status };
  };
}

function read(call: (client: TradeSmart, args: Json) => Promise<unknown>): Call {
  return async (client, args) => ({ result: encode(await call(client, args)) });
}

const strikeOf = (args: Json): Decimal => toDecimal("strike_price", String(args["strike_price"]));
const rest = (args: Json, ...taken: string[]): Json => params(args, taken);

// Every protocol method, by contract (snake_case) name: one SDK call each.
const TABLE: Record<string, Call> = {
  place_order: write("PlaceOrder", (c, a) => c.placeOrder(params(a) as never)),
  place_sliced_order: async (client, args, ctx) => {
    const result = await client.placeSlicedOrder(params(args) as never);
    return { result: slicedObject(result, ctx) };
  },
  modify_order: write("ModifyOrder", (c, a) =>
    c.modifyOrder(text(a, "order_id"), rest(a, "order_id") as never),
  ),
  cancel_order: write("CancelOrder", (c, a) => c.cancelOrder(text(a, "order_id"))),
  exit_order: write("ExitSNOOrder", (c, a) => c.exitOrder(text(a, "order_id"), text(a, "product"))),
  place_gtt: write("PlaceGTTOrder", (c, a) => c.placeGtt(params(a) as never)),
  modify_gtt: write("ModifyGTTOrder", (c, a) =>
    c.modifyGtt(text(a, "alert_id"), rest(a, "alert_id") as never),
  ),
  cancel_gtt: write("CancelGTTOrder", (c, a) => c.cancelGtt(text(a, "alert_id"))),
  place_oco: write("PlaceOCOOrder", (c, a) => c.placeOco(ocoParams(a) as never)),
  modify_oco: write("ModifyOCOOrder", (c, a) =>
    c.modifyOco(text(a, "alert_id"), ocoParams(a, ["alert_id"]) as never),
  ),
  cancel_oco: write("CancelOCOOrder", (c, a) => c.cancelOco(text(a, "alert_id"))),
  profile: read((c) => c.profile()),
  margins: read((c) => c.margins()),
  positions: read((c) => c.positions()),
  holdings: read((c, a) => c.holdings(rest(a))),
  orders: read((c) => c.orders()),
  order_history: read((c, a) => c.orderHistory(text(a, "order_id"))),
  trades: read((c) => c.trades()),
  order_margin: read((c, a) => c.orderMargin(params(a) as never)),
  pending_gtts: read((c) => c.pendingGtts()),
  triggered_gtts: read((c) => c.triggeredGtts()),
  gtt_alert_types: read((c) => c.gttAlertTypes()),
  search_instruments: read((c, a) => c.searchInstruments(text(a, "text"))),
  quote: read((c, a) => c.quote(text(a, "exchange"), text(a, "token"))),
  security_info: read((c, a) => c.securityInfo(text(a, "exchange"), text(a, "token"))),
  option_chain: read((c, a) => {
    const count = a["count"];
    if (typeof count !== "number") throw new ArgumentError("count must be a number");
    return c.optionChain(text(a, "exchange"), text(a, "tradingsymbol"), strikeOf(a), count);
  }),
  historical_data: read((c, a) =>
    c.historicalData(text(a, "exchange"), text(a, "token"), {
      ...(a["from_date"] == null
        ? {}
        : { fromDate: timeInput("from_date", a["from_date"]) as never }),
      ...(a["to_date"] == null ? {} : { toDate: timeInput("to_date", a["to_date"]) as never }),
      ...(a["interval"] == null ? {} : { interval: a["interval"] as number | string }),
    }),
  ),
  daily_history: read((c, a) =>
    c.dailyHistory(
      text(a, "exchange"),
      text(a, "tradingsymbol"),
      timeInput("from_date", a["from_date"]) as never,
      timeInput("to_date", a["to_date"]) as never,
    ),
  ),
  option_greeks: read((c, a) =>
    c.optionGreeks(
      text(a, "exchange"),
      text(a, "tradingsymbol"),
      rest(a, "exchange", "tradingsymbol"),
    ),
  ),
  option_chain_snapshot: read((c, a) =>
    c.optionChainSnapshot(
      text(a, "exchange"),
      text(a, "tradingsymbol"),
      strikeOf(a),
      rest(a, "exchange", "tradingsymbol", "strike_price"),
    ),
  ),
  buildup: read((c, a) => c.buildup(text(a, "exchange"), text(a, "token"))),
  instruments: read((c, a) => c.instruments(text(a, "exchange"))),
  download_instruments: read((c, a) =>
    c.downloadInstruments(text(a, "exchange"), rest(a, "exchange")),
  ),
  request: read((c, a) => {
    const payload = a["payload"];
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new ArgumentError("payload must be an object");
    }
    const expect = a["expect"] === "list" ? "list" : "object";
    return c.request(text(a, "endpoint"), payload as never, {
      stateChanging: a["state_changing"] === true,
      expect,
    });
  }),
};

/** The contract names of every method the driver answers. */
export const METHODS: readonly string[] = Object.freeze(Object.keys(TABLE));

// --------------------------------------------------------------------------- the loop

export interface Output {
  write(text: string): unknown;
}

export interface ServeOptions {
  /** The run's nonce (`TRADESMART_LIVE_DRIVER_RUN`), echoed in the handshake. */
  nonce: string;
  /** The SDK's version. */
  version: string;
  /** The environment the client was built for (`uat`, `production`). */
  environment: string;
  /** The wire capture the client's dispatcher records into. */
  capture: WireCapture;
  /** Secret values to mask in everything written to the log and in error texts. */
  secrets?: readonly string[];
  /** Receives one redacted log line at a time (stderr in the program). */
  log?: (line: string) => void;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Serve the protocol: write the handshake, then answer one request at a time, each before the next
 * is read. Resolves with the exit status: 0 when `input` ends, 1 on a protocol violation (a line
 * that is not a JSON object, a request without an integer `id` or a string `method`, an unknown
 * method, a last line without its newline), 2 when there is no nonce (nothing is written).
 */
export async function serve(
  input: AsyncIterable<string | Uint8Array>,
  output: Output,
  client: TradeSmart,
  options: ServeOptions,
): Promise<number> {
  if (options.nonce.trim() === "") return 2;
  const redact = redactor([...(options.secrets ?? []), options.nonce, client.clientId]);
  const log = (line: string): void => options.log?.(redact(line));
  const send = (value: Json): void => {
    output.write(`${JSON.stringify(value)}\n`);
  };
  send({
    hello: {
      sdk: SDK_NAME,
      version: options.version,
      environment: options.environment,
      client_id: client.clientId,
      run: options.nonce,
      protocol: PROTOCOL,
    },
  });
  const violation = (reason: string): number => {
    log(`driver: protocol violation: ${reason}`);
    return 1;
  };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  try {
    for await (const chunk of input) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const status = await handleLine(line, client, options, redact, log, send, violation);
        if (status !== null) return status;
      }
    }
    buffer += decoder.decode();
  } catch (error) {
    if (error instanceof TypeError) return violation("input is not UTF-8");
    throw error;
  }
  if (buffer.trim() !== "") return violation("the last line has no newline");
  return 0;
}

/** One request line: `null` to go on, or the exit status when the protocol was violated. */
async function handleLine(
  line: string,
  client: TradeSmart,
  options: ServeOptions,
  redact: (text: string) => string,
  log: (line: string) => void,
  send: (value: Json) => void,
  violation: (reason: string) => number,
): Promise<number | null> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return violation("a line that is not JSON");
  }
  if (!isRecord(message)) return violation("a line that is not a JSON object");
  const id = message["id"];
  const method = message["method"];
  if (typeof id !== "number" || !Number.isInteger(id))
    return violation("a request without an integer id");
  if (typeof method !== "string" || method === "") return violation("a request without a method");
  const args = message["args"] ?? {};
  if (!isRecord(args)) return violation("args is not an object");
  const call = Object.hasOwn(TABLE, method) ? TABLE[method] : undefined;
  if (call === undefined) return violation(`unknown method ${redact(method.slice(0, 40))}`);
  const ctx: Context = {
    method,
    write:
      method.startsWith("place_") ||
      /^(modify|cancel|exit)_/.test(method) ||
      (method === "request" && args["state_changing"] === true),
    capture: options.capture,
    mark: options.capture.mark(),
    redact,
  };
  let reply: Json;
  try {
    const outcome = await call(client, args, ctx);
    reply = { id, result: outcome.result };
    if (outcome.raw !== undefined) {
      reply["raw"] = outcome.raw;
      reply["http_status"] = outcome.http_status ?? null;
    }
  } catch (error) {
    if (contractName(error) === null) {
      log(`driver: ${method}: unexpected ${errorName(error)}: ${errorMessage(error)}`);
    }
    reply = { id, error: replyError(error, ctx) };
  }
  send(reply);
  return null;
}

function replyError(error: unknown, ctx: Context): Json {
  if (error instanceof Unreplyable) {
    // The SDK answered but the wire body cannot be reported: never a success, never a guess.
    return {
      type: "OrderStatusUnknownError",
      message: ctx.redact(error.message),
      stat: null,
      emsg: null,
      http_status: null,
      raw: null,
      sliced_result: null,
      fields: [],
    };
  }
  return errorObject(error, ctx);
}

// --------------------------------------------------------------------------- the program

/** Why the program must not start (`live-driver.md`, "Start-up refusal"), or `null`. */
export function startRefusal(env: Env): string | null {
  if ((env[NONCE_ENV] ?? "").trim() === "") {
    return (
      `refusing to start: ${NONCE_ENV} is not set (the live-order harness gives each run a nonce; ` +
      "a driver started by hand has none)"
    );
  }
  for (const name of ["TRADESMART_LIVE_TESTS", "TRADESMART_LIVE_ORDER_TESTS"]) {
    if (env[name] !== "1") return `refusing to start: ${name} must be 1 (both order opt-ins)`;
  }
  return null;
}

export interface Built {
  client: TradeSmart;
  capture: WireCapture;
  version: string;
  environment: string;
  /** Secret values (the token, the keys) to mask in logs. */
  secrets: readonly string[];
  close(): Promise<void>;
}

export interface Io {
  stdin: AsyncIterable<string | Uint8Array>;
  stdout: Output;
  stderr: Output;
}

/**
 * The whole program with its streams and client builder injected: refuse (exit 2) before any
 * client exists unless the nonce and both opt-ins are present, build the client, serve, close.
 */
export async function runProgram(
  env: Env,
  io: Io,
  build: (env: Env) => Promise<Built>,
): Promise<number> {
  const refusal = startRefusal(env);
  const known = redactor([...envSecrets(env), env[NONCE_ENV] ?? ""]);
  const note = (text: string): void => {
    io.stderr.write(`${known(text)}\n`);
  };
  if (refusal !== null) {
    note(refusal);
    return 2;
  }
  let built: Built;
  try {
    built = await build(env);
  } catch (error) {
    note(`could not build the client: ${errorName(error)}: ${errorMessage(error)}`);
    return 2;
  }
  try {
    return await serve(io.stdin, io.stdout, built.client, {
      nonce: (env[NONCE_ENV] ?? "").trim(),
      version: built.version,
      environment: built.environment,
      capture: built.capture,
      secrets: [...built.secrets, ...envSecrets(env)],
      log: note,
    });
  } finally {
    await built.close().catch(() => undefined);
  }
}

// --------------------------------------------------------------------------- the environment

export class EnvironmentRefusal extends Error {}

export interface TokenStore {
  defaultTokenFilePath(env: Env, platform: NodeJS.Platform, home: string, cwd: string): string;
  /** The client id the saved login at `file` names, or `null` when there is none to read. */
  savedClientId(file: string): string | null;
  platform: NodeJS.Platform;
  home: string;
  cwd: string;
}

export interface EnvironmentPlan {
  /** `production`, or the lower-case `TRADESMART_ENV` name. */
  name: string;
  /** The client settings for that environment. */
  config: ClientConfigInit;
  /** The environment the client is built from (the token file of this environment set). */
  env: Record<string, string | undefined>;
}

const ENV_NAME = /^[a-z0-9-]+$/;
const PRODUCTION = "production";
const URL_VARIABLES: readonly [string, keyof ClientConfigInit][] = [
  ["TRADESMART_ENV_BASE_URL", "baseUrl"],
  ["TRADESMART_ENV_WS_URL", "wsUrl"],
  ["TRADESMART_ENV_AUTHORIZE_URL", "authorizeUrl"],
];

function value(env: Env, name: string): string {
  return (env[name] ?? "").trim();
}

function sameFile(a: string, b: string, platform: NodeJS.Platform): boolean {
  const real = (file: string): string => {
    try {
      return realpathSync.native(file);
    } catch {
      return path.resolve(file);
    }
  };
  const norm = (file: string): string =>
    platform === "win32" ? real(file).toLowerCase() : real(file);
  return norm(a) === norm(b);
}

/**
 * The environment the harness selected, the way the Python harness builds its client
 * (`sdk-python/tests/_environment.py`): the name (`TRADESMART_ENV`, `production` when unset), the
 * URLs (all three required outside production, never a fallback to production), the token file of
 * the environment (`<folder>/<env>-token.json`; an override must not be the production file or
 * named `token.json`) and the refusal of a shell token or a client id that is not the saved
 * login's. A refusal is an `EnvironmentRefusal`; nothing is built here.
 */
export function planEnvironment(env: Env, store: TokenStore): EnvironmentPlan {
  const name = value(env, "TRADESMART_ENV").toLowerCase() || PRODUCTION;
  if (!ENV_NAME.test(name)) {
    throw new EnvironmentRefusal(
      `TRADESMART_ENV=${JSON.stringify(name)} is not a valid environment name ` +
        "(use lower-case letters, digits and hyphens only)",
    );
  }
  const planned: Record<string, string | undefined> = { ...env };
  if (name === PRODUCTION) {
    const base = value(env, "TRADESMART_BASE_URL");
    return { name, config: base === "" ? {} : { baseUrl: base }, env: planned };
  }
  const missing = URL_VARIABLES.filter(([variable]) => value(env, variable) === "").map(([v]) => v);
  if (missing.length > 0) {
    throw new EnvironmentRefusal(`TRADESMART_ENV=${name} needs: ${missing.join(", ")}`);
  }
  const config: ClientConfigInit = {};
  for (const [variable, key] of URL_VARIABLES) {
    (config as Record<string, unknown>)[key] = value(env, variable);
  }
  const script = value(env, "TRADESMART_ENV_SCRIPT_MASTER_URL");
  if (script !== "") config.scriptMasterBaseUrl = script;

  const productionFile = store.defaultTokenFilePath(
    { ...env, TRADESMART_TOKEN_FILE: "" },
    store.platform,
    store.home,
    store.cwd,
  );
  const explicit = value(env, "TRADESMART_TOKEN_FILE");
  let tokenFile: string;
  if (explicit !== "") {
    tokenFile = store.defaultTokenFilePath(env, store.platform, store.home, store.cwd);
    if (sameFile(tokenFile, productionFile, store.platform)) {
      throw new EnvironmentRefusal(
        `TRADESMART_ENV=${name}: TRADESMART_TOKEN_FILE is the production token file; unset it ` +
          "(each environment keeps its own login)",
      );
    }
    if (path.basename(tokenFile).toLowerCase() === "token.json") {
      throw new EnvironmentRefusal(
        `TRADESMART_ENV=${name}: TRADESMART_TOKEN_FILE is named token.json (the production ` +
          "login's name); unset it",
      );
    }
  } else {
    const parent =
      store.platform === "win32"
        ? path.win32.dirname(productionFile)
        : path.posix.dirname(productionFile);
    tokenFile =
      store.platform === "win32"
        ? path.win32.join(parent, `${name}-token.json`)
        : path.posix.join(parent, `${name}-token.json`);
  }
  if (value(env, "TRADESMART_ACCESS_TOKEN") !== "") {
    throw new EnvironmentRefusal(
      `TRADESMART_ENV=${name}: TRADESMART_ACCESS_TOKEN is set in the shell; it would bypass ` +
        `${path.basename(tokenFile)} and could send another environment's token; unset it`,
    );
  }
  const clientId = value(env, "TRADESMART_CLIENT_ID");
  if (clientId !== "") {
    const saved = store.savedClientId(tokenFile);
    if (saved !== null && saved.toLowerCase() !== clientId.toLowerCase()) {
      throw new EnvironmentRefusal(
        `TRADESMART_ENV=${name}: TRADESMART_CLIENT_ID differs from the client id in ` +
          `${path.basename(tokenFile)}; unset it (the environment's login names its own client id)`,
      );
    }
  }
  planned["TRADESMART_TOKEN_FILE"] = tokenFile;
  return { name, config, env: planned };
}

const DIST_INDEX = "../../dist/index.js";
const DIST_TOKEN_FILE = "../../dist/token-store/token-file.js";
const MAX_TIMER_MS = 2_147_483_647;
const ms = (seconds: number): number =>
  Math.min(MAX_TIMER_MS, Math.max(1, Math.round(seconds * 1000)));

/**
 * The real client: the built SDK (`../../dist`), built for the selected environment from the same
 * `TRADESMART_*` variables and saved login as the SDK's own live tests, on a dispatcher that
 * records the wire bodies (`captureDispatcher`) with the SDK's own connection settings.
 * `TradeSmart.fromEnv` resolves the login; the client that serves is built from what it resolved.
 */
export async function buildFromEnvironment(env: Env): Promise<Built> {
  const sdk = (await import(DIST_INDEX)) as typeof import("../../src/index.js");
  const tokens = (await import(
    DIST_TOKEN_FILE
  )) as typeof import("../../src/token-store/token-file.js");
  const { Agent } = await import("undici");
  const plan = planEnvironment(env, {
    defaultTokenFilePath: tokens.defaultTokenFilePath,
    savedClientId: (file) => {
      try {
        return tokens.readTokenFile(file).clientId;
      } catch {
        return null; // the client reports an unusable file itself
      }
    },
    platform: process.platform,
    home: os.homedir(),
    cwd: process.cwd(),
  });
  const resolved = sdk.TradeSmart.fromEnv({ env: plan.env, config: plan.config });
  if (resolved.accessToken === null) {
    // The driver never logs in, and the client rebuilt below would lose `fromEnv`'s reason for a
    // missing token: refuse here, with a fixed message.
    await resolved.close();
    throw new Error("no usable login: log in first (the driver never logs in)");
  }
  const config = resolved.config;
  const agent = new Agent({
    connections: config.maxConnections,
    keepAliveTimeout: ms(config.keepaliveExpiry),
    keepAliveMaxTimeout: ms(config.keepaliveExpiry),
    headersTimeout: ms(config.readTimeout),
    bodyTimeout: ms(config.readTimeout),
    connect: { timeout: ms(config.connectTimeout) },
  });
  const capture = new WireCapture();
  const token = resolved.accessToken;
  const client = new sdk.TradeSmart(resolved.clientId, {
    accessToken: token,
    config,
    httpDispatcher: captureDispatcher(agent, capture),
  });
  await resolved.close();
  const secrets = envSecrets(plan.env);
  secrets.push(typeof token === "string" ? token : token.accessToken.reveal());
  return {
    client,
    capture,
    version: sdk.VERSION,
    environment: plan.name,
    secrets,
    close: async () => {
      await client.close();
      await agent.close();
    },
  };
}

/** Whether `entry` (`process.argv[1]`) is this very file, by real path (a symlinked checkout runs). */
export function isEntryPoint(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined) return false;
  try {
    return realpathSync(path.resolve(entry)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  process.exitCode = await runProgram(
    process.env,
    { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
    buildFromEnvironment,
  );
}
