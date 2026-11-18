// The internal stream connection (sdk-behaviour.md §9.1–9.6): one WebSocket at a time over the
// `ws` library, the connect frame and its acknowledgement, heartbeat, liveness, reconnect with
// back-off and resubscription, snapshots and the subscription limit. It hands parsed messages,
// state changes and the end of the stream to a `StreamSink`; delivery to user code (callbacks,
// iteration, backlog) is the public stream's job (Task 17). All timing goes through the injected
// `Clock`. No frame is ever logged: the connect frame carries the token (§13).
import WebSocket from "ws";
import { AccessToken, LOGIN_HINT } from "../auth.js";
import { headerUserAgent, type ClientConfig } from "../config.js";
import {
  AuthenticationError,
  NetworkError,
  RequestTimeoutError,
  TradeSmartError,
  TransportError,
} from "../errors.js";
import { makeLog, type Logger } from "../lib/log.js";
import { systemClock, type Clock } from "../lib/ratelimit.js";
import type { ConnectAck } from "../models/generated/stream.js";
import {
  ackAccepted,
  connectMessage,
  depthMessage,
  heartbeatMessage,
  orderUpdatesMessage,
  parseMessage,
  positionUpdatesMessage,
  reconnectDelayMs,
  toScripKey,
  toScripKeys,
  touchlineMessage,
  unsubscribeDepthMessage,
  unsubscribeOrdersMessage,
  unsubscribePositionsMessage,
  unsubscribeTouchlineMessage,
  type InstrumentKey,
  type InstrumentsArg,
  type OutboundMessage,
  type ParsedMessage,
  type RawFrame,
} from "./protocol.js";
import { SnapshotCache, StateMachine, StreamState, SubscriptionRegistry } from "./state.js";

/** Milliseconds a closing handshake may take before the socket is dropped (§9.7). */
export const CLOSE_TIMEOUT_MS = 2000;

/**
 * Where a connection reports to (the public stream's delivery layer). Every method is called
 * synchronously from the socket handler, so it must return at once and should not throw (a
 * throw is logged and ignored).
 */
export interface StreamSink {
  /**
   * One inbound message in arrival order, after the snapshot cache was updated. `ak` and `hk`
   * are consumed by the connection and never passed on.
   */
  message(parsed: ParsedMessage): void;
  /** Each state transition, exactly once (§9.6); CLOSED is the last. */
  stateChange(state: StreamState): void;
  /**
   * The stream has ended, called once right after CLOSED is reported: `error` is the terminal
   * error of a running stream (reconnects exhausted, an ack rejection or an expired token on
   * reconnect, a heartbeat failure), or null after `close()` or a failed initial `connect()`
   * (whose error `connect()` rejects with).
   */
  closed(error: TradeSmartError | null): void;
}

export interface StreamConnectionOptions {
  readonly clientId: string;
  /** A plain token (never checked for expiry) or an `AccessToken` (checked, §9.1, §9.5). */
  readonly accessToken: string | AccessToken;
  readonly config: ClientConfig;
  readonly sink: StreamSink;
  /** Monotonic time and sleeps in milliseconds (default: the real clock). */
  readonly clock?: Clock;
  /** The back-off jitter U in [0, 1) (default `Math.random`). */
  readonly random?: () => number;
  /** Wall-clock time for the token expiry check (default: now). */
  readonly now?: () => Date;
}

/** `close()` was called while a connection was being established. */
class StreamClosed extends Error {
  override name = "StreamClosed";
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined); // a rejection nobody awaits is not an unhandled rejection
  return { promise, resolve, reject };
}

/** What a failure was, without its message (which may hold an address or a response). */
function errorKind(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
  return error instanceof Error ? error.name : typeof error;
}

/** One WebSocket and what is known about it. */
class Link {
  readonly opened = deferred<undefined>();
  readonly closed = deferred<undefined>();
  readonly ack = deferred<ConnectAck>();
  /** Stops the liveness watchdog of this socket. */
  readonly watch = new AbortController();
  lastFrameAt = 0;
  isClosed = false;

  constructor(readonly ws: WebSocket) {}
}

/**
 * One stream connection. Single-use: `connect()` once; after CLOSED every subscribe and
 * unsubscribe rejects with `TradeSmartError`. Subscribing before `connect()` or while not CONNECTED
 * only updates the registry; the requests are sent when CONNECTED is (re)reached.
 *
 * Registry updates and sends happen synchronously in one step, and the (re)connect replay runs
 * synchronously too, so a subscription made during a reconnect is sent exactly once (§9.4).
 */
export class StreamConnection {
  readonly #clientId: string;
  readonly #token: string | AccessToken;
  readonly #config: ClientConfig;
  readonly #sink: StreamSink;
  readonly #clock: Clock;
  readonly #random: () => number;
  readonly #now: () => Date;
  readonly #log: Logger;
  readonly #machine: StateMachine;
  readonly #registry = new SubscriptionRegistry();
  readonly #snapshots = new SnapshotCache();
  /** Aborted when the stream is closing: ends every sleep and pending wait. */
  readonly #stop = new AbortController();
  readonly #done = deferred<undefined>();
  #link: Link | null = null;
  #connectCalled = false;
  #closing = false;
  #ended = false;
  #error: TradeSmartError | null = null;
  #attempts = 0;
  #reconnects = 0;
  #heartbeatAcks = 0;
  #connectedAt = 0;

  constructor(options: StreamConnectionOptions) {
    this.#clientId = options.clientId;
    this.#token = options.accessToken;
    this.#config = options.config;
    this.#sink = options.sink;
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? ((): Date => new Date());
    this.#log = makeLog(this.#config.logger, "tradesmart.stream");
    this.#machine = new StateMachine((state) => {
      this.#reportState(state);
    });
  }

  get state(): StreamState {
    return this.#machine.state;
  }

  /** Successful reconnects; incremented before the CONNECTED that follows is reported. */
  get reconnectCount(): number {
    return this.#reconnects;
  }

  /** `hk` replies received over all connections. */
  get heartbeatAcks(): number {
    return this.#heartbeatAcks;
  }

  /** The terminal error once the stream ended with one, else null. */
  get terminalError(): TradeSmartError | null {
    return this.#error;
  }

  /**
   * A copy of the latest merged fields of one instrument (§9.3), or null when unseen. The key is
   * normalised like a subscription; a list or an invalid key throws `RequestValidationError`.
   */
  snapshot(key: InstrumentKey): Record<string, unknown> | null {
    if (typeof key === "string") {
      const exact = this.#snapshots.get(key);
      if (exact !== null) return exact;
    }
    return this.#snapshots.get(toScripKey(key));
  }

  // --- lifecycle -------------------------------------------------------------------------------

  /**
   * Open the socket, authenticate and replay the registry (§9.1). Rejects on failure, which is
   * never retried; the stream is then CLOSED. Resolves quietly when `close()` interrupts it.
   */
  async connect(): Promise<void> {
    if (this.#connectCalled || this.#machine.state !== StreamState.DISCONNECTED) {
      throw new TradeSmartError("connect() can only be called once per stream");
    }
    this.#connectCalled = true;
    let link: Link;
    try {
      this.#checkExpiry();
      link = await this.#openAndAuthenticate(true);
      this.#activate(link, false);
    } catch (error) {
      if (error instanceof StreamClosed) return;
      this.#closing = true;
      this.#stop.abort();
      await this.#dropLink(true);
      this.#finish(null);
      throw error;
    }
    void this.#run(link);
    void this.#heartbeats();
  }

  /** Stop the stream: end every wait, close the socket (bounded), report CLOSED. Idempotent. */
  async close(): Promise<void> {
    if (this.#closing) {
      await this.#done.promise;
      return;
    }
    this.#closing = true;
    this.#stop.abort();
    try {
      await this.#dropLink(false);
    } finally {
      this.#finish(null);
    }
  }

  // --- subscriptions (§9.4) --------------------------------------------------------------------

  subscribeTouchline(instruments: InstrumentsArg): Promise<void> {
    return this.#operation(() => {
      const keys = toScripKeys(instruments);
      if (keys.length === 0) return;
      this.#registry.ensureCapacity({ touchline: keys });
      this.#registry.addTouchline(keys);
      this.#sendIfConnected(touchlineMessage(keys));
    });
  }

  unsubscribeTouchline(instruments: InstrumentsArg): Promise<void> {
    return this.#operation(() => {
      const keys = toScripKeys(instruments);
      if (keys.length === 0) return;
      this.#registry.removeTouchline(keys);
      this.#sendIfConnected(unsubscribeTouchlineMessage(keys));
    });
  }

  subscribeDepth(instruments: InstrumentsArg): Promise<void> {
    return this.#operation(() => {
      const keys = toScripKeys(instruments);
      if (keys.length === 0) return;
      this.#registry.ensureCapacity({ depth: keys });
      this.#registry.addDepth(keys);
      this.#sendIfConnected(depthMessage(keys));
    });
  }

  unsubscribeDepth(instruments: InstrumentsArg): Promise<void> {
    return this.#operation(() => {
      const keys = toScripKeys(instruments);
      if (keys.length === 0) return;
      this.#registry.removeDepth(keys);
      this.#sendIfConnected(unsubscribeDepthMessage(keys));
    });
  }

  subscribeOrders(): Promise<void> {
    return this.#operation(() => {
      this.#registry.orders = true;
      this.#sendIfConnected(orderUpdatesMessage(this.#clientId));
    });
  }

  unsubscribeOrders(): Promise<void> {
    return this.#operation(() => {
      this.#registry.orders = false;
      this.#sendIfConnected(unsubscribeOrdersMessage());
    });
  }

  subscribePositions(): Promise<void> {
    return this.#operation(() => {
      this.#registry.positions = true;
      this.#sendIfConnected(positionUpdatesMessage(this.#clientId));
    });
  }

  unsubscribePositions(): Promise<void> {
    return this.#operation(() => {
      this.#registry.positions = false;
      this.#sendIfConnected(unsubscribePositionsMessage());
    });
  }

  /** Run a subscription change synchronously (atomic with the replay); a throw rejects. */
  #operation(change: () => void): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.#machine.state === StreamState.CLOSED) {
        throw new TradeSmartError("stream is closed; create a new stream");
      }
      change();
      resolve();
    });
  }

  // --- connection ------------------------------------------------------------------------------

  #reportState(state: StreamState): void {
    this.#log.debug(`stream state -> ${state}`);
    try {
      this.#sink.stateChange(state);
    } catch (error) {
      this.#log.error(`stream sink raised: ${errorKind(error)}`);
    }
  }

  #setState(state: StreamState): void {
    this.#machine.transition(state);
  }

  #tokenText(): string {
    return this.#token instanceof AccessToken ? this.#token.accessToken.reveal() : this.#token;
  }

  /** An expired `AccessToken` (under `check_token_expiry`) is `AuthenticationError` (§9.1, §9.5). */
  #checkExpiry(): void {
    const token = this.#token;
    if (token instanceof AccessToken && this.#config.checkTokenExpiry) {
      if (token.isExpired(this.#now())) {
        throw new AuthenticationError(
          `Access token expired at ${token.expiresAt.toISOString()} ` +
            `(tokens are valid until 06:00 IST); log in again, e.g. ${LOGIN_HINT}`,
          { endpoint: "", httpStatus: null },
        );
      }
    }
  }

  /** Create a socket with its listeners; it becomes the current link. */
  #openLink(): Link {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.#config.wsUrl, {
        headers: { "User-Agent": headerUserAgent(this.#config) },
        followRedirects: false,
      });
    } catch (error) {
      throw new NetworkError(`WebSocket connection failed: ${errorKind(error)}`);
    }
    const link = new Link(ws);
    ws.on("open", () => {
      link.opened.resolve(undefined);
    });
    ws.on("error", (error) => {
      link.opened.reject(new NetworkError(`WebSocket connection failed: ${errorKind(error)}`));
    });
    ws.on("close", () => {
      link.isClosed = true;
      link.opened.reject(new NetworkError("WebSocket connection failed: closed"));
      link.closed.resolve(undefined);
    });
    ws.on("message", (data: WebSocket.RawData) => {
      this.#onFrame(link, data);
    });
    this.#link = link;
    return link;
  }

  /**
   * `promise`, unless `ms` pass first (`onTimeout()` is thrown) or the stream starts closing
   * (`StreamClosed` is thrown).
   */
  #within<T>(promise: Promise<T>, ms: number, onTimeout: () => TradeSmartError): Promise<T> {
    const timer = new AbortController();
    const stop = this.#stop.signal;
    let onStop = (): void => undefined;
    return new Promise<T>((resolve, reject) => {
      onStop = (): void => {
        reject(new StreamClosed());
      };
      if (stop.aborted) {
        onStop();
        return;
      }
      stop.addEventListener("abort", onStop, { once: true });
      void this.#clock.sleep(ms, timer.signal).then(
        () => {
          reject(onTimeout());
        },
        () => undefined,
      );
      promise.then(resolve, reject);
    }).finally(() => {
      timer.abort();
      stop.removeEventListener("abort", onStop);
    });
  }

  /**
   * Open a socket (`NetworkError` on failure or after `ws_auth_timeout`), send the connect frame
   * and wait up to `ws_auth_timeout` for `ak` (§9.1 steps 2–5). Frames arriving first are
   * dispatched normally. On any failure the socket is dropped.
   */
  async #openAndAuthenticate(initial: boolean): Promise<Link> {
    const seconds = this.#config.wsAuthTimeout;
    const ms = seconds * 1000;
    if (initial) this.#setState(StreamState.CONNECTING);
    const link = this.#openLink();
    try {
      await this.#within(
        link.opened.promise,
        ms,
        () => new NetworkError("WebSocket connection failed: TimeoutError"),
      );
      if (initial) this.#setState(StreamState.AUTHENTICATING);
      link.ws.send(JSON.stringify(connectMessage(this.#clientId, this.#tokenText())));
      const lost = link.closed.promise.then((): never => {
        throw new NetworkError("WebSocket closed during authentication");
      });
      const ack = await this.#within(
        Promise.race([link.ack.promise, lost]),
        ms,
        () => new RequestTimeoutError(`No connect acknowledgement within ${String(seconds)}s`),
      );
      if (!ackAccepted(ack.status)) {
        throw new AuthenticationError(
          `WebSocket authentication rejected (s=${String(ack.status)})`,
          { endpoint: "WebSocket", httpStatus: null, raw: ack.raw },
        );
      }
      return link;
    } catch (error) {
      const graceful = error instanceof AuthenticationError || error instanceof RequestTimeoutError;
      this.#discard(link, graceful);
      throw error;
    }
  }

  /**
   * Replay the registry and go CONNECTED, in one synchronous step (§9.1 step 6, §9.4). A socket
   * that is no longer open after the replay is dropped and `NetworkError` thrown (a failed attempt).
   */
  #activate(link: Link, reconnect: boolean): void {
    if (this.#closing) {
      this.#discard(link, false);
      throw new StreamClosed();
    }
    for (const message of this.#registry.restoreMessages(this.#clientId)) {
      this.#send(link, message);
    }
    // `ws` handles a close frame arriving in the same chunk as the `ak` synchronously, so the
    // socket can already be closing here; its sends then fail only through their callbacks. That
    // attempt failed (§9.5): never report CONNECTED for it (also with nothing to replay).
    if (link.isClosed || link.ws.readyState !== WebSocket.OPEN) {
      this.#discard(link, false);
      throw new NetworkError("WebSocket closed while restoring subscriptions");
    }
    const now = this.#clock.now();
    this.#connectedAt = now;
    link.lastFrameAt = now;
    if (reconnect) this.#reconnects += 1;
    this.#setState(StreamState.CONNECTED);
  }

  #send(link: Link, message: OutboundMessage): void {
    link.ws.send(JSON.stringify(message), (error) => {
      if (error != null) this.#log.debug("send skipped: connection closed");
    });
  }

  /** Send `message` when CONNECTED; otherwise the registry restores it on (re)connect. */
  #sendIfConnected(message: OutboundMessage): void {
    const link = this.#link;
    if (this.#machine.state !== StreamState.CONNECTED || link === null) return;
    if (link.ws.readyState !== WebSocket.OPEN) return;
    this.#send(link, message);
  }

  /** Forget `link` if it is current and close it (gracefully, bounded) or drop it at once. */
  #discard(link: Link, graceful: boolean): void {
    if (this.#link === link) this.#link = null;
    link.watch.abort();
    if (graceful) void this.#closeGracefully(link);
    else link.ws.terminate();
  }

  async #dropLink(abort: boolean): Promise<void> {
    const link = this.#link;
    this.#link = null;
    if (link === null) return;
    link.watch.abort();
    if (abort) {
      link.ws.terminate();
      return;
    }
    await this.#closeGracefully(link);
  }

  /** A closing handshake; a peer that does not answer within `CLOSE_TIMEOUT_MS` is dropped. */
  async #closeGracefully(link: Link): Promise<void> {
    if (link.isClosed) return;
    try {
      link.ws.close(1000);
    } catch {
      link.ws.terminate();
      return;
    }
    const timer = new AbortController();
    const timedOut = await Promise.race([
      link.closed.promise.then(() => false),
      this.#clock.sleep(CLOSE_TIMEOUT_MS, timer.signal).then(
        () => true,
        () => false,
      ),
    ]);
    timer.abort();
    if (timedOut) link.ws.terminate();
  }

  /** The socket handler: parse, consume `ak`/`hk`, update snapshots, pass on (never waits). */
  #onFrame(link: Link, data: RawFrame): void {
    if (link !== this.#link || this.#ended) return;
    link.lastFrameAt = this.#clock.now();
    const parsed = parseMessage(data, this.#log);
    switch (parsed.kind) {
      case "HeartbeatAck":
        this.#heartbeatAcks += 1;
        return;
      case "ConnectAck":
        link.ack.resolve(parsed.message);
        return;
      case "TouchlineAck":
      case "TouchlineFeed":
      case "DepthAck":
      case "DepthFeed":
        this.#snapshots.update(parsed.message.raw);
        break;
      default:
        break;
    }
    try {
      this.#sink.message(parsed);
    } catch (error) {
      this.#log.error(`stream sink raised: ${errorKind(error)}`);
    }
  }

  // --- tasks -----------------------------------------------------------------------------------

  /** Supervisor: wait until the connection is lost, then reconnect, until the stream ends. */
  async #run(first: Link): Promise<void> {
    const stableMs = 2 * this.#config.heartbeatInterval * 1000;
    let link = first;
    try {
      for (;;) {
        const dead = await this.#readUntilLost(link);
        if (this.#closing) return;
        // Only a connection that held for 2 × heartbeat resets the attempt budget.
        if (this.#clock.now() - this.#connectedAt >= stableMs) this.#attempts = 0;
        this.#setState(StreamState.RECONNECTING);
        await this.#dropLink(dead);
        link = await this.#reconnect();
      }
    } catch (error) {
      if (error instanceof StreamClosed) return;
      if (error instanceof TradeSmartError) {
        await this.#terminate(error);
        return;
      }
      const kind = errorKind(error);
      this.#log.error(`stream reader failed: ${kind}`);
      await this.#terminate(new NetworkError(`Stream failed: ${kind}`));
    }
  }

  /**
   * Resolves when `link` is lost: false when it closed (or the stream is closing), true when no
   * frame arrived for 2 × heartbeat (the connection is dead, §9.5).
   */
  #readUntilLost(link: Link): Promise<boolean> {
    const silenceMs = 2 * this.#config.heartbeatInterval * 1000;
    const stop = this.#stop.signal;
    return new Promise<boolean>((resolve) => {
      const done = { settled: false };
      const settle = (dead: boolean): void => {
        if (done.settled) return;
        done.settled = true;
        stop.removeEventListener("abort", onStop);
        resolve(dead);
      };
      const onStop = (): void => {
        settle(false);
      };
      if (stop.aborted) {
        settle(false);
        return;
      }
      stop.addEventListener("abort", onStop, { once: true });
      const lost = (dead: boolean): void => {
        if (done.settled || this.#closing) {
          settle(false);
          return;
        }
        this.#log.warn(
          dead
            ? `No WebSocket message for ${String(silenceMs / 1000)}s; reconnecting`
            : "WebSocket connection lost; reconnecting",
        );
        settle(dead);
      };
      void link.closed.promise.then(() => {
        lost(false);
      });
      void (async (): Promise<void> => {
        try {
          for (;;) {
            const wait = link.lastFrameAt + silenceMs - this.#clock.now();
            if (wait <= 0) break;
            await this.#clock.sleep(wait, link.watch.signal);
          }
        } catch {
          return; // the link was dropped
        }
        if (!link.isClosed) lost(true);
      })();
    });
  }

  /**
   * Reconnect with back-off (§9.5): the delay is slept before every attempt, then an expired
   * token ends the stream; transport failures and ack timeouts count as failed attempts, an ack
   * rejection is terminal. Exhausted → `NetworkError("reconnect attempts exhausted")`.
   */
  async #reconnect(): Promise<Link> {
    const limit = this.#config.reconnectMaxAttempts;
    while (limit === null || this.#attempts < limit) {
      if (this.#closing) throw new StreamClosed();
      await this.#sleep(
        reconnectDelayMs(
          this.#attempts,
          this.#config.reconnectBackoffBase,
          this.#config.reconnectBackoffCap,
          this.#random,
        ),
      );
      this.#checkExpiry();
      this.#attempts += 1;
      try {
        const link = await this.#openAndAuthenticate(false);
        this.#activate(link, true);
        return link;
      } catch (error) {
        if (!(error instanceof TransportError)) throw error;
        this.#log.warn(`Reconnect attempt ${String(this.#attempts)} failed: ${error.message}`);
      }
    }
    throw new NetworkError("reconnect attempts exhausted");
  }

  async #sleep(ms: number): Promise<void> {
    try {
      await this.#clock.sleep(ms, this.#stop.signal);
    } catch (error) {
      if (this.#stop.signal.aborted) throw new StreamClosed();
      throw error;
    }
  }

  /** Send `{"t":"h"}` every `heartbeat_interval` while CONNECTED; a failure ends the stream. */
  async #heartbeats(): Promise<void> {
    const ms = this.#config.heartbeatInterval * 1000;
    try {
      for (;;) {
        await this.#clock.sleep(ms, this.#stop.signal);
        if (this.#closing) return;
        this.#sendIfConnected(heartbeatMessage());
      }
    } catch (error) {
      if (this.#closing) return; // a shutdown is under way: not an error
      const kind = errorKind(error);
      this.#log.error(`stream heartbeat failed: ${kind}`);
      await this.#terminate(new NetworkError(`Stream heartbeat failed: ${kind}`));
    }
  }

  /** End a running stream with `error` (once). */
  async #terminate(error: TradeSmartError): Promise<void> {
    if (this.#ended) return;
    this.#log.error(`Stream stopped: ${error.message}`);
    this.#closing = true;
    this.#stop.abort();
    try {
      await this.#dropLink(false);
    } catch {
      // the socket is gone either way
    } finally {
      this.#finish(error);
    }
  }

  /** CLOSED (terminal): report it, then the end of the stream, once. */
  #finish(error: TradeSmartError | null): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#closing = true;
    this.#stop.abort();
    this.#error = error;
    this.#setState(StreamState.CLOSED);
    try {
      this.#sink.closed(error);
    } catch (sinkError) {
      this.#log.error(`stream sink raised: ${errorKind(sinkError)}`);
    }
    this.#done.resolve(undefined);
  }
}
