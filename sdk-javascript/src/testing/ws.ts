// The offline broker's stream endpoint (Python: testing/_ws.py): a loopback WebSocket server on
// 127.0.0.1 speaking the documented stream protocol (05-websocket.md). `a` -> `ak`,
// `t` / `d` -> one `tk` / `dk` per key with the current quote, `u` -> `uk` (same `k`), `ud` ->
// `udk`, `o` -> nothing (order updates have no acknowledgement), `uo` -> `uok`, `p` -> `pk`, `up`
// -> `upk`, `h` -> `hk` unless the state is silenced. State events (`tf`, `df`, `om`, `pm`) reach
// only the connections subscribed to that instrument, to orders or to positions. Node is single
// threaded, so one `send` per connection arrives in order and needs no queue.
//
// A client's `wsUrl` must be known when it is built, but Node reports the port of a listening
// socket only a tick later. So ONE process-wide server is bound at import (top-level await) and
// every broker gets its own path on it, `/NorenWSAPI/<unguessable id>`; an upgrade for any other
// path is refused with 404, so a connection never reaches another broker. The shared server is
// unreferenced: it never keeps the process alive.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import * as replies from "./replies.js";
import { text } from "./replies.js";
import type { Wire } from "./replies.js";
import type { BrokerState } from "./state.js";

const PATH_PREFIX = "/NorenWSAPI/";

/** The brokers' endpoints by path id. */
const endpoints = new Map<string, OfflineStreamServer>();
const sockets = new WebSocketServer({ noServer: true });
const shared = createServer();

/**
 * Refuse an upgrade with a 404. A client that resets the connection meanwhile must not raise an
 * unhandled `error` event on the socket (it would crash the user's test process).
 */
export function refuseUpgrade(socket: Duplex): void {
  socket.on("error", () => {
    socket.destroy();
  });
  socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

shared.on("upgrade", (request, socket, head) => {
  const path = (request.url ?? "").split("?")[0] ?? "";
  const endpoint = path.startsWith(PATH_PREFIX)
    ? endpoints.get(path.slice(PATH_PREFIX.length))
    : undefined;
  if (endpoint === undefined) {
    refuseUpgrade(socket);
    return;
  }
  sockets.handleUpgrade(request, socket, head, (ws) => {
    endpoint.accept(ws);
  });
});
shared.on("request", (_request, response) => {
  response.writeHead(404, { Connection: "close" }).end();
});

/** The port of the shared server (bound below). */
const PORT: number = await new Promise<number>((resolve, reject) => {
  shared.once("error", (cause: Error) => {
    reject(
      new Error(
        `tradesmart/testing could not bind a loopback port for the offline broker: ${cause.message}`,
        { cause },
      ),
    );
  });
  shared.listen(0, "127.0.0.1", () => {
    const address = shared.address();
    if (address === null || typeof address === "string") {
      reject(new Error("tradesmart/testing could not read the loopback port it bound"));
      return;
    }
    shared.unref();
    resolve(address.port);
  });
});
// After the bind, a late server error (for example EMFILE on accept) must not be unhandled.
shared.on("error", () => undefined);

/** One client connection and what it subscribed to. */
class Connection {
  readonly touchline = new Set<string>();
  readonly depth = new Set<string>();
  orders = false;
  positions = false;

  constructor(readonly socket: WebSocket) {}

  send(message: Wire): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(message));
  }

  wants(event: Wire): boolean {
    const kind = event["t"];
    const key = `${String(event["e"])}|${String(event["tk"])}`;
    return (
      (kind === "om" && this.orders) ||
      (kind === "pm" && this.positions) ||
      (kind === "tf" && this.touchline.has(key)) ||
      (kind === "df" && this.depth.has(key))
    );
  }
}

const keysOf = (message: Wire): string[] =>
  text(message["k"])
    .split("#")
    .filter((key) => key !== "");

function frameText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
}

/** The broker's stream endpoint on `127.0.0.1`, listening from construction. */
export class OfflineStreamServer {
  readonly #state: BrokerState;
  readonly #id = randomBytes(16).toString("hex");
  readonly #connections = new Set<Connection>();
  #closed = false;

  constructor(state: BrokerState) {
    this.#state = state;
    endpoints.set(this.#id, this);
    state.addListener((event) => {
      this.#push(event);
    });
  }

  /** `ws://127.0.0.1:<port>/NorenWSAPI/<id>`: this broker's own path on the shared server. */
  get url(): string {
    return `ws://127.0.0.1:${String(PORT)}${PATH_PREFIX}${this.#id}`;
  }

  /** Cut every open connection at once (no closing handshake); clients reconnect. */
  dropAll(): void {
    for (const connection of this.#connections) connection.socket.terminate();
  }

  /** Unregister the path and cut every connection, without waiting. Idempotent. */
  abort(): void {
    this.#closed = true;
    endpoints.delete(this.#id);
    this.dropAll();
  }

  /** Unregister the path and cut this broker's connections (the shared server stays up). */
  close(): Promise<void> {
    this.abort();
    return Promise.resolve();
  }

  /** A connection the shared server routed to this broker. */
  accept(socket: WebSocket): void {
    if (this.#closed) {
      socket.terminate();
      return;
    }
    this.#accept(socket);
  }

  #accept(socket: WebSocket): void {
    const connection = new Connection(socket);
    this.#connections.add(connection);
    socket.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(frameText(data));
      } catch {
        return; // not JSON: ignored
      }
      if (typeof message === "object" && message !== null && !Array.isArray(message)) {
        this.#reply(connection, message as Wire);
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.#connections.delete(connection);
    });
  }

  #push(event: Wire): void {
    for (const connection of this.#connections) if (connection.wants(event)) connection.send(event);
  }

  #reply(connection: Connection, message: Wire): void {
    const state = this.#state;
    const kind = message["t"];
    if (kind === "a") {
      const refused = state.refuseLoginOnce;
      state.refuseLoginOnce = false;
      connection.send(replies.connectAck(text(message["uid"]), !refused));
    } else if (kind === "h") {
      if (!state.silenced) connection.send(replies.heartbeatAck(new Date()));
    } else if (kind === "t" || kind === "d") {
      const keys = keysOf(message);
      const subscribed = kind === "t" ? connection.touchline : connection.depth;
      for (const key of keys) subscribed.add(key);
      const ack = kind === "t" ? replies.touchlineAck : replies.depthAck;
      for (const key of keys) {
        const at = key.indexOf("|");
        const exchange = at < 0 ? key : key.slice(0, at);
        const token = at < 0 ? "" : key.slice(at + 1);
        const { instrument, fields } = state.snapshotOf(exchange, token);
        connection.send(ack(exchange, token, instrument, fields, new Date()));
      }
    } else if (kind === "u") {
      for (const key of keysOf(message)) connection.touchline.delete(key);
      connection.send({ t: "uk", k: text(message["k"]) });
    } else if (kind === "ud") {
      for (const key of keysOf(message)) connection.depth.delete(key);
      connection.send({ t: "udk" });
    } else if (kind === "o") {
      connection.orders = true; // documented: no acknowledgement
    } else if (kind === "uo") {
      connection.orders = false;
      connection.send({ t: "uok" });
    } else if (kind === "p") {
      connection.positions = true;
      connection.send({ t: "pk", uid: text(message["uid"]) });
    } else if (kind === "up") {
      connection.positions = false;
      connection.send({ t: "upk" });
    }
  }
}
