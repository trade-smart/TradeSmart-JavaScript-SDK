// The client core (sdk-behaviour.md §2.2, §2.5, §5, §6.3, §6.4; design §7.2, §7.8): construction,
// token rules, close, request(), retries, abort and generateSession, against an undici MockAgent.
import { inspect } from "node:util";
import { Decimal } from "decimal.js";
import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { AccessToken, computeChecksum } from "../../src/auth.js";
import { TradeSmart } from "../../src/client.js";
import { ClientConfig } from "../../src/config.js";
import {
  APIError,
  AuthenticationError,
  ConfigurationError,
  NetworkError,
  OrderRejectedError,
  OrderStatusUnknownError,
  RequestTimeoutError,
} from "../../src/errors.js";
import { RateLimiter } from "../../src/lib/ratelimit.js";
import { writeTokenFile } from "../../src/token-store/token-file.js";
import { FakeClock } from "../helpers/fake-clock.js";
import {
  BASE_URL,
  expiredToken,
  recordingLogger,
  scriptedClient,
  TOKEN,
  type LogLine,
  type Reply,
  type Scripted,
} from "../helpers/scripted-client.js";

const ACK = '{"stat":"Ok","norenordno":"26111000000001"}';
const open: Scripted[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.agent.close();
});

function scripted(
  replies: readonly Reply[],
  options: Parameters<typeof scriptedClient>[1] = {},
): Scripted {
  const s = scriptedClient(replies, options);
  open.push(s);
  return s;
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

const ordersLines = (lines: LogLine[]): string[] =>
  lines
    .filter((l) => l.ctx?.logger === "tradesmart.orders")
    .map((l) => `${l.level} ${l.msg.replace(/ in \d+ ms$/, "")}`);

describe("construction and the token rules (§2.2, §6.3)", () => {
  it("rejects an empty client id", () => {
    expect(() => new TradeSmart("")).toThrow(ConfigurationError);
    expect(() => new TradeSmart(undefined as unknown as string)).toThrow(ConfigurationError);
  });

  it("strips a string token and treats a blank one as no token", () => {
    expect(new TradeSmart("TEST123", { accessToken: `  ${TOKEN}\n` }).accessToken).toBe(TOKEN);
    expect(new TradeSmart("TEST123", { accessToken: " \n" }).accessToken).toBeNull();
  });

  it.each([
    ["a space", "bad token"],
    ["a control character", "bad\u0000token"],
    ["a non-ASCII character", "tökén"],
  ])("refuses a token with %s, never showing it", (_label, token) => {
    const err = (() => {
      try {
        new TradeSmart("TEST123", { accessToken: token });
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a throw");
    })();
    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.message).toContain("printable ASCII");
    expect(err.message).not.toContain(token);
  });

  it("refuses an AccessToken whose text cannot be sent, and any other type", () => {
    const now = new Date();
    const bad = AccessToken.fromParts("bad token", now, new Date(now.getTime() + 3_600_000));
    expect(() => new TradeSmart("TEST123", { accessToken: bad })).toThrow(ConfigurationError);
    expect(() => new TradeSmart("TEST123", { accessToken: 42 as unknown as string })).toThrow(
      ConfigurationError,
    );
  });

  it("setAccessToken('bad token') throws ConfigurationError and keeps the old token", async () => {
    const s = scripted([{ body: '{"stat":"Ok"}' }]);
    expect(() => {
      s.client.setAccessToken("bad token");
    }).toThrow(ConfigurationError);
    expect(s.client.accessToken).toBe(TOKEN);
    await s.client.request("Limits", {}, { stateChanging: false });
    expect(s.headers[0]?.["authorization"]).toBe(`Bearer ${TOKEN}`);
    s.client.setAccessToken(" other-token \n");
    await s.client.request("Limits", {}, { stateChanging: false });
    expect(s.headers[1]?.["authorization"]).toBe("Bearer other-token");
  });

  it("accepts a ClientConfig or its init object", () => {
    const config = ClientConfig.create({ maxRetries: 0 });
    expect(new TradeSmart("TEST123", { config }).config).toBe(config);
    expect(new TradeSmart("TEST123", { config: { maxRetries: 1 } }).config.maxRetries).toBe(1);
  });

  it("toString, inspect and toJSON show only the client id", () => {
    const client = new TradeSmart("TEST123", {
      accessToken: TOKEN,
      appKey: "synthetic-app-key",
      secretKey: "synthetic-secret",
    });
    for (const text of [String(client), inspect(client), JSON.stringify(client)]) {
      expect(text).toContain("TEST123");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("synthetic-app-key");
      expect(text).not.toContain("synthetic-secret");
    }
    expect(String(client)).toBe("TradeSmart(client_id=TEST123)");
  });
});

describe("authentication before every call (§6.3)", () => {
  it("an expired AccessToken rejects with AuthenticationError and sends nothing", async () => {
    const s = scripted([{ body: '{"stat":"Ok"}' }], { token: "expired" });
    const err = await caught(s.client.request("UserDetails", {}, { stateChanging: false }));
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).message).toContain("expired");
    expect(s.sends).toBe(0);
  });

  it("checkTokenExpiry false sends an expired AccessToken", async () => {
    const s = scripted([{ body: '{"stat":"Ok"}' }], {
      token: "expired",
      config: { checkTokenExpiry: false },
    });
    await s.client.request("UserDetails", {}, { stateChanging: false });
    expect(s.headers[0]?.["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("no token rejects with AuthenticationError naming the ways to log in", async () => {
    const s = scripted([{ body: '{"stat":"Ok"}' }], { token: "none" });
    const err = await caught(s.client.request("Limits", {}, { stateChanging: false }));
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).message).toContain("generateSession()");
    expect(s.sends).toBe(0);
  });

  it("sends Authorization: Bearer and the SDK User-Agent", async () => {
    const s = scripted([{ body: '{"stat":"Ok"}' }]);
    await s.client.request("Limits", {}, { stateChanging: false });
    expect(s.headers[0]?.["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(s.headers[0]?.["user-agent"]).toBe("tradesmart-javascript/2.1.0");
  });
});

describe("close (§2.2)", () => {
  it("rejects every later call with the closed message and sends nothing", async () => {
    const s = scripted([{ body: '{"stat":"Ok"}' }]);
    await s.client.close();
    await s.client.close(); // idempotent
    const err = await caught(s.client.request("Limits", {}, { stateChanging: false }));
    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as Error).message).toBe("client is closed; create a new client");
    expect(s.sends).toBe(0);
    expect(s.hits).toBe(0);
  });

  it("await using closes the client", async () => {
    const s = scripted([{ body: '{"stat":"Ok"}' }]);
    {
      await using client = s.client;
      await client.request("Limits", {}, { stateChanging: false });
    }
    const err = await caught(s.client.request("Limits", {}, { stateChanging: false }));
    expect((err as Error).message).toBe("client is closed; create a new client");
    expect(s.hits).toBe(1);
  });

  it("a send waiting for a permit when the client closes is not sent and logs not_sent", async () => {
    const s = scripted([{ body: ACK }], {
      config: { maxConnections: 1, maxKeepaliveConnections: 1, connectTimeout: 5, readTimeout: 5 },
    });
    const hold = s.holdPermit();
    const pending = caught(
      s.client.request("placeorder", { exch: "NSE" }, { stateChanging: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await s.client.close();
    hold.release();
    await hold.done;
    const err = await pending;
    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as Error).message).toBe("client is closed; create a new client");
    expect(s.hits).toBe(0);
    expect(ordersLines(s.lines)).toEqual(["info PlaceOrder not_sent order_id=-"]);
  });

  it("does not close an injected dispatcher", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get("https://api.example.test")
      .intercept({ path: "/still-open", method: "GET" })
      .reply(200, "ok");
    const client = new TradeSmart("TEST123", { accessToken: TOKEN, httpDispatcher: agent });
    await client.close();
    const res = await agent.request({
      origin: "https://api.example.test",
      path: "/still-open",
      method: "GET",
    });
    expect(await res.body.text()).toBe("ok");
    await agent.close();
  });
});

describe("request() (§2.5)", () => {
  it("sends a known name in its documented spelling and never retries a write on a 503", async () => {
    const s = scripted([{ status: 503, body: "<html>busy</html>" }]);
    const err = await caught(
      s.client.request(" /placeorder/ ", { exch: "NSE" }, { stateChanging: false }),
    );
    expect(err).toBeInstanceOf(OrderStatusUnknownError);
    expect(s.sends).toBe(1);
    expect(s.hits).toBe(1);
    expect(s.bodies[0]).toBe('jData={"exch":"NSE","uid":"TEST123"}');
  });

  it("posts to {base}/{Endpoint}", async () => {
    const s = scripted([{ body: '{"stat":"Ok"}' }]);
    const seen: string[] = [];
    const transport = s.ctx.transport;
    const send = transport.send.bind(transport);
    transport.send = (req, opts) => {
      seen.push(req.url);
      return send(req, opts);
    };
    await s.client.request("placeorder", {}, { stateChanging: false });
    await s.client.request("limits", {}, { stateChanging: false });
    expect(seen).toEqual([`${BASE_URL}/PlaceOrder`, `${BASE_URL}/limits`]);
  });

  it("a Not_Ok write at HTTP 503 is OrderRejectedError, sent once", async () => {
    const s = scripted([{ status: 503, body: '{"stat":"Not_Ok","emsg":"busy"}' }]);
    const err = await caught(s.client.request("CancelOrder", {}, { stateChanging: false }));
    expect(err).toBeInstanceOf(OrderRejectedError);
    expect(s.sends).toBe(1);
  });

  it("converts values to wire strings, appends uid last and keeps a given uid", async () => {
    const s = scripted([{ body: '{"stat":"Ok"}' }]);
    await s.client.request(
      "Custom",
      { flag: true, off: false, count: 5, price: 101.5, prc: new Decimal("1.10"), big: 1e21 },
      { stateChanging: false },
    );
    expect(s.bodies[0]).toBe(
      'jData={"flag":"Yes","off":"No","count":"5","price":"101.5","prc":"1.1","big":"1000000000000000000000","uid":"TEST123"}',
    );
    await s.client.request("Custom", { uid: "OTHER", a: "x" }, { stateChanging: false });
    expect(s.bodies[1]).toBe('jData={"uid":"OTHER","a":"x"}');
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["a nested null", { a: null }],
    ["a nested undefined in a list", [undefined]],
    ["a Map", new Map()],
  ])("a %s value throws TypeError before anything is sent", async (_label, value) => {
    const s = scripted([{ body: '{"stat":"Ok"}' }]);
    const err = await caught(
      s.client.request("placeorder", { actid: value as never }, { stateChanging: true }),
    );
    expect(err).toBeInstanceOf(TypeError);
    expect(s.sends).toBe(0);
    expect(ordersLines(s.lines)).toEqual([]);
  });

  it("sends a nested object and list value in order, scalar leaves converted", async () => {
    const s = scripted([{ body: '{"stat":"Ok"}' }]);
    await s.client.request(
      "Limits",
      { legs: [{ z: 1, a: true }, { m: "x&y" }], box: { q: "1" } },
      { stateChanging: false },
    );
    expect(s.bodies[0]).toBe(
      'jData={"legs":[{"z":"1","a":"Yes"},{"m":"x%26y"}],"box":{"q":"1"},"uid":"' +
        s.client.clientId +
        '"}',
    );
  });

  it("a sparse array or a cyclic object names only the top-level key and sends nothing", async () => {
    const s = scripted([{ body: '{"stat":"Ok"}' }]);
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const deep: unknown[] = [];
    let tip = deep;
    for (let i = 0; i < 150; i++) {
      const next: unknown[] = [];
      tip.push(next);
      tip = next;
    }
    const sparse = [, "a"]; // eslint-disable-line no-sparse-arrays
    for (const [key, value] of [
      ["holes", sparse],
      ["loop", cyclic],
      ["deep", deep],
    ] as const) {
      const err = await caught(
        s.client.request("Limits", { [key]: value } as never, { stateChanging: false }),
      );
      expect(err).toBeInstanceOf(TypeError);
      expect((err as TypeError).message).toContain(`'${key}'`);
    }
    expect(
      (
        (await caught(
          s.client.request("Limits", { loop: cyclic } as never, { stateChanging: false }),
        )) as TypeError
      ).message,
    ).toContain("nested too deeply (or cyclic)");
    expect(s.sends).toBe(0);
  });

  it("a bad endpoint name is ConfigurationError and nothing is sent", async () => {
    const s = scripted([{ body: '{"stat":"Ok"}' }]);
    for (const name of ["Place.Order", "api/PlaceOrder", " / "]) {
      const err = await caught(s.client.request(name, {}, { stateChanging: false }));
      expect(err).toBeInstanceOf(ConfigurationError);
    }
    expect(s.sends).toBe(0);
  });

  it("a Not_Ok no data reply is an APIError, never []", async () => {
    const s = scripted([{ body: '{"stat":"Not_Ok","emsg":"no data"}' }]);
    const err = await caught(
      s.client.request("OrderBook", {}, { stateChanging: false, expect: "list" }),
    );
    expect(err).toBeInstanceOf(APIError);
  });

  it("returns the parsed body with numbers kept exact", async () => {
    const s = scripted([{ body: '{"stat":"Ok","cash":"10.50","n":12345678901234567890}' }]);
    const body = (await s.client.request("Limits", {}, { stateChanging: false })) as Record<
      string,
      unknown
    >;
    expect(body["cash"]).toBe("10.50");
    expect(String(body["n"])).toBe("12345678901234567890");
  });
});

describe("transport DEBUG lines (§13)", () => {
  const transportLines = (lines: LogLine[]): string[] =>
    lines
      .filter((l) => l.ctx?.logger === "tradesmart.transport")
      .map((l) => `${l.level} ${l.msg.replace(/ in \d+ ms$/, "")}`);

  it("logs the payload only with logPayloads, redacted, and never the response body", async () => {
    const s = scripted([{ body: '{"stat":"Ok","access_token":"synthetic-secret-token"}' }], {
      config: { logPayloads: true },
    });
    await s.client.request(
      "Custom",
      { code: "synthetic-code", exch: "NSE" },
      { stateChanging: false },
    );
    expect(transportLines(s.lines)).toEqual([
      'debug POST /Custom payload={"code":"***","exch":"NSE","uid":"TEST123"}',
      "debug POST /Custom -> HTTP 200 stat=Ok",
    ]);
    expect(JSON.stringify(s.lines)).not.toContain("synthetic-secret-token");
    expect(JSON.stringify(s.lines)).not.toContain("synthetic-code");
  });

  it("logs no payload by default", async () => {
    const s = scripted([{ status: 502, body: "<html/>" }], { config: { maxRetries: 0 } });
    await caught(s.client.request("Custom", { exch: "NSE" }, { stateChanging: false }));
    expect(transportLines(s.lines)).toEqual(["debug POST /Custom -> HTTP 502 stat=None"]);
  });
});

describe("read retries (§5.1)", () => {
  it("retries a read on a 503 and sleeps the back-off in milliseconds", async () => {
    const s = scripted([{ status: 503, body: "<html/>" }], {
      config: { backoffBase: 0.5, backoffCap: 8 },
    });
    const err = await caught(s.client.request("Limits", {}, { stateChanging: false }));
    expect(err).toBeInstanceOf(APIError);
    expect(s.sends).toBe(3);
    // min(cap, 0.5 * 2^attempt) * (0.5 + 0.5 / 2) seconds, as milliseconds.
    expect(s.clock.sleeps).toEqual([375, 750]);
  });

  it("a server 429 with Retry-After waits that many seconds", async () => {
    const s = scripted(
      [
        {
          status: 429,
          body: '{"stat":"Not_Ok","emsg":"slow down"}',
          headers: { "retry-after": "2" },
        },
      ],
      { config: { backoffBase: 0.5, backoffCap: 8 } },
    );
    const err = await caught(s.client.request("Quotes", {}, { stateChanging: false }));
    expect(err).toMatchObject({ name: "RateLimitError", retryAfter: 2 });
    expect(s.clock.sleeps).toEqual([2000, 2000]);
  });

  it("a read is retried on a network error and succeeds", async () => {
    const s = scripted([{ failure: "connection_reset" }, { body: '{"stat":"Ok"}' }]);
    await expect(s.client.request("Limits", {}, { stateChanging: false })).resolves.toMatchObject({
      stat: "Ok",
    });
    expect(s.sends).toBe(2);
  });

  it("a write is never retried on a network error", async () => {
    const s = scripted([{ failure: "connect_error" }, { body: ACK }]);
    const err = await caught(s.client.request("Custom", {}, { stateChanging: true }));
    expect(err).toBeInstanceOf(NetworkError);
    expect(s.sends).toBe(1);
  });
});

describe("abort (design §7.8)", () => {
  it("an abort before the send rejects with the reason, sends nothing and logs nothing", async () => {
    const s = scripted([{ body: ACK }]);
    const controller = new AbortController();
    const reason = new Error("stop");
    controller.abort(reason);
    const err = await caught(
      s.client.request(
        "placeorder",
        { exch: "NSE" },
        { stateChanging: true, signal: controller.signal },
      ),
    );
    expect(err).toBe(reason);
    expect(s.sends).toBe(0);
    expect(s.hits).toBe(0);
    expect(ordersLines(s.lines)).toEqual([]);
  });

  it("an abort during the rate-limit wait sends nothing and logs nothing", async () => {
    const s = scripted([{ body: ACK }]);
    // A manual clock: the 11th order at one instant waits (1 s, within the 1 s cap) until aborted.
    const manual = new FakeClock(false);
    s.ctx.clock = manual;
    s.ctx.limiter = new RateLimiter(s.client.config, manual);
    for (let i = 0; i < 10; i += 1)
      await s.client.request("placeorder", {}, { stateChanging: true });
    s.lines.length = 0;
    const before = s.sends;
    const controller = new AbortController();
    const pending = caught(
      s.client.request("placeorder", {}, { stateChanging: true, signal: controller.signal }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(manual.pending).toBe(1);
    controller.abort();
    const err = await pending;
    expect((err as Error).name).toBe("AbortError");
    expect(s.sends - before).toBe(0);
    expect(ordersLines(s.lines)).toEqual([]);
  });

  it("an abort after the send on a write logs unknown and the outcome WARNING", async () => {
    const s = scripted([{ failure: "keyboard_interrupt" }]);
    const err = await caught(
      s.client.request(
        "PlaceGTTOrder",
        { exch: "NSE" },
        {
          stateChanging: false,
          signal: s.interrupt.signal,
        },
      ),
    );
    expect(err).toBe(s.interrupt.signal.reason);
    expect(s.sends).toBe(1);
    expect(ordersLines(s.lines)).toEqual([
      "info PlaceGTTOrder unknown al_id=-",
      "warn PlaceGTTOrder: outcome unknown - check pending_gtts()",
    ]);
  });

  it("an abort after the send on a read rejects with the reason and is not retried", async () => {
    const s = scripted([{ failure: "keyboard_interrupt" }]);
    const err = await caught(
      s.client.request("Limits", {}, { stateChanging: false, signal: s.interrupt.signal }),
    );
    expect(err).toBe(s.interrupt.signal.reason);
    expect(s.sends).toBe(1);
  });
});

describe("generateSession (§6.1, §6.3)", () => {
  const keys = { appKey: "synthetic-app-key", secretKey: "synthetic-secret" };
  const success =
    '{"stat":"Ok","access_token":"synthetic-new-token","uid":"TEST123","actid":"TEST123","expires_in":"86400"}';

  /** A client with the app keys (no token) on a scripted MockAgent; `hits` etc. from the harness. */
  function sessionClient(
    replies: readonly Reply[],
    withKeys = true,
  ): {
    client: TradeSmart;
    hits: number;
    headers: Record<string, string>[];
    bodies: string[];
    lines: LogLine[];
  } {
    const s = scripted(replies, { token: "none" });
    const client = new TradeSmart("TEST123", {
      ...(withKeys ? keys : {}),
      config: s.client.config,
      httpDispatcher: s.agent,
    });
    return {
      client,
      get hits() {
        return s.hits;
      },
      headers: s.headers,
      bodies: s.bodies,
      lines: s.lines,
    };
  }

  it("sends code and checksum without Authorization, stores and returns the token", async () => {
    const s = sessionClient([{ body: success }]);
    const token = await s.client.generateSession("synthetic-code");
    expect(token).toBeInstanceOf(AccessToken);
    expect(token.accessToken.reveal()).toBe("synthetic-new-token");
    expect(s.client.accessToken).toBe(token);
    expect(s.hits).toBe(1);
    expect(s.headers[0]?.["authorization"]).toBeUndefined();
    const checksum = computeChecksum("synthetic-app-key", "synthetic-secret", "synthetic-code");
    expect(s.bodies[0]).toBe(`jData={"code":"synthetic-code","checksum":"${checksum}"}`);
  });

  it("missing keys or an empty code are ConfigurationError before anything is sent", async () => {
    const without = sessionClient([{ body: success }], false);
    await expect(without.client.generateSession("synthetic-code")).rejects.toThrow(
      ConfigurationError,
    );
    const s = sessionClient([{ body: success }]);
    await expect(s.client.generateSession("")).rejects.toThrow(ConfigurationError);
    expect(s.hits + without.hits).toBe(0);
  });

  it.each([
    ['{"stat":"Not_Ok","emsg":"Invalid code"}', 200, "GenAcsTok failed: Invalid code"],
    ['{"stat":"Not_Ok","emsg":"   "}', 200, "GenAcsTok failed (no error message from the server)"],
    ['{"stat":"Not_Ok"}', 401, "GenAcsTok failed (no error message from the server)"],
    ['{"stat":"Not_Ok","emsg":"session expired"}', 200, "GenAcsTok failed: session expired"],
  ])("an API error %s (HTTP %i) is AuthenticationError", async (body, status, message) => {
    const s = sessionClient([{ status, body }]);
    const err = await caught(s.client.generateSession("synthetic-code"));
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).message).toBe(message);
    expect(s.hits).toBe(1);
  });

  it("an unknown outcome or an unparseable success means restart the login", async () => {
    for (const reply of [
      { status: 503, body: "<html>busy</html>" },
      { failure: "read_timeout" },
      { body: '{"stat":"Ok"}' },
    ]) {
      const s = sessionClient([reply]);
      const err = await caught(s.client.generateSession("synthetic-code"));
      expect(err).toBeInstanceOf(AuthenticationError);
      expect((err as Error).message).toContain(
        "the authorisation code is single-use; restart the login",
      );
      expect(s.hits).toBe(1);
    }
  });

  it("a connect failure keeps its type (the code was not used)", async () => {
    const s = sessionClient([{ failure: "connect_error" }]);
    await expect(s.client.generateSession("synthetic-code")).rejects.toThrow(NetworkError);
    const t = sessionClient([{ failure: "connect_timeout" }]);
    await expect(t.client.generateSession("synthetic-code")).rejects.toThrow(RequestTimeoutError);
  });

  it("is never logged as an order", async () => {
    const s = sessionClient([{ failure: "read_timeout" }]);
    await caught(s.client.generateSession("synthetic-code"));
    expect(ordersLines(s.lines)).toEqual([]);
  });

  it("loginUrl needs the app key", () => {
    expect(new TradeSmart("TEST123", keys).loginUrl()).toBe(
      "https://v2api.tradesmartonline.in/OAuthlogin/authorize/oauth?client_id=synthetic-app-key",
    );
    expect(() => new TradeSmart("TEST123").loginUrl()).toThrow(ConfigurationError);
  });
});

describe("fromEnv (§6.4)", () => {
  it("uses the stripped env token with the env client id", () => {
    const client = TradeSmart.fromEnv({
      env: { TRADESMART_CLIENT_ID: " TEST123 ", TRADESMART_ACCESS_TOKEN: `${TOKEN}\n` },
    });
    expect(client.clientId).toBe("TEST123");
    expect(client.accessToken).toBe(TOKEN);
  });

  it("refuses an env token that cannot be sent", () => {
    expect(() =>
      TradeSmart.fromEnv({
        env: { TRADESMART_CLIENT_ID: "TEST123", TRADESMART_ACCESS_TOKEN: "bad token" },
      }),
    ).toThrow(ConfigurationError);
  });

  it("refuses a saved-login token that cannot be sent", async () => {
    const file = process.env["TRADESMART_TOKEN_FILE"] as string;
    const now = new Date();
    await writeTokenFile(file, {
      clientId: "TEST123",
      accessToken: AccessToken.fromParts("bad token", now, new Date(now.getTime() + 3_600_000)),
    });
    expect(() =>
      TradeSmart.fromEnv({ env: { TRADESMART_CLIENT_ID: "TEST123", TRADESMART_TOKEN_FILE: file } }),
    ).toThrow(ConfigurationError);
  });

  it("with only an app key, the first call names the missing token's reason", async () => {
    const lines: LogLine[] = [];
    const client = TradeSmart.fromEnv({
      env: {
        TRADESMART_CLIENT_ID: "TEST123",
        TRADESMART_APP_KEY: "synthetic-app-key",
        TRADESMART_TOKEN_FILE: `${process.env["TRADESMART_TOKEN_FILE"] as string}.missing`,
      },
      config: { logger: recordingLogger(lines) },
    });
    const err = await caught(client.request("Limits", {}, { stateChanging: false }));
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).message).toContain("no saved login");
    await client.close();
  });

  it("an expired saved login is not used when checkTokenExpiry is on", async () => {
    const file = process.env["TRADESMART_TOKEN_FILE"] as string;
    const token = expiredToken();
    await writeTokenFile(file, { clientId: "TEST123", accessToken: token });
    expect(() =>
      TradeSmart.fromEnv({ env: { TRADESMART_CLIENT_ID: "TEST123", TRADESMART_TOKEN_FILE: file } }),
    ).toThrow(AuthenticationError);
  });
});
