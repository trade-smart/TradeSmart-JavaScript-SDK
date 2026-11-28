// The internal stream connection against a local WebSocket server (sdk-behaviour.md §9.1–9.6,
// §3.1 User-Agent, §13 never log frames). Timing goes through an injected clock: heartbeat,
// liveness and auth-timeout tests use a manual FakeClock; reconnect tests use the real clock with
// a tiny back-off and the jitter fixed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessToken } from "../../src/auth.js";
import { ClientConfig, headerUserAgent, type ClientConfigInit } from "../../src/config.js";
import {
  AuthenticationError,
  NetworkError,
  RequestTimeoutError,
  RequestValidationError,
  SubscriptionLimitError,
  TradeSmartError,
} from "../../src/errors.js";
import type { Clock } from "../../src/lib/ratelimit.js";
import type { Logger, LogContext } from "../../src/lib/log.js";
import { StreamConnection, type StreamSink } from "../../src/stream/connection.js";
import type { ParsedMessage } from "../../src/stream/protocol.js";
import type { StreamState } from "../../src/stream/state.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { TestWsServer, type TestServerOptions } from "./ws-server.js";

const CLIENT_ID = "TEST123";
const TOKEN = "synthetic-ws-token-7f3a9c";

interface Recorder {
  sink: StreamSink;
  states: StreamState[];
  messages: ParsedMessage[];
  closedWith: (TradeSmartError | null)[];
  /** `reconnectCount` as seen when each CONNECTED was reported. */
  reconnectsAtConnected: number[];
  closed: Promise<TradeSmartError | null>;
}

interface Line {
  level: string;
  msg: string;
  ctx: LogContext | undefined;
}

function captureLogger(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: string) =>
    (msg: string, ctx?: LogContext): void => {
      lines.push({ level, msg, ctx });
    };
  return {
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
    lines,
  };
}

const servers: TestWsServer[] = [];
const connections: StreamConnection[] = [];

afterEach(async () => {
  while (connections.length > 0) await connections.pop()?.close();
  while (servers.length > 0) await servers.pop()?.stop();
});

async function startServer(options: TestServerOptions = {}): Promise<TestWsServer> {
  const server = await TestWsServer.start(options);
  servers.push(server);
  return server;
}

function recorder(connRef: { conn?: StreamConnection } = {}): Recorder & {
  connRef: { conn?: StreamConnection };
} {
  let resolveClosed: (e: TradeSmartError | null) => void = () => undefined;
  const closed = new Promise<TradeSmartError | null>((resolve) => {
    resolveClosed = resolve;
  });
  const r = {
    states: [] as StreamState[],
    messages: [] as ParsedMessage[],
    closedWith: [] as (TradeSmartError | null)[],
    reconnectsAtConnected: [] as number[],
    closed,
    connRef,
    sink: {} as StreamSink,
  };
  r.sink = {
    message: (parsed) => {
      r.messages.push(parsed);
    },
    stateChange: (state) => {
      r.states.push(state);
      if (state === "CONNECTED") r.reconnectsAtConnected.push(connRef.conn?.reconnectCount ?? -1);
    },
    closed: (error) => {
      r.closedWith.push(error);
      resolveClosed(error);
    },
  };
  return r;
}

interface Make {
  config?: ClientConfigInit;
  clock?: Clock;
  token?: string | AccessToken;
  now?: () => Date;
  sink?: StreamSink;
}

function make(
  server: TestWsServer,
  options: Make = {},
): {
  conn: StreamConnection;
  r: ReturnType<typeof recorder>;
  config: ClientConfig;
} {
  const r = recorder();
  const config = ClientConfig.create({
    wsUrl: server.url,
    reconnectBackoffBase: 0.01,
    reconnectBackoffCap: 0.05,
    ...options.config,
  });
  const conn = new StreamConnection({
    clientId: CLIENT_ID,
    accessToken: options.token ?? TOKEN,
    config,
    sink: options.sink ?? r.sink,
    random: () => 0,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  r.connRef.conn = conn;
  connections.push(conn);
  return { conn, r, config };
}

const settle = <T>(p: Promise<T>): Promise<T | Error> =>
  p.then(
    (v) => v,
    (e: unknown) => e as Error,
  );

describe("connect (§9.1)", () => {
  it("opens, authenticates and reports CONNECTING, AUTHENTICATING, CONNECTED once each", async () => {
    const server = await startServer();
    const { conn, r, config } = make(server);
    expect(conn.state).toBe("DISCONNECTED");
    await conn.connect();
    expect(conn.state).toBe("CONNECTED");
    expect(r.states).toEqual(["CONNECTING", "AUTHENTICATING", "CONNECTED"]);
    expect(server.connections).toHaveLength(1);
    expect(server.last.frames[0]).toEqual({
      t: "a",
      uid: CLIENT_ID,
      actid: CLIENT_ID,
      source: "API",
      accesstoken: TOKEN,
    });
    expect(server.last.headers["user-agent"]).toBe(headerUserAgent(config));
    expect(server.last.headers["user-agent"]).toBe("tradesmart-javascript/2.1.1");
    expect(conn.reconnectCount).toBe(0);
  });

  it("sends a configured User-Agent with the SDK token appended", async () => {
    const server = await startServer();
    const { conn } = make(server, { config: { userAgent: "my-app/1.0" } });
    await conn.connect();
    expect(server.last.headers["user-agent"]).toBe("my-app/1.0 tradesmart-javascript/2.1.1");
  });

  it("accepts the live server's OK", async () => {
    const server = await startServer({ ack: "OK" });
    const { conn } = make(server);
    await conn.connect();
    expect(conn.state).toBe("CONNECTED");
  });

  it("an ak rejection is AuthenticationError(endpoint WebSocket) and CLOSED, never retried", async () => {
    const server = await startServer({ ack: "Not_Ok" });
    const { conn, r } = make(server);
    const error = await settle(conn.connect());
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).endpoint).toBe("WebSocket");
    expect(conn.state).toBe("CLOSED");
    expect(r.states).toEqual(["CONNECTING", "AUTHENTICATING", "CLOSED"]);
    expect(r.closedWith).toEqual([null]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.handshakes).toBe(1);
  });

  it("no ak within ws_auth_timeout is RequestTimeoutError", async () => {
    const server = await startServer({ ack: null });
    const clock = new FakeClock(false);
    const { conn } = make(server, { clock });
    const pending = settle(conn.connect());
    await vi.waitFor(() => {
      expect(server.connections[0]?.frames).toHaveLength(1);
    });
    clock.advance(9999);
    clock.advance(1);
    const error = await pending;
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as Error).message).toBe("No connect acknowledgement within 10s");
    expect(conn.state).toBe("CLOSED");
  });

  it("a refused handshake is NetworkError and the initial connect never retries", async () => {
    const server = await startServer({ refuse: true });
    const { conn, r } = make(server);
    const error = await settle(conn.connect());
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toMatch(/^WebSocket connection failed: /);
    expect(r.states).toEqual(["CONNECTING", "CLOSED"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.handshakes).toBe(1);
  });

  it("an unreachable server is NetworkError", async () => {
    const server = await startServer();
    const url = server.url;
    await server.stop();
    servers.length = 0;
    const r = recorder();
    const conn = new StreamConnection({
      clientId: CLIENT_ID,
      accessToken: TOKEN,
      config: ClientConfig.create({ wsUrl: url }),
      sink: r.sink,
    });
    connections.push(conn);
    await expect(conn.connect()).rejects.toBeInstanceOf(NetworkError);
    expect(conn.state).toBe("CLOSED");
  });

  it("messages arriving before the ak are dispatched normally", async () => {
    const server = await startServer();
    server.beforeAck = (c) => {
      c.send({ t: "tk", e: "NSE", tk: "22", lp: "1156.00", v: "10" });
    };
    const { conn, r } = make(server);
    await conn.connect();
    expect(r.messages.map((m) => m.kind)).toEqual(["TouchlineAck"]);
    expect(conn.snapshot("nse|22")).toEqual({ e: "NSE", tk: "22", lp: "1156.00", v: "10" });
  });

  it("an expired AccessToken is AuthenticationError before anything is opened", async () => {
    const server = await startServer();
    const token = AccessToken.fromParts(
      TOKEN,
      new Date("2026-11-01T00:00:00Z"),
      new Date("2026-11-02T00:30:00Z"),
    );
    const { conn, r } = make(server, { token });
    const error = await settle(conn.connect());
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as Error).message).toContain("expired");
    expect(server.handshakes).toBe(0);
    expect(r.states).toEqual(["CLOSED"]);
  });

  it("check_token_expiry false lets an expired AccessToken connect", async () => {
    const server = await startServer();
    const token = AccessToken.fromParts(
      TOKEN,
      new Date("2026-11-01T00:00:00Z"),
      new Date("2026-11-02T00:30:00Z"),
    );
    const { conn } = make(server, { token, config: { checkTokenExpiry: false } });
    await conn.connect();
    expect(server.last.frames[0]?.["accesstoken"]).toBe(TOKEN);
  });

  it("connect() may be called once", async () => {
    const server = await startServer();
    const { conn } = make(server);
    await conn.connect();
    await expect(conn.connect()).rejects.toThrow(TradeSmartError);
    await expect(conn.connect()).rejects.toThrow("connect() can only be called once per stream");
  });

  it("close() during connect ends it quietly in CLOSED", async () => {
    const server = await startServer({ ack: null });
    const { conn, r } = make(server);
    const pending = settle(conn.connect());
    await vi.waitFor(() => {
      expect(server.connections[0]?.frames).toHaveLength(1);
    });
    await conn.close();
    expect(await pending).toBeUndefined();
    expect(conn.state).toBe("CLOSED");
    expect(r.closedWith).toEqual([null]);
  });
});

describe("messages and snapshots (§9.2, §9.3)", () => {
  it("delivers parsed messages, consumes ak and hk, and keeps unknown frames", async () => {
    const server = await startServer();
    const { conn, r } = make(server);
    await conn.connect();
    server.last.send({ t: "tf", e: "NSE", tk: "22", lp: "1.5" });
    server.last.send({ t: "hk", ft: "1730966400" });
    server.last.send({ t: "ak", s: "OK" });
    server.last.send("{not json");
    server.last.send({ t: "constructor" });
    server.last.send({ t: "om", norenordno: { bad: "1" }, status: "Complete" });
    await vi.waitFor(() => {
      expect(r.messages).toHaveLength(4);
    });
    expect(r.messages.map((m) => [m.kind, m.message.t])).toEqual([
      ["TouchlineFeed", "tf"],
      ["UnknownMessage", ""],
      ["UnknownMessage", "constructor"],
      ["UnknownMessage", "om"],
    ]);
    expect(conn.heartbeatAcks).toBe(1);
    expect(conn.state).toBe("CONNECTED");
  });

  it("merges tk, tf, dk and df into the snapshot of e|tk", async () => {
    const server = await startServer();
    const { conn, r } = make(server);
    await conn.connect();
    server.last.send({ t: "tk", e: "NSE", tk: "22", lp: "1", v: "5" });
    server.last.send({ t: "tf", e: "NSE", tk: "22", lp: "2" });
    server.last.send({ t: "dk", e: "NSE", tk: "22", bp1: "1.9" });
    server.last.send({ t: "df", e: "NSE", tk: "22", sp1: "2.1" });
    server.last.send({ t: "om", norenordno: "1", e: "NSE", tk: "22", lp: "99" });
    await vi.waitFor(() => {
      expect(r.messages).toHaveLength(5);
    });
    const expected = { e: "NSE", tk: "22", lp: "2", v: "5", bp1: "1.9", sp1: "2.1" };
    expect(conn.snapshot("NSE|22")).toEqual(expected);
    expect(conn.snapshot(["nse", "22"])).toEqual(expected);
    expect(conn.snapshot("NSE|23")).toBeNull();
    expect(() => conn.snapshot(["NSE|22"] as unknown as string)).toThrow(RequestValidationError);
    expect(() => conn.snapshot("NSE22")).toThrow(RequestValidationError);
  });

  it("a sink that throws never stops the reader", async () => {
    const server = await startServer();
    const seen: string[] = [];
    const { conn } = make(server, {
      sink: {
        message: (m) => {
          seen.push(m.message.t);
          throw new Error("boom");
        },
        stateChange: () => {
          throw new Error("boom");
        },
        closed: () => undefined,
      },
    });
    await conn.connect();
    server.last.send({ t: "tf", e: "NSE", tk: "22", lp: "1" });
    server.last.send({ t: "tf", e: "NSE", tk: "22", lp: "2" });
    await vi.waitFor(() => {
      expect(seen).toEqual(["tf", "tf"]);
    });
    expect(conn.state).toBe("CONNECTED");
  });
});

describe("subscriptions (§9.4)", () => {
  it("sends subscribe and unsubscribe requests while CONNECTED", async () => {
    const server = await startServer();
    const { conn } = make(server);
    await conn.connect();
    await conn.subscribeTouchline(["nse|22", ["BSE", "1"], "NSE|22"]);
    await conn.subscribeDepth("NSE|22");
    await conn.subscribeOrders();
    await conn.subscribePositions();
    await conn.unsubscribeTouchline("NSE|22");
    await conn.unsubscribeDepth(["NSE", "22"]);
    await conn.unsubscribeOrders();
    await conn.unsubscribePositions();
    await vi.waitFor(() => {
      expect(server.last.frames).toHaveLength(9);
    });
    expect(server.last.frames.slice(1)).toEqual([
      { t: "t", k: "NSE|22#BSE|1" },
      { t: "d", k: "NSE|22" },
      { t: "o", actid: CLIENT_ID },
      { t: "p", uid: CLIENT_ID },
      { t: "u", k: "NSE|22" },
      { t: "ud", k: "NSE|22" },
      { t: "uo" },
      { t: "up" },
    ]);
  });

  it("an empty list sends nothing; an invalid instrument raises before sending", async () => {
    const server = await startServer();
    const { conn } = make(server);
    await conn.connect();
    await conn.subscribeTouchline([]);
    await expect(conn.subscribeTouchline(22 as unknown as string)).rejects.toThrow(
      "Invalid request parameters: instruments.0 (expected 'EXCH|TOKEN', (exchange, token) or a list of them)",
    );
    await conn.subscribeOrders();
    await vi.waitFor(() => {
      expect(server.last.frames).toHaveLength(2);
    });
    expect(server.last.frames[1]).toEqual({ t: "o", actid: CLIENT_ID });
  });

  it("subscribing before connect only registers; the request is sent on connect", async () => {
    const server = await startServer();
    const { conn } = make(server);
    await conn.subscribeTouchline(["NSE|9", "NSE|1"]);
    await conn.subscribePositions();
    await conn.connect();
    await vi.waitFor(() => {
      expect(server.last.frames).toHaveLength(3);
    });
    expect(server.last.frames.slice(1)).toEqual([
      { t: "t", k: "NSE|1#NSE|9" },
      { t: "p", uid: CLIENT_ID },
    ]);
  });

  it("1001 subscriptions raise SubscriptionLimitError and nothing is sent", async () => {
    const server = await startServer();
    const { conn } = make(server);
    await conn.connect();
    const keys = Array.from({ length: 1001 }, (_, i) => `NSE|${String(i)}`);
    await expect(conn.subscribeTouchline(keys)).rejects.toBeInstanceOf(SubscriptionLimitError);
    await conn.subscribeTouchline(keys.slice(0, 1000));
    // The same key in depth counts a second time.
    await expect(conn.subscribeDepth("NSE|0")).rejects.toBeInstanceOf(SubscriptionLimitError);
    await conn.subscribeOrders();
    await vi.waitFor(() => {
      expect(server.last.framesOf("o")).toHaveLength(1);
    });
    expect(server.last.frames.map((f) => f["t"])).toEqual(["a", "t", "o"]);
    expect((server.last.frames[1]?.["k"] as string).split("#")).toHaveLength(1000);
  });

  it("the limit also applies before connect", async () => {
    const server = await startServer();
    const { conn } = make(server);
    const keys = Array.from({ length: 1001 }, (_, i) => `NSE|${String(i)}`);
    await expect(conn.subscribeDepth(keys)).rejects.toBeInstanceOf(SubscriptionLimitError);
  });

  it("after CLOSED every subscribe and unsubscribe raises TradeSmartError", async () => {
    const server = await startServer();
    const { conn } = make(server);
    await conn.connect();
    await conn.close();
    const calls = [
      () => conn.subscribeTouchline("NSE|22"),
      () => conn.unsubscribeTouchline("NSE|22"),
      () => conn.subscribeDepth("NSE|22"),
      () => conn.unsubscribeDepth("NSE|22"),
      () => conn.subscribeOrders(),
      () => conn.unsubscribeOrders(),
      () => conn.subscribePositions(),
      () => conn.unsubscribePositions(),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toThrow("stream is closed; create a new stream");
    }
  });
});

describe("a socket closed before the replay (§9.1, §9.5)", () => {
  it("an initial connect rejects with NetworkError and goes CLOSED, never CONNECTED", async () => {
    const server = await startServer();
    server.kickAfterAck = 1;
    const { conn, r } = make(server);
    await conn.subscribeTouchline("NSE|22");
    const error = await settle(conn.connect());
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toBe("WebSocket closed while restoring subscriptions");
    expect(r.states).toEqual(["CONNECTING", "AUTHENTICATING", "CLOSED"]);
    expect(conn.state).toBe("CLOSED");
    expect(r.closedWith).toEqual([null]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.handshakes).toBe(1);
  });

  it("also with nothing to replay", async () => {
    const server = await startServer();
    server.kickAfterAck = 1;
    const { conn, r } = make(server);
    await expect(conn.connect()).rejects.toThrow("WebSocket closed while restoring subscriptions");
    expect(r.states).toEqual(["CONNECTING", "AUTHENTICATING", "CLOSED"]);
  });

  it("during a reconnect it is a failed attempt: no CONNECTED, reconnectCount unchanged", async () => {
    const server = await startServer();
    const { conn, r } = make(server);
    await conn.subscribeTouchline("NSE|22");
    await conn.connect();
    server.kickAfterAck = 1;
    server.last.close();
    await vi.waitFor(() => {
      expect(server.connections).toHaveLength(3);
      expect(r.states.at(-1)).toBe("CONNECTED");
    });
    expect(server.handshakes).toBe(3);
    expect(r.states).toEqual([
      "CONNECTING",
      "AUTHENTICATING",
      "CONNECTED",
      "RECONNECTING",
      "CONNECTED",
    ]);
    expect(conn.reconnectCount).toBe(1);
    expect(r.reconnectsAtConnected).toEqual([0, 1]);
  });

  it("when every attempt is kicked, the attempts run out and nothing is reported CONNECTED", async () => {
    const server = await startServer();
    const { conn, r } = make(server, { config: { reconnectMaxAttempts: 2 } });
    await conn.connect();
    server.kickAfterAck = 2;
    server.last.close();
    const error = await r.closed;
    expect(error?.message).toBe("reconnect attempts exhausted");
    expect(r.states).toEqual([
      "CONNECTING",
      "AUTHENTICATING",
      "CONNECTED",
      "RECONNECTING",
      "CLOSED",
    ]);
    expect(conn.reconnectCount).toBe(0);
    expect(server.handshakes).toBe(3);
  });
});

describe("reconnect (§9.5, §9.6)", () => {
  it("a server close gives RECONNECTING → CONNECTED and the subscriptions are replayed", async () => {
    const server = await startServer();
    const { conn, r } = make(server);
    await conn.connect();
    await conn.subscribeTouchline(["NSE|3", "NSE|1"]);
    await conn.subscribeDepth(["NSE|2"]);
    await conn.subscribeOrders();
    await conn.subscribePositions();
    await conn.subscribeTouchline("NSE|5");
    await conn.unsubscribeTouchline("NSE|5");
    await vi.waitFor(() => {
      expect(server.last.frames).toHaveLength(7);
    });
    server.last.close();
    await vi.waitFor(() => {
      expect(r.states.at(-1)).toBe("CONNECTED");
      expect(server.connections).toHaveLength(2);
    });
    expect(r.states).toEqual([
      "CONNECTING",
      "AUTHENTICATING",
      "CONNECTED",
      "RECONNECTING",
      "CONNECTED",
    ]);
    expect(conn.reconnectCount).toBe(1);
    expect(r.reconnectsAtConnected).toEqual([0, 1]);
    await vi.waitFor(() => {
      expect(server.last.frames).toHaveLength(5);
    });
    expect(server.last.frames).toEqual([
      { t: "a", uid: CLIENT_ID, actid: CLIENT_ID, source: "API", accesstoken: TOKEN },
      { t: "t", k: "NSE|1#NSE|3" },
      { t: "d", k: "NSE|2" },
      { t: "o", actid: CLIENT_ID },
      { t: "p", uid: CLIENT_ID },
    ]);
    expect(server.last.headers["user-agent"]).toBe("tradesmart-javascript/2.1.1");
  });

  it("an abrupt disconnect also reconnects", async () => {
    const server = await startServer();
    const { conn, r } = make(server);
    await conn.connect();
    server.last.terminate();
    await vi.waitFor(() => {
      expect(server.connections).toHaveLength(2);
      expect(r.states.at(-1)).toBe("CONNECTED");
    });
    expect(conn.reconnectCount).toBe(1);
  });

  it("a subscription made while RECONNECTING is sent exactly once", async () => {
    const server = await startServer();
    const { conn, r } = make(server);
    await conn.connect();
    server.refuse = true;
    server.last.close();
    await vi.waitFor(() => {
      expect(server.handshakes).toBeGreaterThanOrEqual(2);
    });
    expect(conn.state).toBe("RECONNECTING");
    await conn.subscribeTouchline("NSE|7");
    server.refuse = false;
    await vi.waitFor(() => {
      expect(r.states.at(-1)).toBe("CONNECTED");
    });
    await conn.subscribeOrders();
    await vi.waitFor(() => {
      expect(server.last.framesOf("o")).toHaveLength(1);
    });
    expect(server.last.framesOf("t")).toEqual([{ t: "t", k: "NSE|7" }]);
  });

  it("after reconnect_max_attempts failures the stream is CLOSED with the terminal error", async () => {
    const server = await startServer();
    const { conn, r } = make(server, { config: { reconnectMaxAttempts: 2 } });
    await conn.connect();
    server.refuse = true;
    server.last.close();
    const error = await r.closed;
    expect(error).toBeInstanceOf(NetworkError);
    expect(error?.message).toBe("reconnect attempts exhausted");
    expect(r.closedWith).toEqual([error]);
    expect(conn.state).toBe("CLOSED");
    expect(r.states).toEqual([
      "CONNECTING",
      "AUTHENTICATING",
      "CONNECTED",
      "RECONNECTING",
      "CLOSED",
    ]);
    expect(server.handshakes).toBe(3);
    expect(conn.terminalError).toBe(error);
    await expect(conn.subscribeOrders()).rejects.toThrow(TradeSmartError);
  });

  it("reconnect_max_attempts 0 ends at the first loss", async () => {
    const server = await startServer();
    const { conn, r } = make(server, { config: { reconnectMaxAttempts: 0 } });
    await conn.connect();
    server.last.close();
    const error = await r.closed;
    expect(error?.message).toBe("reconnect attempts exhausted");
    expect(server.handshakes).toBe(1);
  });

  it("an ak rejection on reconnect is terminal", async () => {
    const server = await startServer();
    const { conn, r } = make(server);
    await conn.connect();
    server.ack = "Not_Ok";
    server.last.close();
    const error = await r.closed;
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(conn.state).toBe("CLOSED");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.handshakes).toBe(2);
  });

  it("a token expired by the time of a reconnect ends the stream without opening a socket", async () => {
    const server = await startServer();
    let wall = new Date("2026-11-15T10:00:00Z");
    const token = AccessToken.fromParts(
      TOKEN,
      new Date("2026-11-15T09:00:00Z"),
      new Date("2026-11-16T00:30:00Z"),
    );
    const { conn, r } = make(server, { token, now: () => wall });
    await conn.connect();
    wall = new Date("2026-11-16T01:00:00Z");
    server.last.close();
    const error = await r.closed;
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(server.handshakes).toBe(1);
  });

  it("the delay before every attempt follows the back-off formula, the first one included", async () => {
    const server = await startServer();
    const sleeps: number[] = [];
    const handshakesAtSleep: number[] = [];
    const real: Clock = {
      now: () => performance.now(),
      sleep: (ms, signal) => {
        sleeps.push(ms);
        handshakesAtSleep.push(server.handshakes);
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, Math.min(ms, 20));
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
      },
    };
    // Delays under 1 s last at most 20 ms here; the longer sleeps (open and ack timeouts,
    // heartbeat, liveness) never end.
    const { conn, r } = make(server, {
      clock: {
        now: () => performance.now(),
        sleep: (ms, signal) => (ms >= 1000 ? new Promise(() => undefined) : real.sleep(ms, signal)),
      },
      config: { reconnectMaxAttempts: 3, reconnectBackoffBase: 0.1, reconnectBackoffCap: 0.3 },
    });
    await conn.connect();
    server.refuse = true;
    server.last.close();
    await r.closed;
    // random() = 0: min(cap, base·2^n)·0.5 for n = 0, 1, 2.
    expect(sleeps).toEqual([50, 100, 150]);
    // Each delay is slept before its attempt: after 1 (the first connect), 2 and 3 handshakes.
    expect(handshakesAtSleep).toEqual([1, 2, 3]);
  });
});

describe("heartbeat and liveness (§9.5)", () => {
  it("sends {t:h} every heartbeat_interval while CONNECTED and counts hk", async () => {
    const server = await startServer();
    const clock = new FakeClock(false);
    const { conn, r } = make(server, { clock });
    await conn.connect();
    expect(server.last.framesOf("h")).toHaveLength(0);
    clock.advance(29_999);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.last.framesOf("h")).toHaveLength(0);
    clock.advance(1);
    await vi.waitFor(() => {
      expect(server.last.framesOf("h")).toHaveLength(1);
      expect(conn.heartbeatAcks).toBe(1);
    });
    clock.advance(30_000);
    await vi.waitFor(() => {
      expect(server.last.framesOf("h")).toHaveLength(2);
      expect(conn.heartbeatAcks).toBe(2);
    });
    expect(server.last.framesOf("h")[0]).toEqual({ t: "h" });
    expect(r.messages).toHaveLength(0);
    expect(conn.state).toBe("CONNECTED");
  });

  it("no frame for 2 × heartbeat_interval reconnects with a WARNING", async () => {
    const server = await startServer({ answerHeartbeats: false });
    const clock = new FakeClock(false);
    const { logger, lines } = captureLogger();
    const { conn, r } = make(server, { clock, config: { logger } });
    await conn.connect();
    clock.advance(30_000);
    await vi.waitFor(() => {
      expect(server.last.framesOf("h")).toHaveLength(1);
    });
    clock.advance(30_000);
    await vi.waitFor(() => {
      expect(conn.state).toBe("RECONNECTING");
      expect(clock.sleeps).toContain(5); // the first back-off delay (base 0.01 s · 0.5)
    });
    expect(
      lines.some((l) => l.level === "warn" && l.msg.includes("No WebSocket message for 60s")),
    ).toBe(true);
    clock.advance(5);
    await vi.waitFor(() => {
      expect(r.states.at(-1)).toBe("CONNECTED");
    });
    expect(server.connections).toHaveLength(2);
    expect(server.connections[0]?.closed).toBe(true);
  });
});

describe("close (§9.6)", () => {
  it("is idempotent, closes the socket and reports CLOSED once", async () => {
    const server = await startServer();
    const { conn, r } = make(server);
    await conn.connect();
    await Promise.all([conn.close(), conn.close()]);
    await conn.close();
    expect(conn.state).toBe("CLOSED");
    expect(r.states.filter((s) => s === "CLOSED")).toHaveLength(1);
    expect(r.closedWith).toEqual([null]);
    await vi.waitFor(() => {
      expect(server.last.closed).toBe(true);
    });
    expect(conn.terminalError).toBeNull();
  });

  it("closing a never-connected stream reports CLOSED", async () => {
    const server = await startServer();
    const { conn, r } = make(server);
    await conn.close();
    expect(r.states).toEqual(["CLOSED"]);
    expect(server.handshakes).toBe(0);
    await expect(conn.connect()).rejects.toThrow(TradeSmartError);
  });
});

describe("secrets (§13)", () => {
  it("the token and the connect frame never appear in any log line or error", async () => {
    const server = await startServer();
    const { logger, lines } = captureLogger();
    const { conn, r } = make(server, { config: { logger } });
    await conn.connect();
    await conn.subscribeTouchline("NSE|22");
    server.last.send({ t: "tf", e: "NSE", tk: "22", lp: "not-a-price" });
    server.last.send({ t: "zz", accesstoken: TOKEN });
    await vi.waitFor(() => {
      expect(r.messages).toHaveLength(2);
    });
    server.ack = "Not_Ok";
    server.last.close();
    const error = await r.closed;
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.level === "warn")).toBe(true);
    expect(lines.some((l) => l.level === "error")).toBe(true);
    const everything = JSON.stringify(lines);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("accesstoken");
    expect(everything).not.toContain('"t":"a"');
    expect(String(error)).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(JSON.stringify(r.messages.map((m) => m.message.raw))).not.toContain(TOKEN);
  });

  it("a rejected initial connect logs and throws nothing with the token", async () => {
    const server = await startServer({ ack: "Not_Ok" });
    const { logger, lines } = captureLogger();
    const { conn } = make(server, { config: { logger } });
    const error = await settle(conn.connect());
    expect(String(error)).not.toContain(TOKEN);
    expect(JSON.stringify((error as AuthenticationError).raw)).not.toContain(TOKEN);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });
});
