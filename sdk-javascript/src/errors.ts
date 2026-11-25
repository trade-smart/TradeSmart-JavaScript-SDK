// The error taxonomy (sdk-behaviour.md §4.1). Bodies and `raw` are redacted and truncated on
// construction (§13). No error chains a `cause`: on the REST path it could hold raw values or
// the request headers.
import { BODY_LIMIT, redactObject, redactText } from "./lib/redact.js";
import type { SlicedOrderResult } from "./models/generated/orders.js";

/** Base class of every error raised by this SDK. */
export class TradeSmartError extends Error {
  override name = "TradeSmartError";
}

/** Bad configuration, missing keys, a closed client or a bad `request()` name. Nothing was sent. */
export class ConfigurationError extends TradeSmartError {
  override name = "ConfigurationError";
}

/** One failed client-side check. `msg` never contains the value. */
export interface ValidationIssue {
  /** Short machine-readable kind, for example `value_error`, `enum`, `greater_than_equal`. */
  type: string;
  /** The wire path of the failing field (for example `["qty"]` or `["oivariable", 0, "d"]`); empty for a cross-field rule. */
  loc: readonly (string | number)[];
  msg: string;
}

/** Request parameters failed client-side validation. Nothing was sent. */
export class RequestValidationError extends TradeSmartError {
  override name = "RequestValidationError";
  readonly errors: readonly ValidationIssue[];

  constructor(errors: readonly ValidationIssue[]) {
    const names = errors.map((issue) => (issue.loc.length > 0 ? issue.loc.join(".") : issue.msg));
    super(`Invalid request parameters: ${names.join(", ")}`);
    this.errors = Object.freeze(
      errors.map((issue) => Object.freeze({ ...issue, loc: Object.freeze([...issue.loc]) })),
    );
  }
}

/** A `RequestValidationError` for one field (`loc` is its wire key); `msg` must not hold the value. */
export function fieldError(field: string, type: string, msg: string): RequestValidationError {
  return new RequestValidationError([{ type, loc: [field], msg }]);
}

/** More than 1000 stream subscriptions were requested. */
export class SubscriptionLimitError extends TradeSmartError {
  override name = "SubscriptionLimitError";
}

/** Base class of network-level failures. */
export class TransportError extends TradeSmartError {
  override name = "TransportError";
}

/** The connection could not be established or was lost. */
export class NetworkError extends TransportError {
  override name = "NetworkError";
}

/** The request timed out. */
export class RequestTimeoutError extends TransportError {
  override name = "RequestTimeoutError";
}

/** Details of an `OrderStatusUnknownError`. */
export interface OrderStatusUnknownOptions {
  httpStatus?: number | null;
  body?: string | null;
  slicedResult?: SlicedOrderResult | null;
}

/**
 * A state-changing request may or may not have been executed by the server. `httpStatus` and
 * `body` (redacted, at most 2000 characters) are set when a response was received;
 * `slicedResult` holds the partial result of `placeSlicedOrder` when one slice had this outcome.
 */
export class OrderStatusUnknownError extends TradeSmartError {
  override name = "OrderStatusUnknownError";
  readonly endpoint: string;
  readonly httpStatus: number | null;
  readonly body: string | null;
  slicedResult: SlicedOrderResult | null;

  constructor(endpoint: string, message: string, options: OrderStatusUnknownOptions = {}) {
    super(`${endpoint}: order status unknown: ${message}`);
    this.endpoint = endpoint;
    this.httpStatus = options.httpStatus ?? null;
    this.body = options.body == null ? null : redactText(options.body, BODY_LIMIT);
    this.slicedResult = options.slicedResult ?? null;
  }
}

/** Details of an `APIError`. */
export interface APIErrorOptions {
  endpoint: string;
  httpStatus: number | null;
  emsg?: string | null;
  requestTime?: string | null;
  /** The response body; stored redacted. */
  raw?: unknown;
}

/** The API answered with an error (`stat` other than the success word, or an HTTP error). */
export class APIError extends TradeSmartError {
  override name = "APIError";
  readonly endpoint: string;
  readonly httpStatus: number | null;
  readonly emsg: string | null;
  readonly requestTime: string | null;
  readonly raw: unknown;

  constructor(message: string, options: APIErrorOptions) {
    super(message);
    this.endpoint = options.endpoint;
    this.httpStatus = options.httpStatus;
    this.emsg = options.emsg ?? null;
    this.requestTime = options.requestTime ?? null;
    this.raw = options.raw === undefined || options.raw === null ? null : redactObject(options.raw);
  }
}

/** Missing, invalid or expired credentials. */
export class AuthenticationError extends APIError {
  override name = "AuthenticationError";
}

/** The API rate limit was exceeded (server 429 or the client limiter). */
export class RateLimitError extends APIError {
  override name = "RateLimitError";
  /** Seconds to wait, when known. */
  readonly retryAfter: number | null;

  constructor(message: string, options: APIErrorOptions & { retryAfter?: number | null }) {
    super(message, options);
    this.retryAfter = options.retryAfter ?? null;
  }
}

/** HTTP 404. */
export class NotFoundError extends APIError {
  override name = "NotFoundError";
}

/** HTTP 5xx on a read. */
export class ServerError extends APIError {
  override name = "ServerError";
}

/** `Not_Ok` on a state-changing call: the request was not accepted. */
export class OrderRejectedError extends APIError {
  override name = "OrderRejectedError";
}

/** Details of a `ResponseParseError`. */
export interface ResponseParseOptions {
  endpoint: string;
  httpStatus: number | null;
  /** The response body; stored redacted and truncated to 2000 characters. */
  body: string;
  /** Model whose record failed (model parsing only). */
  model?: string | null;
  /** Wire keys (dotted paths into nested records) of the failing fields; never values. */
  fields?: readonly string[];
  /** Whether a protected identity key (`norenordno`, `status`, `al_id`) failed. */
  protectedKey?: boolean;
}

/** The response body was not the expected JSON, or a record could not be parsed. */
export class ResponseParseError extends TradeSmartError {
  override name = "ResponseParseError";
  readonly endpoint: string;
  readonly httpStatus: number | null;
  readonly body: string;
  readonly model: string | null;
  readonly fields: readonly string[];
  readonly protectedKey: boolean;

  constructor(message: string, options: ResponseParseOptions) {
    super(message);
    this.endpoint = options.endpoint;
    this.httpStatus = options.httpStatus;
    this.body = redactText(options.body, BODY_LIMIT);
    this.model = options.model ?? null;
    this.fields = Object.freeze([...(options.fields ?? [])]);
    this.protectedKey = options.protectedKey ?? false;
  }
}
