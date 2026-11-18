// Delivery to user code (sdk-behaviour.md §9.6–9.8, design §7.6). The socket handler only
// enqueues; one dispatch loop runs the ordered callbacks (`onMessage`, then the typed one, and
// `onConnect` / `onDisconnect` / `onReconnect` / `onError`) one at a time in arrival order,
// awaiting a returned Promise before the next, then feeds the iterator. `onStateChange` runs out
// of band. A throwing or rejecting callback is logged and passed to `onError`; it never stops the
// stream. Nothing here waits for user code on the reader's path.
import { AsyncLocalStorage } from "node:async_hooks";
import type { TradeSmartError } from "../errors.js";
import type { Logger } from "../lib/log.js";
import type { Clock } from "../lib/ratelimit.js";
import type {
  DepthAck,
  DepthFeed,
  OrderUpdate,
  PositionAck,
  PositionUpdate,
  TouchlineAck,
  TouchlineFeed,
  UnknownMessage,
  UnsubscribeAck,
} from "../models/generated/stream.js";
import { DeliveryBuffer, type BufferItem } from "./backlog.js";
import { CLOSE_TIMEOUT_MS } from "./connection.js";
import type { ParsedMessage } from "./protocol.js";
import { StreamState } from "./state.js";

/** A message the stream delivers (`ak` and `hk` are consumed internally). */
export type InboundStreamMessage =
  | TouchlineAck
  | TouchlineFeed
  | DepthAck
  | DepthFeed
  | OrderUpdate
  | PositionAck
  | PositionUpdate
  | UnsubscribeAck
  | UnknownMessage;

/** A stream callback: a plain function or an `async` one (its Promise is awaited). */
export type StreamCallback<A> = (arg: A) => void | Promise<void>;

/** A stream callback without an argument. */
export type StreamEventCallback = () => void | Promise<void>;

/** The callbacks of `StreamOptions` (all optional). */
export interface StreamCallbacks {
  /** Every delivered message, before its typed callback. */
  onMessage?: StreamCallback<InboundStreamMessage> | undefined;
  /** `tk` and `tf`. */
  onTouchline?: StreamCallback<TouchlineAck | TouchlineFeed> | undefined;
  /** `dk` and `df`. */
  onDepth?: StreamCallback<DepthAck | DepthFeed> | undefined;
  /** `om`. */
  onOrderUpdate?: StreamCallback<OrderUpdate> | undefined;
  /** `pk` and `pm`. */
  onPosition?: StreamCallback<PositionAck | PositionUpdate> | undefined;
  /** Every time CONNECTED is reached. */
  onConnect?: StreamEventCallback | undefined;
  /** Once each time CONNECTED is left (paired with an earlier `onConnect`). */
  onDisconnect?: StreamEventCallback | undefined;
  /** Right after `onConnect` when CONNECTED is reached again after a reconnect. */
  onReconnect?: StreamEventCallback | undefined;
  /** The terminal error (after the messages received before it) and callback errors. */
  onError?: StreamCallback<Error> | undefined;
  /** Each state transition, out of band (not in the ordered dispatch loop). */
  onStateChange?: StreamCallback<StreamState> | undefined;
}

type Control =
  | { readonly type: "connect" }
  | { readonly type: "reconnect" }
  | { readonly type: "disconnect" }
  | { readonly type: "error"; readonly error: Error };

/** Marks code running inside a callback of a stream, including the async work it starts. */
const callbackOwner = new AsyncLocalStorage<object>();

/** True when called from inside a callback of `owner` (or from work such a callback started). */
export function insideCallbackOf(owner: object): boolean {
  return callbackOwner.getStore() === owner;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function asError(error: unknown, name: string): Error {
  return error instanceof Error
    ? error
    : new Error(`${name} callback threw a non-Error value`, { cause: error });
}

const UPDATE_KINDS: ReadonlySet<string> = new Set(["OrderUpdate", "PositionUpdate"]);

/** The bounded wait of `afterClose()`: resolves true when `promise` settled first. */
function within(promise: Promise<unknown>, deadline: Promise<void>): Promise<boolean> {
  return Promise.race([promise.then(() => true), deadline.then(() => false)]);
}

/**
 * One stream's delivery: the hand-off buffer, the dispatch loop, the iterator and the
 * out-of-band state callbacks. Driven by the public stream from its connection sink.
 */
export class Delivery {
  readonly #owner: object;
  readonly #callbacks: StreamCallbacks;
  readonly #log: Logger;
  readonly #clock: Clock;
  /** Socket handler → dispatch loop. */
  readonly #buffer: DeliveryBuffer<Control>;
  /** Dispatch loop → iterator. */
  readonly #iterBuffer: DeliveryBuffer<never>;
  readonly #messageConsumer: boolean;
  /** Running async `onStateChange` calls (each settles, never rejects). */
  readonly #stateTasks = new Set<Promise<void>>();
  /** Resolves when the dispatch loop has ended (or was abandoned at close). */
  readonly loopDone: Promise<void>;
  #iterating = false;
  /** `close()` was requested: no message callback runs any more. */
  #stopped = false;
  /** The dispatch loop was given up at close (a callback did not return in time). */
  #abandoned = false;
  #inFlight: ParsedMessage | null = null;
  #terminal: TradeSmartError | null = null;
  #wasConnected = false;
  #connectedBefore = false;
  #skipped = 0;
  #skippedUpdates = 0;
  #afterClose: Promise<void> | null = null;

  constructor(owner: object, callbacks: StreamCallbacks, limit: number, log: Logger, clock: Clock) {
    this.#owner = owner;
    this.#callbacks = callbacks;
    this.#log = log;
    this.#clock = clock;
    this.#buffer = new DeliveryBuffer<Control>(limit, log);
    this.#iterBuffer = new DeliveryBuffer<never>(limit, log);
    this.#messageConsumer = [
      callbacks.onMessage,
      callbacks.onTouchline,
      callbacks.onDepth,
      callbacks.onOrderUpdate,
      callbacks.onPosition,
    ].some((cb) => cb !== undefined);
    this.loopDone = this.#run();
  }

  // --- the connection sink side (never waits, never throws) -------------------------------------

  /** One inbound message, in arrival order. Buffered only for an active consumer (§9.7). */
  message(parsed: ParsedMessage): void {
    if (this.#abandoned) {
      this.#countSkipped(parsed);
      this.#toIterator(parsed);
      return;
    }
    if (this.#messageConsumer || this.#iterating) this.#buffer.put(parsed);
  }

  /** A state transition: `onStateChange` now (out of band), the ordered events queued (§9.8). */
  stateChange(state: StreamState): void {
    this.#callStateChange(state);
    if (state === StreamState.CONNECTED) {
      this.#wasConnected = true;
      this.#queue({ type: "connect" }, this.#callbacks.onConnect);
      if (this.#connectedBefore) this.#queue({ type: "reconnect" }, this.#callbacks.onReconnect);
      this.#connectedBefore = true;
    } else if (
      (state === StreamState.RECONNECTING || state === StreamState.CLOSED) &&
      this.#wasConnected
    ) {
      this.#wasConnected = false; // one onDisconnect per disconnection
      this.#queue({ type: "disconnect" }, this.#callbacks.onDisconnect);
    }
  }

  /** The connection ended: `error` is its terminal error, null after close() or a failed connect. */
  ended(error: TradeSmartError | null): void {
    if (error !== null) {
      this.#terminal = error;
      this.#queue({ type: "error", error }, this.#callbacks.onError);
    }
    this.#buffer.end(); // the loop delivers what is waiting, then ends iteration
  }

  // --- the consumer side ------------------------------------------------------------------------

  /**
   * An iterator over the delivered messages (iteration buffers from the first call on). It ends
   * when the stream has ended and every message received before was yielded; after a terminal
   * error it then throws that error.
   */
  iterator(): AsyncIterator<InboundStreamMessage, undefined> {
    this.#iterating = true;
    return {
      next: async (): Promise<IteratorResult<InboundStreamMessage, undefined>> => {
        this.#iterating = true;
        for (;;) {
          const item = await this.#iterBuffer.get();
          if (item === DeliveryBuffer.END) {
            if (this.#terminal !== null) throw this.#terminal;
            return { done: true, value: undefined };
          }
          if (item.kind !== "control") return { done: false, value: item.message };
        }
      },
      return: (): Promise<IteratorResult<InboundStreamMessage, undefined>> => {
        // `break` out of `for await`: stop buffering for iteration until it starts again.
        this.#iterating = false;
        this.#iterBuffer.drain();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }

  // --- close ------------------------------------------------------------------------------------

  /** `close()` was requested: from now on no message reaches a callback (§9.8). */
  stop(): void {
    this.#stopped = true;
  }

  /**
   * The bounded end of `close()` (after the connection is CLOSED): the dispatch loop and the
   * running async `onStateChange` calls get `CLOSE_TIMEOUT` to finish; a loop still inside a
   * callback is then abandoned (its waiting messages still reach the iterator) and the state
   * calls abandoned, each with one WARNING. Then the skipped messages are counted in one DEBUG
   * line. Runs once; never rejects.
   */
  afterClose(): Promise<void> {
    this.#afterClose ??= this.#finishClose().catch((error: unknown) => {
      this.#log.error(`stream close failed: ${errorName(error)}`);
    });
    return this.#afterClose;
  }

  async #finishClose(): Promise<void> {
    const timer = new AbortController();
    const deadline = this.#clock.sleep(CLOSE_TIMEOUT_MS, timer.signal).catch(() => undefined);
    const states = [...this.#stateTasks];
    try {
      const [loopFinished, settled] = await Promise.all([
        within(this.loopDone, deadline),
        Promise.all(states.map((task) => within(task, deadline))),
      ]);
      if (!loopFinished) this.#abandon();
      const running = settled.filter((done) => !done).length;
      if (running > 0) {
        this.#log.warn(
          `${String(running)} onStateChange callback(s) still running ` +
            `${String(CLOSE_TIMEOUT_MS / 1000)}s after close(); abandoned`,
        );
      }
    } finally {
      timer.abort();
    }
    if (this.#skipped > 0) {
      this.#log.debug(
        `stream stopped: ${String(this.#skipped)} received messages were not delivered to the ` +
          `callbacks (${String(this.#skippedUpdates)} order/position updates)`,
      );
    }
  }

  /** Give up on a dispatch loop stuck in a callback: what it holds still reaches the iterator. */
  #abandon(): void {
    this.#abandoned = true;
    this.#log.warn(
      `a stream callback is still running ${String(CLOSE_TIMEOUT_MS / 1000)}s after close(); ` +
        "the remaining callbacks were abandoned",
    );
    const inFlight = this.#inFlight;
    this.#inFlight = null;
    if (inFlight !== null) this.#toIterator(inFlight);
    for (const item of this.#buffer.drain()) {
      if (item.kind === "control") continue;
      this.#countSkipped(item);
      this.#toIterator(item);
    }
    this.#iterBuffer.end();
  }

  // --- the dispatch loop ------------------------------------------------------------------------

  async #run(): Promise<void> {
    try {
      for (;;) {
        const item = await this.#buffer.get();
        if (item === DeliveryBuffer.END) break;
        if (this.#abandoned) return; // close() gave up on this loop
        await this.#dispatch(item);
      }
    } catch (error) {
      // Defensive: every callback error is caught in #call; the loop itself must never reject.
      this.#log.error(`stream dispatcher failed: ${errorName(error)}`);
    }
    if (!this.#abandoned) this.#iterBuffer.end();
  }

  async #dispatch(item: BufferItem<Control>): Promise<void> {
    if (item.kind === "control") {
      await this.#runControl(item.control);
      return;
    }
    this.#inFlight = item;
    if (this.#stopped) {
      this.#countSkipped(item);
    } else {
      await this.#call("onMessage", this.#callbacks.onMessage, item.message);
      // close() during onMessage (or abandonment meanwhile): the typed callback must not follow.
      if (this.#mayDeliver()) await this.#typed(item);
    }
    if (this.#abandoned) return; // #abandon() already passed it to the iterator
    this.#inFlight = null;
    this.#toIterator(item);
  }

  /** Re-read after every await: close() or abandonment may have happened meanwhile. */
  #mayDeliver(): boolean {
    return !this.#stopped && !this.#abandoned;
  }

  async #typed(item: ParsedMessage): Promise<void> {
    const cb = this.#callbacks;
    switch (item.kind) {
      case "TouchlineAck":
      case "TouchlineFeed":
        await this.#call("onTouchline", cb.onTouchline, item.message);
        return;
      case "DepthAck":
      case "DepthFeed":
        await this.#call("onDepth", cb.onDepth, item.message);
        return;
      case "OrderUpdate":
        await this.#call("onOrderUpdate", cb.onOrderUpdate, item.message);
        return;
      case "PositionAck":
      case "PositionUpdate":
        await this.#call("onPosition", cb.onPosition, item.message);
        return;
      default:
        return;
    }
  }

  async #runControl(control: Control): Promise<void> {
    const cb = this.#callbacks;
    switch (control.type) {
      case "connect":
        await this.#call("onConnect", cb.onConnect, undefined);
        return;
      case "reconnect":
        await this.#call("onReconnect", cb.onReconnect, undefined);
        return;
      case "disconnect":
        await this.#call("onDisconnect", cb.onDisconnect, undefined);
        return;
      case "error":
        await this.#call("onError", cb.onError, control.error);
        return;
    }
  }

  /**
   * Run one ordered callback inside the callback context and await a returned Promise. A throw or
   * rejection is logged and passed to `onError` (for `onError` itself, only logged).
   */
  async #call<A>(
    name: string,
    callback: ((arg: A) => void | Promise<void>) | undefined,
    arg: A,
  ): Promise<void> {
    if (callback === undefined) return;
    try {
      const result: unknown = callbackOwner.run(this.#owner, () => callback(arg));
      if (isThenable(result)) await result;
    } catch (error) {
      this.#log.error(`${name} callback raised`, {
        logger: "tradesmart.stream",
        error: errorName(error),
      });
      if (name !== "onError") {
        await this.#call("onError", this.#callbacks.onError, asError(error, name));
      }
    }
  }

  /** `onStateChange`, out of band: inline if plain; a returned Promise is tracked (§9.6). */
  #callStateChange(state: StreamState): void {
    const callback = this.#callbacks.onStateChange;
    if (callback === undefined) return;
    let result: unknown;
    try {
      result = callbackOwner.run(this.#owner, () => callback(state));
    } catch (error) {
      this.#log.error("onStateChange callback raised", {
        logger: "tradesmart.stream",
        error: errorName(error),
      });
      return;
    }
    if (!isThenable(result)) return;
    const task: Promise<void> = callbackOwner.run(this.#owner, () =>
      Promise.resolve(result).then(
        () => undefined,
        (error: unknown) => {
          this.#log.error("onStateChange callback raised", {
            logger: "tradesmart.stream",
            error: errorName(error),
          });
        },
      ),
    );
    this.#stateTasks.add(task);
    void task.then(() => this.#stateTasks.delete(task));
  }

  #queue(control: Control, callback: unknown): void {
    if (callback !== undefined) this.#buffer.putBarrier(control);
  }

  #toIterator(item: ParsedMessage): void {
    if (this.#iterating) this.#iterBuffer.put(item);
  }

  #countSkipped(item: ParsedMessage): void {
    if (!this.#messageConsumer) return;
    this.#skipped += 1;
    if (UPDATE_KINDS.has(item.kind)) this.#skippedUpdates += 1;
  }
}
