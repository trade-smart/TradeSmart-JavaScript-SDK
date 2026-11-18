// `OfflineBroker`: the public face of the offline broker (Python: testing/_broker.py). It owns one
// `BrokerState` (what the test sets and what the strategy sends), an in-memory REST dispatcher and
// a private folder for the script master and a loopback stream server (started with the first
// client or stream), and builds real clients and streams wired to them.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AccessToken } from "../auth.js";
import { TradeSmart } from "../client.js";
import type { ClientConfigInit } from "../config.js";
import { ConfigurationError } from "../errors.js";
import { Exchange } from "../enums.js";
import type { Logger } from "../lib/log.js";
import { TradeSmartStream, type StreamOptions } from "../stream/stream.js";
import type { Drill } from "./drills.js";
import { forget, own, watch, type Orphan } from "./lifecycle.js";
import { OfflineDispatcher, offlineConfig } from "./rest.js";
import { OfflineStreamServer } from "./ws.js";
import type { Numeric, Wire } from "./replies.js";
import {
  BrokerState,
  PLACE_MODES,
  type AddInstrumentOptions,
  type CandleInput,
  type OfflineOrder,
  type OfflineRequest,
} from "./state.js";

// Synthetic app credentials, so loginUrl() and generateSession() work against the offline broker.
const APP_KEY = "offline-app-key";
const SECRET_KEY = "offline-secret-key";
// Settings that point the clients at the offline broker; an override would send calls elsewhere.
const OFFLINE_URLS = ["wsUrl", "baseUrl", "authorizeUrl", "scriptMasterBaseUrl"] as const;
// How long the synthetic login of `client()` stays valid.
const LOGIN_LIFETIME_MS = 24 * 3_600_000;

/** Options of `new OfflineBroker(options)`. */
export interface OfflineBrokerOptions {
  /** The client id of the offline account, `"OFFLINE01"` by default. */
  clientId?: string | undefined;
  /** Receives the broker's own DEBUG lines (a stream listener that failed); silent by default. */
  logger?: Logger | undefined;
}

/**
 * An offline TradeSmart server for testing strategy code with the real SDK client. Use
 * `await using broker = new OfflineBroker()` or call `close()`. Nothing leaves the process: REST
 * runs in memory through an undici dispatcher and streams connect to a WebSocket server on
 * `127.0.0.1` (a free port, started with the first client or stream). `close()` stops the streams
 * built here, the server and deletes the private script-master folder. Every client and stream it
 * builds keeps it alive; a broker never closed is cleaned up once it and all of them are collected.
 */
export class OfflineBroker {
  readonly #state: BrokerState;
  readonly #dispatcher: OfflineDispatcher;
  readonly #instrumentsDir: string;
  // What the finalizer cleans up; it must never refer to the broker itself.
  readonly #orphan: Orphan;
  readonly #streams = new Set<WeakRef<TradeSmartStream>>();
  #closed = false; // no more clients or streams
  #closing: Promise<void> | null = null;

  constructor(options: OfflineBrokerOptions = {}) {
    this.#state = new BrokerState(options.clientId ?? "OFFLINE01", options.logger);
    this.#dispatcher = new OfflineDispatcher(this.#state);
    // Offline script masters go here, never into the user's real cache folder.
    this.#instrumentsDir = mkdtempSync(path.join(tmpdir(), "tradesmart-offline-"));
    this.#orphan = { dir: this.#instrumentsDir, server: null };
    watch(this, this.#orphan);
  }

  // --- lifecycle -----------------------------------------------------------------------

  /**
   * Stop the streams built here and the stream server, and delete the private folder. Idempotent.
   * If stopping fails the error is rejected and a later `close()` tries again; no new client or
   * stream is built meanwhile.
   */
  close(): Promise<void> {
    this.#closing ??= this.#shutdown().catch((error: unknown) => {
      this.#closing = null;
      throw error;
    });
    return this.#closing;
  }

  async #shutdown(): Promise<void> {
    this.#closed = true;
    try {
      const streams = [...this.#streams].map((ref) => ref.deref());
      await Promise.all(streams.map((stream) => stream?.close() ?? Promise.resolve()));
      await this.#orphan.server?.close();
      forget(this);
    } finally {
      try {
        rmSync(this.#instrumentsDir, { recursive: true, force: true });
      } catch {
        // a folder that cannot be removed stays; it holds only synthetic data
      }
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  toString(): string {
    return `OfflineBroker(clientId=${this.clientId})`;
  }

  // --- real clients and streams wired to the offline broker ----------------------------

  /**
   * A real `TradeSmart` wired to the offline broker and already logged in (a synthetic token valid
   * for 24 hours). `config` sets client settings, e.g. `{ maxRetries: 0 }` to see a read drill's
   * error instead of the SDK's retry; the URLs are the broker's own and cannot be overridden.
   */
  client(config: ClientConfigInit = {}): TradeSmart {
    return own(
      new TradeSmart(this.clientId, {
        accessToken: this.#token(),
        appKey: APP_KEY,
        secretKey: SECRET_KEY,
        config: this.#config(config),
        httpDispatcher: this.#dispatcher,
      }),
      this,
    );
  }

  /**
   * A real `TradeSmartStream` for the offline broker, not yet connected (call `connect()`).
   * `callbacks` are the stream's callbacks (`onMessage`, `onOrderUpdate`, ...); `close()` of the
   * broker stops it too.
   */
  stream(callbacks: Omit<StreamOptions, "config"> = {}): TradeSmartStream {
    const stream = new TradeSmartStream(this.clientId, this.#token(), {
      ...callbacks,
      config: this.#config({}),
    });
    this.#streams.add(new WeakRef(stream));
    return own(stream, this);
  }

  // --- state set by the test -----------------------------------------------------------

  /** Add an instrument (served by search, chains, quotes and the script master). */
  addInstrument(
    exchange: string,
    token: string,
    symbol: string,
    options: AddInstrumentOptions = {},
  ): void {
    this.#state.addInstrument(exchange, token, symbol, options);
    this.#forgetScriptMaster(exchange);
  }

  /** Set quote fields (friendly names such as `lastPrice`, or wire keys). */
  setQuote(
    exchange: string,
    token: string,
    fields: Readonly<Record<string, Numeric | null>>,
  ): void {
    this.#state.setQuote(exchange, token, fields);
  }

  /** Set the candles served by `historicalData` and `dailyHistory`. */
  setCandles(exchange: string, token: string, candles: Iterable<CandleInput>): void {
    this.#state.setCandles(exchange, token, candles);
  }

  /** Set `Limits` fields (wire keys, e.g. `{ cash: "100000" }`). */
  setFunds(wire: Readonly<Record<string, unknown>>): void {
    this.#state.setFunds(wire);
  }

  /** Set the `Holdings` records (wire keys). */
  setHoldings(rows: Iterable<Readonly<Record<string, unknown>>>): void {
    this.#state.setHoldings(rows);
  }

  /** Set the starting positions (wire keys; at least `exch`, `tsym`, `prd`). */
  setPositions(rows: Iterable<Readonly<Record<string, unknown>>>): void {
    this.#state.setPositions(rows);
  }

  /** Set `UserDetails` fields (wire keys). */
  setUser(wire: Readonly<Record<string, unknown>>): void {
    this.#state.setUser(wire);
  }

  /** Answer `endpoint` with this body (for endpoints the offline broker does not model). */
  setReply(endpoint: string, body: Wire | readonly unknown[]): void {
    this.#state.setReply(endpoint, body);
  }

  /**
   * Update the quote and push the change as touchline (`tf`) and depth (`df`) messages to the
   * streams subscribed to the instrument. Takes the same fields as `setQuote`.
   */
  tick(exchange: string, token: string, fields: Readonly<Record<string, Numeric | null>>): void {
    this.#state.tick(exchange, token, fields);
  }

  // --- orders, driven by the test ------------------------------------------------------

  /** PENDING -> OPEN (TRIGGER_PENDING for a stop order). */
  accept(orderId: string): void {
    this.#state.accept(orderId);
  }

  /** Reject an open order with `message` as the reason. */
  reject(orderId: string, message: string): void {
    this.#state.reject(orderId, message);
  }

  /** Fill `quantity` (default: all that is open) at `price`; partials accumulate. */
  fill(orderId: string, price: Numeric, quantity?: number): void {
    this.#state.fill(orderId, price, quantity);
  }

  /** Cancel an open order (as the exchange would). */
  cancel(orderId: string): void {
    this.#state.cancel(orderId);
  }

  /** TRIGGER_PENDING -> OPEN. */
  trigger(orderId: string): void {
    this.#state.trigger(orderId);
  }

  /**
   * Fire a pending GTT: its order is placed (as `defaultPlace` says, with `add_ord_id` =
   * `alertId`) and the GTT moves to `triggeredGtts()`. Returns the new order id. A GTT never
   * fires on its own in the offline broker.
   */
  triggerGtt(alertId: string): string {
    return this.#state.triggerGtt(alertId);
  }

  /** Arm `drill` (from `drills`) for the next call of `endpoint`. */
  failNext(endpoint: string, drill: Drill): void {
    this.#state.failNext(endpoint, drill);
  }

  // --- stream drills -------------------------------------------------------------------

  /** Cut every open stream connection at once; the clients reconnect and resubscribe. */
  dropStream(): void {
    this.#orphan.server?.dropAll();
  }

  /** The next stream connect is answered `Not_Ok` (once). */
  refuseStreamLogin(): void {
    this.#state.refuseLoginOnce = true;
  }

  /** Stop answering heartbeats, so the clients' silence detection fires. */
  silenceStream(): void {
    this.#state.silenced = true;
  }

  /** Answer heartbeats again. */
  resumeStream(): void {
    this.#state.silenced = false;
  }

  // --- read access and settings --------------------------------------------------------

  /** The orders the strategy sent, oldest first (a new list; the orders are live). */
  get orders(): OfflineOrder[] {
    return [...this.#state.orders];
  }

  /** Every REST call received, oldest first (secrets masked). */
  get requests(): OfflineRequest[] {
    return [...this.#state.requests];
  }

  /** The client id of the offline account (`"OFFLINE01"` unless given). */
  get clientId(): string {
    return this.#state.clientId;
  }

  /** How a new order is booked: `"open"` (default), `"pending"` or `"reject"`. */
  get defaultPlace(): "open" | "pending" | "reject" {
    return this.#state.defaultPlace as "open" | "pending" | "reject";
  }

  set defaultPlace(value: "open" | "pending" | "reject") {
    if (!(PLACE_MODES as readonly string[]).includes(value)) {
      throw new RangeError(
        `defaultPlace must be 'open', 'pending' or 'reject', not '${value as string}'`,
      );
    }
    this.#state.defaultPlace = value;
  }

  /** The reason given to orders rejected by `defaultPlace = "reject"`. */
  get defaultRejectMessage(): string {
    return this.#state.defaultRejectMessage;
  }

  set defaultRejectMessage(value: string) {
    this.#state.defaultRejectMessage = value;
  }

  // --- helpers -------------------------------------------------------------------------

  /** The stream URL the clients are configured with; the server starts with the first call. */
  #wsUrl(): string {
    this.#orphan.server ??= new OfflineStreamServer(this.#state);
    return this.#orphan.server.url;
  }

  /** Delete the exchange's cached script master, so the next read gets the new list. */
  #forgetScriptMaster(exchange: string): void {
    if (!(Object.values(Exchange) as string[]).includes(exchange)) return;
    const cached = path.join(this.#instrumentsDir, `${exchange}_symbols.txt`);
    for (const file of [cached, `${cached}.checked`]) rmSync(file, { force: true });
  }

  #config(overrides: ClientConfigInit): ClientConfigInit {
    if (this.#closed) throw new Error("OfflineBroker is closed; create a new one");
    for (const name of OFFLINE_URLS) {
      if (Object.hasOwn(overrides, name)) {
        throw new ConfigurationError(
          `OfflineBroker sets ${name} itself (it points the client at itself); remove it from the settings`,
        );
      }
    }
    return offlineConfig(this.#wsUrl(), { instrumentsDir: this.#instrumentsDir, ...overrides });
  }

  /**
   * A synthetic login valid for 24 hours. Not the real 06:00 IST expiry: the broker cannot move
   * the clock, so that expiry would only make a test that runs across 06:00 IST fail.
   */
  #token(): AccessToken {
    const issued = new Date();
    return AccessToken.fromParts(
      `offline-token-${randomBytes(16).toString("hex")}`,
      issued,
      new Date(issued.getTime() + LOGIN_LIFETIME_MS),
    );
  }
}
