// The HTTP transport (sdk-behaviour.md §3.1, §3.3, §5.2, §2.2; design §7.4). One undici
// `Agent` per client (a `Pool` per origin: the REST host and the script-master host) unless the
// caller injects a dispatcher, which is used as is and never closed. Redirects are refused on
// every request; an SDK semaphore in front of the pool gives the pool-wait timeout; every
// request is fully built before it is handed to undici. Config values are seconds; undici and
// timers take milliseconds.
import { Agent, type Dispatcher } from "undici";
import { type ClientConfig, headerUserAgent } from "../config.js";
import { ConfigurationError } from "../errors.js";
import { PoolWaitTimeout, TransportFailure } from "./failures.js";

/** A request ready to send: URL, headers (no `User-Agent`; the transport sets it) and body bytes. */
export interface PreparedRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array | null;
  method: "POST" | "GET";
}

export interface SendOptions {
  /** State-changing calls wait at most `connectTimeout` for a pool permit, reads `readTimeout`. */
  stateChanging: boolean;
  /** Aborting rejects with `signal.reason` (before the send nothing is sent). */
  signal?: AbortSignal | undefined;
  /** Called once, synchronously, right after the request was handed to undici. Must not throw. */
  onSent?: (() => void) | undefined;
}

export interface TransportResponse {
  status: number;
  /** Lower-case names; repeated headers joined with `", "`. */
  headers: Record<string, string>;
  /** The body as UTF-8 text (invalid bytes replaced, like the reference). */
  bodyText: string;
  bodyBytes: Uint8Array;
}

export const CLOSED_MESSAGE = "client is closed; create a new client";

/** The longest delay a Node timer takes (2^31 - 1 ms); a longer one fires after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Seconds to whole milliseconds for undici and timers, clamped to [1, 2^31 - 1]: undici reads 0
 * as "no timeout", and a Node timer beyond 2^31 - 1 ms fires at once.
 */
const ms = (seconds: number): number =>
  Math.min(MAX_TIMER_MS, Math.max(1, Math.round(seconds * 1000)));

// RFC 9110 token for header names; values: printable ASCII and tab (no CR, LF, NUL, DEL or
// non-ASCII), so a header can never be split or injected (§13).
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

/** A FIFO semaphore of `size` permits with a per-acquire timeout and abort. */
class Permits {
  private free: number;
  private readonly waiters: ((release: () => void) => void)[] = [];

  constructor(size: number) {
    this.free = size;
  }

  /** Resolve with a release function; reject with `PoolWaitTimeout` or `signal.reason`. */
  acquire(timeoutMs: number, signal?: AbortSignal): Promise<() => void> {
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise<() => void>((resolve, reject) => {
      const grant = (release: () => void): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(release);
      };
      const leave = (): void => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        clearTimeout(timer);
        leave();
        // The abort reason is whatever the caller passed to abort(); it is re-raised unchanged.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        leave();
        reject(new PoolWaitTimeout());
      }, timeoutMs);
      this.waiters.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** A release function that gives the permit back once (to the next waiter, if any). */
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next === undefined) this.free += 1;
      else next(this.releaser());
    };
  }
}

type Built = Dispatcher.RequestOptions & { maxRedirections: 0 };

export class HttpTransport {
  private readonly cfg: ClientConfig;
  private readonly dispatcher: Dispatcher;
  private readonly owned: boolean;
  private readonly permits: Permits;
  private readonly userAgent: string;
  private closed = false;

  constructor(cfg: ClientConfig, dispatcher?: Dispatcher) {
    this.cfg = cfg;
    this.owned = dispatcher === undefined;
    this.dispatcher =
      dispatcher ??
      new Agent({
        connections: cfg.maxConnections,
        // undici has no "max idle connections" (maxKeepaliveConnections); the SDK permits cap
        // the total at maxConnections.
        keepAliveTimeout: ms(cfg.keepaliveExpiry),
        keepAliveMaxTimeout: ms(cfg.keepaliveExpiry),
        headersTimeout: ms(cfg.readTimeout),
        bodyTimeout: ms(cfg.readTimeout),
        connect: { timeout: ms(cfg.connectTimeout) },
      });
    this.permits = new Permits(cfg.maxConnections);
    this.userAgent = headerUserAgent(cfg);
  }

  /**
   * Send `req` once (never retried here). Rejects with `ConfigurationError` after `close()`,
   * `signal.reason` on abort, or a `TransportFailure` (see failures.ts).
   */
  async send(req: PreparedRequest, opts: SendOptions): Promise<TransportResponse> {
    if (this.isClosed()) throw new ConfigurationError(CLOSED_MESSAGE);
    const signal = opts.signal;
    signal?.throwIfAborted();
    const built = this.build(req, signal);

    const waitMs = ms(opts.stateChanging ? this.cfg.connectTimeout : this.cfg.readTimeout);
    let release: () => void;
    try {
      release = await this.permits.acquire(waitMs, signal);
    } catch (e) {
      signal?.throwIfAborted();
      throw TransportFailure.from(e, "pool");
    }

    try {
      signal?.throwIfAborted();
      // close() may have run while this send waited for its permit: never hand it to a closed
      // pool (nothing is sent; an order logs not_sent, §5.6).
      if (this.isClosed()) throw new ConfigurationError(CLOSED_MESSAGE);
      let pending: Promise<Dispatcher.ResponseData>;
      try {
        pending = this.dispatcher.request(built);
      } catch (e) {
        // A dispatcher that throws synchronously may already have written: classified below
        // as after the send. The original value is kept for classification.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        pending = Promise.reject(e);
      }
      void pending.catch(() => undefined); // handled below; never an unhandled rejection
      try {
        opts.onSent?.();
      } catch (e) {
        void pending.then(
          (r) => r.body.dump(),
          () => undefined,
        );
        throw e;
      }
      try {
        const res = await pending;
        const bodyBytes = new Uint8Array(await res.body.arrayBuffer());
        return {
          status: res.statusCode,
          headers: flattenHeaders(res.headers),
          bodyText: new TextDecoder("utf-8").decode(bodyBytes),
          bodyBytes,
        };
      } catch (e) {
        signal?.throwIfAborted();
        throw TransportFailure.from(e, "sent");
      }
    } finally {
      release();
    }
  }

  /**
   * True after `close()`, and when the dispatcher itself was closed or destroyed (also an
   * injected one the caller closed, §2.2).
   */
  isClosed(): boolean {
    if (this.closed) return true;
    const d = this.dispatcher as { closed?: unknown; destroyed?: unknown };
    return d.closed === true || d.destroyed === true;
  }

  /** Release the SDK's own pool (idempotent). An injected dispatcher is never closed. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.owned) await this.dispatcher.close();
  }

  /** Every check before anything is sent (§5.2): a failure is `build_error`, nothing sent. */
  private build(req: PreparedRequest, signal: AbortSignal | undefined): Built {
    const fail = (reason: string): TransportFailure =>
      new TransportFailure("build_error", false, reason);
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      throw fail("invalid URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw fail("invalid URL");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HEADER_NAME.test(name)) throw fail("a header name is not a valid token");
      if (!HEADER_VALUE.test(value)) throw fail("a header value is not printable ASCII");
      if (name.toLowerCase() !== "user-agent") headers[name] = value;
    }
    headers["user-agent"] = this.userAgent;
    const built: Built = {
      origin: url.origin,
      path: `${url.pathname}${url.search}`,
      method: req.method,
      headers,
      body: req.body,
      headersTimeout: ms(this.cfg.readTimeout),
      bodyTimeout: ms(this.cfg.readTimeout),
      // Never follow a redirect, also through an injected redirect-following dispatcher (§3.1).
      maxRedirections: 0,
    };
    if (signal !== undefined) built.signal = signal;
    return built;
  }
}

function flattenHeaders(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}
