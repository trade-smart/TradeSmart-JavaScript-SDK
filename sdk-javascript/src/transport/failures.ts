// Send-failure classification and mapping (sdk-behaviour.md §5.1, §5.2, §13; vector
// transport_failures.json). Only failures that prove nothing reached the server are definitive
// for a state-changing call; everything else that can happen after the request was handed to
// undici is `OrderStatusUnknownError`. No error built here keeps the underlying error's message
// or chains it as `cause`: it can hold the URL, the request headers or a raw body.
import {
  ConfigurationError,
  NetworkError,
  OrderStatusUnknownError,
  RequestTimeoutError,
  TradeSmartError,
} from "../errors.js";
import { checkHint } from "../lib/classify.js";

/**
 * What went wrong while sending. The vector kinds of transport_failures.json, plus
 * `build_error` (the request could not be built; nothing was sent, §5.2) and `transport_error`
 * (any other HTTP-library transport error: unknown for a write, a retryable `NetworkError` for
 * a read). `write_timeout` is never produced by undici (it has no separate write timeout; the
 * headers timeout covers the write) but is mapped like the vector says.
 */
export type TransportFailureKind =
  | "build_error"
  | "pool_timeout"
  | "connect_error"
  | "connect_timeout"
  | "read_timeout"
  | "write_timeout"
  | "connection_reset"
  | "remote_protocol_error"
  | "decoding_error"
  | "transport_error"
  | "hook_exception"
  | "hook_sdk_error";

/**
 * Where the failure was seen. `pool`: waiting for an SDK permit (before the request was handed
 * to undici). `connect` and `sent`: after it was handed over; they classify identically, by the
 * error code alone, because a dispatcher's own report of "not yet written" (an injected one
 * especially) is not proof that nothing was sent.
 */
export type SendPhase = "pool" | "connect" | "sent";

/** The SDK's pool-wait semaphore gave no permit in time. Nothing was sent. */
export class PoolWaitTimeout extends Error {
  override name = "PoolWaitTimeout";
  constructor() {
    super("timed out waiting for a free connection");
  }
}

/**
 * Error code → kind. A code is matched whatever raised it: a transport error raised by the
 * caller's own dispatcher (an interceptor throwing an `ECONNREFUSED`) is mapped like undici's
 * own (§5.1).
 *
 * Only codes that can occur solely while connecting are `connect_*` here: refused connections,
 * DNS failures, undici's connect timeout and certificate verification during the TLS handshake.
 * Besides, any system error with `syscall === "connect"` is connect-phase (Node sets that only
 * when connect(2) failed, before any request byte; see `classifySendFailure`). The same codes
 * from a live socket (`read`/`write`: EHOSTUNREACH, ENETUNREACH, EADDRNOTAVAIL, ETIMEDOUT) and
 * non-certificate TLS errors (`ERR_SSL_*`) stay `transport_error`, ambiguous for a write.
 */
const CODE_KINDS: ReadonlyMap<string, TransportFailureKind> = new Map<string, TransportFailureKind>(
  [
    // Connect refused / DNS: no connection, nothing sent.
    ["ECONNREFUSED", "connect_error"],
    ["ENOTFOUND", "connect_error"],
    ["EAI_AGAIN", "connect_error"],
    ["EAI_FAIL", "connect_error"],
    ["EAI_NODATA", "connect_error"],
    ["EAI_NONAME", "connect_error"],
    // TLS certificate verification (handshake only, before any request byte).
    ["ERR_TLS_CERT_ALTNAME_INVALID", "connect_error"],
    ["CERT_HAS_EXPIRED", "connect_error"],
    ["CERT_NOT_YET_VALID", "connect_error"],
    ["CERT_REVOKED", "connect_error"],
    ["CERT_UNTRUSTED", "connect_error"],
    ["CERT_REJECTED", "connect_error"],
    ["CERT_SIGNATURE_FAILURE", "connect_error"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "connect_error"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "connect_error"],
    ["UNABLE_TO_GET_ISSUER_CERT", "connect_error"],
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "connect_error"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "connect_error"],
    ["HOSTNAME_MISMATCH", "connect_error"],
    // undici's connect timeout (the `connect.timeout` option): nothing sent.
    ["UND_ERR_CONNECT_TIMEOUT", "connect_timeout"],
    // Waiting for the response: the request may have been executed.
    ["UND_ERR_HEADERS_TIMEOUT", "read_timeout"],
    ["UND_ERR_BODY_TIMEOUT", "read_timeout"],
    // The connection broke after the request was handed over.
    ["ECONNRESET", "connection_reset"],
    ["EPIPE", "connection_reset"],
    ["UND_ERR_SOCKET", "connection_reset"],
    // The reply broke the HTTP protocol (HPE_* codes are matched by prefix below).
    ["UND_ERR_HEADERS_OVERFLOW", "remote_protocol_error"],
    ["UND_ERR_RES_CONTENT_LENGTH_MISMATCH", "remote_protocol_error"],
    ["UND_ERR_INFO", "remote_protocol_error"],
    // A body that could not be decoded (a decompress interceptor, or a fatal text decoder).
    ["Z_DATA_ERROR", "decoding_error"],
    ["Z_BUF_ERROR", "decoding_error"],
    ["Z_NEED_DICT", "decoding_error"],
    ["ERR_ENCODING_INVALID_ENCODED_DATA", "decoding_error"],
  ],
);

// undici marks its errors with these registered symbols (also across undici copies).
const UNDICI_ERROR = Symbol.for("undici.error.UND_ERR");
const UNDICI_PARSER_ERROR = Symbol.for("undici.error.UND_ERR_HTTP_PARSER");

function marked(err: object, mark: symbol): boolean {
  return (err as Record<symbol, unknown>)[mark] === true;
}

function codeOf(err: object): string | null {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** A Node system error (`errno`/`syscall` set), e.g. from `net`, `tls` or `dns`. */
function isSystemError(err: object): boolean {
  const e = err as { errno?: unknown; syscall?: unknown };
  return typeof e.errno === "number" || typeof e.syscall === "string";
}

/** Kinds that prove the request never reached the server. */
const NOT_SENT_KINDS: ReadonlySet<TransportFailureKind> = new Set([
  "build_error",
  "pool_timeout",
  "connect_error",
  "connect_timeout",
]);

/** Classify an error raised while sending a request (see `CODE_KINDS`). */
export function classifySendFailure(err: unknown, phase: SendPhase): TransportFailureKind {
  if (phase === "pool" && err instanceof PoolWaitTimeout) return "pool_timeout";
  if (err instanceof TradeSmartError) return "hook_sdk_error";
  if (typeof err !== "object" || err === null) return "hook_exception";
  const code = codeOf(err);
  if (code !== null && (err as { syscall?: unknown }).syscall === "connect") {
    // connect(2) failed: no connection, nothing sent (Python: httpx.ConnectError / ConnectTimeout).
    return code === "ETIMEDOUT" ? "connect_timeout" : "connect_error";
  }
  if (code !== null) {
    const kind = CODE_KINDS.get(code);
    if (kind !== undefined) return kind;
    if (code.startsWith("HPE_")) return "remote_protocol_error";
    if (code.startsWith("ERR_SSL_")) return "transport_error";
  }
  if (marked(err, UNDICI_PARSER_ERROR)) return "remote_protocol_error";
  if (marked(err, UNDICI_ERROR) || isSystemError(err)) return "transport_error";
  // Anything else came from the caller's own dispatcher or interceptor (or a bug): deterministic.
  return "hook_exception";
}

/** The caller's own dispatcher raised it: deterministic, so a read is never retried (§5.1). */
export function isHookFailure(kind: TransportFailureKind): boolean {
  return kind === "hook_exception" || kind === "hook_sdk_error";
}

const TYPE_NAME = /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/;

/** The error's type name for messages: a plain identifier or `"Error"`; never its text. */
function typeNameOf(err: unknown): string {
  if (typeof err !== "object" || err === null) return typeof err === "string" ? "string" : "Error";
  const name = (err as { name?: unknown }).name;
  if (typeof name === "string" && TYPE_NAME.test(name)) return name;
  const ctor = (err as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof ctor === "string" && TYPE_NAME.test(ctor) ? ctor : "Error";
}

/** Details `mapFailure` may use: the underlying type name and the caller's own SDK error. */
export interface FailureDetail {
  readonly typeName?: string;
  readonly sdkError?: TradeSmartError | null;
}

/**
 * A failed send, as the transport reports it. Keeps only the kind, whether the request may
 * have reached the server, and the underlying type name; never the underlying message or
 * `cause`. `sdkError` holds an SDK error raised by the caller's own dispatcher (passed through
 * unchanged on a read, §5.1).
 */
export class TransportFailure extends Error {
  override name = "TransportFailure";
  readonly kind: TransportFailureKind;
  /** The request may have reached the server (it was handed to undici and the kind is not a "nothing sent" one). */
  readonly sent: boolean;
  /** The underlying error's type name (for `build_error`: a fixed reason phrase). Never a value. */
  readonly typeName: string;
  readonly sdkError: TradeSmartError | null;

  constructor(
    kind: TransportFailureKind,
    handedOver: boolean,
    typeName: string,
    sdkError: TradeSmartError | null = null,
  ) {
    super(`transport failure: ${kind} (${typeName})`);
    this.kind = kind;
    this.sent = handedOver && !NOT_SENT_KINDS.has(kind);
    this.typeName = typeName;
    this.sdkError = sdkError;
  }

  /** Classify `err` seen in `phase`; `pool` means the request was not handed over. */
  static from(err: unknown, phase: SendPhase): TransportFailure {
    const kind = classifySendFailure(err, phase);
    return new TransportFailure(
      kind,
      phase !== "pool",
      typeNameOf(err),
      err instanceof TradeSmartError ? err : null,
    );
  }
}

/**
 * The SDK error for a failed send (§5.1, §5.2; transport_failures.json). Messages name the
 * endpoint and the underlying type only.
 */
export function mapFailure(
  kind: TransportFailureKind,
  stateChanging: boolean,
  endpoint: string,
  detail: FailureDetail = {},
): TradeSmartError {
  const typeName = detail.typeName ?? "Error";
  switch (kind) {
    case "build_error":
      return new ConfigurationError(
        `${endpoint}: the request could not be built (${typeName}); check the access token, ` +
          "user_agent and the request headers; nothing was sent",
      );
    case "connect_timeout":
      return new RequestTimeoutError(`${endpoint}: connect timed out`);
    case "connect_error":
      return new NetworkError(`${endpoint}: could not connect (${typeName})`);
    case "pool_timeout":
      return new RequestTimeoutError(
        `${endpoint}: timed out waiting for a free connection; nothing was sent`,
      );
    case "hook_exception":
    case "hook_sdk_error":
      if (stateChanging) {
        return new OrderStatusUnknownError(
          endpoint,
          `${typeName} during the request; check ${checkHint(endpoint)} before retrying`,
        );
      }
      if (kind === "hook_sdk_error" && detail.sdkError) return detail.sdkError;
      return new NetworkError(`${endpoint}: unexpected error (${typeName})`);
    case "read_timeout":
    case "write_timeout":
    case "connection_reset":
    case "remote_protocol_error":
    case "decoding_error":
    case "transport_error":
      if (stateChanging) {
        return new OrderStatusUnknownError(
          endpoint,
          `${typeName} after the request may have been sent; check ${checkHint(endpoint)} before retrying`,
        );
      }
      return kind === "read_timeout" || kind === "write_timeout"
        ? new RequestTimeoutError(`${endpoint}: request timed out`)
        : new NetworkError(`${endpoint}: network error (${typeName})`);
  }
}
