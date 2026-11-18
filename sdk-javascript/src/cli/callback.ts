// The loopback server that receives the OAuth redirect (sdk-behaviour 6.6 step 1) and the
// extraction of a pasted code or URL. Nothing here logs: the request line carries the code.
import http from "node:http";
import { CliCancelled } from "./io.js";

export const CALLBACK_PATH = "/callback";
export const DEFAULT_CALLBACK_TIMEOUT_MS = 120_000;

/** The first non-blank `code` value of a query string, stripped; `null` when there is none. */
function codeOf(query: string): string | null {
  const first = new URLSearchParams(query).getAll("code").find((value) => value !== "");
  const code = first?.trim() ?? "";
  return code === "" ? null : code;
}

/** The `code` from a pasted redirect URL, or the pasted text itself when it is a bare code. */
export function extractCode(pasted: string): string | null {
  const text = pasted.trim();
  if (text === "") return null;
  if (
    text.includes("://") ||
    text.startsWith("?") ||
    text.startsWith("/") ||
    text.includes("code=")
  ) {
    const mark = text.indexOf("?");
    if (mark >= 0) return codeOf(text.slice(mark + 1).split("#", 1)[0] ?? "");
    return codeOf(text);
  }
  return text;
}

/** A client that vanishes mid-request is not worth a crash or a message. */
function ignoreError(): void {}

export interface CallbackServer {
  /** The code, or `null` after `timeoutMs`. Rejects with `CliCancelled` when `signal` aborts. */
  waitForCode(timeoutMs: number, signal?: AbortSignal): Promise<string | null>;
  close(): Promise<void>;
}

/** Listen on `host:port` for `GET /callback?code=...`; rejects when the address cannot be bound. */
export function startCallbackServer(host: string, port: number): Promise<CallbackServer> {
  let publish: (code: string) => void = () => undefined;
  const published = new Promise<string>((resolve) => {
    publish = resolve;
  });
  let claimed = false;

  const handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const reply = (status: number, text: string, done?: () => void): void => {
      const body = Buffer.from(text, "utf8");
      res.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": body.length,
        Connection: "close",
      });
      res.end(body, done);
    };
    if (req.method !== "GET") {
      reply(501, "Unsupported method.");
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      reply(400, "Bad request."); // never echo the target
      return;
    }
    if (url.pathname.replace(/\/+$/, "") !== CALLBACK_PATH) {
      reply(404, "Not found.");
      return;
    }
    const code = codeOf(url.search.slice(1));
    if (code === null) {
      reply(400, "No authorisation code in the redirect.");
    } else if (!claimed) {
      claimed = true;
      // Publish only after the reply is written (the main flow may close the server at once).
      reply(200, "Login complete. You can close this window and return to the terminal.", () => {
        publish(code);
      });
    } else {
      reply(409, "Login already received. You can close this window.");
    }
  };
  // Nothing a client sends may raise an uncaught exception: any local process or page can reach
  // this port, and a crash would abort the login.
  const server = http.createServer((req, res) => {
    req.on("error", ignoreError);
    res.on("error", ignoreError);
    try {
      handle(req, res);
    } catch {
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Length": 12, Connection: "close" });
        res.end("Bad request.");
      } else res.destroy();
    }
  });
  // A connection that sends nothing cannot hold the login (and never blocks another one).
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, () => {
      server.off("error", reject);
      server.on("error", ignoreError); // a later error (EMFILE on accept) must not crash the login
      resolve({
        waitForCode(timeoutMs, signal) {
          return new Promise<string | null>((done, fail) => {
            const finish = (): void => {
              clearTimeout(timer);
              signal?.removeEventListener("abort", onAbort);
            };
            const onAbort = (): void => {
              finish();
              fail(new CliCancelled());
            };
            const timer = setTimeout(() => {
              finish();
              done(null);
            }, timeoutMs);
            if (signal?.aborted === true) {
              onAbort();
              return;
            }
            signal?.addEventListener("abort", onAbort, { once: true });
            void published.then((code) => {
              finish();
              done(code);
            });
          });
        },
        close() {
          return new Promise<void>((closed) => {
            server.close(() => {
              closed();
            });
            server.closeAllConnections();
          });
        },
      });
    });
  });
}
