// A real `TradeSmart` whose HTTP dispatcher is an undici `MockAgent` answering scripted replies in
// turn (the last one repeats), as specifications/conformance/README.md describes for
// outcome_words.json and transport_failures.json. Time is a `FakeClock` (no real sleeping) and
// every log line is recorded.
import { errors, MockAgent } from "undici";
import { AccessToken } from "../../src/auth.js";
import { TradeSmart } from "../../src/client.js";
import { ClientConfig, type ClientConfigInit } from "../../src/config.js";
import { ServerError, type TradeSmartError } from "../../src/errors.js";
import { type CallContext, callContext } from "../../src/lib/call.js";
import type { LogContext, Logger } from "../../src/lib/log.js";
import { RateLimiter } from "../../src/lib/ratelimit.js";
import { retryPolicy } from "../../src/lib/retry.js";
import type { PreparedRequest, SendOptions, TransportResponse } from "../../src/transport/http.js";
import { FakeClock } from "./fake-clock.js";

export const ORIGIN = "https://api.example.test";
export const BASE_URL = `${ORIGIN}/NorenWClientAPIv2`;
export const TOKEN = "synthetic-token";
const HOLD_PATH = "/NorenWClientAPIv2/HoldThePermit";

export interface Reply {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  failure?: string;
}

export interface LogLine {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  ctx: LogContext | undefined;
}

export function recordingLogger(lines: LogLine[]): Logger {
  const at =
    (level: LogLine["level"]) =>
    (msg: string, ctx?: LogContext): void => {
      lines.push({ level, msg, ctx });
    };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

function sysError(code: string, syscall: string): Error {
  return Object.assign(new Error(`${syscall} ${code}`), { code, syscall, errno: -1 });
}

// The runtime constructor is (message, code?) (undici's .d.ts omits it).
const ParserError = errors.HTTPParserError as unknown as new (
  message: string,
  code?: string,
) => Error;

/**
 * The error the caller's dispatcher raises for each vector failure kind. `write_timeout`: undici
 * has no separate write timeout (its headers timeout covers the write, failures.ts), so the
 * vector's write timeout is undici's `HeadersTimeoutError`. `pool_timeout` and
 * `keyboard_interrupt` are not dispatcher errors: the harness produces them for real (a held
 * permit; an abort fired from `onSent`).
 */
const FAILURES: Readonly<Record<string, () => unknown>> = {
  connect_error: () => sysError("ECONNREFUSED", "connect"),
  connect_timeout: () => new errors.ConnectTimeoutError(),
  read_timeout: () => new errors.HeadersTimeoutError(),
  write_timeout: () => new errors.HeadersTimeoutError(),
  connection_reset: () => sysError("ECONNRESET", "read"),
  remote_protocol_error: () => new ParserError("bad reply", "INVALID_STATUS"),
  decoding_error: () => Object.assign(new Error("zlib"), { code: "Z_DATA_ERROR", errno: -3 }),
  hook_exception: () => new Error("raised by the caller's hook"),
  hook_sdk_error: () =>
    new ServerError("raised by the caller's hook", { endpoint: "hook", httpStatus: 503 }),
};

/** The error the caller's dispatcher raises for a vector failure kind (see FAILURES). */
export function dispatcherFailure(kind: string): unknown {
  const make = FAILURES[kind];
  if (make === undefined) throw new Error(`no dispatcher failure for ${kind}`);
  return make();
}

export type TokenKind = "valid" | "none" | "expired";

export function expiredToken(): AccessToken {
  return AccessToken.fromParts(
    TOKEN,
    new Date("2026-01-01T09:00:00+05:30"),
    new Date("2026-01-02T06:00:00+05:30"),
  );
}

export interface Scripted {
  client: TradeSmart;
  ctx: CallContext;
  agent: MockAgent;
  clock: FakeClock;
  lines: LogLine[];
  /** Requests that reached the transport (`HttpTransport.send` calls), the permit holder excluded. */
  sends: number;
  /** Requests that reached the mock server, the permit holder excluded. */
  hits: number;
  /** The headers of each request that reached the mock server. */
  headers: Record<string, string>[];
  /** The body of each request that reached the mock server. */
  bodies: string[];
  /** The path of each request that reached the mock server. */
  paths: string[];
  /** The abort fired from `onSent` for a `keyboard_interrupt` reply (else never aborted). */
  interrupt: AbortController;
  /** Take the only permit (needs `maxConnections: 1`) until `release()`. */
  holdPermit(): { release: () => void; done: Promise<unknown> };
}

/**
 * Config for a real pool-wait timeout: one permit (held by `holdPermit()`) and a 20 ms wait for
 * both writes (connect timeout) and reads (read timeout).
 */
export const POOL_TIMEOUT_CONFIG: ClientConfigInit = {
  maxConnections: 1,
  maxKeepaliveConnections: 1,
  connectTimeout: 0.02,
  readTimeout: 0.02,
};

/** Build the scripted client. `replies` answer the requests in turn; the last one repeats. */
export function scriptedClient(
  replies: readonly Reply[],
  options: { token?: TokenKind; config?: ClientConfigInit } = {},
): Scripted {
  const lines: LogLine[] = [];
  const agent = new MockAgent();
  agent.disableNetConnect();
  const interrupt = new AbortController();
  const state = { sends: 0, hits: 0 };
  const headers: Record<string, string>[] = [];
  const bodies: string[] = [];
  const paths: string[] = [];
  let releaseHold: (() => void) | null = null;

  agent
    .get(ORIGIN)
    .intercept({ path: () => true, method: "POST" })
    .reply(async (opts) => {
      if (opts.path === HOLD_PATH) {
        await new Promise<void>((resolve) => (releaseHold = resolve));
        return { statusCode: 200, data: "{}" };
      }
      state.hits += 1;
      headers.push(
        Object.fromEntries(
          Object.entries(opts.headers as Record<string, string>).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        ),
      );
      paths.push(opts.path);
      bodies.push(
        typeof opts.body === "string"
          ? opts.body
          : new TextDecoder().decode(opts.body as Uint8Array),
      );
      const step = replies[Math.min(state.hits, replies.length) - 1] ?? {};
      if (step.failure === "keyboard_interrupt") {
        // No answer: the request ends when the abort fired from onSent arrives.
        return new Promise<never>((_resolve, reject) => {
          const end = (): void => {
            reject(new Error("aborted"));
          };
          if (interrupt.signal.aborted) end();
          else interrupt.signal.addEventListener("abort", end, { once: true });
        });
      }
      if (step.failure !== undefined) {
        const make = FAILURES[step.failure];
        if (make === undefined) throw new Error(`no dispatcher failure for ${step.failure}`);
        throw make();
      }
      return {
        statusCode: step.status ?? 200,
        data: step.body ?? "",
        responseOptions: { headers: step.headers ?? {} },
      };
    })
    .persist();

  const token = options.token ?? "valid";
  const config = ClientConfig.create({
    baseUrl: BASE_URL,
    backoffBase: 1e-6,
    backoffCap: 1e-6,
    logger: recordingLogger(lines),
    ...options.config,
  });
  const client = new TradeSmart("TEST123", {
    ...(token === "valid" ? { accessToken: TOKEN } : {}),
    ...(token === "expired" ? { accessToken: expiredToken() } : {}),
    config,
    httpDispatcher: agent,
  });
  const ctx = callContext(client);
  const clock = new FakeClock();
  ctx.clock = clock;
  ctx.limiter = new RateLimiter(config, clock);
  ctx.policy = retryPolicy(config, () => 0.5);

  const transport = ctx.transport;
  const send = transport.send.bind(transport);
  const usesKeyboardInterrupt = replies.some((r) => r.failure === "keyboard_interrupt");
  transport.send = (req: PreparedRequest, opts: SendOptions): Promise<TransportResponse> => {
    if (!req.url.endsWith("/HoldThePermit")) state.sends += 1;
    if (!usesKeyboardInterrupt) return send(req, opts);
    return send(req, {
      ...opts,
      onSent: () => {
        opts.onSent?.();
        interrupt.abort();
      },
    });
  };

  const scripted: Scripted = {
    client,
    ctx,
    agent,
    clock,
    lines,
    get sends() {
      return state.sends;
    },
    get hits() {
      return state.hits;
    },
    headers,
    bodies,
    paths,
    interrupt,
    holdPermit() {
      const done = send(
        { url: `${ORIGIN}${HOLD_PATH}`, method: "POST", headers: {}, body: null },
        { stateChanging: false },
      ).catch((e: unknown) => e);
      return { release: () => releaseHold?.(), done };
    },
  };
  return scripted;
}

// ---------------------------------------------------------------------------------------------
// The calls of the vectors. `request_*` and `limits` go through the real `request()`; the typed
// order and GTT calls go through the real methods with the arguments the Python generator uses
// (sdk-python/scripts/gen_conformance.py `_ORDER_ARGUMENTS`). `invalid` makes the method's own
// validation reject the call before the logged block (§5.6: no line, nothing sent): `quantity` 0,
// or an empty id for the calls without a quantity.

const ORDER_ID = "26111000000001";
const ALERT_ID = "26111200000010";

const LIMIT_BUY = {
  exchange: "NSE",
  tradingsymbol: "ACC-EQ",
  quantity: 1,
  transactionType: "BUY",
  product: "CNC",
  orderType: "LIMIT",
  price: "2000.05",
};
const MODIFY = {
  exchange: "NSE",
  tradingsymbol: "ACC-EQ",
  quantity: 1,
  price: "2001.00",
  orderType: "LIMIT",
  product: "CNC",
};
const GTT = {
  exchange: "NSE",
  tradingsymbol: "INFY-EQ",
  alertType: "LTP_B_O",
  triggerValue: "1500",
  alertValidity: "GTT",
  tag: "Buy INFY below 1500",
  transactionType: "B",
  orderType: "LMT",
  product: "C",
  validity: "DAY",
  quantity: 1,
  price: "1500",
};

type Typed = (c: TradeSmart, invalid: boolean, opts: { signal?: AbortSignal }) => Promise<unknown>;

const TYPED: Readonly<Record<string, Typed>> = {
  place_order: (c, invalid, opts) =>
    c.placeOrder({ ...LIMIT_BUY, quantity: invalid ? 0 : 1 }, opts),
  modify_order: (c, invalid, opts) =>
    c.modifyOrder(ORDER_ID, { ...MODIFY, quantity: invalid ? 0 : 1 }, opts),
  cancel_order: (c, invalid, opts) => c.cancelOrder(invalid ? "" : ORDER_ID, opts),
  exit_order: (c, invalid, opts) => c.exitOrder(invalid ? "" : ORDER_ID, "BO", opts),
  place_gtt: (c, invalid, opts) => c.placeGtt({ ...GTT, quantity: invalid ? 0 : 1 }, opts),
  modify_gtt: (c, invalid, opts) =>
    c.modifyGtt(ALERT_ID, { ...GTT, quantity: invalid ? 0 : 1 }, opts),
  cancel_gtt: (c, invalid, opts) => c.cancelGtt(invalid ? "" : ALERT_ID, opts),
};

/** Run one vector `call` on the client; `signal` is the interruption's (`keyboard_interrupt`). */
export function invoke(
  s: Scripted,
  call: string,
  options: { invalid?: boolean; signal?: AbortSignal } = {},
): Promise<unknown> {
  const c = s.client;
  const signal = options.signal;
  const opts = { stateChanging: false, ...(signal === undefined ? {} : { signal }) };
  switch (call) {
    case "request_place_order":
      return c.request("placeorder", { exch: "NSE" }, { ...opts, stateChanging: true });
    case "request_place_gtt":
      return c.request("placegttorder", { exch: "NSE" }, opts);
    case "request_cancel_gtt":
      return c.request("CANCELGTTORDER", { al_id: "26111200000099" }, opts);
    case "request_place_iceberg":
      return c.request("placeicebergorder", { exch: "NSE" }, opts);
    case "request_order_book_state_changing":
    case "request_state_changing":
      return c.request("OrderBook", {}, { ...opts, stateChanging: true, expect: "list" });
    case "limits":
      return c.margins(signal === undefined ? {} : { signal });
  }
  const typed = TYPED[call];
  if (typed === undefined) throw new Error(`unknown vector call ${call}`);
  return typed(c, options.invalid === true, signal === undefined ? {} : { signal });
}

/** The error type name the vectors use: `KeyboardInterrupt` for the interruption's own reason. */
export function errorName(s: Scripted, error: unknown): string {
  if (s.interrupt.signal.aborted && error === s.interrupt.signal.reason) return "KeyboardInterrupt";
  return (error as TradeSmartError).name;
}
