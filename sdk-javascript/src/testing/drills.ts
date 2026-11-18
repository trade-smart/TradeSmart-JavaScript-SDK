// Failure drills (sdk-behaviour.md §16; Python: testing/drills.py): arm one with
// `broker.failNext(endpoint, drill)`. Each fires once, on the next call of that endpoint, and is
// raised at once (no test waits for a real timeout).

/** What an armed drill does when its endpoint is called. */
export type DrillKind =
  | "reject"
  | "timeout_after_send"
  | "connect_error"
  | "rate_limit"
  | "server_error"
  | "bad_body"
  | "session_expired";

/** One armed failure; build it with the functions of `drills`. */
export interface Drill {
  readonly kind: DrillKind;
  /** The `emsg` of a `reject` drill; empty for the others. */
  readonly message: string;
  /** The HTTP status of a `server_error` drill; 0 for the others. */
  readonly status: number;
  /** Seconds for the `Retry-After` header of a `rate_limit` drill, or `null`. */
  readonly retryAfter: number | null;
  /** A `server_error` drill sends a JSON `Not_Ok` body instead of an HTML page. */
  readonly json: boolean;
}

// Every drill built here is remembered, so `failNext` can refuse anything else (a drill function
// passed without being called, a plain object) with a clear error.
const BUILT = new WeakSet<object>();

function build(kind: DrillKind, fields: Partial<Omit<Drill, "kind">> = {}): Drill {
  const frozen = Object.freeze<Drill>({
    kind,
    message: "",
    status: 0,
    retryAfter: null,
    json: false,
    ...fields,
  });
  BUILT.add(frozen);
  return frozen;
}

/** True for a drill built by the functions of `drills`. */
export function isDrill(value: unknown): value is Drill {
  return typeof value === "object" && value !== null && BUILT.has(value);
}

/** The server answers `Not_Ok` with `message` as `emsg`. */
function reject(message: string): Drill {
  return build("reject", { message });
}

/** The call takes effect (an order IS placed) but the client gets a read timeout. */
function timeoutAfterSend(): Drill {
  return build("timeout_after_send");
}

/** The connection fails before anything is sent; nothing takes effect and nothing is recorded. */
function connectError(): Drill {
  return build("connect_error");
}

/**
 * HTTP 429 with a JSON `Not_Ok` body (assumed shape), and a `Retry-After` header when
 * `retryAfter` (seconds) is given.
 */
function rateLimit(retryAfter?: number): Drill {
  return build("rate_limit", { retryAfter: retryAfter ?? null });
}

/**
 * An HTTP server error with this status (default 503). By default the body is an HTML gateway
 * page, as a real gateway 5xx normally is: on an order the outcome is unknown
 * (`OrderStatusUnknownError`). `json: true` sends a JSON `Not_Ok` body instead (assumed shape):
 * on an order, a definite rejection (`OrderRejectedError`).
 */
function serverError(status = 503, options: { json?: boolean } = {}): Drill {
  return build("server_error", { status, json: options.json ?? false });
}

/** A reply body that is not JSON. */
function badBody(): Drill {
  return build("bad_body");
}

/** `Not_Ok` "Session Expired": the login is no longer valid. */
function sessionExpired(): Drill {
  return build("session_expired");
}

/** The drill builders; arm one with `broker.failNext(endpoint, drills.reject("..."))`. */
export const drills = Object.freeze({
  reject,
  timeoutAfterSend,
  connectError,
  rateLimit,
  serverError,
  badBody,
  sessionExpired,
});
