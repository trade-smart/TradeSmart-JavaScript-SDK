// The public TradeSmartStream against a local WebSocket server (sdk-behaviour.md §2.6, §9.3,
// §9.6–9.8; design §7.6): ordered delivery in one dispatch loop, onStateChange out of band,
// `closed` that always resolves, iteration, close() semantics, a throwing or never-settling
// callback, and the factories.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AccessToken } from "../../src/auth.js";
import { TradeSmart } from "../../src/client.js";
import { ClientConfig } from "../../src/config.js";
import {
  AuthenticationError,
  RequestTimeoutError,
  RequestValidationError,
  TradeSmartError,
} from "../../src/errors.js";
import * as index from "../../src/index.js";
import type { Logger, LogContext } from "../../src/lib/log.js";
import {
  TradeSmartStream,
  withStreamInternals,
  type InboundStreamMessage,
  type StreamOptions,
} from "../../src/stream/stream.js";
import type { StreamState } from "../../src/stream/state.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { TestWsServer, type TestServerOptions } from "./ws-server.js";

const CLIENT_ID = "TEST123";
const TOKEN = "synthetic-ws-token-5d2e8b";

// Ruling 4: no unhandled rejection anywhere in these tests.
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeAll(() => {
  process.on("unhandledRejection", onUnhandled);
});
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
});

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
const streams: TradeSmartStream[] = [];

afterEach(async () => {
  while (streams.length > 0) await streams.pop()?.close();
  while (servers.length > 0) await servers.pop()?.stop();
});

async function startServer(options: TestServerOptions = {}): Promise<TestWsServer> {
  const server = await TestWsServer.start(options);
  servers.push(server);
  return server;
}

interface Made {
  stream: TradeSmartStream;
  lines: Line[];
}

function make(
  server: TestWsServer,
  options: StreamOptions = {},
  internals: { clock?: FakeClock } = {},
): Made {
  const { logger, lines } = captureLogger();
  const config = ClientConfig.create({
    wsUrl: server.url,
    reconnectBackoffBase: 0.01,
    reconnectBackoffCap: 0.05,
    logger,
  });
  const stream = new TradeSmartStream(
    CLIENT_ID,
    TOKEN,
    withStreamInternals(
      { ...options, config },
      internals.clock === undefined ? {} : { clock: internals.clock },
    ),
  );
  streams.push(stream);
  return { stream, lines };
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const tf = (lp: string, tk = "22"): Record<string, unknown> => ({ t: "tf", e: "NSE", tk, lp });
const lpOf = (m: InboundStreamMessage): string => String(m.raw["lp"]);
const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Advance a manual clock in steps until `done()` (the real event loop runs in between). */
async function advanceUntil(clock: FakeClock, done: () => boolean, stepMs = 500): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) {
    clock.advance(stepMs);
    await pause(5);
  }
  expect(done()).toBe(true);
}

describe("ordered delivery (§9.7, §9.8, design §7.6)", () => {
  it("runs callbacks one at a time in arrival order: onMessage first, then the typed one", async () => {
    const server = await startServer();
    const events: string[] = [];
    const slowly =
      (name: string) =>
      async (m: InboundStreamMessage): Promise<void> => {
        events.push(`${name}:${m.t}:start`);
        await pause(3);
        events.push(`${name}:${m.t}:end`);
      };
    const { stream } = make(server, {
      onConnect: () => {
        events.push("connect");
      },
      onMessage: slowly("message"),
      onTouchline: slowly("touchline"),
      onDepth: slowly("depth"),
      onOrderUpdate: slowly("order"),
      onPosition: slowly("position"),
    });
    await stream.connect();
    const frames = [
      { t: "tk", e: "NSE", tk: "22", lp: "1" },
      tf("2"),
      { t: "dk", e: "NSE", tk: "22", bp1: "1" },
      { t: "df", e: "NSE", tk: "22", bp1: "2" },
      { t: "om", norenordno: "1", status: "OPEN" },
      { t: "pk" },
      { t: "pm", tsym: "X" },
      { t: "uk" },
    ];
    for (const frame of frames) server.last.send(frame);
    const typed: Record<string, string> = {
      tk: "touchline",
      tf: "touchline",
      dk: "depth",
      df: "depth",
      om: "order",
      pk: "position",
      pm: "position",
    };
    const expected = ["connect"];
    for (const frame of frames) {
      const t = String(frame.t);
      expected.push(`message:${t}:start`, `message:${t}:end`);
      const name = typed[t];
      if (name !== undefined) expected.push(`${name}:${t}:start`, `${name}:${t}:end`);
    }
    await vi.waitFor(() => {
      expect(events).toEqual(expected);
    });
  });

  it("a slow onMessage delays neither reading nor heartbeats", async () => {
    const server = await startServer();
    const clock = new FakeClock(false);
    const g = gate();
    const seen: string[] = [];
    const { stream } = make(
      server,
      {
        onMessage: async (m) => {
          seen.push(lpOf(m));
          await g.promise;
        },
      },
      { clock },
    );
    await stream.connect();
    for (const lp of ["1", "2", "3"]) server.last.send(tf(lp));
    await vi.waitFor(() => {
      expect(stream.snapshot("NSE|22")?.["lp"]).toBe("3");
    });
    expect(seen).toEqual(["1"]);
    clock.advance(30_000);
    await vi.waitFor(() => {
      expect(server.last.framesOf("h")).toHaveLength(1);
      expect(stream.heartbeatAcks).toBe(1);
    });
    expect(seen).toEqual(["1"]);
    g.release();
    await vi.waitFor(() => {
      expect(seen).toEqual(["1", "2", "3"]);
    });
  });

  it("messages are buffered only for an active consumer", async () => {
    const server = await startServer();
    const { stream } = make(server);
    await stream.connect();
    server.last.send(tf("1"));
    await vi.waitFor(() => {
      expect(stream.snapshot("NSE|22")?.["lp"]).toBe("1");
    });
    const iterator = stream[Symbol.asyncIterator]();
    server.last.send(tf("2"));
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(lpOf(first.value as InboundStreamMessage)).toBe("2");
  });
});

describe("connect and disconnect callbacks (§9.8)", () => {
  it("onConnect on every CONNECTED, onReconnect after a reconnect, onDisconnect paired", async () => {
    const server = await startServer();
    const events: string[] = [];
    const { stream } = make(server, {
      onConnect: () => {
        events.push("connect");
      },
      onDisconnect: () => {
        events.push("disconnect");
      },
      onReconnect: async () => {
        await pause(1);
        events.push("reconnect");
      },
    });
    await stream.connect();
    await vi.waitFor(() => {
      expect(events).toEqual(["connect"]);
    });
    server.last.close();
    await vi.waitFor(() => {
      expect(events).toEqual(["connect", "disconnect", "connect", "reconnect"]);
    });
    expect(stream.reconnectCount).toBe(1);
    await stream.close();
    expect(events).toEqual(["connect", "disconnect", "connect", "reconnect", "disconnect"]);
  });

  it("a failed initial connect fires no callback; connect() rejects and closed resolves with the error", async () => {
    const server = await startServer({ ack: "Not_Ok" });
    const events: string[] = [];
    const record = (name: string) => (): void => {
      events.push(name);
    };
    const { stream } = make(server, {
      onConnect: record("connect"),
      onDisconnect: record("disconnect"),
      onError: record("error"),
      onReconnect: record("reconnect"),
    });
    const error = await stream.connect().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(stream.state).toBe("CLOSED");
    expect(await stream.closed).toBe(error);
    await pause(20);
    expect(events).toEqual([]);
  });

  it("connect() rejects with RequestTimeoutError after timeoutMs and the stream is closed", async () => {
    const server = await startServer({ ack: null });
    const { stream } = make(server);
    const error = await stream.connect({ timeoutMs: 50 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as Error).message).toBe("Stream did not connect within 0.05s");
    expect(stream.state).toBe("CLOSED");
    expect(await stream.closed).toBe(error);
  });

  it("connect() may be called once", async () => {
    const server = await startServer();
    const { stream } = make(server);
    await stream.connect();
    await expect(stream.connect()).rejects.toBeInstanceOf(TradeSmartError);
  });
});

describe("terminal errors and closed (design §7.6)", () => {
  it("onError comes after the messages received before the terminal error", async () => {
    const server = await startServer();
    const events: string[] = [];
    const g = gate();
    const { stream } = make(server, {
      onConnect: () => {
        events.push("connect");
      },
      onMessage: async (m) => {
        events.push(`message:${lpOf(m)}`);
        await g.promise;
      },
      onDisconnect: () => {
        events.push("disconnect");
      },
      onError: (e) => {
        events.push(`error:${e.name}`);
      },
    });
    await stream.connect();
    server.last.send(tf("1"));
    server.last.send(tf("2"));
    await vi.waitFor(() => {
      expect(stream.snapshot("NSE|22")?.["lp"]).toBe("2");
    });
    server.ack = "Not_Ok";
    server.last.close();
    await vi.waitFor(() => {
      expect(stream.state).toBe("CLOSED");
    });
    expect(events).toEqual(["connect", "message:1"]);
    g.release();
    const error = await stream.closed;
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(events).toEqual([
      "connect",
      "message:1",
      "message:2",
      "disconnect",
      "error:AuthenticationError",
    ]);
  });

  it("closed resolves null after close(), is always the same promise and never rejects", async () => {
    const server = await startServer();
    const { stream } = make(server);
    expect(stream.closed).toBe(stream.closed);
    await stream.connect();
    await stream.close();
    expect(await stream.closed).toBeNull();
    await stream.close(); // idempotent
    expect(stream.state).toBe("CLOSED");
  });

  it("with no consumer the terminal error is logged at ERROR and closed resolves with it", async () => {
    const server = await startServer();
    const { stream, lines } = make(server);
    await stream.connect();
    server.ack = "Not_Ok";
    server.last.close();
    const error = await stream.closed;
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(lines.some((l) => l.level === "error" && l.msg.includes((error as Error).message))).toBe(
      true,
    );
  });

  it("an iterator throws the terminal error after the messages received before it", async () => {
    const server = await startServer();
    const { stream } = make(server);
    const iterator = stream[Symbol.asyncIterator]();
    await stream.connect();
    server.last.send(tf("1"));
    await vi.waitFor(() => {
      expect(stream.snapshot("NSE|22")?.["lp"]).toBe("1");
    });
    server.ack = "Not_Ok";
    server.last.close();
    const error = await stream.closed;
    const first = await iterator.next();
    expect(lpOf(first.value as InboundStreamMessage)).toBe("1");
    await expect(iterator.next()).rejects.toBe(error);
  });
});

describe("close() (§9.7, §9.8)", () => {
  it("after close() no message callback runs; one DEBUG line counts the skipped messages", async () => {
    const server = await startServer();
    const g = gate();
    const calls: string[] = [];
    const { stream, lines } = make(server, {
      onMessage: async (m) => {
        calls.push(`message:${m.t}`);
        await g.promise;
      },
      onOrderUpdate: () => {
        calls.push("order");
      },
    });
    await stream.connect();
    server.last.send(tf("1"));
    server.last.send({ t: "om", norenordno: "1", status: "OPEN" });
    server.last.send(tf("3"));
    await vi.waitFor(() => {
      expect(stream.snapshot("NSE|22")?.["lp"]).toBe("3");
    });
    const closing = stream.close();
    g.release();
    await closing;
    await pause(20);
    expect(calls).toEqual(["message:tf"]);
    const skipped = lines.filter((l) => l.msg.startsWith("stream stopped:"));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.level).toBe("debug");
    expect(skipped[0]?.msg).toBe(
      "stream stopped: 2 received messages were not delivered to the callbacks " +
        "(1 order/position updates)",
    );
  });

  it("an iterator yields the messages already received after close(), then ends", async () => {
    const server = await startServer();
    const { stream } = make(server);
    const iterator = stream[Symbol.asyncIterator]();
    await stream.connect();
    server.last.send(tf("1"));
    server.last.send({ t: "om", norenordno: "1", status: "OPEN" });
    server.last.send(tf("2"));
    await vi.waitFor(() => {
      expect(stream.snapshot("NSE|22")?.["lp"]).toBe("2");
    });
    await stream.close();
    const got: string[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      got.push(next.value.t);
    }
    expect(got).toEqual(["tf", "om", "tf"]);
    expect((await iterator.next()).done).toBe(true);
  });

  it("close() from inside onMessage returns without waiting for itself", async () => {
    const server = await startServer();
    let finished = false;
    let elapsed = -1;
    const { stream } = make(server, {
      onMessage: async () => {
        const started = Date.now();
        await stream.close();
        elapsed = Date.now() - started;
        finished = true;
      },
    });
    await stream.connect();
    server.last.send(tf("1"));
    await vi.waitFor(() => {
      expect(finished).toBe(true);
    });
    expect(elapsed).toBeLessThan(1000);
    expect(await stream.closed).toBeNull();
  });

  it("[Symbol.asyncDispose] closes the stream", async () => {
    const server = await startServer();
    const { stream } = make(server);
    await stream.connect();
    await stream[Symbol.asyncDispose]();
    expect(stream.state).toBe("CLOSED");
    await expect(stream.subscribeOrders()).rejects.toBeInstanceOf(TradeSmartError);
  });
});

describe("close() while RECONNECTING (§9.5, §9.7)", () => {
  it("closes cleanly during the back-off wait: closed resolves null, no further attempt", async () => {
    const server = await startServer();
    const clock = new FakeClock(false);
    const states: StreamState[] = [];
    const { stream } = make(
      server,
      {
        onStateChange: (state) => {
          states.push(state);
        },
      },
      { clock },
    );
    await stream.connect();
    server.last.close();
    await vi.waitFor(() => {
      expect(states.at(-1)).toBe("RECONNECTING");
    });
    const attempts = server.connections.length;
    let done = false;
    void stream.close().then(() => {
      done = true;
    });
    await advanceUntil(clock, () => done);
    expect(await stream.closed).toBeNull();
    expect(states.at(-1)).toBe("CLOSED");
    clock.advance(120_000);
    await pause(30);
    expect(server.connections).toHaveLength(attempts);
    expect(stream.reconnectCount).toBe(0);
  });

  it("closes cleanly while a reconnect handshake is in progress: closed resolves, socket closed, no callback, no further attempt", async () => {
    const server = await startServer();
    const events: string[] = [];
    const record = (name: string) => (): void => {
      events.push(name);
    };
    const { stream } = make(server, {
      onConnect: record("connect"),
      onReconnect: record("reconnect"),
      onDisconnect: record("disconnect"),
      onMessage: record("message"),
    });
    await stream.connect();
    // The next login is never answered, so the second connection stays in its handshake.
    server.ack = null;
    server.last.close();
    await vi.waitFor(() => {
      expect(server.connections).toHaveLength(2);
      expect(server.connections[1]?.framesOf("a")).toHaveLength(1);
    });
    expect(stream.state).not.toBe("CONNECTED");
    const handshake = server.connections[1];
    await stream.close();
    expect(stream.state).toBe("CLOSED");
    expect(await stream.closed).toBeNull();
    const seen = [...events];
    await vi.waitFor(() => {
      expect(handshake?.closed).toBe(true);
    });
    await pause(100);
    expect(server.connections).toHaveLength(2);
    expect(stream.reconnectCount).toBe(0);
    expect(events).toEqual(seen);
    expect(events).not.toContain("reconnect");
  });
});

describe("a typed callback never runs after close()", () => {
  it("close() during onMessage of an order update skips onOrderUpdate", async () => {
    const server = await startServer();
    const g = gate();
    const calls: string[] = [];
    const { stream } = make(server, {
      onMessage: async (m) => {
        calls.push(`message:${m.t}`);
        await g.promise;
      },
      onOrderUpdate: () => {
        calls.push("order");
      },
    });
    await stream.connect();
    server.last.send({ t: "om", norenordno: "1", status: "OPEN" });
    await vi.waitFor(() => {
      expect(calls).toEqual(["message:om"]);
    });
    const closing = stream.close();
    g.release();
    await closing;
    await pause(20);
    expect(calls).toEqual(["message:om"]);
  });
});

describe("a failing callback (Review Focus 5)", () => {
  it("a callback that throws synchronously is logged and passed to onError; the stream goes on", async () => {
    const server = await startServer();
    let calls = 0;
    const errors: Error[] = [];
    const { stream, lines } = make(server, {
      onMessage: () => {
        calls += 1;
        throw new Error("boom");
      },
      onError: (e) => {
        errors.push(e);
      },
    });
    await stream.connect();
    for (const lp of ["1", "2", "3"]) server.last.send(tf(lp));
    await vi.waitFor(() => {
      expect(calls).toBe(3);
      expect(errors).toHaveLength(3);
    });
    expect(errors.map((e) => e.message)).toEqual(["boom", "boom", "boom"]);
    expect(lines.filter((l) => l.msg === "onMessage callback raised")).toHaveLength(3);
    expect(lines.find((l) => l.msg === "onMessage callback raised")?.level).toBe("error");
    await stream.subscribeTouchline("NSE|22");
    await vi.waitFor(() => {
      expect(server.last.framesOf("t")).toHaveLength(1);
    });
    await stream.close();
    expect(await stream.closed).toBeNull();
  });

  it("a rejecting async callback is logged and passed to onError; an onError that throws is only logged", async () => {
    const server = await startServer();
    const errors: Error[] = [];
    const { stream, lines } = make(server, {
      onTouchline: async () => {
        await pause(1);
        throw new Error("async boom");
      },
      onError: (e) => {
        errors.push(e);
        throw new Error("onError boom");
      },
    });
    await stream.connect();
    server.last.send(tf("1"));
    server.last.send(tf("2"));
    await vi.waitFor(() => {
      expect(errors).toHaveLength(2);
      expect(lines.filter((l) => l.msg === "onError callback raised")).toHaveLength(2);
    });
    expect(lines.filter((l) => l.msg === "onTouchline callback raised")).toHaveLength(2);
    expect(stream.state).toBe("CONNECTED");
  });

  it("a callback whose Promise never settles: reading, heartbeats, reconnects and state changes go on; close() completes", async () => {
    const server = await startServer();
    const clock = new FakeClock(false);
    let calls = 0;
    const states: StreamState[] = [];
    const { stream, lines } = make(
      server,
      {
        onMessage: () => {
          calls += 1;
          return new Promise<void>(() => undefined);
        },
        onStateChange: (state) => {
          states.push(state);
        },
      },
      { clock },
    );
    await stream.connect();
    server.last.send(tf("1"));
    server.last.send(tf("2"));
    await vi.waitFor(() => {
      expect(stream.snapshot("NSE|22")?.["lp"]).toBe("2");
    });
    expect(calls).toBe(1);
    clock.advance(30_000);
    await vi.waitFor(() => {
      expect(server.last.framesOf("h")).toHaveLength(1);
    });
    server.last.close();
    await advanceUntil(clock, () => stream.reconnectCount === 1, 20);
    await vi.waitFor(() => {
      expect(states.slice(-2)).toEqual(["RECONNECTING", "CONNECTED"]);
    });
    server.last.send(tf("3"));
    await vi.waitFor(() => {
      expect(stream.snapshot("NSE|22")?.["lp"]).toBe("3");
    });
    let done = false;
    void stream.close().then(() => {
      done = true;
    });
    await advanceUntil(clock, () => done);
    expect(states.at(-1)).toBe("CLOSED");
    expect(calls).toBe(1);
    expect(lines.filter((l) => l.level === "warn" && l.msg.includes("still running"))).toHaveLength(
      1,
    );
    expect(await stream.closed).toBeNull();
  });
});

describe("onStateChange (§9.6)", () => {
  it("an async onStateChange still running at close() is awaited", async () => {
    const server = await startServer();
    const clock = new FakeClock(false);
    const g = gate();
    const { stream, lines } = make(
      server,
      { onStateChange: (s) => (s === "CLOSED" ? g.promise : undefined) },
      { clock },
    );
    await stream.connect();
    let done = false;
    void stream.close().then(() => {
      done = true;
    });
    await pause(50);
    expect(done).toBe(false);
    g.release();
    await vi.waitFor(() => {
      expect(done).toBe(true);
    });
    expect(lines.filter((l) => l.level === "warn")).toEqual([]);
  });

  it("is given CLOSE_TIMEOUT (2 s) at close(), then abandoned with one WARNING", async () => {
    const server = await startServer();
    const clock = new FakeClock(false);
    const { stream, lines } = make(
      server,
      {
        onStateChange: (s) => (s === "CLOSED" ? new Promise<void>(() => undefined) : undefined),
      },
      { clock },
    );
    await stream.connect();
    let done = false;
    void stream.close().then(() => {
      done = true;
    });
    await pause(50);
    expect(done).toBe(false);
    clock.advance(1999);
    await pause(20);
    expect(done).toBe(false);
    await advanceUntil(clock, () => done, 1);
    const warnings = lines.filter((l) => l.level === "warn");
    expect(warnings.map((l) => l.msg)).toEqual([
      "1 onStateChange callback(s) still running 2s after close(); abandoned",
    ]);
    expect(await stream.closed).toBeNull();
  });

  it("runs out of band: a throwing one is logged and the stream goes on", async () => {
    const server = await startServer();
    const { stream, lines } = make(server, {
      onStateChange: () => {
        throw new Error("state boom");
      },
    });
    await stream.connect();
    expect(stream.state).toBe("CONNECTED");
    expect(lines.filter((l) => l.msg === "onStateChange callback raised").length).toBe(3);
  });

  it("close() from inside an async onStateChange returns without waiting for itself", async () => {
    const server = await startServer();
    let inner: Promise<void> | undefined;
    let elapsed = -1;
    const { stream, lines } = make(server, {
      onStateChange: async (s) => {
        if (s !== "RECONNECTING") return;
        const started = Date.now();
        inner = stream.close();
        await inner;
        elapsed = Date.now() - started;
      },
    });
    await stream.connect();
    server.last.close();
    await vi.waitFor(() => {
      expect(elapsed).toBeGreaterThanOrEqual(0);
    });
    expect(elapsed).toBeLessThan(1000);
    expect(await stream.closed).toBeNull();
    await pause(20);
    expect(lines.filter((l) => l.level === "warn" && l.msg.includes("still running"))).toEqual([]);
  });
});

describe("snapshots and subscriptions (§9.3, §9.4)", () => {
  it("snapshot() returns the merged wire fields, a JSON number as its exact text", async () => {
    const server = await startServer();
    const { stream } = make(server);
    await stream.connect();
    server.last.send('{"t":"tk","e":"NSE","tk":"22","lp":1156.50,"v":123456789012345678901}');
    server.last.send({ t: "tf", e: "NSE", tk: "22", pc: "0.5" });
    await vi.waitFor(() => {
      expect(stream.snapshot("NSE|22")?.["pc"]).toBe("0.5");
    });
    expect(stream.snapshot(["nse", "22"])).toEqual({
      e: "NSE",
      tk: "22",
      lp: "1156.50",
      v: "123456789012345678901",
      pc: "0.5",
    });
    expect(stream.snapshot("NSE|99")).toBeNull();
    expect(() => stream.snapshot(["NSE|1", "NSE|2"] as unknown as string)).toThrow(
      RequestValidationError,
    );
  });

  it("subscribe and unsubscribe pass through; after CLOSED they reject", async () => {
    const server = await startServer();
    const { stream } = make(server);
    await stream.connect();
    await stream.subscribeTouchline(["NSE|22", ["nse", "23"]]);
    await stream.subscribeDepth("NSE|22");
    await stream.subscribeOrders();
    await stream.subscribePositions();
    await stream.unsubscribeTouchline("NSE|22");
    await stream.unsubscribeDepth("NSE|22");
    await stream.unsubscribeOrders();
    await stream.unsubscribePositions();
    await vi.waitFor(() => {
      expect(server.last.frames.slice(1).map((f) => f["t"])).toEqual([
        "t",
        "d",
        "o",
        "p",
        "u",
        "ud",
        "uo",
        "up",
      ]);
    });
    expect(server.last.frames[1]).toEqual({ t: "t", k: "NSE|22#NSE|23" });
    await stream.close();
    await expect(stream.subscribeTouchline("NSE|22")).rejects.toBeInstanceOf(TradeSmartError);
  });
});

describe("factories (§2.6)", () => {
  it("fromClient with an expired AccessToken throws AuthenticationError and connects nothing", async () => {
    const server = await startServer();
    const token = AccessToken.fromParts(
      TOKEN,
      new Date("2026-11-01T00:00:00Z"),
      new Date("2026-11-02T00:30:00Z"),
    );
    const client = new TradeSmart(CLIENT_ID, {
      accessToken: token,
      config: { wsUrl: server.url },
    });
    try {
      expect(() => TradeSmartStream.fromClient(client)).toThrow(AuthenticationError);
      await pause(20);
      expect(server.handshakes).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("fromClient without a token throws AuthenticationError", async () => {
    const client = new TradeSmart(CLIENT_ID);
    try {
      expect(() => TradeSmartStream.fromClient(client)).toThrow(AuthenticationError);
    } finally {
      await client.close();
    }
  });

  it("fromClient takes the client's id, token and config", async () => {
    const server = await startServer();
    const client = new TradeSmart(CLIENT_ID, {
      accessToken: TOKEN,
      config: { wsUrl: server.url },
    });
    try {
      const stream = TradeSmartStream.fromClient(client);
      streams.push(stream);
      await stream.connect();
      expect(server.last.frames[0]).toMatchObject({ uid: CLIENT_ID, accesstoken: TOKEN });
    } finally {
      await client.close();
    }
  });

  it("fromEnv reads the client id and token from the environment", async () => {
    const server = await startServer();
    const stream = TradeSmartStream.fromEnv({
      env: { TRADESMART_CLIENT_ID: CLIENT_ID, TRADESMART_ACCESS_TOKEN: TOKEN },
      config: { wsUrl: server.url },
    });
    streams.push(stream);
    await stream.connect();
    expect(server.last.frames[0]).toMatchObject({ uid: CLIENT_ID, accesstoken: TOKEN });
  });

  it("is exported from the package index", () => {
    expect(index.TradeSmartStream).toBe(TradeSmartStream);
    expect(index.StreamState.CLOSED).toBe("CLOSED");
  });
});
