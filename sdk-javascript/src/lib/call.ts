// The one call path every REST method uses (sdk-behaviour.md §2.5, §5.1–5.6, §6.3; design §7.8),
// mirroring sdk-python/src/tradesmart/_transport/async_http.py. Per attempt: closed check, token
// check, rate limit, abort check, build (body bytes and headers), send, classify, decode. Reads
// are retried; state-changing calls are sent at most once. Order calls get one outcome line.
import type { ClientConfig } from "../config.js";
import { ConfigurationError, RateLimitError, TradeSmartError } from "../errors.js";
import { CLOSED_MESSAGE, type HttpTransport } from "../transport/http.js";
import { isHookFailure, mapFailure, TransportFailure } from "../transport/failures.js";
import { classifyResponse, type ClassifyResult } from "./classify.js";
import { encodeJData, type WirePayload } from "./codec.js";
import { noopLogger, type Logger } from "./log.js";
import type { RateGroup } from "./names.js";
import { isOrderEndpoint, OutcomeLog, outcomeId, rawAckId } from "./outcome.js";
import type { Clock, RateLimiter } from "./ratelimit.js";
import { redactObject } from "./redact.js";
import { parseRetryAfter, type RetryPolicy } from "./retry.js";

/** One REST call, fully described before anything is sent. */
export interface CallSpec<T> {
  /** The canonical endpoint name (`PlaceOrder`); sent to `{baseUrl}/{endpoint}`. */
  endpoint: string;
  /** The wire payload in wire key order (`uid` included when the endpoint takes it). */
  payload: WirePayload;
  /** Never retried; ambiguous outcomes are `OrderStatusUnknownError`. */
  stateChanging: boolean;
  expect: "object" | "list";
  /** A `Not_Ok` "no data" reply is the empty signal (`{ kind: "empty" }`), not an error. */
  allowEmpty: boolean;
  rateGroup: RateGroup | null;
  /** Default true: `Authorization: Bearer <token>`. `GenAcsTok` through `generateSession` sends none. */
  authenticated?: boolean;
  /** Turn the classified success into the method's result; may throw (an unparseable order ack: `OrderStatusUnknownError`). */
  decode: (result: ClassifyResult) => T;
  /** The acknowledgement's order id (GTT: alert id) for the outcome line; default: the raw body's. */
  ackId?: (result: T) => unknown;
  signal?: AbortSignal | undefined;
}

/** What a client hands to `executeCall`: its configuration, transport and time sources. */
export interface CallContext {
  readonly config: ClientConfig;
  readonly transport: HttpTransport;
  limiter: RateLimiter;
  policy: RetryPolicy;
  /** Milliseconds; retry back-off sleeps go through it. */
  clock: Clock;
  /** True once the client was closed. */
  isClosed(): boolean;
  /** The bearer token text; throws `AuthenticationError` (missing or expired) so nothing is sent. */
  bearer(): string;
  readonly ordersLog: Logger;
  readonly transportLog: Logger;
}

/** Internal: the property under which a `TradeSmart` keeps its `CallContext` (tests, later tasks). */
export const CALL_CONTEXT: unique symbol = Symbol("tradesmart.callContext");

/** The `CallContext` of a client (not public). */
export function callContext(client: object): CallContext {
  const ctx = (client as { [CALL_CONTEXT]?: CallContext })[CALL_CONTEXT];
  if (ctx === undefined) throw new TypeError("not a TradeSmart client");
  return ctx;
}

/** How far one call got: `sent` once the request was handed to undici (and not proven unsent). */
interface Progress {
  sent: boolean;
  /** `performance.now()` when the request was handed over. */
  sentAt: number;
}

function isAbort(signal: AbortSignal | undefined, error: unknown): boolean {
  return signal !== undefined && signal.aborted && error === signal.reason;
}

/**
 * Execute one call. Order endpoints log one outcome line (§5.6): `accepted` when it returns;
 * `unknown` + WARNING for `OrderStatusUnknownError`; `not_sent` when nothing reached the server
 * (closed client, no or expired token, client-side rate limit, build failure, connect-phase
 * failure); `rejected` for any other SDK error. An abort before the send rejects with the
 * signal's reason and logs nothing; after the send it logs `unknown` + the outcome WARNING and
 * rejects with the reason (design §7.8). Any other non-SDK error after the send is treated the
 * same way (the order may be live).
 */
export async function executeCall<T>(ctx: CallContext, spec: CallSpec<T>): Promise<T> {
  if (!isOrderEndpoint(spec.endpoint)) return run(ctx, spec, { sent: false, sentAt: 0 });
  const outcome = new OutcomeLog(ctx.ordersLog);
  const started = performance.now();
  const progress: Progress = { sent: false, sentAt: 0 };
  let result: T;
  try {
    result = await run(ctx, spec, progress);
  } catch (error) {
    const id = outcomeId(spec.endpoint, spec.payload, null);
    if (error instanceof TradeSmartError && !isAbort(spec.signal, error)) {
      outcome.failure(spec.endpoint, error, progress.sent, id, performance.now() - started);
    } else if (progress.sent) {
      // Interrupted after the hand-over: the order may have been executed. Timed from the send.
      outcome.interrupted(spec.endpoint, id, performance.now() - progress.sentAt);
    }
    throw error;
  }
  outcome.line(spec.endpoint, "accepted", acceptedId(spec, result), performance.now() - started);
  return result;
}

/**
 * The id of an `accepted` line, computed inside a guard: the order was accepted, so a failure
 * here must never reject the call or lose its line (the id is then `-`).
 */
function acceptedId<T>(spec: CallSpec<T>, result: T): string {
  try {
    const ackId = spec.ackId === undefined ? rawAckId(spec.endpoint, result) : spec.ackId(result);
    return outcomeId(spec.endpoint, spec.payload, ackId);
  } catch {
    return "-";
  }
}

async function run<T>(ctx: CallContext, spec: CallSpec<T>, progress: Progress): Promise<T> {
  const signal = spec.signal;
  const url = `${ctx.config.baseUrl}/${spec.endpoint}`;
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    if (ctx.isClosed()) throw new ConfigurationError(CLOSED_MESSAGE);
    const headers: Record<string, string> =
      spec.authenticated === false ? {} : { Authorization: `Bearer ${ctx.bearer()}` };
    // A client-side RateLimitError is raised here, outside the retried block: never retried.
    await ctx.limiter.acquire(spec.rateGroup, spec.endpoint, signal);
    // `acquire(null, ...)` returns without looking at the signal: checked again before sending.
    signal?.throwIfAborted();
    // Built before anything is sent: a RequestValidationError here is definitive (not_sent).
    const body = encodeJData(spec.payload);
    logPayload(ctx, spec);
    try {
      const response = await ctx.transport.send(
        { url, method: "POST", headers, body },
        {
          stateChanging: spec.stateChanging,
          signal,
          onSent: () => {
            progress.sent = true;
            progress.sentAt = performance.now();
          },
        },
      );
      logResponse(ctx, spec, response.status, response.bodyText, progress.sentAt);
      const classified = classifyResponse({
        endpoint: spec.endpoint,
        httpStatus: response.status,
        bodyText: response.bodyText,
        stateChanging: spec.stateChanging,
        expect: spec.expect,
        allowEmpty: spec.allowEmpty,
        retryAfter: parseRetryAfter(response.headers["retry-after"] ?? null, new Date()),
      });
      return spec.decode(classified);
    } catch (caught) {
      if (isAbort(signal, caught)) throw caught;
      let error = caught;
      let retryable = true;
      if (caught instanceof TransportFailure) {
        // A connect-phase failure after the hand-over still proves nothing was sent.
        progress.sent = caught.sent;
        // The caller's own dispatcher raised it: deterministic, never retried (§5.1).
        retryable = !isHookFailure(caught.kind);
        error = mapFailure(caught.kind, spec.stateChanging, spec.endpoint, caught);
      }
      if (
        !(error instanceof TradeSmartError) ||
        !retryable ||
        !ctx.policy.shouldRetry(attempt, error, spec.stateChanging)
      ) {
        throw error;
      }
      const retryAfter = error instanceof RateLimitError ? error.retryAfter : null;
      // RetryPolicy.delay is in seconds; the Clock sleeps in milliseconds.
      await ctx.clock.sleep(ctx.policy.delay(attempt, retryAfter) * 1000, signal);
    }
  }
}

/** DEBUG `POST /<Endpoint> payload=<redacted JSON>`, only with `logPayloads` (§13). */
function logPayload<T>(ctx: CallContext, spec: CallSpec<T>): void {
  if (!ctx.config.logPayloads) return;
  const shown = JSON.stringify(redactObject(Object.fromEntries(spec.payload)));
  ctx.transportLog.debug(`POST /${spec.endpoint} payload=${shown}`);
}

/** DEBUG `POST /<Endpoint> -> HTTP <status> stat=<stat> in <ms> ms`; never the body. */
function logResponse<T>(
  ctx: CallContext,
  spec: CallSpec<T>,
  status: number,
  bodyText: string,
  sentAt: number,
): void {
  if (ctx.config.logger === noopLogger) return; // no second parse of every body for nothing
  let stat = "None";
  try {
    const data: unknown = JSON.parse(bodyText);
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      const value = (data as Record<string, unknown>)["stat"];
      if (typeof value === "string") stat = value;
    }
  } catch {
    // Not JSON: no stat to show.
  }
  const elapsed = String(Math.round(Math.max(0, performance.now() - sentAt)));
  ctx.transportLog.debug(
    `POST /${spec.endpoint} -> HTTP ${String(status)} stat=${stat} in ${elapsed} ms`,
  );
}
