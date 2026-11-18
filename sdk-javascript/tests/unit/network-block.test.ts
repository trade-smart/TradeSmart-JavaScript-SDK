import { once } from "node:events";
import net from "node:net";
import { describe, expect, it } from "vitest";

describe("network block", () => {
  it("refuses fetch to a public host", async () => {
    await expect(fetch("https://example.com")).rejects.toThrow(/network is blocked in tests/);
  });

  it("refuses a raw connection to a public host", () => {
    expect(() => net.connect(443, "example.com")).toThrow(/network is blocked in tests/);
  });

  it("allows a loopback connection", async () => {
    const server = net.createServer((socket) => {
      socket.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as net.AddressInfo;
    const client = net.connect(address.port, "127.0.0.1");
    await once(client, "connect");
    client.destroy();
    server.close();
  });
});
