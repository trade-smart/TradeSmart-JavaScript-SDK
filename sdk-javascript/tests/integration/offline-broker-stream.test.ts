// The offline broker's stream half and lifecycle (sdk-behaviour.md §16, §9): a real
// `TradeSmartStream` connects to the broker's loopback WebSocket server. Tests wait on observable
// events (a message, a state), never on fixed sleeps.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { AuthenticationError, TradeSmart, TradeSmartStream } from "../../src/index.js";
import type { InboundStreamMessage } from "../../src/index.js";
import type { Logger, LogContext } from "../../src/lib/log.js";
import { OfflineBroker, drills } from "../../src/testing/index.js";
import { ownerOf, releaseOrphan } from "../../src/testing/lifecycle.js";
import { OfflineStreamServer } from "../../src/testing/ws.js";
import { BrokerState } from "../../src/testing/state.js";

const TCS = ["NSE", "11536"] as const;
const LIMIT_BUY = {
  exchange: "NSE",
  tradingsymbol: "TCS-EQ",
  quantity: 10,
  transactionType: "B",
  product: "I",
  orderType: "LMT",
  price: "100.50",
} as const;
const WAIT_MS = 8000;
const KEY = "NSE|11536";
// What the Python reference prints for the position in the "carried fixes" test below.
const REFERENCE_RPNL = "10.00000000000000000000000002";

const brokers: OfflineBroker[] = [];
const clients: TradeSmart[] = [];
const streams: TradeSmartStream[] = [];

/** Every message a stream delivered, with a way to wait for the next one that matches. */
class Inbox {
  readonly messages: InboundStreamMessage[] = [];
  readonly #waiters: { test: (m: InboundStreamMessage) => boolean; done: () => void }[] = [];

  push = (message: InboundStreamMessage): void => {
    this.messages.push(message);
    for (const waiter of [...this.#waiters]) if (waiter.test(message)) waiter.done();
  };

  /** Resolves when a message matching `test` has arrived (now or later). */
  waitFor(test: (m: InboundStreamMessage) => boolean): Promise<void> {
    if (this.messages.some(test)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for a stream message"));
      }, WAIT_MS);
      this.#waiters.push({
        test,
        done: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  types(): string[] {
    return this.messages.map((m) => String(m.raw["t"]));
  }

  ofType(t: string): InboundStreamMessage[] {
    return this.messages.filter((m) => m.raw["t"] === t);
  }
}

const isType =
  (t: string) =>
  (m: InboundStreamMessage): boolean =>
    m.raw["t"] === t;

/** Resolves the next time `register` calls its callback (a callback with a deadline). */
function once(register: (fire: () => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for a stream event"));
    }, WAIT_MS);
    register(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function setup(): { broker: OfflineBroker; inbox: Inbox } {
  const broker = new OfflineBroker();
  brokers.push(broker);
  broker.addInstrument(TCS[0], TCS[1], "TCS-EQ", { tickSize: "0.05" });
  broker.addInstrument(TCS[0], "22", "INFY-EQ");
  return { broker, inbox: new Inbox() };
}

async function connected(
  broker: OfflineBroker,
  inbox: Inbox,
  callbacks: Parameters<OfflineBroker["stream"]>[0] = {},
): Promise<TradeSmartStream> {
  const stream = broker.stream({ onMessage: inbox.push, ...callbacks });
  streams.push(stream);
  await stream.connect();
  return stream;
}

afterEach(async () => {
  while (streams.length > 0) await streams.pop()?.close();
  while (clients.length > 0) await clients.pop()?.close();
  while (brokers.length > 0) await brokers.pop()?.close();
});

describe("order and position messages", () => {
  it("sends om after every order change and pm after a fill; the order subscription gets no ack", async () => {
    const { broker, inbox } = setup();
    broker.defaultPlace = "pending";
    const client = broker.client();
    clients.push(client);
    const stream = await connected(broker, inbox);
    await stream.subscribeOrders();
    await stream.subscribePositions();
    await inbox.waitFor(isType("pk")); // frames are handled in order: anything owed for "o" came first
    expect(inbox.types()).toEqual(["pk"]);

    const orderId = await client.placeOrder(LIMIT_BUY);
    await inbox.waitFor((m) => m.raw["reporttype"] === "NewAck");
    broker.accept(orderId);
    broker.fill(orderId, "100.50", 4);
    await inbox.waitFor(isType("pm"));
    await client.cancelOrder(orderId);
    await inbox.waitFor((m) => m.raw["reporttype"] === "Canceled");

    const changes = inbox.messages
      .filter((m) => m.raw["t"] === "om" || m.raw["t"] === "pm")
      .map((m) => `${String(m.raw["t"])}:${String(m.raw["reporttype"] ?? m.raw["netqty"])}`);
    expect(changes).toEqual(["om:NewAck", "om:New", "om:Fill", "pm:4", "om:Canceled"]);
    expect(inbox.ofType("om")[0]?.raw["norenordno"]).toBe(orderId);
    expect(inbox.types()).not.toContain("ok");
  });

  it("unsubscribing from orders and positions stops the messages and is acknowledged", async () => {
    const { broker, inbox } = setup();
    broker.defaultPlace = "pending";
    const client = broker.client();
    clients.push(client);
    const stream = await connected(broker, inbox);
    await stream.subscribeOrders();
    await stream.subscribePositions();
    await inbox.waitFor(isType("pk"));
    await stream.unsubscribeOrders();
    await stream.unsubscribePositions();
    await inbox.waitFor(isType("upk"));
    expect(inbox.types()).toEqual(["pk", "uok", "upk"]);
    const orderId = await client.placeOrder(LIMIT_BUY);
    broker.accept(orderId);
    broker.fill(orderId, "100.50");
    await stream.subscribePositions(); // an ordered marker: nothing arrived for the changes above
    await inbox.waitFor(() => inbox.ofType("pk").length === 2);
    expect(inbox.types()).toEqual(["pk", "uok", "upk", "pk"]);
  });

  it("a stream that is not subscribed gets neither", async () => {
    const { broker, inbox } = setup();
    const client = broker.client();
    clients.push(client);
    const stream = await connected(broker, inbox);
    await client.placeOrder(LIMIT_BUY);
    await stream.subscribePositions(); // marker
    await inbox.waitFor(isType("pk"));
    expect(inbox.types()).toEqual(["pk"]);
  });
});

describe("touchline and depth", () => {
  it("answers a subscription with the current quote, then pushes ticks for that instrument only", async () => {
    const { broker, inbox } = setup();
    broker.setQuote(TCS[0], TCS[1], { lastPrice: "101.50" });
    const stream = await connected(broker, inbox);
    await stream.subscribeTouchline([KEY]);
    await inbox.waitFor(isType("tk"));
    const ack = inbox.ofType("tk")[0];
    expect(ack?.raw["tk"]).toBe(TCS[1]);
    expect(ack?.raw["ts"]).toBe("TCS-EQ");
    expect(ack?.raw["lp"]).toBe("101.50");

    broker.tick(TCS[0], "22", { lastPrice: "55" }); // not subscribed
    broker.tick(TCS[0], TCS[1], { lastPrice: "102.25", volume: 900 });
    await inbox.waitFor(isType("tf"));
    const feeds = inbox.ofType("tf");
    expect(feeds).toHaveLength(1);
    expect(feeds[0]?.raw["tk"]).toBe(TCS[1]);
    expect(feeds[0]?.raw["lp"]).toBe("102.25");
    expect(feeds[0]?.raw["v"]).toBe("900");
    expect(inbox.types()).not.toContain("df"); // depth was never subscribed

    // The tick also updated the quote that a new subscription sees.
    await stream.unsubscribeTouchline([KEY]);
    await inbox.waitFor(isType("uk"));
    await stream.subscribeTouchline([KEY]);
    await inbox.waitFor(() => inbox.ofType("tk").length === 2);
    expect(inbox.ofType("tk")[1]?.raw["lp"]).toBe("102.25");
  });

  it("pushes df to a depth subscription, acknowledged with dk, and stops after unsubscribe", async () => {
    const { broker, inbox } = setup();
    const stream = await connected(broker, inbox);
    await stream.subscribeDepth([KEY]);
    await inbox.waitFor(isType("dk"));
    broker.tick(TCS[0], TCS[1], { lastPrice: "7" });
    await inbox.waitFor(isType("df"));
    expect(inbox.ofType("df")[0]?.raw["lp"]).toBe("7");
    expect(inbox.types()).not.toContain("tf");
    await stream.unsubscribeDepth([KEY]);
    await inbox.waitFor(isType("udk"));
    broker.tick(TCS[0], TCS[1], { lastPrice: "8" });
    await stream.subscribePositions(); // ordered marker
    await inbox.waitFor(isType("pk"));
    expect(inbox.ofType("df")).toHaveLength(1);
  });

  it("tick refuses an unknown field name before changing anything", () => {
    const { broker } = setup();
    expect(() => {
      broker.tick(TCS[0], TCS[1], { lastPrise: "1" });
    }).toThrow(RangeError);
  });
});

describe("drills", () => {
  it("dropStream: the client reconnects, resubscribes and keeps receiving", async () => {
    const { broker, inbox } = setup();
    let fire = (): void => undefined;
    const again = once((f) => {
      fire = f;
    });
    const stream = await connected(broker, inbox, {
      onReconnect: () => {
        fire();
      },
    });
    await stream.subscribeTouchline([KEY]);
    await inbox.waitFor(isType("tk"));
    broker.dropStream();
    await again;
    await inbox.waitFor(() => inbox.ofType("tk").length === 2); // replayed subscription
    expect(stream.reconnectCount).toBe(1);
    broker.tick(TCS[0], TCS[1], { lastPrice: "5" });
    await inbox.waitFor(isType("tf"));
    expect(inbox.ofType("tf")[0]?.raw["lp"]).toBe("5");
  });

  it("refuseStreamLogin: the next connect is Not_Ok once; a later connect works", async () => {
    const { broker, inbox } = setup();
    broker.refuseStreamLogin();
    const refused = broker.stream();
    streams.push(refused);
    await expect(refused.connect()).rejects.toBeInstanceOf(AuthenticationError);
    await expect(refused.closed).resolves.toBeInstanceOf(AuthenticationError);
    const stream = await connected(broker, inbox);
    expect(stream.state).toBe("CONNECTED");
  });

  it("silenceStream: missing heartbeat replies are detected at the 0.5 s heartbeat; resume recovers", async () => {
    const { broker, inbox } = setup();
    let lost = (): void => undefined;
    let back = (): void => undefined;
    const disconnected = once((f) => {
      lost = f;
    });
    const reconnected = once((f) => {
      back = f;
    });
    const stream = await connected(broker, inbox, {
      onDisconnect: () => {
        lost();
      },
      onReconnect: () => {
        back();
      },
    });
    await stream.subscribeTouchline([KEY]);
    await inbox.waitFor(isType("tk"));
    const before = stream.heartbeatAcks;
    broker.silenceStream();
    await disconnected; // 2 x 0.5 s without a frame
    broker.resumeStream();
    await reconnected;
    await expect.poll(() => stream.heartbeatAcks, { timeout: WAIT_MS }).toBeGreaterThan(before);
    expect(stream.state).toBe("CONNECTED");
  });
});

/** Open a WebSocket to `url`: "open", or the HTTP status the handshake was refused with. */
function handshake(url: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const socket = new WebSocket(url);
    socket.once("open", () => {
      socket.terminate();
      resolve("open");
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(String(response.statusCode));
    });
    socket.once("error", () => {
      resolve("error");
    });
  });
}

/** `gc` when V8 can be asked for it (`--expose-gc`, or enabled at run time), else `null`. */
function forcedGc(): (() => void) | null {
  const exposed = (globalThis as { gc?: () => void }).gc;
  if (typeof exposed === "function") return exposed;
  try {
    v8.setFlagsFromString("--expose-gc");
    const gc: unknown = vm.runInNewContext("gc");
    return typeof gc === "function" ? (gc as () => void) : null;
  } catch {
    return null;
  }
}

describe("lifecycle", () => {
  const dirOf = (broker: OfflineBroker): string => {
    const client = broker.client();
    clients.push(client);
    const dir = client.config.instrumentsDir;
    if (dir === null) throw new Error("no instruments dir");
    return dir;
  };

  it("close() with a connected stream resolves, the stream ends cleanly and the folder is gone", async () => {
    const { broker, inbox } = setup();
    const dir = dirOf(broker);
    expect(existsSync(dir)).toBe(true);
    const stream = await connected(broker, inbox);
    await stream.subscribeOrders();
    await broker.close();
    await expect(stream.closed).resolves.toBeNull();
    expect(stream.state).toBe("CLOSED");
    expect(existsSync(dir)).toBe(false);
    await broker.close(); // idempotent
  });

  it("close() unregisters this broker's path; another broker on the shared server still works", async () => {
    const { broker } = setup();
    const other = setup().broker;
    const url = broker.client().config.wsUrl;
    const otherUrl = other.client().config.wsUrl;
    expect(new URL(url).port).toBe(new URL(otherUrl).port); // one shared server
    expect(url).not.toBe(otherUrl);
    expect(await handshake(url)).toBe("open");
    await broker.close();
    expect(await handshake(url)).toBe("404");
    expect(await handshake(otherUrl)).toBe("open");
    const port = new URL(url).port;
    expect(await handshake(`ws://127.0.0.1:${port}/NorenWSAPI/nobody`)).toBe("404");
    expect(await handshake(`ws://127.0.0.1:${port}/other`)).toBe("404");
  });

  it("two brokers on the shared server see only their own orders and ticks", async () => {
    const a = setup();
    const b = setup();
    a.broker.defaultPlace = "pending";
    b.broker.defaultPlace = "pending";
    const clientA = a.broker.client();
    const clientB = b.broker.client();
    clients.push(clientA, clientB);
    const streamA = await connected(a.broker, a.inbox);
    const streamB = await connected(b.broker, b.inbox);
    for (const stream of [streamA, streamB]) {
      await stream.subscribeOrders();
      await stream.subscribePositions();
      await stream.subscribeTouchline([KEY]);
      await stream.subscribeDepth([KEY]);
    }
    await a.inbox.waitFor(isType("dk"));
    await b.inbox.waitFor(isType("dk"));
    const orderA = await clientA.placeOrder(LIMIT_BUY);
    a.broker.tick(TCS[0], TCS[1], { lastPrice: "11" });
    b.broker.tick(TCS[0], TCS[1], { lastPrice: "22" });
    await a.inbox.waitFor((m) => m.raw["t"] === "om");
    await b.inbox.waitFor((m) => m.raw["t"] === "df" && m.raw["lp"] === "22");
    await a.inbox.waitFor((m) => m.raw["t"] === "df" && m.raw["lp"] === "11");
    expect(a.inbox.ofType("om").map((m) => m.raw["norenordno"])).toEqual([orderA]);
    expect(b.inbox.ofType("om")).toEqual([]);
    expect(a.inbox.ofType("tf").map((m) => m.raw["lp"])).toEqual(["11"]);
    expect(b.inbox.ofType("tf").map((m) => m.raw["lp"])).toEqual(["22"]);
    expect(b.broker.orders).toEqual([]);
  });

  it("a closed broker builds no more clients or streams", async () => {
    const broker = new OfflineBroker();
    await broker.close();
    expect(() => broker.client()).toThrow(/closed/);
    expect(() => broker.stream()).toThrow(/closed/);
  });

  it("every stream the broker built is stopped by close(), connected or not", async () => {
    const { broker, inbox } = setup();
    const live = await connected(broker, inbox);
    const idle = broker.stream();
    streams.push(idle);
    await broker.close();
    await expect(live.closed).resolves.toBeNull();
    expect(idle.state).toBe("CLOSED");
  });

  it("the client and the stream each keep the broker alive", () => {
    const broker = new OfflineBroker();
    brokers.push(broker);
    const client = broker.client();
    clients.push(client);
    const stream = broker.stream();
    streams.push(stream);
    expect(ownerOf(client)).toBe(broker);
    expect(ownerOf(stream)).toBe(broker);
  });

  it("a broker held only by its client and stream still works", async () => {
    const make = (): { client: TradeSmart; stream: TradeSmartStream; dir: string } => {
      const broker = new OfflineBroker();
      broker.addInstrument(TCS[0], TCS[1], "TCS-EQ");
      const client = broker.client();
      return { client, stream: broker.stream(), dir: client.config.instrumentsDir ?? "" };
    };
    const { client, stream, dir } = make();
    clients.push(client);
    streams.push(stream);
    forcedGc()?.();
    await stream.connect();
    expect(existsSync(dir)).toBe(true);
    expect((await client.profile()).stat).toBe("Ok");
  });

  it("the finalizer callback unregisters the path and removes the folder", async () => {
    const server = new OfflineStreamServer(new BrokerState());
    const dir = mkdtempSync(path.join(tmpdir(), "tradesmart-offline-"));
    expect(await handshake(server.url)).toBe("open");
    releaseOrphan({ dir, server });
    expect(existsSync(dir)).toBe(false);
    releaseOrphan({ dir, server }); // safe to repeat
    expect(await handshake(server.url)).toBe("404");
  });

  it("any number of brokers built in one tick work, and two of them stream", async () => {
    const made = Array.from({ length: 20 }, () => new OfflineBroker());
    brokers.push(...made);
    const urls = made.map((broker) => broker.client().config.wsUrl);
    expect(new Set(urls).size).toBe(20);
    for (const broker of made.slice(0, 2)) {
      const inbox = new Inbox();
      const stream = await connected(broker, inbox);
      await stream.subscribePositions();
      await inbox.waitFor(isType("pk"));
    }
  });

  it("a collected broker's folder is removed by the finalizer (when gc can be forced)", async () => {
    const gc = forcedGc();
    if (gc === null) return; // gc is not exposed here; the callback itself is tested above
    let dir = "";
    ((): void => {
      const broker = new OfflineBroker();
      dir = broker.client().config.instrumentsDir ?? "";
    })();
    expect(existsSync(dir)).toBe(true);
    await expect
      .poll(
        () => {
          gc();
          return existsSync(dir);
        },
        { timeout: WAIT_MS, interval: 50 },
      )
      .toBe(false);
  });
});

describe("carried fixes", () => {
  it("rpnl is the reference's money text, not rounded to two decimals", () => {
    const state = new BrokerState();
    state.setPositions([
      {
        exch: "NSE",
        tsym: "TCS-EQ",
        prd: "I",
        cfbuyqty: 3,
        cfbuyamt: 31,
        daysellqty: 3,
        daysellamt: 41,
      },
    ]);
    // 41/3 - 31/3 at 28 significant digits (Python's default Decimal context), times 3
    expect(state.positions[0]?.["rpnl"]).toBe(REFERENCE_RPNL);
  });

  it("drills.reject('') answers with the reference's fallback message", async () => {
    const { broker } = setup();
    const client = broker.client({ maxRetries: 0 });
    clients.push(client);
    broker.failNext("Limits", drills.reject(""));
    await expect(client.margins()).rejects.toMatchObject({ emsg: "Rejected by OfflineBroker" });
  });

  it("a throwing state listener is logged at DEBUG and does not stop the others", () => {
    const lines: { msg: string; ctx: LogContext | undefined }[] = [];
    const logger: Logger = {
      debug: (msg, ctx) => lines.push({ msg, ctx }),
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    const state = new BrokerState("OFFLINE01", logger);
    const seen: unknown[] = [];
    state.addListener(() => {
      throw new Error("listener boom");
    });
    state.addListener((message) => seen.push(message["t"]));
    state.tick(TCS[0], TCS[1], { lastPrice: "2" });
    expect(seen).toEqual(["tf", "df"]);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.msg).toContain("listener boom");
    expect(lines[0]?.ctx?.logger).toBe("tradesmart");
  });
});
