// Default test runs make no network connection except to loopback. Live suites are the only
// exemption (they run with TRADESMART_LIVE_TESTS=1). The block works at four levels:
// net.connect / net.createConnection / Socket.prototype.connect (so tls and undici are covered),
// tls.connect, dns.lookup (callback and promise forms) and global fetch (which would otherwise
// wrap the refusal in an opaque "fetch failed").
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { networkBlockEnabled } from "./live-mode.js";

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

if (networkBlockEnabled(process.env)) {
  installNetworkBlock();
}

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(h) ||
    h === "::ffff:127.0.0.1"
  );
}

function assertLoopback(host: string): void {
  if (!isLoopback(host)) throw new Error(`network is blocked in tests: ${host}`);
}

// The host a net.connect-style call targets; undefined for a Unix socket path.
function connectTarget(args: unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    const o = first as { host?: unknown; hostname?: unknown; path?: unknown };
    if (typeof o.path === "string") return undefined;
    if (typeof o.host === "string") return o.host;
    if (typeof o.hostname === "string") return o.hostname;
    return "localhost";
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    return typeof args[1] === "string" ? args[1] : "localhost";
  }
  return undefined;
}

function guardConnect(args: unknown[]): void {
  const host = connectTarget(args);
  if (host !== undefined) assertLoopback(host);
}

function guardLookup(args: unknown[]): void {
  const host = args[0];
  if (typeof host === "string" && host !== "") assertLoopback(host);
}

// Replace target[name] with a wrapper that runs `guard` first. With `async`, a refusal becomes a
// rejected promise instead of a synchronous throw.
function patch(
  target: object,
  name: string,
  guard: (args: unknown[]) => void,
  async = false,
): void {
  const record = target as Record<string, AnyFn>;
  const original = record[name];
  if (original === undefined) throw new Error(`cannot patch ${name}`);
  record[name] = function (this: unknown, ...args: unknown[]): unknown {
    if (async) {
      try {
        guard(args);
      } catch (error) {
        return Promise.reject(asError(error));
      }
    } else {
      guard(args);
    }
    return original.apply(this, args);
  };
}

function installNetworkBlock(): void {
  patch(net, "connect", guardConnect);
  patch(net, "createConnection", guardConnect);
  patch(net.Socket.prototype, "connect", guardConnect);
  patch(tls, "connect", guardConnect);
  patch(dns, "lookup", guardLookup);
  patch(dns.promises, "lookup", guardLookup, true);

  // Node's built-in fetch turns a refused connection into a generic "fetch failed", so refuse a
  // non-loopback origin up front with the readable message.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    try {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      assertLoopback(url.hostname);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    return originalFetch(input, init);
  };
}
