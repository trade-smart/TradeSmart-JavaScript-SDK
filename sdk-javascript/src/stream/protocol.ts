// Sans-IO stream protocol (sdk-behaviour.md §9.1, §9.2, §9.4, §9.5, §2.6): instrument keys,
// outbound request builders, connect-ack acceptance, the reconnect delay and inbound parsing.
// Nothing here does I/O or logs a frame.
import { RequestValidationError, ResponseParseError } from "../errors.js";
import { noopLogger, type Logger } from "../lib/log.js";
import { parseJsonLossless } from "../lib/json.js";
import { maskKeys } from "../lib/redact.js";
import { ENUM_LOOKUP } from "../models/generated/enums.js";
import {
  STREAM_MESSAGE_PARSERS,
  type ConnectAck,
  type DepthAck,
  type DepthFeed,
  type HeartbeatAck,
  type OrderUpdate,
  type PositionAck,
  type PositionUpdate,
  type StreamMessage,
  type TouchlineAck,
  type TouchlineFeed,
  type UnknownMessage,
  type UnsubscribeAck,
} from "../models/generated/stream.js";

/** One instrument: `"EXCH|TOKEN"` or an `[exchange, token]` pair. */
export type InstrumentKey = string | readonly [string, string];

/** One instrument or a list of them (the subscribe/unsubscribe argument, §2.6). */
export type InstrumentsArg = InstrumentKey | ReadonlyArray<InstrumentKey>;

/** An outbound request: every value is a string. */
export type OutboundMessage = Readonly<Record<string, string>>;

/** A parsed inbound frame, tagged with the model it was parsed to. */
export type ParsedMessage =
  | { readonly kind: "ConnectAck"; readonly message: ConnectAck }
  | { readonly kind: "TouchlineAck"; readonly message: TouchlineAck }
  | { readonly kind: "TouchlineFeed"; readonly message: TouchlineFeed }
  | { readonly kind: "DepthAck"; readonly message: DepthAck }
  | { readonly kind: "DepthFeed"; readonly message: DepthFeed }
  | { readonly kind: "OrderUpdate"; readonly message: OrderUpdate }
  | { readonly kind: "PositionAck"; readonly message: PositionAck }
  | { readonly kind: "PositionUpdate"; readonly message: PositionUpdate }
  | { readonly kind: "UnsubscribeAck"; readonly message: UnsubscribeAck }
  | { readonly kind: "HeartbeatAck"; readonly message: HeartbeatAck }
  | { readonly kind: "UnknownMessage"; readonly message: UnknownMessage };

/** The model name of each parsed message. */
export type MessageKind = ParsedMessage["kind"];

/**
 * The model of each wire `t` (the keys of `STREAM_MESSAGE_PARSERS`). A null-prototype table:
 * `t: "constructor"` or `"toString"` is never an inherited entry.
 */
export const MESSAGE_KINDS: Readonly<Record<string, Exclude<MessageKind, "UnknownMessage">>> =
  Object.freeze(
    Object.assign(
      Object.create(null) as Record<string, Exclude<MessageKind, "UnknownMessage">>,
      {
        ak: "ConnectAck",
        tk: "TouchlineAck",
        tf: "TouchlineFeed",
        dk: "DepthAck",
        df: "DepthFeed",
        om: "OrderUpdate",
        pk: "PositionAck",
        pm: "PositionUpdate",
        uk: "UnsubscribeAck",
        udk: "UnsubscribeAck",
        uok: "UnsubscribeAck",
        upk: "UnsubscribeAck",
        hk: "HeartbeatAck",
      } as const,
    ),
  );

// --- instrument keys ---------------------------------------------------------------------------

const LIST_REASON = "expected 'EXCH|TOKEN', (exchange, token) or a list of them";

/** `RequestValidationError` for item `index` of the instruments argument; never echoes a value. */
export function invalidInstrument(index: number, reason: string): RequestValidationError {
  const error = new RequestValidationError([
    { type: "value_error", loc: ["instruments", String(index)], msg: reason },
  ]);
  error.message = `Invalid request parameters: instruments.${String(index)} (${reason})`;
  return error;
}

function isPair(value: unknown): value is readonly [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string" &&
    !value[0].includes("|")
  );
}

/**
 * One instrument (`"NSE|22"` or `["NSE", "22"]`) or a list of them, as a list. A 2-item array of
 * strings whose first item has no `|` is one `[exchange, token]` instrument; `["NSE|22",
 * "NSE|23"]` stays two instruments. Anything else that is not iterable is refused.
 */
function asInstrumentList(instruments: unknown): unknown[] {
  if (typeof instruments === "string") return [instruments];
  if (isPair(instruments)) return [instruments];
  if (Array.isArray(instruments)) return [...(instruments as unknown[])];
  if (typeof instruments === "object" && instruments !== null && Symbol.iterator in instruments) {
    return Array.from(instruments as Iterable<unknown>);
  }
  throw invalidInstrument(0, LIST_REASON);
}

function split(item: unknown, index: number): [string, string] {
  if (typeof item === "string") {
    const at = item.indexOf("|");
    if (at < 0) throw invalidInstrument(index, "expected EXCH|TOKEN");
    return [item.slice(0, at), item.slice(at + 1)];
  }
  if (Array.isArray(item) && item.length === 2) {
    const [exchange, token] = item as unknown[];
    if (typeof exchange === "string" && typeof token === "string") return [exchange, token];
    throw invalidInstrument(index, "exchange and token must be strings");
  }
  throw invalidInstrument(index, "expected 'EXCH|TOKEN' or (exchange, token)");
}

const BAD_TOKEN = /[|#\s]/u;

/** A token is non-empty, without `|`, `#` or whitespace (as Python's `str.isspace`, so U+001C–U+001F too). */
function isBadToken(token: string): boolean {
  if (token === "" || BAD_TOKEN.test(token)) return true;
  for (let i = 0; i < token.length; i += 1) {
    const code = token.charCodeAt(i);
    if (code >= 0x1c && code <= 0x1f) return true;
  }
  return false;
}

function formatKey(item: unknown, index: number): string {
  const [rawExchange, token] = split(item, index);
  const exchanges: Readonly<Record<string, string>> = ENUM_LOOKUP.Exchange;
  const upper = rawExchange.trim().toUpperCase();
  const exchange = Object.hasOwn(exchanges, upper) ? exchanges[upper] : undefined;
  if (exchange === undefined) throw invalidInstrument(index, "unknown exchange");
  if (isBadToken(token)) throw invalidInstrument(index, "invalid token");
  return `${exchange}|${token}`;
}

/**
 * Validate instruments and return ordered, de-duplicated `EXCH|TOKEN` keys (§9.2). The exchange
 * is accepted in any case, trimmed, and sent upper-case (`nse|22` → `NSE|22`). Invalid input
 * throws `RequestValidationError` naming `instruments.<index>`.
 */
export function toScripKeys(instruments: InstrumentsArg): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  asInstrumentList(instruments).forEach((item, index) => {
    const key = formatKey(item, index);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  });
  return keys;
}

/**
 * Exactly one instrument (`"EXCH|TOKEN"` or one `[exchange, token]` pair) as its key (§9.3); a
 * list, an array that is not one pair, or an invalid key throws `RequestValidationError`.
 */
export function toScripKey(instrument: InstrumentKey): string {
  if (typeof instrument !== "string" && !isPair(instrument)) {
    throw invalidInstrument(0, "expected one instrument");
  }
  return formatKey(instrument, 0);
}

// --- outbound ----------------------------------------------------------------------------------

/** The connect frame. It carries the token: never log it. */
export function connectMessage(uid: string, accessToken: string): OutboundMessage {
  return { t: "a", uid, actid: uid, source: "API", accesstoken: accessToken };
}

export function touchlineMessage(keys: readonly string[]): OutboundMessage {
  return { t: "t", k: keys.join("#") };
}

export function unsubscribeTouchlineMessage(keys: readonly string[]): OutboundMessage {
  return { t: "u", k: keys.join("#") };
}

export function depthMessage(keys: readonly string[]): OutboundMessage {
  return { t: "d", k: keys.join("#") };
}

export function unsubscribeDepthMessage(keys: readonly string[]): OutboundMessage {
  return { t: "ud", k: keys.join("#") };
}

export function orderUpdatesMessage(actid: string): OutboundMessage {
  return { t: "o", actid };
}

export function unsubscribeOrdersMessage(): OutboundMessage {
  return { t: "uo" };
}

export function positionUpdatesMessage(uid: string): OutboundMessage {
  return { t: "p", uid };
}

export function unsubscribePositionsMessage(): OutboundMessage {
  return { t: "up" };
}

export function heartbeatMessage(): OutboundMessage {
  return { t: "h" };
}

// --- connect ack and reconnect delay -----------------------------------------------------------

/**
 * Whether the `s` of an `ak` accepts the connection (§9.1 step 5, `ws_connect_ack.json`): trimmed,
 * it equals `ok` in any case. The docs say `Ok`; the live server sends `OK` (F18).
 */
export function ackAccepted(status: unknown): boolean {
  return typeof status === "string" && status.trim().toLowerCase() === "ok";
}

/**
 * Milliseconds to wait before 0-based reconnect `attempt` (§9.5):
 * `min(cap, base · 2^attempt) · (0.5 + U/2)`, `base` and `cap` in seconds, `random()` = U in [0, 1).
 */
export function reconnectDelayMs(
  attempt: number,
  baseSeconds: number,
  capSeconds: number,
  random: () => number,
): number {
  const ceiling = Math.min(capSeconds * 1000, baseSeconds * 1000 * 2 ** Math.min(attempt, 1000));
  return ceiling * (0.5 + random() / 2);
}

// --- inbound -----------------------------------------------------------------------------------

/** A frame as the `ws` library delivers it. */
export type RawFrame = string | Buffer | ArrayBuffer | readonly Buffer[];

const decoder = new TextDecoder("utf-8"); // invalid bytes become U+FFFD, never an exception

function frameText(raw: RawFrame): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return decoder.decode(new Uint8Array(raw));
  if (Array.isArray(raw)) return decoder.decode(Buffer.concat(raw as readonly Buffer[]));
  return decoder.decode(raw as Buffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An `UnknownMessage` keeping `data` as its (key-masked) `raw`. */
function unknown(data: Record<string, unknown>): ParsedMessage {
  const t = Object.hasOwn(data, "t") && typeof data["t"] === "string" ? data["t"] : "";
  const extra = Object.fromEntries(Object.entries(data).filter(([key]) => key !== "t"));
  const message: UnknownMessage = Object.freeze({
    t,
    raw: Object.freeze(maskKeys(data)),
    extra: Object.freeze(extra),
  });
  return { kind: "UnknownMessage", message };
}

/**
 * Parse one inbound frame into its model (§9.2). Never throws: invalid JSON, a non-object, an
 * unknown `t` or a model failure (a protected key included) gives `UnknownMessage` with the data
 * kept in `raw`; a model failure logs one WARNING naming the failing fields only.
 */
export function parseMessage(raw: RawFrame, log: Logger = noopLogger): ParsedMessage {
  let text: string;
  let data: unknown;
  try {
    text = frameText(raw);
  } catch {
    return unknown({ text: "" });
  }
  try {
    data = parseJsonLossless(text);
  } catch {
    return unknown({ text });
  }
  if (!isRecord(data)) return unknown({ text });
  const t = Object.hasOwn(data, "t") ? data["t"] : undefined;
  if (typeof t !== "string" || !Object.hasOwn(STREAM_MESSAGE_PARSERS, t)) return unknown(data);
  const kind = MESSAGE_KINDS[t];
  const parse = STREAM_MESSAGE_PARSERS[t];
  if (kind === undefined || parse === undefined) return unknown(data);
  let fields: readonly string[] = [];
  let detail: string;
  try {
    const message = parse(data, { endpoint: kind }) as StreamMessage;
    return { kind, message } as ParsedMessage;
  } catch (error) {
    if (error instanceof ResponseParseError) {
      fields = error.fields;
      detail = error.message; // names the failing fields only, never their values
    } else {
      detail = error instanceof Error ? error.name : typeof error;
    }
  }
  log.warn(`Unparseable "${t}" stream message delivered as UnknownMessage: ${detail}`, {
    logger: "tradesmart.stream",
    t,
    fields: [...fields],
  });
  return unknown(data);
}
