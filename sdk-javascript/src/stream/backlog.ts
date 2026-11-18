// The bounded, merging hand-off between the stream's socket handler and the code that consumes
// it (sdk-behaviour.md §9.7, vectors `stream_backlog.json`). `put` never waits or throws.
import { JsonNumber } from "../lib/json.js";
import type { Logger } from "../lib/log.js";
import {
  DepthFeedSpec,
  STREAM_MESSAGE_PARSERS,
  TouchlineFeedSpec,
} from "../models/generated/stream.js";
import type { ParsedMessage } from "./protocol.js";

/** A non-message entry (e.g. a connect or disconnect event); nothing merges across it. */
export interface ControlItem<C> {
  readonly kind: "control";
  readonly control: C;
}

/** What the buffer hands out: a parsed message or a control entry, in arrival order. */
export type BufferItem<C> = ParsedMessage | ControlItem<C>;

type FeedKind = "TouchlineFeed" | "DepthFeed";

const IDENTITY: ReadonlySet<string> = new Set(["t", "e", "tk"]);

/** The wire keys each feed type can carry (its model's fields), identity keys excluded. */
const WIRE_FIELDS: Readonly<Record<FeedKind, ReadonlySet<string>>> = {
  TouchlineFeed: new Set(
    TouchlineFeedSpec.fields.map((f) => f.wire).filter((k) => !IDENTITY.has(k)),
  ),
  DepthFeed: new Set(DepthFeedSpec.fields.map((f) => f.wire).filter((k) => !IDENTITY.has(k))),
};

const END: unique symbol = Symbol("tradesmart.stream.end");

class Entry<C> {
  /** The latest message merged into this entry (or the control item). */
  item: BufferItem<C>;
  /** Merged wire fields once something was merged into the entry (it is then rebuilt). */
  raw: Record<string, unknown> | null = null;
  readonly feed: FeedKind | null;

  constructor(
    item: BufferItem<C>,
    readonly instrument: string | null,
  ) {
    this.item = item;
    this.feed =
      instrument !== null && (item.kind === "TouchlineFeed" || item.kind === "DepthFeed")
        ? item.kind
        : null;
  }

  wireRecord(): Readonly<Record<string, unknown>> {
    if (this.raw !== null) return this.raw;
    return this.item.kind === "control" ? {} : this.item.message.raw;
  }

  merge(fields: Readonly<Record<string, unknown>>): void {
    this.raw = { ...this.wireRecord(), ...fields };
  }
}

/** `e|tk` of any message carrying both (feeds, acks, unknown types), else null. */
function instrumentOf(item: BufferItem<unknown>): string | null {
  if (item.kind === "control") return null;
  const raw = item.message.raw;
  const exchange = raw["e"];
  const token = raw["tk"];
  if (exchange === undefined || exchange === null || token === undefined || token === null) {
    return null;
  }
  return `${keyText(exchange)}|${keyText(token)}`;
}

/** An `e` / `tk` value as text: a string as is, a JSON number by its exact text. */
function keyText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof JsonNumber) return value.text;
  return JSON.stringify(value);
}

/**
 * A FIFO of stream messages (and control entries) for one consumer.
 *
 * Once `limit` entries are waiting, a touchline/depth feed (`tf`/`df`) may be merged into a
 * waiting entry of its instrument instead of being appended (latest value per field wins; the
 * entry keeps its position). Only the instrument's two newest waiting entries are considered:
 * (a) the newest is a feed of the same type: merge into it; (b) the newest is a feed of the other
 * type and the second newest a feed of the same type: merge into the second newest and copy the
 * fields the newest's type can carry into the newest too. Otherwise it is appended. Acks, order
 * and position updates, unknown messages and control entries are never merged; nothing merges
 * across an entry of the same instrument, and nothing at all across a control entry. One WARNING
 * when merging starts, one when the backlog falls below `max(1, limit / 2)`.
 */
export class DeliveryBuffer<C> {
  /** What `get()` resolves with once the buffer has ended and is drained. */
  static readonly END: typeof END = END;

  readonly #limit: number;
  readonly #log: Logger;
  #entries: (Entry<C> | undefined)[] = [];
  #head = 0;
  /** Each instrument's waiting entries, newest last: at most the two newest. */
  #recent = new Map<string, Entry<C>[]>();
  #waiters: (() => void)[] = [];
  #merged = 0;
  #merging = false;
  #ended = false;

  constructor(limit: number, log: Logger) {
    this.#limit = limit;
    this.#log = log;
  }

  /** Entries waiting. */
  get length(): number {
    return this.#entries.length - this.#head;
  }

  /** How many messages were merged into an earlier waiting entry so far. */
  get mergedCount(): number {
    return this.#merged;
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** Append (or merge) one parsed message. */
  put(parsed: ParsedMessage): void {
    const entry = new Entry<C>(parsed, instrumentOf(parsed));
    if (entry.feed !== null && this.length >= this.#limit && this.#merge(entry)) return;
    this.#append(entry);
  }

  /** Append a control entry; nothing that arrives later merges into an entry before it. */
  putBarrier(control: C): void {
    this.#recent.clear();
    this.#append(new Entry<C>({ kind: "control", control }, null));
  }

  /** The next entry, or undefined when none is waiting. */
  take(): BufferItem<C> | undefined {
    return this.length > 0 ? this.#pop() : undefined;
  }

  /** The next entry in order; `DeliveryBuffer.END` once ended and drained. */
  async get(): Promise<BufferItem<C> | typeof END> {
    while (this.length === 0) {
      if (this.#ended) return END;
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
      });
    }
    return this.#pop();
  }

  /** Remove and return every waiting entry, in order. */
  drain(): BufferItem<C>[] {
    const items: BufferItem<C>[] = [];
    while (this.length > 0) items.push(this.#pop());
    return items;
  }

  /** No more entries will arrive: `get()` resolves `END` once the rest is taken. */
  end(): void {
    this.#ended = true;
    this.#wake();
  }

  #append(entry: Entry<C>): void {
    this.#entries.push(entry);
    if (entry.instrument !== null) {
      let recent = this.#recent.get(entry.instrument);
      if (recent === undefined) {
        recent = [];
        this.#recent.set(entry.instrument, recent);
      }
      recent.push(entry);
      if (recent.length > 2) recent.shift();
    }
    this.#wake();
  }

  /** Apply rule a or b to the feed `entry`; false when it must be appended. */
  #merge(entry: Entry<C>): boolean {
    const recent = entry.instrument === null ? undefined : this.#recent.get(entry.instrument);
    const newest = recent?.at(-1);
    if (recent === undefined || newest === undefined || entry.item.kind === "control") {
      return false;
    }
    const fields = entry.item.message.raw;
    let target: Entry<C>;
    if (newest.feed === entry.feed) {
      target = newest; // a
    } else if (newest.feed !== null && recent.length === 2 && recent[0]?.feed === entry.feed) {
      target = recent[0]; // b: `newest` is delivered after `target`, so it gets the newer values
      const known = new Set([...WIRE_FIELDS[newest.feed], ...Object.keys(newest.wireRecord())]);
      const shared = Object.fromEntries(
        Object.entries(fields).filter(([key]) => known.has(key) && !IDENTITY.has(key)),
      );
      if (Object.keys(shared).length > 0) newest.merge(shared);
    } else {
      return false;
    }
    target.merge(fields);
    target.item = entry.item;
    this.#merged += 1;
    if (!this.#merging) {
      this.#merging = true;
      this.#log.warn(
        `Stream consumer is falling behind (${String(this.length)} messages waiting); ` +
          "merging market-data updates per instrument",
      );
    }
    return true;
  }

  #pop(): BufferItem<C> {
    const entry = this.#entries[this.#head];
    if (entry === undefined) throw new Error("DeliveryBuffer is empty");
    this.#entries[this.#head] = undefined; // released for the garbage collector
    this.#head += 1;
    if (this.#head > 1024 && this.#head * 2 > this.#entries.length) {
      this.#entries = this.#entries.slice(this.#head);
      this.#head = 0;
    }
    if (entry.instrument !== null) {
      const recent = this.#recent.get(entry.instrument);
      if (recent?.[0] === entry) {
        recent.shift(); // the oldest is popped first
        if (recent.length === 0) this.#recent.delete(entry.instrument);
      }
    }
    const item = this.#rebuilt(entry);
    if (this.#merging && this.length < Math.max(1, Math.floor(this.#limit / 2))) {
      this.#merging = false;
      this.#log.warn(
        `Stream consumer caught up (${String(this.length)} messages waiting); ` +
          `${String(this.#merged)} updates merged so far`,
      );
    }
    return item;
  }

  /** The entry's message, rebuilt from its merged wire fields when something was merged in. */
  #rebuilt(entry: Entry<C>): BufferItem<C> {
    const item = entry.item;
    if (entry.raw === null || item.kind === "control") return item;
    const t = item.message.t;
    const parse = Object.hasOwn(STREAM_MESSAGE_PARSERS, t) ? STREAM_MESSAGE_PARSERS[t] : undefined;
    try {
      if (parse === undefined) throw new Error("no parser");
      const message = parse(entry.raw, { endpoint: item.kind });
      return { kind: item.kind, message } as ParsedMessage;
    } catch {
      // Defensive: deliver the latest update rather than nothing.
      this.#log.warn(`Could not rebuild a merged "${t}" stream message`);
      return item;
    }
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }
}
