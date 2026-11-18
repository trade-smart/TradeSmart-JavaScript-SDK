// A local WebSocket server speaking the TradeSmart stream protocol, for integration tests. It
// listens on 127.0.0.1 only (the test network block allows loopback and nothing else).
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export type Frame = Record<string, unknown>;

/** One accepted client connection. */
export class ServerConnection {
  /** Frames received from the client, parsed, in order. */
  readonly frames: Frame[] = [];
  closed = false;

  constructor(
    readonly socket: WebSocket,
    readonly headers: IncomingHttpHeaders,
  ) {
    socket.on("close", () => {
      this.closed = true;
    });
  }

  send(frame: Frame | string): void {
    this.socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  /** A closing handshake from the server side. */
  close(code = 1000): void {
    this.socket.close(code);
  }

  /**
   * Write an `ak` text frame and a close frame (1000) in one TCP write, bypassing `ws`'s framing,
   * so the client parses both in the same data event.
   */
  ackThenCloseInOneChunk(status: string): void {
    const payload = Buffer.from(JSON.stringify({ t: "ak", s: status }), "utf8");
    if (payload.length > 125) throw new Error("ak payload too long for a one-byte length");
    const text = Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
    const close = Buffer.from([0x88, 0x02, 0x03, 0xe8]);
    const raw = (this.socket as unknown as { _socket: { write(data: Buffer): boolean } })._socket;
    raw.write(Buffer.concat([text, close]));
  }

  /** Drop the TCP connection without a closing handshake. */
  terminate(): void {
    this.socket.terminate();
  }

  /** Frames received whose `t` is `t`. */
  framesOf(t: string): Frame[] {
    return this.frames.filter((f) => f["t"] === t);
  }
}

export interface TestServerOptions {
  /** The `s` of the `ak` reply; `null` sends no `ak` at all. Default `"OK"`. */
  ack?: string | null;
  /** Answer every `{"t":"h"}` with `{"t":"hk"}`. Default true. */
  answerHeartbeats?: boolean;
  /** Refuse the WebSocket handshake (HTTP 503). Default false. */
  refuse?: boolean;
}

export class TestWsServer {
  readonly connections: ServerConnection[] = [];
  /** Handshakes attempted (accepted or refused). */
  handshakes = 0;
  ack: string | null;
  answerHeartbeats: boolean;
  refuse: boolean;
  /** Called with each new connection before the `ak` is sent (to send frames ahead of it). */
  beforeAck: ((conn: ServerConnection) => void) | null = null;
  /**
   * The next this-many connections get their `ak` and a close frame in one TCP chunk (the server
   * kicks the session right after accepting it), so the client sees the close before it can replay.
   */
  kickAfterAck = 0;

  private constructor(
    private readonly wss: WebSocketServer,
    options: TestServerOptions,
  ) {
    this.ack = options.ack === undefined ? "OK" : options.ack;
    this.answerHeartbeats = options.answerHeartbeats ?? true;
    this.refuse = options.refuse ?? false;
  }

  static async start(options: TestServerOptions = {}): Promise<TestWsServer> {
    let server: TestWsServer | null = null;
    const wss = await new Promise<WebSocketServer>((resolve, reject) => {
      const s = new WebSocketServer({
        host: "127.0.0.1",
        port: 0,
        verifyClient: (_info, done) => {
          if (server !== null) server.handshakes += 1;
          if (server?.refuse === true) done(false, 503);
          else done(true);
        },
      });
      s.once("listening", () => {
        resolve(s);
      });
      s.once("error", reject);
    });
    server = new TestWsServer(wss, options);
    const self = server;
    wss.on("connection", (socket, request) => {
      const conn = new ServerConnection(socket, request.headers);
      self.connections.push(conn);
      socket.on("message", (data) => {
        const text = Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data).toString("utf8");
        const frame = JSON.parse(text) as Frame;
        conn.frames.push(frame);
        self.onFrame(conn, frame);
      });
    });
    return server;
  }

  private onFrame(conn: ServerConnection, frame: Frame): void {
    if (frame["t"] === "a" && this.kickAfterAck > 0) {
      this.kickAfterAck -= 1;
      conn.ackThenCloseInOneChunk(this.ack ?? "OK");
      return;
    }
    if (frame["t"] === "a") {
      this.beforeAck?.(conn);
      if (this.ack !== null) conn.send({ t: "ak", uid: frame["uid"], s: this.ack });
    } else if (frame["t"] === "h" && this.answerHeartbeats) {
      conn.send({ t: "hk", ft: "1730966400" });
    }
  }

  get url(): string {
    const address = this.wss.address() as AddressInfo;
    return `ws://127.0.0.1:${String(address.port)}/NorenWSAPI/`;
  }

  /** The newest connection. */
  get last(): ServerConnection {
    const conn = this.connections.at(-1);
    if (conn === undefined) throw new Error("no connection yet");
    return conn;
  }

  /** Every frame received over all connections. */
  get frames(): Frame[] {
    return this.connections.flatMap((c) => c.frames);
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => {
      this.wss.close(() => {
        resolve();
      });
    });
  }
}
