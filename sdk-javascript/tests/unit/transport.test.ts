// The HTTP transport (sdk-behaviour §3.1, §3.3, §5.1–5.2, §2.2): undici MockAgent with the
// network disabled, plus a few loopback sockets that produce undici's real error codes.
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { Agent, type Dispatcher, MockAgent, errors, interceptors } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientConfig, type ClientConfigInit } from "../../src/config.js";
import {
  ConfigurationError,
  NetworkError,
  RequestTimeoutError,
  ServerError,
  TradeSmartError,
} from "../../src/errors.js";
import {
  PoolWaitTimeout,
  TransportFailure,
  type TransportFailureKind,
  classifySendFailure,
  isHookFailure,
  mapFailure,
} from "../../src/transport/failures.js";
import { HttpTransport, type PreparedRequest } from "../../src/transport/http.js";
import { loadVector } from "../conformance/vectors.js";

const ORIGIN = "https://api.example.test";
const PATH = "/NorenWClientAPIv2/PlaceOrder";
const BODY = new TextEncoder().encode('jData={"uid":"TEST123"}');

function cfg(init: ClientConfigInit = {}): ClientConfig {
  return ClientConfig.create({ baseUrl: `${ORIGIN}/NorenWClientAPIv2`, ...init });
}

function prepared(over: Partial<PreparedRequest> = {}): PreparedRequest {
  return {
    url: `${ORIGIN}${PATH}`,
    method: "POST",
    headers: { Authorization: "Bearer synthetic-token" },
    body: BODY,
    ...over,
  };
}

function mockAgent(): MockAgent {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return agent;
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

function failure(e: unknown): TransportFailure {
  expect(e).toBeInstanceOf(TransportFailure);
  return e as TransportFailure;
}

/** A gate the test opens to let a held mock reply finish. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (closers.length > 0) await closers.pop()?.();
});

describe("HttpTransport: request and response", () => {
  it("POSTs the body and returns status, headers, text and bytes", async () => {
    const agent = mockAgent();
    const seen: { method: string; body: unknown }[] = [];
    agent
      .get(ORIGIN)
      .intercept({ path: PATH, method: "POST" })
      .reply((opts) => {
        seen.push({ method: opts.method, body: opts.body });
        return {
          statusCode: 200,
          data: '{"stat":"Ok","norenordno":"1"}',
          responseOptions: { headers: { "x-test": "a" } },
        };
      });
    const t = new HttpTransport(cfg(), agent);
    const r = await t.send(prepared(), { stateChanging: true });
    expect(r.status).toBe(200);
    expect(r.bodyText).toBe('{"stat":"Ok","norenordno":"1"}');
    expect(new TextDecoder().decode(r.bodyBytes)).toBe(r.bodyText);
    expect(r.headers["x-test"]).toBe("a");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
  });

  it("sends User-Agent tradesmart-javascript/2.1.0 by default", async () => {
    const agent = mockAgent();
    let ua: unknown;
    agent
      .get(ORIGIN)
      .intercept({ path: PATH, method: "POST" })
      .reply((opts) => {
        ua = (opts.headers as Record<string, string>)["user-agent"];
        return { statusCode: 200, data: "{}" };
      });
    await new HttpTransport(cfg(), agent).send(prepared(), { stateChanging: false });
    expect(ua).toBe("tradesmart-javascript/2.1.0");
  });

  it("appends the SDK token to a configured userAgent", async () => {
    const agent = mockAgent();
    const uas: unknown[] = [];
    agent
      .get(ORIGIN)
      .intercept({ path: PATH, method: "POST" })
      .reply((opts) => {
        uas.push((opts.headers as Record<string, string>)["user-agent"]);
        return { statusCode: 200, data: "{}" };
      })
      .times(2);
    await new HttpTransport(cfg({ userAgent: "bot/1" }), agent).send(prepared(), {
      stateChanging: false,
    });
    await new HttpTransport(cfg({ userAgent: "x tradesmart-javascript/2.1.0" }), agent).send(
      prepared(),
      { stateChanging: false },
    );
    expect(uas).toEqual(["bot/1 tradesmart-javascript/2.1.0", "x tradesmart-javascript/2.1.0"]);
  });

  it("passes maxRedirections 0 and the read timeout (ms) on every request", async () => {
    const agent = mockAgent();
    agent.get(ORIGIN).intercept({ path: PATH, method: "POST" }).reply(200, "{}");
    const seen: Dispatcher.DispatchOptions[] = [];
    const spy = agent.compose((dispatch) => (opts, handler) => {
      seen.push(opts);
      return dispatch(opts, handler);
    });
    await new HttpTransport(cfg({ readTimeout: 7 }), spy).send(prepared(), {
      stateChanging: true,
    });
    expect(seen).toHaveLength(1);
    const o = seen[0] as Dispatcher.DispatchOptions & { maxRedirections?: unknown };
    expect(o.maxRedirections).toBe(0);
    expect(o.headersTimeout).toBe(7000);
    expect(o.bodyTimeout).toBe(7000);
  });

  it.each([
    // 0.0001 s rounds to 0 ms, which undici reads as "no timeout": at least 1 ms.
    [0.0001, 1],
    // Beyond 2^31 - 1 ms a Node timer fires after 1 ms: at most 2147483647 ms.
    [1e7, 2147483647],
  ])("clamps a %s s timeout to %i ms", async (seconds, expected) => {
    const agent = mockAgent();
    agent.get(ORIGIN).intercept({ path: PATH, method: "POST" }).reply(200, "{}");
    const seen: Dispatcher.DispatchOptions[] = [];
    const spy = agent.compose((dispatch) => (opts, handler) => {
      seen.push(opts);
      return dispatch(opts, handler);
    });
    await new HttpTransport(cfg({ readTimeout: seconds }), spy).send(prepared(), {
      stateChanging: false,
    });
    expect(seen[0]?.headersTimeout).toBe(expected);
    expect(seen[0]?.bodyTimeout).toBe(expected);
  });
});

describe("HttpTransport: redirects are never followed", () => {
  it("returns a 307 to another host as is, also through a redirect-following dispatcher", async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({ path: PATH, method: "POST" })
      .reply(307, "", { headers: { location: "https://other.example.test/steal" } });
    let otherCalls = 0;
    agent
      .get("https://other.example.test")
      .intercept({ path: "/steal", method: "POST" })
      .reply(() => {
        otherCalls += 1;
        return { statusCode: 200, data: '{"stat":"Ok"}' };
      })
      .persist();
    const following = agent.compose(interceptors.redirect({ maxRedirections: 5 }));
    const r = await new HttpTransport(cfg(), following).send(prepared(), { stateChanging: true });
    expect(r.status).toBe(307);
    expect(otherCalls).toBe(0);
  });
});

describe("HttpTransport: close", () => {
  it("never closes an injected dispatcher", async () => {
    const agent = mockAgent();
    const close = vi.spyOn(agent, "close");
    const destroy = vi.spyOn(agent, "destroy");
    const t = new HttpTransport(cfg(), agent);
    await t.close();
    expect(close).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("closes its own pool, once", async () => {
    const close = vi.spyOn(Agent.prototype, "close");
    const t = new HttpTransport(cfg());
    await t.close();
    // undici's promise form of close() calls close(callback) itself, so count after the first.
    const calls = close.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    await t.close();
    expect(close).toHaveBeenCalledTimes(calls);
  });

  it("refuses to send after close, sending nothing", async () => {
    const agent = mockAgent();
    let calls = 0;
    agent
      .get(ORIGIN)
      .intercept({ path: PATH, method: "POST" })
      .reply(() => {
        calls += 1;
        return { statusCode: 200, data: "{}" };
      });
    const t = new HttpTransport(cfg(), agent);
    await t.close();
    const onSent = vi.fn();
    const e = await caught(t.send(prepared(), { stateChanging: true, onSent }));
    expect(e).toBeInstanceOf(ConfigurationError);
    expect((e as Error).message).toBe("client is closed; create a new client");
    expect(onSent).not.toHaveBeenCalled();
    expect(calls).toBe(0);
  });
});

describe("HttpTransport: pool wait", () => {
  function heldAgent(): { agent: MockAgent; held: ReturnType<typeof gate>; calls: string[] } {
    const agent = mockAgent();
    const held = gate();
    const calls: string[] = [];
    const pool = agent.get(ORIGIN);
    pool.intercept({ path: "/first", method: "POST" }).reply(async () => {
      calls.push("first");
      await held.wait;
      return { statusCode: 200, data: "{}" };
    });
    pool
      .intercept({ path: PATH, method: "POST" })
      .reply(() => {
        calls.push("second");
        return { statusCode: 200, data: "{}" };
      })
      .persist();
    return { agent, held, calls };
  }

  it("a state-changing call waits at most connectTimeout for a permit, then fails with pool_timeout and sends nothing", async () => {
    const { agent, held, calls } = heldAgent();
    const t = new HttpTransport(
      cfg({ maxConnections: 1, maxKeepaliveConnections: 1, connectTimeout: 0.05, readTimeout: 30 }),
      agent,
    );
    const first = t.send(prepared({ url: `${ORIGIN}/first` }), { stateChanging: false });
    const onSent = vi.fn();
    const started = performance.now();
    const f = failure(await caught(t.send(prepared(), { stateChanging: true, onSent })));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(f.kind).toBe("pool_timeout");
    expect(f.sent).toBe(false);
    expect(onSent).not.toHaveBeenCalled();
    expect(calls).toEqual(["first"]);
    held.open();
    expect((await first).status).toBe(200);
    // The permit came back: the next call goes through.
    expect((await t.send(prepared(), { stateChanging: true })).status).toBe(200);
    expect(calls).toEqual(["first", "second"]);
  });

  it("a send waiting for a permit when the transport closes is refused, never handed over", async () => {
    const { agent, held, calls } = heldAgent();
    const t = new HttpTransport(
      cfg({ maxConnections: 1, maxKeepaliveConnections: 1, connectTimeout: 30, readTimeout: 30 }),
      agent,
    );
    const first = t.send(prepared({ url: `${ORIGIN}/first` }), { stateChanging: false });
    const onSent = vi.fn();
    const second = caught(t.send(prepared(), { stateChanging: true, onSent }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await t.close();
    held.open();
    await first;
    const e = await second;
    expect(e).toBeInstanceOf(ConfigurationError);
    expect((e as Error).message).toBe("client is closed; create a new client");
    expect(onSent).not.toHaveBeenCalled();
    expect(calls).toEqual(["first"]);
  });

  it("a long pool wait (readTimeout beyond 2^31 ms) does not time out at once", async () => {
    const { agent, held, calls } = heldAgent();
    const t = new HttpTransport(
      cfg({ maxConnections: 1, maxKeepaliveConnections: 1, connectTimeout: 30, readTimeout: 1e7 }),
      agent,
    );
    const first = t.send(prepared({ url: `${ORIGIN}/first` }), { stateChanging: false });
    let settled = false;
    const second = t.send(prepared(), { stateChanging: false }).finally(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    held.open();
    await first;
    expect((await second).status).toBe(200);
    expect(calls).toEqual(["first", "second"]);
  });

  it("a read waits at most readTimeout for a permit", async () => {
    const { agent, held, calls } = heldAgent();
    const t = new HttpTransport(
      cfg({ maxConnections: 1, maxKeepaliveConnections: 1, connectTimeout: 30, readTimeout: 0.05 }),
      agent,
    );
    const first = t.send(prepared({ url: `${ORIGIN}/first` }), { stateChanging: true });
    const f = failure(await caught(t.send(prepared(), { stateChanging: false })));
    expect(f.kind).toBe("pool_timeout");
    expect(calls).toEqual(["first"]);
    held.open();
    await first;
  });

  it("releases the permit after a send error", async () => {
    const agent = mockAgent();
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: PATH, method: "POST" })
      .replyWithError(Object.assign(new Error("reset"), { code: "ECONNRESET", syscall: "read" }));
    pool.intercept({ path: PATH, method: "POST" }).reply(200, "{}");
    const t = new HttpTransport(
      cfg({ maxConnections: 1, maxKeepaliveConnections: 1, connectTimeout: 0.05 }),
      agent,
    );
    const f = failure(await caught(t.send(prepared(), { stateChanging: true })));
    expect(f.kind).toBe("connection_reset");
    expect((await t.send(prepared(), { stateChanging: true })).status).toBe(200);
  });
});

describe("HttpTransport: onSent and abort", () => {
  it("fires onSent exactly once on success and on a send error", async () => {
    const agent = mockAgent();
    const pool = agent.get(ORIGIN);
    pool.intercept({ path: PATH, method: "POST" }).reply(200, "{}");
    pool.intercept({ path: PATH, method: "POST" }).replyWithError(new errors.HeadersTimeoutError());
    const t = new HttpTransport(cfg(), agent);
    const ok = vi.fn();
    await t.send(prepared(), { stateChanging: true, onSent: ok });
    expect(ok).toHaveBeenCalledTimes(1);
    const bad = vi.fn();
    const f = failure(await caught(t.send(prepared(), { stateChanging: true, onSent: bad })));
    expect(bad).toHaveBeenCalledTimes(1);
    expect(f.kind).toBe("read_timeout");
    expect(f.sent).toBe(true);
  });

  it("an aborted signal before sending rejects with its reason and sends nothing", async () => {
    const agent = mockAgent();
    let calls = 0;
    agent
      .get(ORIGIN)
      .intercept({ path: PATH, method: "POST" })
      .reply(() => {
        calls += 1;
        return { statusCode: 200, data: "{}" };
      });
    const ac = new AbortController();
    const reason = new Error("stop");
    ac.abort(reason);
    const onSent = vi.fn();
    const e = await caught(
      new HttpTransport(cfg(), agent).send(prepared(), {
        stateChanging: true,
        signal: ac.signal,
        onSent,
      }),
    );
    expect(e).toBe(reason);
    expect(onSent).not.toHaveBeenCalled();
    expect(calls).toBe(0);
  });

  it("an abort while waiting for a permit rejects with its reason, sends nothing and leaks no permit", async () => {
    const agent = mockAgent();
    const held = gate();
    const calls: string[] = [];
    const pool = agent.get(ORIGIN);
    pool.intercept({ path: "/first", method: "POST" }).reply(async () => {
      calls.push("first");
      await held.wait;
      return { statusCode: 200, data: "{}" };
    });
    pool
      .intercept({ path: PATH, method: "POST" })
      .reply(() => {
        calls.push("second");
        return { statusCode: 200, data: "{}" };
      })
      .persist();
    const t = new HttpTransport(
      cfg({ maxConnections: 1, maxKeepaliveConnections: 1, connectTimeout: 30 }),
      agent,
    );
    const first = t.send(prepared({ url: `${ORIGIN}/first` }), { stateChanging: false });
    const ac = new AbortController();
    const onSent = vi.fn();
    const waiting = t.send(prepared(), { stateChanging: true, signal: ac.signal, onSent });
    const reason = new Error("stop");
    ac.abort(reason);
    expect(await caught(waiting)).toBe(reason);
    expect(onSent).not.toHaveBeenCalled();
    held.open();
    await first;
    expect((await t.send(prepared(), { stateChanging: true })).status).toBe(200);
    expect(calls).toEqual(["first", "second"]);
  });

  it("an abort fired from onSent rejects with its reason after the request was sent", async () => {
    const agent = mockAgent();
    let calls = 0;
    agent
      .get(ORIGIN)
      .intercept({ path: PATH, method: "POST" })
      .reply(() => {
        calls += 1;
        return { statusCode: 200, data: "{}" };
      })
      .delay(50);
    const ac = new AbortController();
    const reason = new Error("interrupted");
    const e = await caught(
      new HttpTransport(cfg(), agent).send(prepared(), {
        stateChanging: true,
        signal: ac.signal,
        onSent: () => {
          ac.abort(reason);
        },
      }),
    );
    expect(e).toBe(reason);
    expect(calls).toBe(1);
  });
});

describe("HttpTransport: build before send", () => {
  it.each([
    ["a CR/LF in a header value", { headers: { Authorization: "Bearer a\r\nX-Evil: 1" } }],
    ["a non-ASCII header value", { headers: { Authorization: "Bearer é" } }],
    ["a bad header name", { headers: { "Bad Name": "x" } }],
    ["an invalid URL", { url: "not a url" }],
  ] as const)("%s fails as build_error, sends nothing", async (_name, over) => {
    const agent = mockAgent();
    let calls = 0;
    agent
      .get(ORIGIN)
      .intercept({ path: PATH, method: "POST" })
      .reply(() => {
        calls += 1;
        return { statusCode: 200, data: "{}" };
      });
    const onSent = vi.fn();
    const f = failure(
      await caught(
        new HttpTransport(cfg(), agent).send(prepared(over), { stateChanging: true, onSent }),
      ),
    );
    expect(f.kind).toBe("build_error");
    expect(f.sent).toBe(false);
    expect(f.message).not.toContain("Evil");
    expect(f.message).not.toContain("synthetic");
    expect(onSent).not.toHaveBeenCalled();
    expect(calls).toBe(0);
    const err = mapFailure("build_error", true, "PlaceOrder", f);
    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.message).toMatch(
      /^PlaceOrder: the request could not be built \(.+\); .*nothing was sent$/,
    );
  });
});

describe("HttpTransport: errors from the caller's dispatcher", () => {
  /** A caller's interceptor that throws `err` instead of dispatching. */
  function throwingDispatcher(err: unknown): Dispatcher {
    return mockAgent().compose(
      // undici's compose() requires a dispatch function declaring exactly two parameters.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      () => (_opts: Dispatcher.DispatchOptions, _handler: Dispatcher.DispatchHandler) => {
        throw err;
      },
    );
  }

  it("a plain exception is hook_exception; its text is never kept", async () => {
    const throwing = throwingDispatcher(
      new TypeError("boom https://secret.example.test Bearer synthetic-token"),
    );
    const f = failure(
      await caught(new HttpTransport(cfg(), throwing).send(prepared(), { stateChanging: true })),
    );
    expect(f.kind).toBe("hook_exception");
    expect(f.sent).toBe(true);
    expect(f.typeName).toBe("TypeError");
    expect(f.message).not.toContain("boom");
    expect(f.cause).toBeUndefined();
    const err = mapFailure(f.kind, true, "PlaceOrder", f);
    expect(err.name).toBe("OrderStatusUnknownError");
    expect(err.message).toBe(
      "PlaceOrder: order status unknown: TypeError during the request; check orders() before retrying",
    );
    expect(err.cause).toBeUndefined();
    const read = mapFailure(f.kind, false, "Limits", f);
    expect(read).toBeInstanceOf(NetworkError);
    expect(read.message).toBe("Limits: unexpected error (TypeError)");
  });

  it("an SDK error is hook_sdk_error and passes through unchanged on a read", async () => {
    const own = new ServerError("caller's own", { endpoint: "Limits", httpStatus: 503 });
    const throwing = throwingDispatcher(own);
    const f = failure(
      await caught(new HttpTransport(cfg(), throwing).send(prepared(), { stateChanging: false })),
    );
    expect(f.kind).toBe("hook_sdk_error");
    expect(mapFailure(f.kind, false, "Limits", f)).toBe(own);
    expect(mapFailure(f.kind, true, "PlaceGTTOrder", f).message).toBe(
      "PlaceGTTOrder: order status unknown: ServerError during the request; check pending_gtts() before retrying",
    );
  });
});

// Real undici errors from loopback sockets (no MockAgent): evidence for the code table.
describe("HttpTransport: real undici failures on loopback", () => {
  async function listen(server: net.Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    );
    return (server.address() as AddressInfo).port;
  }

  async function sendTo(port: number, init: ClientConfigInit = {}): Promise<TransportFailure> {
    const t = new HttpTransport(cfg({ baseUrl: `http://127.0.0.1:${String(port)}`, ...init }));
    closers.push(() => t.close());
    return failure(
      await caught(
        t.send(prepared({ url: `http://127.0.0.1:${String(port)}/X` }), { stateChanging: true }),
      ),
    );
  }

  it("connection refused is connect_error", async () => {
    const server = net.createServer();
    const port = await listen(server);
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    closers.pop();
    const f = await sendTo(port);
    expect(f.kind).toBe("connect_error");
    expect(f.sent).toBe(false);
    expect(mapFailure(f.kind, true, "PlaceOrder", f)).toBeInstanceOf(NetworkError);
  });

  it("Node reports a failed connect(2) with syscall 'connect'", async () => {
    const server = net.createServer();
    const port = await listen(server);
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    closers.pop();
    const err = await new Promise<unknown>((resolve) => {
      net.connect(port, "127.0.0.1").on("error", resolve);
    });
    expect(err).toMatchObject({ code: "ECONNREFUSED", syscall: "connect" });
    expect(classifySendFailure(err, "sent")).toBe("connect_error");
  });

  it("connect-phase system errors are definitive: nothing sent", () => {
    for (const code of ["EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"]) {
      const f = TransportFailure.from(sysError(code, "connect"), "sent");
      expect(f.kind).toBe("connect_error");
      expect(f.sent).toBe(false);
      expect(mapFailure(f.kind, true, "PlaceOrder", f)).toBeInstanceOf(NetworkError);
    }
    const t = TransportFailure.from(sysError("ETIMEDOUT", "connect"), "sent");
    expect(t.kind).toBe("connect_timeout");
    expect(t.sent).toBe(false);
    expect(mapFailure(t.kind, true, "PlaceOrder", t)).toBeInstanceOf(RequestTimeoutError);
    // The same code on a live socket may follow the request: unknown for a write.
    const live = TransportFailure.from(sysError("EHOSTUNREACH", "write"), "sent");
    expect(live.sent).toBe(true);
    expect(mapFailure(live.kind, true, "PlaceOrder", live).name).toBe("OrderStatusUnknownError");
  });

  it("no response headers within readTimeout is read_timeout", async () => {
    const sockets: net.Socket[] = [];
    const server = net.createServer((s) => sockets.push(s));
    const port = await listen(server);
    // Runs before the server's close (closers run last-in first-out).
    closers.push(() => {
      for (const s of sockets) s.destroy();
      return Promise.resolve();
    });
    const f = await sendTo(port, { readTimeout: 0.2 });
    expect(f.kind).toBe("read_timeout");
    expect(mapFailure(f.kind, true, "PlaceOrder", f).name).toBe("OrderStatusUnknownError");
  });

  it("a garbage status line is remote_protocol_error", async () => {
    const server = net.createServer((s) => {
      s.once("data", () => s.end("HTTP/1.1 abc nonsense\r\n\r\n"));
    });
    const port = await listen(server);
    const f = await sendTo(port);
    expect(f.kind).toBe("remote_protocol_error");
  });

  it("the connection closed after the request is connection_reset", async () => {
    const server = net.createServer((s) => {
      s.once("data", () => s.destroy());
    });
    const port = await listen(server);
    const f = await sendTo(port);
    expect(f.kind).toBe("connection_reset");
  });

  it("a real 302 from a local server is returned, not followed", async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits += 1;
      res.writeHead(302, { location: "/elsewhere" }).end();
    });
    const port = await listen(server);
    const t = new HttpTransport(cfg({ baseUrl: `http://127.0.0.1:${String(port)}` }));
    closers.push(() => t.close());
    const r = await t.send(prepared({ url: `http://127.0.0.1:${String(port)}/X` }), {
      stateChanging: true,
    });
    expect(r.status).toBe(302);
    expect(hits).toBe(1);
  });
});

// The failure-kind table (failures.ts) row by row, and every kind against transport_failures.json.
type Row = readonly [label: string, make: () => unknown, kind: TransportFailureKind];

function sysError(code: string, syscall: string): Error {
  return Object.assign(new Error(`${syscall} ${code} 10.0.0.1:443`), { code, syscall, errno: -1 });
}

// The runtime constructor is (message, code?) (undici's .d.ts omits it).
const ParserError = errors.HTTPParserError as unknown as new (
  message: string,
  code?: string,
) => Error;

const TABLE: readonly Row[] = [
  ["ECONNREFUSED", () => sysError("ECONNREFUSED", "connect"), "connect_error"],
  ["ENOTFOUND", () => sysError("ENOTFOUND", "getaddrinfo"), "connect_error"],
  ["EAI_AGAIN", () => sysError("EAI_AGAIN", "getaddrinfo"), "connect_error"],
  [
    "CERT_HAS_EXPIRED",
    () => Object.assign(new Error("cert"), { code: "CERT_HAS_EXPIRED" }),
    "connect_error",
  ],
  [
    "ERR_TLS_CERT_ALTNAME_INVALID",
    () => Object.assign(new Error("alt"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }),
    "connect_error",
  ],
  [
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    () => Object.assign(new Error("leaf"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }),
    "connect_error",
  ],
  [
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    () => Object.assign(new Error("self"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
    "connect_error",
  ],
  ["UND_ERR_CONNECT_TIMEOUT", () => new errors.ConnectTimeoutError(), "connect_timeout"],
  ["UND_ERR_HEADERS_TIMEOUT", () => new errors.HeadersTimeoutError(), "read_timeout"],
  ["UND_ERR_BODY_TIMEOUT", () => new errors.BodyTimeoutError(), "read_timeout"],
  ["ECONNRESET", () => sysError("ECONNRESET", "read"), "connection_reset"],
  ["EPIPE", () => sysError("EPIPE", "write"), "connection_reset"],
  ["UND_ERR_SOCKET", () => new errors.SocketError("other side closed"), "connection_reset"],
  ["HPE_INVALID_STATUS", () => new ParserError("bad", "INVALID_STATUS"), "remote_protocol_error"],
  ["HTTPParserError without a code", () => new ParserError("bad"), "remote_protocol_error"],
  ["UND_ERR_HEADERS_OVERFLOW", () => new errors.HeadersOverflowError(), "remote_protocol_error"],
  [
    "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
    () => new errors.ResponseContentLengthMismatchError(),
    "remote_protocol_error",
  ],
  ["UND_ERR_INFO", () => new errors.InformationalError("x"), "remote_protocol_error"],
  [
    "Z_DATA_ERROR",
    () => Object.assign(new Error("zlib"), { code: "Z_DATA_ERROR", errno: -3 }),
    "decoding_error",
  ],
  [
    "ERR_ENCODING_INVALID_ENCODED_DATA",
    () => Object.assign(new TypeError("enc"), { code: "ERR_ENCODING_INVALID_ENCODED_DATA" }),
    "decoding_error",
  ],
  ["UND_ERR_ABORTED (not our signal)", () => new errors.RequestAbortedError(), "transport_error"],
  ["UND_ERR_DESTROYED", () => new errors.ClientDestroyedError(), "transport_error"],
  ["UND_ERR_CLOSED", () => new errors.ClientClosedError(), "transport_error"],
  // Node sets syscall "connect" only when connect(2) failed: before any request byte, so
  // definitive. The same codes from a live socket (read/write) stay ambiguous.
  ["EHOSTUNREACH on connect", () => sysError("EHOSTUNREACH", "connect"), "connect_error"],
  ["ENETUNREACH on connect", () => sysError("ENETUNREACH", "connect"), "connect_error"],
  ["EADDRNOTAVAIL on connect", () => sysError("EADDRNOTAVAIL", "connect"), "connect_error"],
  ["ECONNRESET on connect", () => sysError("ECONNRESET", "connect"), "connect_error"],
  ["ETIMEDOUT on connect", () => sysError("ETIMEDOUT", "connect"), "connect_timeout"],
  ["EHOSTUNREACH on a live socket", () => sysError("EHOSTUNREACH", "write"), "transport_error"],
  ["ENETUNREACH on a live socket", () => sysError("ENETUNREACH", "read"), "transport_error"],
  ["EADDRNOTAVAIL on a live socket", () => sysError("EADDRNOTAVAIL", "write"), "transport_error"],
  ["ETIMEDOUT on a live socket", () => sysError("ETIMEDOUT", "read"), "transport_error"],
  [
    "a non-certificate TLS error is an ambiguous transport error",
    () => Object.assign(new Error("tls"), { code: "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC" }),
    "transport_error",
  ],
  ["an unknown undici error", () => new errors.UndiciError("x"), "transport_error"],
  [
    "a TradeSmartError from the caller",
    () => new ServerError("x", { endpoint: "Limits", httpStatus: 503 }),
    "hook_sdk_error",
  ],
  ["a plain Error from the caller", () => new Error("x"), "hook_exception"],
  ["a TypeError from the caller", () => new TypeError("x"), "hook_exception"],
  ["a thrown string", () => "oops", "hook_exception"],
  ["a thrown null", () => null, "hook_exception"],
];

/** kind → expected error name for an order (place_order) and a read (limits), from the vector. */
function vectorExpectations(): Map<string, { write?: string; read?: string }> {
  const out = new Map<string, { write?: string; read?: string }>();
  for (const c of loadVector("transport_failures.json").cases) {
    const input = c.input as { call: string; failure: string };
    const expected = c.expected as { error: string };
    const entry = out.get(input.failure) ?? {};
    if (input.call === "place_order") entry.write = expected.error;
    if (input.call === "limits") entry.read = expected.error;
    out.set(input.failure, entry);
  }
  return out;
}

describe("classifySendFailure: the code table", () => {
  it.each(TABLE.map(([label, make, kind]) => [`${label} → ${kind}`, make, kind] as const))(
    "%s",
    (_label, make, kind) => {
      expect(classifySendFailure(make(), "sent")).toBe(kind);
      // "connect" gives no extra trust: the same kinds as after sending.
      expect(classifySendFailure(make(), "connect")).toBe(kind);
    },
  );

  it("only the SDK's own permit wait is pool_timeout, and only in the pool phase", () => {
    expect(classifySendFailure(new PoolWaitTimeout(), "pool")).toBe("pool_timeout");
    expect(classifySendFailure(new PoolWaitTimeout(), "sent")).toBe("hook_exception");
    expect(classifySendFailure(new errors.HeadersTimeoutError(), "pool")).toBe("read_timeout");
  });

  it("hook kinds are not retryable", () => {
    expect(isHookFailure("hook_exception")).toBe(true);
    expect(isHookFailure("hook_sdk_error")).toBe(true);
    expect(isHookFailure("connection_reset")).toBe(false);
    expect(isHookFailure("transport_error")).toBe(false);
  });
});

describe("mapFailure: every kind as transport_failures.json expects", () => {
  const vector = vectorExpectations();
  const kinds = [...vector.keys()].filter((k) => k !== "keyboard_interrupt");

  it("covers every vector kind except keyboard_interrupt (an abort in JavaScript)", () => {
    expect(kinds.sort()).toEqual(
      [
        "connect_error",
        "connect_timeout",
        "decoding_error",
        "hook_exception",
        "hook_sdk_error",
        "pool_timeout",
        "read_timeout",
        "remote_protocol_error",
        "write_timeout",
        "connection_reset",
      ].sort(),
    );
  });

  it.each(kinds)("%s", (kind) => {
    const want = vector.get(kind);
    const sdkError = new ServerError("caller's own", { endpoint: "Limits", httpStatus: 503 });
    const detail = { typeName: "SomeError", sdkError };
    const k = kind as TransportFailureKind;
    expect(mapFailure(k, true, "PlaceOrder", detail).name).toBe(want?.write);
    expect(mapFailure(k, false, "Limits", detail).name).toBe(want?.read);
  });

  it("every row of the code table maps to the error its vector kind expects", () => {
    for (const [, make, kind] of TABLE) {
      // transport_error is "any other HTTP-library transport error": unknown for writes, a
      // retryable NetworkError for reads, like connection_reset.
      const vk = kind === "transport_error" ? "connection_reset" : kind;
      const want = vector.get(vk);
      const err = make();
      const detail = {
        typeName: "X",
        ...(err instanceof TradeSmartError ? { sdkError: err } : {}),
      };
      expect(mapFailure(kind, true, "PlaceOrder", detail).name).toBe(want?.write);
      expect(mapFailure(kind, false, "Limits", detail).name).toBe(want?.read);
    }
  });

  it("an ambiguous failure on a write names the check and never echoes or chains", () => {
    const err = mapFailure("read_timeout", true, "CancelOrder", {
      typeName: "HeadersTimeoutError",
    });
    expect(err.message).toBe(
      "CancelOrder: order status unknown: HeadersTimeoutError after the request may have been sent; check orders() before retrying",
    );
    expect(err.cause).toBeUndefined();
    expect(mapFailure("connect_timeout", true, "PlaceOrder").message).toBe(
      "PlaceOrder: connect timed out",
    );
    expect(mapFailure("pool_timeout", true, "PlaceOrder").message).toBe(
      "PlaceOrder: timed out waiting for a free connection; nothing was sent",
    );
    expect(mapFailure("connect_error", false, "Limits", { typeName: "Error" }).message).toBe(
      "Limits: could not connect (Error)",
    );
    expect(mapFailure("read_timeout", false, "Limits").message).toBe("Limits: request timed out");
    expect(
      mapFailure("connection_reset", false, "Limits", { typeName: "SocketError" }).message,
    ).toBe("Limits: network error (SocketError)");
  });

  it("a TransportFailure keeps only the kind and a sanitised type name", () => {
    const weird = new Error("secret");
    weird.name = "Bearer abc\r\ndef";
    expect(TransportFailure.from(weird, "sent").typeName).toBe("Error");
    const f = TransportFailure.from(new errors.HeadersTimeoutError(), "sent");
    expect(f.kind).toBe("read_timeout");
    expect(f.typeName).toBe("HeadersTimeoutError");
    expect(f.sent).toBe(true);
    expect(f.cause).toBeUndefined();
    expect(f.message).not.toContain("Headers Timeout Error");
    expect(TransportFailure.from(new PoolWaitTimeout(), "pool").sent).toBe(false);
    // Connect-phase kinds prove nothing reached the server, whenever they are seen.
    expect(TransportFailure.from(new errors.ConnectTimeoutError(), "sent").sent).toBe(false);
    expect(TransportFailure.from(sysError("ECONNREFUSED", "connect"), "sent").sent).toBe(false);
    expect(TransportFailure.from(new Error("hook"), "sent").sent).toBe(true);
  });
});
