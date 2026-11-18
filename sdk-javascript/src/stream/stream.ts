// The public WebSocket stream (sdk-behaviour.md §2.6, §9; design §7.6): one class with callbacks
// in the constructor options and `for await (const msg of stream)`. The connection (Task 16)
// reads, authenticates, reconnects and keeps snapshots; delivery to user code runs in its own
// dispatch loop (delivery.ts) so a slow callback never delays reading, heartbeats or reconnects.
import { inspect } from "node:util";
import { AccessToken } from "../auth.js";
import type { TradeSmart } from "../client.js";
import { ClientConfig, type ClientConfigInit } from "../config.js";
import { resolveFromEnv } from "../env.js";
import { ConfigurationError, RequestTimeoutError, TradeSmartError } from "../errors.js";
import { callContext } from "../lib/call.js";
import { JsonNumber } from "../lib/json.js";
import { makeLog } from "../lib/log.js";
import { systemClock, type Clock } from "../lib/ratelimit.js";
import { StreamConnection, type StreamSink } from "./connection.js";
import {
  Delivery,
  insideCallbackOf,
  type InboundStreamMessage,
  type StreamCallbacks,
} from "./delivery.js";
import type { InstrumentKey, InstrumentsArg } from "./protocol.js";
import { StreamState } from "./state.js";

export type {
  InboundStreamMessage,
  StreamCallback,
  StreamCallbacks,
  StreamEventCallback,
} from "./delivery.js";
export type { InstrumentKey, InstrumentsArg } from "./protocol.js";
export { StreamState };

/** Options of `new TradeSmartStream(clientId, accessToken, options)`. */
export interface StreamOptions extends StreamCallbacks {
  /** Default: `new ClientConfig()`; `fromClient` uses the client's. */
  config?: ClientConfig | ClientConfigInit | undefined;
}

/** Options of `TradeSmartStream.fromEnv()`. */
export interface StreamFromEnvOptions extends StreamOptions {
  /** Default `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
}

/** Options of `connect()`. */
export interface StreamConnectOptions {
  /** Milliseconds until `RequestTimeoutError`; default `(2 × wsAuthTimeout + 5) × 1000`. */
  timeoutMs?: number | undefined;
}

/** A snapshot value: wire text (a JSON number as its exact text), never a float. */
export type SnapshotValue =
  string | boolean | null | readonly SnapshotValue[] | { readonly [key: string]: SnapshotValue };

/** Internal: injected time and randomness (tests). Not part of the public API. */
export interface StreamInternals {
  clock?: Clock;
  random?: () => number;
  now?: () => Date;
}

const STREAM_INTERNALS: unique symbol = Symbol("tradesmart.streamInternals");

/** Internal (tests): `options` carrying injected time and randomness for the stream. */
export function withStreamInternals<T extends StreamOptions>(
  options: T,
  internals: StreamInternals,
): T {
  const copy = { ...options };
  Object.defineProperty(copy, STREAM_INTERNALS, { value: internals, enumerable: false });
  return copy;
}

function toConfig(config: ClientConfig | ClientConfigInit | undefined): ClientConfig {
  return config instanceof ClientConfig ? config : ClientConfig.create(config ?? {});
}

/** A wire value as snapshot text: a `JsonNumber` becomes its exact source text. */
function toSnapshotValue(value: unknown): SnapshotValue {
  if (value instanceof JsonNumber) return value.text;
  if (typeof value === "string" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map(toSnapshotValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toSnapshotValue(v)]),
    );
  }
  return null; // a JSON value is never anything else
}

/**
 * The TradeSmart WebSocket stream. Single-use: `connect()` once, `close()` when done.
 *
 * Callbacks (`onMessage`, `onTouchline`, `onDepth`, `onOrderUpdate`, `onPosition`, `onConnect`,
 * `onDisconnect`, `onReconnect`, `onError`) run one at a time in arrival order in one dispatch
 * loop; a returned Promise is awaited before the next. `onStateChange` runs out of band. A
 * callback that throws or rejects is logged and passed to `onError`; it never stops the stream.
 * `for await (const msg of stream)` yields the same messages (start iterating before
 * subscribing: messages are buffered only for an active consumer). `await stream.closed` waits
 * for the end: it resolves (never rejects) with null after `close()`, or with the terminal error.
 */
export class TradeSmartStream {
  readonly clientId: string;
  readonly config: ClientConfig;
  readonly #connection: StreamConnection;
  readonly #delivery: Delivery;
  readonly #clock: Clock;
  readonly #closed: Promise<Error | null>;
  #settleClosed: (value: Error | null) => void = () => undefined;
  #connectCalled = false;
  #afterClose: Promise<void> | null = null;

  constructor(clientId: string, accessToken: string | AccessToken, options: StreamOptions = {}) {
    this.clientId = clientId;
    this.config = toConfig(options.config);
    const internals = (options as { [STREAM_INTERNALS]?: StreamInternals })[STREAM_INTERNALS] ?? {};
    this.#clock = internals.clock ?? systemClock;
    this.#closed = new Promise<Error | null>((resolve) => {
      this.#settleClosed = resolve;
    });
    const log = makeLog(this.config.logger, "tradesmart.stream");
    this.#delivery = new Delivery(this, options, this.config.streamBacklogLimit, log, this.#clock);
    const delivery = this.#delivery;
    const sink: StreamSink = {
      message: (parsed) => {
        delivery.message(parsed);
      },
      stateChange: (state) => {
        delivery.stateChange(state);
      },
      closed: (error) => {
        delivery.ended(error);
        // A terminal error: `closed` resolves once its messages and `onError` were delivered.
        if (error !== null) {
          void delivery.loopDone.then(() => {
            this.#settleClosed(error);
          });
        }
      },
    };
    this.#connection = new StreamConnection({
      clientId,
      accessToken,
      config: this.config,
      sink,
      clock: this.#clock,
      ...(internals.random === undefined ? {} : { random: internals.random }),
      ...(internals.now === undefined ? {} : { now: internals.now }),
    });
  }

  /**
   * Build a stream from the `TRADESMART_*` variables or the saved login, like
   * `TradeSmart.fromEnv()` (§6.4) but ignoring `TRADESMART_APP_KEY`: a stream cannot log in.
   */
  static fromEnv(options: StreamFromEnvOptions = {}): TradeSmartStream {
    const { env, ...rest } = options;
    const config = toConfig(options.config);
    const resolved = resolveFromEnv(env ?? process.env, {
      kind: "stream",
      checkTokenExpiry: config.checkTokenExpiry,
    });
    if (resolved.token === null) {
      throw new ConfigurationError("No access token for the stream");
    }
    return new TradeSmartStream(resolved.clientId, resolved.token, { ...rest, config });
  }

  /**
   * Build a stream with a REST client's id, held token (an `AccessToken` keeps its expiry check)
   * and config (unless `options.config` is given). Nothing is sent; a client without a token or
   * with an expired `AccessToken` throws `AuthenticationError`.
   */
  static fromClient(client: TradeSmart, options: StreamOptions = {}): TradeSmartStream {
    callContext(client).bearer(); // AuthenticationError when missing or expired
    const token = client.accessToken;
    if (token === null) throw new TradeSmartError("the client has no access token");
    return new TradeSmartStream(client.clientId, token, {
      ...options,
      config: options.config ?? client.config,
    });
  }

  get state(): StreamState {
    return this.#connection.state;
  }

  /** Successful reconnects; already incremented when the CONNECTED that follows is reported. */
  get reconnectCount(): number {
    return this.#connection.reconnectCount;
  }

  /** Heartbeat replies (`hk`) received over all connections. */
  get heartbeatAcks(): number {
    return this.#connection.heartbeatAcks;
  }

  /**
   * Resolves once the stream has ended: null after `close()`, else the terminal error (after its
   * messages and `onError` were delivered), or the error a failed `connect()` rejected with.
   * Never rejects.
   */
  get closed(): Promise<Error | null> {
    return this.#closed;
  }

  /**
   * The latest merged wire fields of one instrument (§9.3), JSON numbers as their exact text, or
   * null when unseen. The key is normalised like a subscription (`"nse|22"` finds `"NSE|22"`); a
   * list or an invalid key throws `RequestValidationError`.
   */
  snapshot(instrument: InstrumentKey): Readonly<Record<string, SnapshotValue>> | null {
    const fields = this.#connection.snapshot(instrument);
    if (fields === null) return null;
    return Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, toSnapshotValue(value)]),
    );
  }

  // --- lifecycle -------------------------------------------------------------------------------

  /**
   * Open the socket and authenticate (§9.1); resolves once CONNECTED. Rejects with the connect
   * error (never retried; the stream is then CLOSED and `closed` resolves with that error), or
   * with `RequestTimeoutError` after `timeoutMs` (the stream is then closed). Once per stream.
   */
  async connect(options: StreamConnectOptions = {}): Promise<void> {
    if (this.#connectCalled) {
      throw new TradeSmartError("connect() can only be called once per stream");
    }
    const ms = options.timeoutMs ?? (2 * this.config.wsAuthTimeout + 5) * 1000;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
      throw new TypeError("timeoutMs must be a finite number >= 0");
    }
    this.#connectCalled = true;
    const attempt = this.#connection.connect();
    const timer = new AbortController();
    const timedOut = this.#clock.sleep(ms, timer.signal).then(
      () => true,
      () => false,
    );
    let late: boolean;
    try {
      late = await Promise.race([attempt.then(() => false), timedOut]);
    } catch (error) {
      if (error instanceof Error) this.#settleClosed(error); // not a user close (ruling 2)
      throw error;
    } finally {
      timer.abort();
    }
    if (late) {
      const error = new RequestTimeoutError(`Stream did not connect within ${String(ms / 1000)}s`);
      this.#settleClosed(error);
      await this.close();
      throw error;
    }
    if (this.state !== StreamState.CONNECTED) {
      throw new TradeSmartError("stream was closed before it connected");
    }
  }

  /**
   * Stop the stream; idempotent. From now on no message reaches a callback (the skipped ones are
   * counted in one DEBUG line; `onDisconnect` still pairs an earlier `onConnect`); an iterator
   * still yields the messages already received, then ends. The socket closes with a bounded
   * handshake; the dispatch loop and running async `onStateChange` calls get `CLOSE_TIMEOUT`
   * (2 s) to finish, then are abandoned with a WARNING. Called from inside a callback (or work it
   * started), it returns without waiting for the callbacks (it would wait for itself).
   */
  async close(): Promise<void> {
    this.#delivery.stop();
    await this.#connection.close();
    this.#afterClose ??= this.#delivery.afterClose().then(() => {
      this.#settleClosed(this.#connection.terminalError);
    });
    if (insideCallbackOf(this)) return;
    await this.#afterClose;
  }

  /** `await using stream = ...` closes the stream at the end of the block. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** Iterate the delivered messages; a terminal error is thrown after the messages before it. */
  [Symbol.asyncIterator](): AsyncIterator<InboundStreamMessage, undefined> {
    return this.#delivery.iterator();
  }

  // --- subscriptions (§9.4) --------------------------------------------------------------------

  subscribeTouchline(instruments: InstrumentsArg): Promise<void> {
    return this.#connection.subscribeTouchline(instruments);
  }

  unsubscribeTouchline(instruments: InstrumentsArg): Promise<void> {
    return this.#connection.unsubscribeTouchline(instruments);
  }

  subscribeDepth(instruments: InstrumentsArg): Promise<void> {
    return this.#connection.subscribeDepth(instruments);
  }

  unsubscribeDepth(instruments: InstrumentsArg): Promise<void> {
    return this.#connection.unsubscribeDepth(instruments);
  }

  subscribeOrders(): Promise<void> {
    return this.#connection.subscribeOrders();
  }

  unsubscribeOrders(): Promise<void> {
    return this.#connection.unsubscribeOrders();
  }

  subscribePositions(): Promise<void> {
    return this.#connection.subscribePositions();
  }

  unsubscribePositions(): Promise<void> {
    return this.#connection.unsubscribePositions();
  }

  toString(): string {
    return `TradeSmartStream(client_id=${this.clientId}, state=${this.state})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}
