// Response classification (sdk-behaviour.md §4.2, §4.2.1, §4.3), mirroring
// sdk-python/src/tradesmart/_transport/codec.py (`parse_response`). Order-safety code: a state-
// changing call whose body neither confirms nor definitively rejects it is an
// `OrderStatusUnknownError`, never a success or a rejection.
import {
  APIError,
  AuthenticationError,
  ConfigurationError,
  NotFoundError,
  OrderRejectedError,
  OrderStatusUnknownError,
  RateLimitError,
  ResponseParseError,
  ServerError,
  type APIErrorOptions,
} from "../errors.js";
import { parseJsonLossless } from "./json.js";
import { canonicalEndpoint, isFailureWord, isSuccessWord, type EndpointInfo } from "./names.js";
import { redactText, redactedBody } from "./redact.js";

/** One response to classify. */
export interface ClassifyInput {
  /** The endpoint name (canonical spelling, as `canonicalEndpoint` returns it). */
  endpoint: string;
  httpStatus: number;
  /** The response body as text; parsed here (losslessly) whatever the HTTP status. */
  bodyText: string;
  /** True for the twelve never-retried names and any `request(..., stateChanging)` call. */
  stateChanging: boolean;
  /** The shape the caller asked for. */
  expect: "object" | "list";
  /**
   * True for a list endpoint where a `Not_Ok` "no data" reply means an empty list. Ignored for the
   * GTT and iceberg writes, where "no data" is never an empty list (§4.2.1).
   */
  allowEmpty: boolean;
  /** A field that must be a non-blank string on success; defaults to the endpoint's own (`al_id`). */
  requiredAckField?: string;
  /** A finite `Retry-After` in seconds from the response header, applied on every 429. */
  retryAfter?: number | null;
}

/** A classified success: the parsed body, or the empty signal (`Not_Ok` "no data"). */
export type ClassifyResult = { kind: "ok"; body: unknown } | { kind: "empty" };

const ICEBERG_WRITES: ReadonlySet<string> = new Set([
  "PlaceIceBergOrder",
  "ModifyIceBergOrder",
  "CancelIceBergOrder",
]);
const GTT_WRITES: ReadonlySet<string> = new Set([
  "PlaceGTTOrder",
  "ModifyGTTOrder",
  "CancelGTTOrder",
  "PlaceOCOOrder",
  "ModifyOCOOrder",
  "CancelOCOOrder",
]);
const ICEBERG_FAILURE_STAT = "false";

// Python `re.IGNORECASE` on a Unicode pattern also matches the dotless and dotted i, the long s and
// the Kelvin sign for i, s and k, which a JavaScript `i` flag does not; spelled out here.
const PY_FOLD: Readonly<Record<string, string>> = {
  i: "[iI\\u0131\\u0130]",
  s: "[sS\\u017f]",
  k: "[kK\\u212a]",
};
function pyInsensitive(phrases: readonly string[]): RegExp {
  const parts = phrases.map((phrase) =>
    phrase
      .split("")
      .map((char) => PY_FOLD[char] ?? char)
      .join(""),
  );
  return new RegExp(parts.join("|"), "i");
}
const AUTH_EMSG = pyInsensitive([
  "session expired",
  "invalid access token",
  "invalid session",
  "invalid user id",
  "invalid acct id",
]);

// Python `str.isspace()` characters (what `strip()` removes), not JavaScript `trim()`'s set: the
// information separators U+001C-U+001F and U+0085 count, a BOM does not.
const PY_SPACE_CODES: ReadonlySet<number> = new Set([
  0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);
function isPySpace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) || (code >= 0x2000 && code <= 0x200a) || PY_SPACE_CODES.has(code)
  );
}
function isBlankText(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (!isPySpace(text.charCodeAt(index))) return false;
  }
  return true;
}

/** The text of an error `body`: parsed JSON through the redactor, anything else as text. */
function errorBody(text: string, parsed: { value: unknown } | null): string {
  if (parsed !== null && typeof parsed.value === "object" && parsed.value !== null) {
    return redactedBody(parsed.value);
  }
  return text;
}

/** The parsed body, or `null` when it is not valid JSON (or too deeply nested to parse). */
function tryParse(text: string): { value: unknown } | null {
  try {
    return { value: parseJsonLossless(text) };
  } catch {
    return null;
  }
}

/** What to check after an unknown outcome: `pending_gtts()` for the GTT writes, else `orders()`. */
export function checkHint(endpoint: string): string {
  return GTT_WRITES.has(endpoint) ? "pending_gtts()" : "orders()";
}

function infoFor(endpoint: string): EndpointInfo | null {
  try {
    return canonicalEndpoint(endpoint);
  } catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
}

function has(object: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(object, key);
}
function field(object: Record<string, unknown>, key: string): unknown {
  return has(object, key) ? object[key] : undefined;
}

function statusClass(status: number): typeof APIError | null {
  if (status === 429) return RateLimitError;
  if (status === 401 || status === 403) return AuthenticationError;
  if (status >= 500) return ServerError;
  return null;
}

function build(
  cls: typeof APIError,
  message: string,
  options: APIErrorOptions,
  retryAfter: number | null,
): APIError {
  if (cls === RateLimitError) {
    return new RateLimitError(message, {
      ...options,
      retryAfter: retryAfter !== null && Number.isFinite(retryAfter) ? retryAfter : null,
    });
  }
  const Ctor = cls as new (message: string, options: APIErrorOptions) => APIError;
  return new Ctor(message, options);
}

/** `<Endpoint> failed: <emsg>` or the fixed text for a missing or blank `emsg` (§4.2). */
export function failureMessage(endpoint: string, emsg: string | null): string {
  // Never a raw server value in a message: redacted first (the constructors do not redact it).
  if (emsg !== null && !isBlankText(emsg)) return `${endpoint} failed: ${redactText(emsg)}`;
  return `${endpoint} failed (no error message from the server)`;
}

/**
 * Classify one response (§4.2). Returns the parsed body, or `{ kind: "empty" }` for a `Not_Ok` "no
 * data" reply on an endpoint that allows empty; throws the error of the matching row otherwise.
 */
export function classifyResponse(r: ClassifyInput): ClassifyResult {
  const { endpoint, httpStatus: status, bodyText: text, stateChanging, expect: shape } = r;
  const retryAfter = r.retryAfter ?? null;
  const info = infoFor(endpoint);
  const canonical = info?.endpoint ?? endpoint;
  const ackField = r.requiredAckField ?? info?.requiresAckId ?? null;
  const ownWords =
    ackField !== null ||
    (info !== null && !(info.successWords.length === 1 && info.successWords[0] === "Ok"));

  const unknown = (what: string, parsed: { value: unknown } | null): OrderStatusUnknownError =>
    new OrderStatusUnknownError(
      endpoint,
      `${what} (HTTP ${String(status)}); the request may have been executed, ` +
        `check ${checkHint(canonical)} before retrying`,
      { httpStatus: status, body: errorBody(text, parsed) },
    );
  const parseError = (what: string, parsed: { value: unknown } | null): ResponseParseError =>
    new ResponseParseError(`${endpoint}: ${what}`, {
      endpoint,
      httpStatus: status,
      body: errorBody(text, parsed),
    });
  const statusError = (cls: typeof APIError, raw: unknown): APIError =>
    build(
      cls,
      `${endpoint} failed: HTTP ${String(status)}`,
      { endpoint, httpStatus: status, emsg: null, requestTime: null, raw },
      retryAfter,
    );
  // A read whose body is not usable: the status class when one applies, else a parse error.
  const unexpected = (what: string, parsed: { value: unknown } | null): Error => {
    const cls = statusClass(status);
    if (cls !== null) return statusError(cls, parsed === null ? text : parsed.value);
    return parseError(what, parsed);
  };

  // Rows 1-3: not JSON (a body too deep for the parser counts as not valid JSON).
  const parsed = tryParse(text);
  if (parsed === null) {
    const what = "response is not valid JSON";
    if (stateChanging) throw unknown(what, null);
    throw unexpected(what, null);
  }
  const data = parsed.value;

  if (Array.isArray(data)) {
    // Rows 4-7. An endpoint with its own success words acknowledges with an object.
    if (ownWords || (stateChanging && (status >= 400 || shape === "object"))) {
      throw unknown("expected a JSON object but received a list", parsed);
    }
    if (status >= 400) {
      const cls = statusClass(status) ?? (status === 404 ? NotFoundError : APIError);
      throw statusError(cls, data);
    }
    if (shape === "list" || (r.allowEmpty && data.length === 0)) return { kind: "ok", body: data };
    throw parseError("expected a JSON object but received a list", parsed);
  }

  let what = "unexpected response shape";
  if (typeof data === "object" && data !== null) {
    const object = data as Record<string, unknown>;
    const stat = field(object, "stat");
    // `Invalid Oi` is a definite failure, checked before the success check (§4.2.1).
    if (info !== null && isFailureWord(canonical, stat)) {
      const requestTime = field(object, "request_time");
      throw new OrderRejectedError("Invalid Oi", {
        endpoint,
        httpStatus: status,
        emsg: redactText(stat as string),
        requestTime: typeof requestTime === "string" ? requestTime : null,
        raw: object,
      });
    }
    let success =
      typeof stat === "string" && (info === null ? stat === "Ok" : isSuccessWord(canonical, stat));
    if (success && ackField !== null) {
      const ack = field(object, ackField);
      const emsg = field(object, "emsg");
      if (typeof ack !== "string" || isBlankText(ack)) {
        success = false;
        what = `success word without a non-blank ${ackField}`;
      } else if (
        emsg !== undefined &&
        emsg !== null &&
        !(typeof emsg === "string" && isBlankText(emsg))
      ) {
        success = false;
        what = "success word with an error message";
      }
    }
    if (success) {
      // Rows 8-9.
      if (shape === "object") return { kind: "ok", body: data };
      if (stateChanging) throw unknown("expected a JSON list but received an object", parsed);
      throw parseError("expected a JSON list but received an object", parsed);
    }
    if (stat === "Not_Ok") {
      return notOk(object, ["emsg"], r.allowEmpty && !ownWords);
    }
    if (stat === ICEBERG_FAILURE_STAT && ICEBERG_WRITES.has(canonical)) {
      return notOk(object, ["rejreason", "emsg"], false);
    }
  }

  // Rows 17-18: any other JSON (an object without a valid `stat`, a scalar).
  if (stateChanging) throw unknown(what, parsed);
  throw unexpected(what, parsed);

  /** Rows 10-16: a definite failure; the message text is the first non-blank of `keys`. */
  function notOk(
    object: Record<string, unknown>,
    keys: readonly string[],
    allowEmpty: boolean,
  ): never | ClassifyResult {
    const texts = keys
      .map((key) => field(object, key))
      .filter((value): value is string => typeof value === "string");
    const emsg = texts.find((value) => !isBlankText(value)) ?? texts[0] ?? null;
    if (allowEmpty && emsg !== null && emsg.toLowerCase().includes("no data")) {
      return { kind: "empty" };
    }
    let cls: typeof APIError;
    if (status === 401 || status === 403 || (emsg !== null && AUTH_EMSG.test(emsg))) {
      cls = AuthenticationError;
    } else if (status === 429) {
      cls = RateLimitError;
    } else if (status >= 500) {
      // A JSON Not_Ok is a definitive answer: the order was not accepted.
      cls = stateChanging ? OrderRejectedError : ServerError;
    } else if (status === 404) {
      cls = NotFoundError;
    } else if (stateChanging) {
      cls = OrderRejectedError;
    } else {
      cls = APIError;
    }
    const requestTime = field(object, "request_time");
    throw build(
      cls,
      failureMessage(endpoint, emsg),
      {
        endpoint,
        httpStatus: status,
        emsg: emsg === null ? null : redactText(emsg),
        requestTime: typeof requestTime === "string" ? requestTime : null,
        raw: object,
      },
      retryAfter,
    );
  }
}
