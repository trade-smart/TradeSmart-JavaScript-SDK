// The REST client (sdk-behaviour.md §2.2, §2.5, §6.1–6.4; design §7.2, §7.8). Every method goes
// through `executeCall` (lib/call.ts). The token and the app keys are private: `toString`,
// `inspect` and `toJSON` show only the client id.
import { inspect } from "node:util";
import { Decimal } from "decimal.js";
import type { Dispatcher } from "undici";
import {
  AccessToken,
  assertSendableToken,
  buildAuthorizeUrl,
  checkTokenText,
  computeChecksum,
  LOGIN_HINT,
} from "./auth.js";
import { ClientConfig, type ClientConfigInit } from "./config.js";
import { resolveFromEnv } from "./env.js";
import {
  APIError,
  AuthenticationError,
  ConfigurationError,
  OrderStatusUnknownError,
  ResponseParseError,
  TradeSmartError,
} from "./errors.js";
import { CALL_CONTEXT, type CallContext, type CallSpec, executeCall } from "./lib/call.js";
import { failureMessage } from "./lib/classify.js";
import { toWireDecimal } from "./lib/decimal.js";
import { makeLog } from "./lib/log.js";
import { canonicalEndpoint } from "./lib/names.js";
import { RateLimiter, systemClock } from "./lib/ratelimit.js";
import { retryPolicy } from "./lib/retry.js";
import { HttpTransport } from "./transport/http.js";
import {
  checkDisclosedQuantity,
  checkOrderRateFit,
  checkOrderRoom,
  checkSliceArguments,
  contractTokenAndLot,
  DEFAULT_MAX_SLICES,
  freezeQuantity,
  planSlices,
  SliceProgress,
  type PlaceSlicedOrderParams,
} from "./lib/slicing.js";
import { getContractIndex } from "./instruments/cache.js";
import type { Exchange, Product } from "./enums.js";
import {
  createInstrumentsContext,
  downloadInstruments as downloadInstrumentsFile,
  INSTRUMENTS_CONTEXT,
  exchangeCode,
  instrumentsContext,
  loadInstruments,
  type DownloadInstrumentsOptions,
} from "./instruments/download.js";
import {
  dailyHistoryCall,
  historicalDataCall,
  optionChainCall,
  quoteCall,
  searchCall,
  securityInfoCall,
  type TimeInput,
} from "./endpoints/market.js";
import {
  buildup as buildupOf,
  optionChainSnapshot as optionChainSnapshotOf,
  optionGreeks as optionGreeksOf,
  type DerivedDeps,
  type OptionChainSnapshot,
  type OptionChainSnapshotOptions,
  type OptionGreeksOptions,
} from "./endpoints/derived.js";
import type { PriceInput } from "./endpoints/orders.js";
import type { BuildupReading } from "./models/generated/analytics.js";
import type { OptionGreeks } from "./models/generated/greeks.js";
import {
  cancelGttCall,
  gttAlertTypesCall,
  modifyGttCall,
  pendingGttsCall,
  placeGttCall,
  triggeredGttsCall,
  type ModifyGttParams,
  type PlaceGttParams,
} from "./endpoints/gtt.js";
import {
  cancelOrderCall,
  exitOrderCall,
  modifyOrderCall,
  orderMarginCall,
  placeOrderCall,
  type ModifyOrderParams,
  type OrderMarginParams,
  type PlaceOrderParams,
} from "./endpoints/orders.js";
import {
  holdingsCall,
  limitsCall,
  orderBookCall,
  orderHistoryCall,
  positionsCall,
  tradeBookCall,
} from "./endpoints/portfolio.js";
import { userDetailsCall } from "./endpoints/user.js";
import type { Logger } from "./lib/log.js";
import type {
  Candle,
  DailyCandle,
  Gtt,
  Holding,
  Limits,
  OptionContract,
  Order,
  OrderHistoryEntry,
  OrderMargin,
  Position,
  Quote,
  ScripMatch,
  SecurityInfo,
  SlicedOrderResult,
  Trade,
  TriggeredGtt,
  UserDetails,
  OpenEnum,
} from "./models/index.js";

export type { ModifyGttParams, PlaceGttParams } from "./endpoints/gtt.js";
export type { PlaceSlicedOrderParams } from "./lib/slicing.js";
export type {
  ModifyOrderParams,
  OrderMarginParams,
  PlaceOrderParams,
  PriceInput,
} from "./endpoints/orders.js";

/** Options every client method accepts. */
export interface CallOptions {
  /** Abort the call: before the send nothing is sent; after it an order's outcome is unknown. */
  signal?: AbortSignal | undefined;
}

/** Options of `holdings()`. */
export interface HoldingsOptions extends CallOptions {
  /** A product word in any case or its wire code; default `CNC`. */
  product?: OpenEnum<Product> | undefined;
}

/** Options of `historicalData()`. */
export interface HistoricalDataOptions extends CallOptions {
  fromDate?: TimeInput | undefined;
  toDate?: TimeInput | undefined;
  /** Minutes: 1, 3, 5, 10, 15, 30, 60, 120 or 240. */
  interval?: number | string | undefined;
}

/** Options of `new TradeSmart(clientId, options)`. */
export interface TradeSmartOptions {
  /** A token string (stripped; blank means none) or an `AccessToken`; checked when set (§6.3). */
  accessToken?: string | AccessToken | null | undefined;
  /** The API Dashboard's App ID, for `loginUrl()` and `generateSession()`. */
  appKey?: string | null | undefined;
  secretKey?: string | null | undefined;
  config?: ClientConfig | ClientConfigInit | undefined;
  /** An undici dispatcher used as is (proxies, custom TLS, tests); never closed by the SDK. */
  httpDispatcher?: Dispatcher | undefined;
}

/** Options of `TradeSmart.fromEnv()`. */
export interface FromEnvOptions {
  config?: ClientConfig | ClientConfigInit | undefined;
  /** Default `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
}

/** Options of `request()`. */
export interface RequestOptions extends CallOptions {
  /** True: never retried and an ambiguous outcome is `OrderStatusUnknownError`. */
  stateChanging: boolean;
  /** Default `"object"`. */
  expect?: "object" | "list" | undefined;
}

/** A `request()` payload value: converted to its wire text (§7.3). */
export type RequestValue = string | number | boolean | bigint | Decimal;

function toConfig(config: ClientConfig | ClientConfigInit | undefined): ClientConfig {
  return config instanceof ClientConfig ? config : ClientConfig.create(config ?? {});
}

/**
 * A token as set (§6.3): a string is stripped and must then be visible ASCII (a blank one is no
 * token, `null`); an `AccessToken`'s text must be visible ASCII as is. Anything else is a
 * `ConfigurationError`. The value is never shown.
 */
function cleanToken(token: unknown): string | AccessToken | null {
  if (token instanceof AccessToken) {
    assertSendableToken(token.accessToken.reveal());
    return token;
  }
  if (typeof token !== "string") {
    throw new ConfigurationError("access_token must be a string or an AccessToken");
  }
  const text = checkTokenText(token);
  return text === "" ? null : text;
}

/**
 * A `request()` value as wire text (§7.3): a string as is; a boolean `"Yes"`/`"No"`; a finite
 * number or a Decimal as plain decimal text (no exponent); a bigint as its digits. `null`,
 * `undefined`, a non-finite number or any other value is a `TypeError` (a programming error), so
 * nothing is sent.
 */
function wireValue(key: string, value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "bigint") return value.toString();
  if ((typeof value === "number" && Number.isFinite(value)) || value instanceof Decimal) {
    if (value instanceof Decimal && !value.isFinite()) throw badValue(key);
    return toWireDecimal(value, key);
  }
  throw badValue(key);
}

function badValue(key: string): TypeError {
  return new TypeError(
    `request() payload value of '${key}' must be a string, a finite number, a boolean, a bigint ` +
      "or a finite Decimal (not null or undefined)",
  );
}

/** The TradeSmart API V2 REST client. Every method returns a `Promise`. */
export class TradeSmart {
  readonly clientId: string;
  readonly config: ClientConfig;
  #token: string | AccessToken | null;
  readonly #appKey: string | null;
  readonly #secretKey: string | null;
  /** Why `fromEnv` found no usable token (never secret); used by the first call's error. */
  #missingTokenReason: string | null = null;
  readonly #transport: HttpTransport;
  readonly #ctx: CallContext;
  /** The root `tradesmart` logger (the GTT "acknowledged alert id differs" DEBUG line). */
  readonly #log: Logger;
  #closed = false;

  constructor(clientId: string, options: TradeSmartOptions = {}) {
    if (typeof clientId !== "string" || clientId === "") {
      throw new ConfigurationError("client_id must not be empty");
    }
    this.clientId = clientId;
    this.config = toConfig(options.config);
    this.#token =
      options.accessToken === undefined || options.accessToken === null
        ? null
        : cleanToken(options.accessToken);
    this.#appKey = options.appKey ?? null;
    this.#secretKey = options.secretKey ?? null;
    this.#transport = new HttpTransport(this.config, options.httpDispatcher);
    const config = this.config;
    this.#ctx = {
      config,
      transport: this.#transport,
      limiter: new RateLimiter(config, systemClock),
      policy: retryPolicy(config),
      clock: systemClock,
      isClosed: () => this.#closed || this.#transport.isClosed(),
      bearer: () => this.#bearer(),
      ordersLog: makeLog(config.logger, "tradesmart.orders"),
      transportLog: makeLog(config.logger, "tradesmart.transport"),
    };
    this.#log = makeLog(config.logger, "tradesmart");
    Object.defineProperty(this, CALL_CONTEXT, { value: this.#ctx, enumerable: false });
    Object.defineProperty(this, INSTRUMENTS_CONTEXT, {
      value: createInstrumentsContext(
        config,
        this.#transport,
        makeLog(config.logger, "tradesmart.instruments"),
        () => this.#ctx.isClosed(),
      ),
      enumerable: false,
    });
  }

  /**
   * Build from `TRADESMART_*` environment variables or the saved login (§6.4). Every token found
   * is checked like a constructor token. Without a usable token but with an app key the client is
   * built and the first authenticated call names the reason.
   */
  static fromEnv(options: FromEnvOptions = {}): TradeSmart {
    const config = toConfig(options.config);
    const resolved = resolveFromEnv(options.env ?? process.env, {
      kind: "client",
      checkTokenExpiry: config.checkTokenExpiry,
    });
    const client = new TradeSmart(resolved.clientId, {
      accessToken: resolved.token,
      appKey: resolved.appKey,
      secretKey: resolved.secretKey,
      config,
    });
    client.#missingTokenReason = resolved.missingTokenReason;
    return client;
  }

  /** The token used for authenticated calls (`null` when none is set). */
  get accessToken(): AccessToken | string | null {
    return this.#token;
  }

  /** Replace the token (the constructor's checks; on failure the old token stays). */
  setAccessToken(token: string | AccessToken): void {
    this.#token = cleanToken(token);
  }

  /** The URL to open in a browser so the user can authorize the app (needs the app key). */
  loginUrl(): string {
    if (this.#appKey === null || this.#appKey === "") {
      throw new ConfigurationError("app_key is required to build the authorize URL");
    }
    return buildAuthorizeUrl(this.#appKey, this.config.authorizeUrl);
  }

  /**
   * Exchange a single-use authorization `code` for an access token (`GenAcsTok`, no
   * `Authorization` header, never retried) and store it on the client (§6.1, §6.3).
   */
  async generateSession(code: string, options: CallOptions = {}): Promise<AccessToken> {
    if (!this.#appKey || !this.#secretKey) {
      throw new ConfigurationError(
        "app_key and secret_key are required to generate an access token",
      );
    }
    if (typeof code !== "string") throw new ConfigurationError("code must be a string");
    const checksum = computeChecksum(this.#appKey, this.#secretKey, code);
    const spec: CallSpec<AccessToken> = {
      endpoint: "GenAcsTok",
      payload: [
        ["code", code],
        ["checksum", checksum],
      ],
      stateChanging: true,
      expect: "object",
      allowEmpty: false,
      rateGroup: null,
      authenticated: false,
      decode: (r) => AccessToken.fromResponse(r.kind === "ok" ? r.body : null, new Date()),
      signal: options.signal,
    };
    let token: AccessToken;
    try {
      token = await executeCall(this.#ctx, spec);
    } catch (error) {
      throw sessionError(error);
    }
    this.setAccessToken(token);
    return token;
  }

  /**
   * Call any endpoint (§2.5): the name is trimmed of whitespace and slashes and must be ASCII
   * letters (a known name takes its documented spelling, so `placeorder` is the never-retried
   * `PlaceOrder`); `uid` is appended when absent; values become wire text; always authenticated;
   * a `Not_Ok` "no data" reply is an `APIError`. Returns the parsed JSON body (numbers as exact
   * `JsonNumber` text).
   */
  async request(
    endpoint: string,
    payload: Readonly<Record<string, RequestValue>>,
    options: RequestOptions,
  ): Promise<unknown> {
    // Runtime guards for JavaScript callers the types do not reach.
    if (typeof (endpoint as unknown) !== "string") throw new TypeError("endpoint must be a string");
    const body = payload as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new TypeError("payload must be an object of wire keys and values");
    }
    const given = options as Partial<Record<"stateChanging" | "expect", unknown>> | null;
    if (typeof given !== "object" || given === null || typeof given.stateChanging !== "boolean") {
      throw new TypeError("options.stateChanging must be true or false");
    }
    const expect = options.expect ?? "object";
    if (given.expect !== undefined && given.expect !== "object" && given.expect !== "list") {
      throw new TypeError("options.expect must be 'object' or 'list'");
    }
    const info = canonicalEndpoint(endpoint);
    const wire: [string, string][] = Object.entries(payload).map(([key, value]) => [
      key,
      wireValue(key, value),
    ]);
    if (!Object.hasOwn(payload, "uid")) wire.push(["uid", this.clientId]);
    return executeCall(this.#ctx, {
      endpoint: info.endpoint,
      payload: wire,
      stateChanging: options.stateChanging || info.stateChanging,
      expect,
      allowEmpty: false,
      rateGroup: info.rateGroup,
      decode: (r) => (r.kind === "ok" ? r.body : []),
      signal: options.signal,
    });
  }

  // ---- Reads (sdk-behaviour.md §2.3). Never state-changing; the call path retries them (§5.1).
  // A parameter that fails its client-side check rejects the returned promise; nothing is sent.

  /** The user's profile (`UserDetails`). */
  profile(options: CallOptions = {}): Promise<UserDetails> {
    return this.#read(() => userDetailsCall(this.clientId, options.signal));
  }

  /** Margins and limits (`Limits`). */
  margins(options: CallOptions = {}): Promise<Limits> {
    return this.#read(() => limitsCall(this.clientId, options.signal));
  }

  /** Open positions (`PositionBook`); `[]` when there are none. */
  positions(options: CallOptions = {}): Promise<readonly Position[]> {
    return this.#read(() => positionsCall(this.clientId, options.signal));
  }

  /** Holdings of one product (`Holdings`; default `CNC`); `[]` when there are none. */
  holdings(options: HoldingsOptions = {}): Promise<readonly Holding[]> {
    return this.#read(() => holdingsCall(this.clientId, options.product, options.signal));
  }

  /** Today's orders (`OrderBook`); `[]` when there are none. */
  orders(options: CallOptions = {}): Promise<readonly Order[]> {
    return this.#read(() => orderBookCall(this.clientId, options.signal));
  }

  /** The history of one order (`SingleOrdHist`); `orderId` is a string. */
  orderHistory(orderId: string, options: CallOptions = {}): Promise<readonly OrderHistoryEntry[]> {
    return this.#read(() => orderHistoryCall(this.clientId, orderId, options.signal));
  }

  /** Today's trades (`TradeBook`); `[]` when there are none. */
  trades(options: CallOptions = {}): Promise<readonly Trade[]> {
    return this.#read(() => tradeBookCall(this.clientId, options.signal));
  }

  /** Pending GTTs (`GetPendingGTTOrder`); `[]` when there are none. */
  pendingGtts(options: CallOptions = {}): Promise<readonly Gtt[]> {
    return this.#read(() => pendingGttsCall(this.clientId, options.signal));
  }

  /** Triggered GTTs (`GetTrgOi`); `[]` when there are none. */
  triggeredGtts(options: CallOptions = {}): Promise<readonly TriggeredGtt[]> {
    return this.#read(() => triggeredGttsCall(this.clientId, options.signal));
  }

  /** The enabled GTT alert families such as `LTP` (`GetEnabledGTTs`). */
  gttAlertTypes(options: CallOptions = {}): Promise<readonly string[]> {
    return this.#read(() => gttAlertTypesCall(this.clientId, options.signal));
  }

  /** Search instruments by text (`SearchScrip`); `[]` when nothing matches. */
  searchInstruments(text: string, options: CallOptions = {}): Promise<readonly ScripMatch[]> {
    return this.#read(() => searchCall(this.clientId, text, options.signal));
  }

  /** A quote (`GetQuotes`); `token` is a string such as `"2885"`. */
  quote(exchange: OpenEnum<Exchange>, token: string, options: CallOptions = {}): Promise<Quote> {
    return this.#read(() => quoteCall(this.clientId, exchange, token, options.signal));
  }

  /** Security information (`GetSecurityInfo`); `token` is a string. */
  securityInfo(
    exchange: OpenEnum<Exchange>,
    token: string,
    options: CallOptions = {},
  ): Promise<SecurityInfo> {
    return this.#read(() => securityInfoCall(this.clientId, exchange, token, options.signal));
  }

  /** The option chain around a strike (`GetOptionChain`); `count` (at least 1) strikes per side. */
  optionChain(
    exchange: OpenEnum<Exchange>,
    tradingsymbol: string,
    strikePrice: Decimal | string | number,
    count: number,
    options: CallOptions = {},
  ): Promise<readonly OptionContract[]> {
    return this.#read(() =>
      optionChainCall(this.clientId, exchange, tradingsymbol, strikePrice, count, options.signal),
    );
  }

  /** Intraday candles (`TPSeries`); `interval` is in minutes (1, 3, 5, 10, 15, 30, 60, 120, 240). */
  historicalData(
    exchange: OpenEnum<Exchange>,
    token: string,
    options: HistoricalDataOptions = {},
  ): Promise<readonly Candle[]> {
    return this.#read(() =>
      historicalDataCall(this.clientId, exchange, token, options, options.signal),
    );
  }

  /** Daily candles (`EODChartData`, documented without `uid`). */
  dailyHistory(
    exchange: OpenEnum<Exchange>,
    tradingsymbol: string,
    fromDate: TimeInput,
    toDate: TimeInput,
    options: CallOptions = {},
  ): Promise<readonly DailyCandle[]> {
    return this.#read(() =>
      dailyHistoryCall(exchange, tradingsymbol, fromDate, toDate, options.signal),
    );
  }

  // ---- Derived reads: estimates and snapshots the SDK computes from several calls (§10.7, §11).

  /**
   * Implied volatility and Greeks of an option (estimates; see `tradesmart/greeks`). Black-76 on
   * the underlying future selected from the script master (or `underlyingPrice` as its price);
   * Black-Scholes-Merton when `spotPrice` is given. Prices not given are fetched with `quote()`
   * (at most two calls). Everything is checked before any request; a quote with no last price
   * gives `status: "no_price"`. After the expiry instant the option is not quoted (`"expired"`).
   */
  optionGreeks(
    exchange: OpenEnum<Exchange>,
    tradingsymbol: string,
    options: OptionGreeksOptions = {},
  ): Promise<OptionGreeks> {
    return optionGreeksOf(this.#derived(), exchange, tradingsymbol, options);
  }

  /**
   * `optionChain()` plus one `quote()` per contract, at most 10 in flight. A contract whose quote
   * fails for that contract alone is listed in `missing`; every other error is raised. Rows are
   * sorted by strike, then CE before PE.
   */
  optionChainSnapshot(
    exchange: OpenEnum<Exchange>,
    tradingsymbol: string,
    strikePrice: PriceInput,
    options: OptionChainSnapshotOptions = {},
  ): Promise<OptionChainSnapshot> {
    return optionChainSnapshotOf(this.#derived(), exchange, tradingsymbol, strikePrice, options);
  }

  /**
   * Buildup: the price change since the previous close (`lp − c`) and the open-interest change
   * since today's open (the sum of `intoi`).
   */
  buildup(
    exchange: OpenEnum<Exchange>,
    token: string,
    options: CallOptions = {},
  ): Promise<BuildupReading> {
    return buildupOf(this.#derived(), exchange, token, options);
  }

  #derived(): DerivedDeps {
    const ictx = instrumentsContext(this);
    return {
      quote: (exchange, token, signal) => this.quote(exchange, token, { signal }),
      optionChain: (exchange, tradingsymbol, strike, count, signal) =>
        this.optionChain(exchange, tradingsymbol, strike, count, { signal }),
      historicalData: (exchange, token, fromDate, toDate, signal) =>
        this.historicalData(exchange, token, { fromDate, toDate, interval: 1, signal }),
      contractIndex: (exchange, signal) => getContractIndex(ictx, exchange, signal),
      now: () => ictx.now(),
    };
  }

  // ---- Instruments (script master, sdk-behaviour.md §8). Plain GETs to the script-master origin.

  /**
   * The exchange's script master as header-keyed rows of strings, parsed afresh on every call
   * (the file is downloaded or reused first, §8.2). An unknown exchange is a `RangeError`.
   */
  instruments(
    exchange: OpenEnum<Exchange>,
    options: CallOptions = {},
  ): Promise<readonly Readonly<Record<string, string>>[]> {
    return loadInstruments(instrumentsContext(this), exchange, options.signal);
  }

  /**
   * Download `<EXCH>_symbols.txt` unless the cached file is fresh (§8.2) and return its path.
   * An unknown exchange is a `RangeError`.
   */
  downloadInstruments(
    exchange: OpenEnum<Exchange>,
    options: DownloadInstrumentsOptions = {},
  ): Promise<string> {
    return downloadInstrumentsFile(instrumentsContext(this), exchange, options);
  }

  // ---- Orders (sdk-behaviour.md §2.4, §5.2–5.6). Sent at most once, never retried: an ambiguous
  // outcome is `OrderStatusUnknownError` (check `orders()` before acting; never resend
  // automatically). Every parameter is checked first: all failures are reported together in one
  // `RequestValidationError` and nothing is sent or logged. Each call logs one outcome line on
  // `tradesmart.orders`.

  /**
   * Place an order and return its order id (the ack's `norenordno`, as received). An accepted
   * order is not a filled or even an open one: its state is in `orders()` / `orderHistory()`.
   * `algoId` overrides `ClientConfig.algoId` for this order. Pass a unique `tag` to find the
   * order in `orders()` after an `OrderStatusUnknownError`.
   */
  async placeOrder(params: PlaceOrderParams, options: CallOptions = {}): Promise<string> {
    const algoId = this.config.algoId;
    const result = await this.#write(() =>
      placeOrderCall(this.clientId, params, algoId, options.signal),
    );
    return result.id;
  }

  /**
   * Place an order larger than the exchange freeze limit as slices, one after another (§5.7).
   * `quantity` and `maxSliceQuantity` are in trade units, whole multiples of the lot size, on
   * every exchange. The slice size comes from the script master's lot size and
   * `securityInfo().frzqty`; every other parameter is sent unchanged on every slice through the
   * `placeOrder` path (never retried, paced by the order rate limit). A quantity within one slice
   * goes out as one order. Refused before anything is sent: `RangeError` (contract, lot size,
   * freeze quantity, quantity, slice limits), `placeOrder`'s own validation error,
   * `ConfigurationError` (the rate-limit settings would stop the order part-way) or
   * `RateLimitError` (the current minute has no room for all the slices). Sending stops at the
   * first failure: a definite one is returned as `{ complete: false, error }`; an ambiguous one
   * rejects with `OrderStatusUnknownError` carrying `slicedResult` (check `orders()` before
   * sending anything again). An abort or any other interruption stops further slices, rejects
   * with the original value and attaches `slicedResult` where the value accepts properties.
   */
  async placeSlicedOrder(
    params: PlaceSlicedOrderParams,
    options: CallOptions = {},
  ): Promise<SlicedOrderResult> {
    const { maxSliceQuantity, maxSlices, ...order } = params;
    const limit = maxSlices ?? DEFAULT_MAX_SLICES;
    checkSliceArguments(order.quantity, maxSliceQuantity, limit, order.tradingsymbol);
    options.signal?.throwIfAborted();
    const code = exchangeCode(order.exchange);
    const index = await getContractIndex(instrumentsContext(this), code, options.signal);
    const row = index.instruments.get(order.tradingsymbol.trim().toUpperCase()) ?? null;
    const { token, lotSize } = contractTokenAndLot(row, code);
    const info = await this.securityInfo(code, token, options);
    const slices = planSlices(code, order.quantity, lotSize, freezeQuantity(info, lotSize), {
      maxSliceQuantity,
      maxSlices: limit,
    });
    checkDisclosedQuantity(order.disclosedQuantity, slices);
    checkOrderRateFit(slices.length, this.config);
    checkOrderRoom(this.#ctx.limiter.orderRoomWait(slices.length), this.config);
    // placeOrder's own checks, once, on the first slice's arguments: nothing is sent when it fails.
    placeOrderCall(
      this.clientId,
      { ...order, quantity: slices[0] as number },
      this.config.algoId,
      undefined,
    );
    const progress = new SliceProgress(order.quantity, slices, this.#ctx.ordersLog);
    for (const size of slices) {
      try {
        progress.orderIds.push(await this.placeOrder({ ...order, quantity: size }, options));
      } catch (error) {
        const aborted = options.signal?.aborted === true && error === options.signal.reason;
        if (!aborted && error instanceof OrderStatusUnknownError) {
          progress.unknown(error);
          throw error;
        }
        if (!aborted && error instanceof TradeSmartError) return progress.stopped(error);
        progress.interrupted(error);
        throw error;
      }
    }
    return progress.done();
  }

  /**
   * Modify an open order and return its order id: the ack's `norenordno`, else its `result`,
   * else `orderId`. `price` is required for LMT / SL-LMT (`null` for MKT / SL-MKT sends `0`).
   */
  async modifyOrder(
    orderId: string,
    params: ModifyOrderParams,
    options: CallOptions = {},
  ): Promise<string> {
    const algoId = this.config.algoId;
    const result = await this.#write(() =>
      modifyOrderCall(this.clientId, orderId, params, algoId, options.signal),
    );
    return result.id;
  }

  /** Cancel an open order (`CancelOrder`) and return `orderId`. */
  async cancelOrder(orderId: string, options: CallOptions = {}): Promise<string> {
    const result = await this.#write(() => cancelOrderCall(this.clientId, orderId, options.signal));
    return result.id;
  }

  /** Exit a cover (`CO`) or bracket (`BO`) order (`ExitSNOOrder`) and return `orderId`. */
  async exitOrder(
    orderId: string,
    product: OpenEnum<Product>,
    options: CallOptions = {},
  ): Promise<string> {
    const result = await this.#write(() =>
      exitOrderCall(this.clientId, orderId, product, options.signal),
    );
    return result.id;
  }

  /** The margin an order would need (`GetOrderMargin`; a read: nothing is placed, retried). */
  orderMargin(params: OrderMarginParams, options: CallOptions = {}): Promise<OrderMargin> {
    return this.#read(() => orderMarginCall(this.clientId, params, options.signal));
  }

  // ---- GTT orders (sdk-behaviour.md §2.8). Order calls like the above; success only on the
  // documented word with a non-blank `al_id`; after an `OrderStatusUnknownError` look the GTT up
  // by its `tag` in `pendingGtts()` before placing anything again.

  /**
   * Place a GTT and return its alert id. The order is held on the server and sent when the value
   * `alertType` watches crosses `triggerValue`; a GTT whose condition is already true fires at
   * once (a real order). `alertValidity` `GTT` (default) keeps it until it triggers or is
   * cancelled (at most 365 days or the contract expiry); `DAY` ends it with the trading day.
   */
  placeGtt(params: PlaceGttParams, options: CallOptions = {}): Promise<string> {
    return this.#write(() => placeGttCall(this.clientId, params, options.signal));
  }

  /**
   * Modify a pending GTT: send every field again (`alertType` cannot change). `validity` and
   * `alertValidity` have no defaults. Returns the ack's `al_id` exactly as sent; when it differs
   * from `alertId` one DEBUG line on the `tradesmart` logger says so.
   */
  async modifyGtt(
    alertId: string,
    params: ModifyGttParams,
    options: CallOptions = {},
  ): Promise<string> {
    const returned = await this.#write(() =>
      modifyGttCall(this.clientId, alertId, params, options.signal),
    );
    return this.#acknowledgedAlertId("ModifyGTTOrder", alertId, returned);
  }

  /** Cancel a pending (not yet triggered) GTT; returns the ack's `al_id` exactly as sent. */
  async cancelGtt(alertId: string, options: CallOptions = {}): Promise<string> {
    const returned = await this.#write(() => cancelGttCall(this.clientId, alertId, options.signal));
    return this.#acknowledgedAlertId("CancelGTTOrder", alertId, returned);
  }

  #acknowledgedAlertId(endpoint: string, sent: string, returned: string): string {
    if (returned !== sent) {
      this.#log.debug(`${endpoint}: the acknowledged alert id differs from the one sent`);
    }
    return returned;
  }

  /**
   * Build an order call's spec and execute it. A failed parameter check rejects before the
   * logged block of `executeCall`, so it logs no outcome line and sends nothing (§5.6).
   */
  #write<T>(build: () => CallSpec<T>): Promise<T> {
    return this.#read(build);
  }

  /** Build a read's call spec (a failed check rejects, nothing is sent) and execute it. */
  #read<T>(build: () => CallSpec<T>): Promise<T> {
    // A throwing build rejects the promise (the executor turns a throw into a rejection).
    return new Promise<T>((resolve) => {
      resolve(executeCall(this.#ctx, build()));
    });
  }

  /** Release the connections; every later call rejects with `ConfigurationError` (idempotent). */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#transport.close();
  }

  /** `await using client = new TradeSmart(...)` closes the client at the end of the block. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  toString(): string {
    return `TradeSmart(client_id=${this.clientId})`;
  }

  toJSON(): { clientId: string } {
    return { clientId: this.clientId };
  }

  [inspect.custom](): string {
    return this.toString();
  }

  /** The bearer token text; `AuthenticationError` (nothing is sent) when missing or expired. */
  #bearer(): string {
    const token = this.#token;
    const text = token instanceof AccessToken ? token.accessToken.reveal() : token;
    if (text === null || text === "") {
      const message =
        this.#missingTokenReason !== null
          ? `No access token set: ${this.#missingTokenReason}; ${LOGIN_HINT} or call generateSession()`
          : "No access token set; call generateSession() or setAccessToken(), or " +
            `${LOGIN_HINT} and build the client with fromEnv()`;
      throw new AuthenticationError(message, { endpoint: "", httpStatus: null });
    }
    if (token instanceof AccessToken && this.config.checkTokenExpiry && token.isExpired()) {
      throw new AuthenticationError(
        `Access token expired at ${token.expiresAt.toISOString()} ` +
          `(tokens are valid until 06:00 IST); log in again, e.g. ${LOGIN_HINT}`,
        { endpoint: "", httpStatus: null },
      );
    }
    return text;
  }
}

/**
 * A failed `GenAcsTok` as §6.3 says: an `APIError` becomes `AuthenticationError("GenAcsTok
 * failed: <emsg>")` (an `AuthenticationError` already reads so); an unknown outcome or an
 * unparseable success means the single-use code is spent; provably-unsent failures keep their
 * types. No cause is chained.
 */
function sessionError(error: unknown): unknown {
  if (error instanceof AuthenticationError) return error;
  if (error instanceof APIError) {
    return new AuthenticationError(failureMessage("GenAcsTok", error.emsg), {
      endpoint: error.endpoint,
      httpStatus: error.httpStatus,
      emsg: error.emsg,
      requestTime: error.requestTime,
      raw: error.raw,
    });
  }
  if (error instanceof OrderStatusUnknownError) {
    return new AuthenticationError(
      "GenAcsTok outcome unknown: the authorisation code is single-use; restart the login",
      { endpoint: "GenAcsTok", httpStatus: error.httpStatus },
    );
  }
  if (error instanceof ResponseParseError) {
    return new AuthenticationError(
      "GenAcsTok response could not be parsed; the authorisation code is single-use; restart the login",
      { endpoint: "GenAcsTok", httpStatus: null },
    );
  }
  return error;
}
