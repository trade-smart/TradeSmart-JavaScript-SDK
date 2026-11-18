// Stream state without I/O (sdk-behaviour.md §9.3, §9.4, §9.6): the state machine, the
// subscription registry and the snapshot cache.
import { SubscriptionLimitError } from "../errors.js";
import { JsonNumber } from "../lib/json.js";
import { StreamState } from "../models/generated/enums.js";
import {
  depthMessage,
  orderUpdatesMessage,
  positionUpdatesMessage,
  touchlineMessage,
  type OutboundMessage,
} from "./protocol.js";

export { StreamState };

/** Subscriptions per connection: distinct touchline keys plus distinct depth keys (§9.4). */
export const MAX_SUBSCRIPTIONS = 1000;

/**
 * The connection state (§9.6): `DISCONNECTED → CONNECTING → AUTHENTICATING → CONNECTED`, on loss
 * `CONNECTED → RECONNECTING → CONNECTED`, and `CLOSED`, which is terminal. Each transition is
 * reported once to `onChange`; a repeat of the current state and anything after CLOSED are ignored.
 */
export class StateMachine {
  #state: StreamState = StreamState.DISCONNECTED;

  constructor(private readonly onChange: (state: StreamState) => void) {}

  get state(): StreamState {
    return this.#state;
  }

  /** Move to `next`; true when that was a transition (and it was reported). */
  transition(next: StreamState): boolean {
    if (this.#state === next || this.#state === StreamState.CLOSED) return false;
    this.#state = next;
    this.onChange(next);
    return true;
  }
}

/** What is subscribed, so a (re)connect can restore it (§9.4). */
export class SubscriptionRegistry {
  readonly touchline = new Set<string>();
  readonly depth = new Set<string>();
  orders = false;
  positions = false;

  /** Throw `SubscriptionLimitError` when adding these keys would exceed `MAX_SUBSCRIPTIONS`. */
  ensureCapacity(add: { touchline?: readonly string[]; depth?: readonly string[] }): void {
    const total =
      new Set([...this.touchline, ...(add.touchline ?? [])]).size +
      new Set([...this.depth, ...(add.depth ?? [])]).size;
    if (total > MAX_SUBSCRIPTIONS) {
      throw new SubscriptionLimitError(
        `Subscription limit exceeded: ${String(total)} > ${String(MAX_SUBSCRIPTIONS)} per connection`,
      );
    }
  }

  addTouchline(keys: readonly string[]): void {
    for (const key of keys) this.touchline.add(key);
  }

  removeTouchline(keys: readonly string[]): void {
    for (const key of keys) this.touchline.delete(key);
  }

  addDepth(keys: readonly string[]): void {
    for (const key of keys) this.depth.add(key);
  }

  removeDepth(keys: readonly string[]): void {
    for (const key of keys) this.depth.delete(key);
  }

  /** The requests that restore every subscription: touchline (sorted), depth (sorted), orders, positions. */
  restoreMessages(uid: string): OutboundMessage[] {
    const messages: OutboundMessage[] = [];
    if (this.touchline.size > 0) messages.push(touchlineMessage([...this.touchline].sort()));
    if (this.depth.size > 0) messages.push(depthMessage([...this.depth].sort()));
    if (this.orders) messages.push(orderUpdatesMessage(uid));
    if (this.positions) messages.push(positionUpdatesMessage(uid));
    return messages;
  }
}

/** A non-empty `e` / `tk` value as text (a JSON number by its exact text), else null. */
function keyPart(value: unknown): string | null {
  const text = typeof value === "string" ? value : value instanceof JsonNumber ? value.text : "";
  return text === "" ? null : text;
}

/** The latest merged fields per `e|tk`, from `tk`, `tf`, `dk` and `df` (§9.3). */
export class SnapshotCache {
  readonly #data = new Map<string, Record<string, unknown>>();

  /** Merge every key of `raw` except `t` into the entry of its `e|tk` (ignored without both). */
  update(raw: Readonly<Record<string, unknown>>): void {
    const exchange = keyPart(raw["e"]);
    const token = keyPart(raw["tk"]);
    if (exchange === null || token === null) return;
    const key = `${exchange}|${token}`;
    let entry = this.#data.get(key);
    if (entry === undefined) {
      entry = Object.create(null) as Record<string, unknown>;
      this.#data.set(key, entry);
    }
    for (const [name, value] of Object.entries(raw)) {
      if (name !== "t") entry[name] = value;
    }
  }

  /** A copy of the entry of `key`, or null when it was never seen. */
  get(key: string): Record<string, unknown> | null {
    const entry = this.#data.get(key);
    return entry === undefined ? null : { ...entry };
  }
}
