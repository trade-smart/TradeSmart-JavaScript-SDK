// Final review M-g: a reset on a loopback socket the SDK's own helper servers hold must never be
// an unhandled 'error' event (it would crash a user's test process or the login).
import { EventEmitter } from "node:events";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCallbackServer } from "../../src/cli/callback.js";
import { refuseUpgrade } from "../../src/testing/ws.js";

afterEach(() => {
  vi.restoreAllMocks();
});

class FakeSocket extends EventEmitter {
  ended: string | undefined;
  destroyed = false;
  end(data: string): void {
    this.ended = data;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

describe("offline broker: an upgrade for an unknown path", () => {
  it("is refused with a 404 and survives a reset on the socket", () => {
    const socket = new FakeSocket();
    refuseUpgrade(socket as never);
    expect(socket.ended).toContain("404 Not Found");
    // Without an 'error' listener this emit throws (an unhandled error event).
    expect(() => socket.emit("error", new Error("read ECONNRESET"))).not.toThrow();
    expect(socket.destroyed).toBe(true);
  });
});

describe("login callback server: an error after listen", () => {
  it("does not crash the process and the server still closes", async () => {
    const created: http.Server[] = [];
    const real = http.createServer.bind(http);
    vi.spyOn(http, "createServer").mockImplementation((...args: Parameters<typeof real>) => {
      const server = real(...args);
      created.push(server);
      return server;
    });
    const callback = await startCallbackServer("127.0.0.1", 0);
    try {
      const [server] = created;
      expect(server).toBeDefined();
      expect(() => server?.emit("error", new Error("accept EMFILE"))).not.toThrow();
    } finally {
      await callback.close();
    }
  });
});
