// The login CLI end to end (sdk-behaviour 6.6-6.7): real loopback callback server, real token and
// key files in a temp folder, the GenAcsTok call answered by a scripted undici MockAgent.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeChecksum } from "../../src/auth.js";
import { CliCancelled, type CliIo } from "../../src/cli/io.js";
import { commandArg, envHints } from "../../src/cli/login.js";
import { runCli } from "../../src/cli/run.js";
import { saveKeys } from "../../src/token-store/key-file.js";
import { BASE_URL, scriptedClient, type Reply, type Scripted } from "../helpers/scripted-client.js";

const APP = "synthetic-app-key";
const SECRET = "synthetic-secret-key";
const CODE = "synthetic-code";
const NEW_TOKEN = "synthetic-new-token";
const AUTHORIZE = "https://auth.example.test/authorize";
const OK_BODY = JSON.stringify({
  stat: "Ok",
  access_token: NEW_TOKEN,
  uid: "TEST123",
  actid: "TEST123",
  uname: "Test User",
  expires_in: "86400",
});

const root = mkdtempSync(path.join(os.tmpdir(), "tradesmart-cli-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
const posix = process.platform !== "win32";
/** A path as the CLI quotes it on this platform (the quoting itself: tests/unit/cli-args). */
const arg = (p: string): string => commandArg(p, process.platform)[0];

let dir = "";
let tokenFile = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(root, "case-"));
  tokenFile = path.join(dir, "token.json");
});

const servers: Scripted[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.agent.close();
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => {
        resolve(port);
      });
    });
  });
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { agent: false }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      })
      .on("error", reject);
  });
}

interface Harness {
  io: CliIo;
  out: string[];
  err: string[];
  asked: { question: string; echo: boolean }[];
  opened: string[];
  session: Scripted;
}

interface HarnessOptions {
  env?: Record<string, string>;
  answers?: Record<string, string | null | typeof CliCancelled>;
  replies?: Reply[];
  /** Runs when the browser is "opened" (the redirect, normally); its result is the opener's. */
  browser?: (url: string) => Promise<boolean> | boolean;
  timeoutMs?: number;
  interrupt?: AbortSignal;
}

function harness(options: HarnessOptions = {}): Harness {
  const session = scriptedClient(options.replies ?? [{ body: OK_BODY }], { token: "none" });
  servers.push(session);
  const out: string[] = [];
  const err: string[] = [];
  const asked: Harness["asked"] = [];
  const opened: string[] = [];
  const answers = options.answers ?? {};
  const io: CliIo = {
    env: { ...options.env },
    platform: process.platform, // the real path rules: the temp folders are real paths
    home: dir,
    cwd: dir,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    prompt: (question, { echo }) => {
      asked.push({ question, echo });
      const key = Object.keys(answers).find((k) => question.startsWith(k));
      if (key === undefined) return Promise.resolve(null);
      const answer = answers[key];
      if (answer === CliCancelled) return Promise.reject(new CliCancelled());
      return Promise.resolve(answer as string | null);
    },
    openBrowser: (url) => {
      opened.push(url);
      return Promise.resolve(options.browser === undefined ? false : options.browser(url));
    },
    now: () => new Date(),
    httpDispatcher: session.agent,
    config: { baseUrl: BASE_URL, authorizeUrl: AUTHORIZE },
    callbackTimeoutMs: options.timeoutMs ?? 5_000,
    ...(options.interrupt === undefined ? {} : { interrupt: options.interrupt }),
  };
  return { io, out, err, asked, opened, session };
}

const KEYS = { TRADESMART_APP_KEY: APP, TRADESMART_SECRET_KEY: SECRET };

/** A browser that delivers the redirect with `code` to the callback. */
function redirecting(port: number, code = CODE): (url: string) => Promise<boolean> {
  return async () => {
    const reply = await get(`http://127.0.0.1:${String(port)}/callback?code=${code}`);
    expect(reply.status).toBe(200);
    return true;
  };
}

function loginArgs(port: number, ...extra: string[]): string[] {
  return [
    "login",
    "--client-id",
    "TEST123",
    "--token-file",
    tokenFile,
    "--port",
    String(port),
    ...extra,
  ];
}

const allOutput = (h: Harness): string[] => [...h.out, ...h.err];

describe("login in the browser", () => {
  it("completes from the redirect, saves the token and prints the success lines", async () => {
    const port = await freePort();
    const h = harness({ env: KEYS, browser: redirecting(port) });
    expect(await runCli(loginArgs(port), h.io)).toBe(0);

    expect(h.opened).toEqual([`${AUTHORIZE}?client_id=${APP}`]);
    expect(h.out).toContain("Your browser shows the TradeSmart login page; log in there.");
    expect(h.out).toContain(
      `Waiting up to 5 s for the redirect to http://127.0.0.1:${String(port)}/callback ...`,
    );
    expect(h.out).toContain("Logged in as Test User (TEST123).");
    expect(h.out).toContainEqual(
      expect.stringMatching(
        /^The token is valid until \d{4}-\d{2}-\d{2} 06:00 IST \(TradeSmart tokens expire daily at 06:00 IST\)\.$/,
      ),
    );
    expect(h.out).toContain(
      `Saved to ${tokenFile}. For TradeSmart.fromEnv() to use this file, set TRADESMART_TOKEN_FILE in the environment of your scripts:`,
    );
    for (const hint of envHints(tokenFile, process.platform)) expect(h.out).toContain(`  ${hint}`);
    if (posix) expect(h.out).toContain(`  export TRADESMART_TOKEN_FILE='${tokenFile}'`);
    expect(h.out).toContain(
      `Remove the saved login with \`npx tradesmart logout --token-file ${arg(tokenFile)}\`.`,
    );

    const saved = JSON.parse(readFileSync(tokenFile, "utf8")) as Record<string, string>;
    expect(saved["client_id"]).toBe("TEST123");
    expect(saved["access_token"]).toBe(NEW_TOKEN);
    expect(h.session.hits).toBe(1);
    expect(h.session.bodies[0]).toBe(
      `jData={"code":"${CODE}","checksum":"${computeChecksum(APP, SECRET, CODE)}"}`,
    );
    expect(h.session.headers[0]?.["authorization"]).toBeUndefined();
    // Environment keys are never saved.
    expect(existsSync(path.join(dir, "credentials.json"))).toBe(false);
  });

  it("a login to the default token file says TradeSmart.fromEnv() uses it", async () => {
    const port = await freePort();
    const h = harness({
      env: { ...KEYS, TRADESMART_TOKEN_FILE: tokenFile },
      browser: redirecting(port),
    });
    expect(await runCli(["login", "--client-id", "TEST123", "--port", String(port)], h.io)).toBe(0);
    expect(h.out).toContain(`Saved to ${tokenFile}; TradeSmart.fromEnv() uses it.`);
    expect(h.out).toContain("Remove the saved login with `npx tradesmart logout`.");
    expect(existsSync(tokenFile)).toBe(true);
  });

  it("a ~ in --token-file is expanded", async () => {
    const port = await freePort();
    const h = harness({ env: KEYS, browser: redirecting(port) });
    const code = await runCli(
      ["login", "--client-id", "TEST123", "--token-file", "~/sub/t.json", "--port", String(port)],
      h.io,
    );
    expect(code).toBe(0);
    expect(existsSync(path.join(dir, "sub", "t.json"))).toBe(true);
  });

  it("when no browser opens it prints the URL and keeps listening", async () => {
    const port = await freePort();
    const h = harness({ env: KEYS });
    h.io.openBrowser = (url) => {
      h.opened.push(url);
      void redirecting(port)(url);
      return Promise.resolve(false);
    };
    expect(await runCli(loginArgs(port), h.io)).toBe(0);
    expect(h.out).toContain(
      "Open this URL in your browser and log in; this window continues by itself after the redirect.",
    );
    expect(h.out).toContain(`${AUTHORIZE}?client_id=${APP}`);
  });

  it("a second redirect with a code gets 409 and is not used", async () => {
    const port = await freePort();
    const statuses: { status: number; body: string }[] = [];
    const h = harness({
      env: KEYS,
      browser: async () => {
        const base = `http://127.0.0.1:${String(port)}/callback`;
        statuses.push(await get(`${base}?code=first`));
        statuses.push(await get(`${base}?code=second`));
        return true;
      },
    });
    expect(await runCli(loginArgs(port), h.io)).toBe(0);
    expect(statuses.map((s) => s.status)).toEqual([200, 409]);
    expect(statuses[1]?.body).toBe("Login already received. You can close this window.");
    expect(h.session.hits).toBe(1);
    expect(h.session.bodies[0]).toContain('"code":"first"');
  });

  it("answers 400 without a code and 404 for other paths, then still takes the real one", async () => {
    const port = await freePort();
    const seen: number[] = [];
    const h = harness({
      env: KEYS,
      browser: async () => {
        const base = `http://127.0.0.1:${String(port)}`;
        seen.push((await get(`${base}/callback`)).status);
        seen.push((await get(`${base}/callback?code=`)).status);
        seen.push((await get(`${base}/other?code=x`)).status);
        seen.push((await get(`${base}/callback/?code=${CODE}`)).status);
        return true;
      },
    });
    expect(await runCli(loginArgs(port), h.io)).toBe(0);
    expect(seen).toEqual([400, 400, 404, 200]);
  });

  it("a client that vanishes mid-request does not end the login", async () => {
    const port = await freePort();
    const h = harness({
      env: KEYS,
      browser: async () => {
        const socket = net.connect(port, "127.0.0.1");
        await new Promise((resolve) => socket.once("connect", resolve));
        socket.write("GET /callback HTTP/1.1\r\nHost: x\r\nContent-Length: 50\r\n\r\nabc");
        await new Promise((resolve) => setTimeout(resolve, 30));
        socket.destroy();
        await new Promise((resolve) => setTimeout(resolve, 30));
        return redirecting(port)("");
      },
    });
    expect(await runCli(loginArgs(port), h.io)).toBe(0);
    expect(h.err).toEqual([]);
  });

  it("garbage that is not HTTP is dropped and the login still completes", async () => {
    const port = await freePort();
    const h = harness({
      env: KEYS,
      browser: async () => {
        const socket = net.connect(port, "127.0.0.1");
        await new Promise((resolve) => socket.once("connect", resolve));
        socket.write("\u0001\u0002 not http at all\r\n\r\n");
        await new Promise((resolve) => socket.once("close", resolve));
        return redirecting(port)("");
      },
    });
    expect(await runCli(loginArgs(port), h.io)).toBe(0);
    expect(h.err).toEqual([]);
  });

  it("a malformed request target gets a fixed 400 and the login still completes", async () => {
    const port = await freePort();
    const raw = (target: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
        });
        let text = "";
        socket.on("data", (c: Buffer) => (text += c.toString()));
        socket.on("close", () => {
          resolve(text);
        });
        socket.on("error", reject);
      });
    const replies: string[] = [];
    const h = harness({
      env: KEYS,
      browser: async () => {
        for (const target of ["//", "//:", "///x?code=leak", "http://"]) {
          replies.push(await raw(target));
        }
        return redirecting(port)("");
      },
    });
    expect(await runCli(loginArgs(port), h.io)).toBe(0);
    for (const reply of replies) {
      expect(reply).toMatch(/^HTTP\/1\.1 (400|404) /);
      expect(reply).not.toContain("leak");
      expect(reply).not.toContain("//:");
    }
    expect(h.err).toEqual([]);
    expect(h.session.hits).toBe(1);
    expect(h.session.bodies[0]).toContain(`"code":"${CODE}"`);
  });

  it("an idle connection does not block the redirect", async () => {
    const port = await freePort();
    let idle: net.Socket | null = null;
    const h = harness({
      env: KEYS,
      browser: async () => {
        const socket = net.connect(port, "127.0.0.1"); // a speculative pre-connect, sends nothing
        idle = socket;
        await new Promise((resolve) => socket.once("connect", resolve));
        return redirecting(port)("");
      },
    });
    expect(await runCli(loginArgs(port), h.io)).toBe(0);
    (idle as net.Socket | null)?.destroy();
  });

  // The test run refuses every non-loopback address (tests/setup/network-block.ts also refuses the
  // lookup behind listen("0.0.0.0")), so the listener itself cannot bind here: the warning and the
  // paste fallback are what is observable. The real 0.0.0.0 bind is the compose login service.
  it("a non-loopback --listen-host prints one warning, before listening", async () => {
    const port = await freePort();
    const h = harness({ env: KEYS, answers: { "code or URL": CODE } });
    expect(await runCli(loginArgs(port, "--listen-host", "0.0.0.0"), h.io)).toBe(0);
    const warnings = h.err.filter((line) => line.startsWith("Warning: listening on 0.0.0.0:"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`-p 127.0.0.1:${String(port)}:${String(port)}`);
    expect(h.err.some((line) => line.startsWith("Cannot listen on 0.0.0.0:"))).toBe(true);
  });

  it("a loopback --listen-host prints no warning", async () => {
    const port = await freePort();
    const h = harness({ env: KEYS, browser: redirecting(port) });
    expect(await runCli(loginArgs(port, "--listen-host", "127.0.0.1"), h.io)).toBe(0);
    expect(h.err).toEqual([]);
  });

  it("an IPv6 --listen-host is a usage error before anything happens", async () => {
    const h = harness({ env: KEYS });
    expect(await runCli(["login", "--client-id", "TEST123", "--listen-host", "::1"], h.io)).toBe(2);
    expect(h.err.join("\n")).toMatch(/accepts IPv4 addresses only/);
    expect(h.session.hits).toBe(0);
    expect(h.opened).toEqual([]);
  });
});

describe("the paste fallback", () => {
  it("a busy port falls back to pasting the whole redirect URL", async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      const h = harness({
        env: KEYS,
        answers: { "code or URL": `http://127.0.0.1:8080/callback?code=${CODE}` },
      });
      expect(await runCli(loginArgs(port), h.io)).toBe(0);
      expect(h.err[0]).toMatch(
        new RegExp(
          `^Cannot listen on 127\\.0\\.0\\.1:${String(port)} \\(.+\\); paste the code instead\\.$`,
        ),
      );
      expect(h.out).toContain(
        "Paste the `code` from the address bar after logging in (or the whole URL) and press Enter.",
      );
      expect(h.out).toContain("Open this URL in a browser and log in:");
      expect(h.session.bodies[0]).toContain(`"code":"${CODE}"`);
    } finally {
      blocker.close();
    }
  });

  it("a timeout falls back to pasting a bare code", async () => {
    const port = await freePort();
    const h = harness({ env: KEYS, timeoutMs: 50, answers: { "code or URL": ` ${CODE} ` } });
    expect(await runCli(loginArgs(port), h.io)).toBe(0);
    expect(h.err).toContain(
      "No redirect received in time. If no browser opened, run `npx tradesmart login --no-browser`.",
    );
    expect(h.session.bodies[0]).toContain(`"code":"${CODE}"`);
    // The listener is closed again: the port can be bound.
    const again = http.createServer();
    await new Promise<void>((resolve, reject) => {
      again.once("error", reject);
      again.listen(port, "127.0.0.1", resolve);
    });
    again.close();
  });

  it("--no-browser neither opens a browser nor listens", async () => {
    const port = await freePort();
    const h = harness({ env: KEYS, answers: { "code or URL": CODE } });
    expect(await runCli(loginArgs(port, "--no-browser"), h.io)).toBe(0);
    expect(h.opened).toEqual([]);
    expect(h.out.slice(0, 2)).toEqual([
      "Open this URL in a browser and log in:",
      `${AUTHORIZE}?client_id=${APP}`,
    ]);
    expect(h.asked.at(-1)).toEqual({ question: "code or URL: ", echo: true });
  });

  it("no code pasted (end of input) fails with exit 1 and exchanges nothing", async () => {
    const h = harness({ env: KEYS });
    expect(await runCli(loginArgs(await freePort(), "--no-browser"), h.io)).toBe(1);
    expect(h.err).toContain("No authorisation code received; run `npx tradesmart login` again.");
    expect(h.session.hits).toBe(0);
    expect(existsSync(tokenFile)).toBe(false);
  });
});

describe("the exchange and the account check", () => {
  it("a failed exchange exits 1, is not retried and saves nothing", async () => {
    const h = harness({
      env: KEYS,
      replies: [{ body: '{"stat":"Not_Ok","emsg":"Invalid code"}' }],
      answers: { "code or URL": CODE },
    });
    expect(await runCli(loginArgs(await freePort(), "--no-browser"), h.io)).toBe(1);
    expect(h.err).toContain("Login failed: GenAcsTok failed: Invalid code");
    expect(h.session.hits).toBe(1);
    expect(existsSync(tokenFile)).toBe(false);
  });

  it("an account that differs from the requested one saves nothing and exits 1", async () => {
    const other = JSON.stringify({
      stat: "Ok",
      access_token: NEW_TOKEN,
      uid: "OTHER9",
      actid: "OTHER9",
    });
    const h = harness({ env: KEYS, replies: [{ body: other }], answers: { "code or URL": CODE } });
    expect(await runCli(loginArgs(await freePort(), "--no-browser"), h.io)).toBe(1);
    expect(h.err).toContain(
      "This login belongs to account OTHER9, not TEST123 - nothing was saved.",
    );
    expect(existsSync(tokenFile)).toBe(false);
  });

  it("the account check ignores case and the token is saved under the server's spelling", async () => {
    const lower = JSON.stringify({
      stat: "Ok",
      access_token: NEW_TOKEN,
      uid: "Test123",
      actid: "TEST123",
      uname: "Test User",
    });
    const h = harness({ env: KEYS, replies: [{ body: lower }], answers: { "code or URL": CODE } });
    expect(await runCli(loginArgs(await freePort(), "--no-browser"), h.io)).toBe(0);
    expect(JSON.parse(readFileSync(tokenFile, "utf8"))).toMatchObject({ client_id: "Test123" });
    expect(h.out).toContain("Logged in as Test User (Test123).");
  });

  it("a token file that cannot be saved exits 1 and says the code is single-use", async () => {
    mkdirSync(tokenFile); // a directory where the file should go
    const h = harness({ env: KEYS, answers: { "code or URL": CODE } });
    expect(await runCli(loginArgs(await freePort(), "--no-browser"), h.io)).toBe(1);
    const text = h.err.join("\n");
    expect(text).toMatch(/^Logged in, but the token could not be saved to .+/);
    expect(text).toContain("(the login code is single-use)");
    expect(text).toContain("npx tradesmart login");
  });

  it("no output line contains the token, secret key, checksum or code", async () => {
    const checksum = computeChecksum(APP, SECRET, CODE);
    const secrets = [NEW_TOKEN, SECRET, checksum, CODE];
    const port = await freePort();
    const cases: Harness[] = [];
    // success through the browser
    const a = harness({ env: KEYS, browser: redirecting(port) });
    await runCli(loginArgs(port), a.io);
    cases.push(a);
    // a pasted URL: failed exchange, wrong account, token that cannot be saved, success
    for (const body of [
      '{"stat":"Not_Ok","emsg":"Invalid code"}',
      JSON.stringify({ stat: "Ok", access_token: NEW_TOKEN, uid: "OTHER9" }),
      OK_BODY,
    ]) {
      const h = harness({
        env: { ...KEYS, TRADESMART_TOKEN_FILE: path.join(dir, "token-dir") },
        replies: [{ body }],
        answers: { "code or URL": `http://127.0.0.1:8080/callback?code=${CODE}` },
      });
      mkdirSync(path.join(dir, "token-dir"), { recursive: true });
      await runCli(["login", "--client-id", "TEST123", "--no-browser"], h.io);
      cases.push(h);
    }
    for (const h of cases) {
      expect(allOutput(h).length).toBeGreaterThan(0);
      for (const line of allOutput(h)) {
        for (const secret of secrets) expect(line).not.toContain(secret);
      }
    }
  });
});

describe("keys", () => {
  it("asks for missing keys without echo and saves typed keys after the token", async () => {
    const port = await freePort();
    const h = harness({
      browser: redirecting(port),
      answers: { "App key": APP, "Secret key": SECRET },
    });
    expect(await runCli(loginArgs(port), h.io)).toBe(0);
    expect(h.asked).toEqual([
      { question: "App key: ", echo: false },
      { question: "Secret key: ", echo: false },
    ]);
    const keysFile = path.join(dir, "credentials.json");
    expect(JSON.parse(readFileSync(keysFile, "utf8"))).toEqual({
      version: 1,
      clients: { TEST123: { app_key: APP, secret_key: SECRET } },
    });
    expect(h.out).toContain(
      `Saved the App Key and Secret key for TEST123 to ${keysFile} (readable only by you, not encrypted); the next login uses them.`,
    );
    expect(h.out).toContain(
      `Forget them with \`npx tradesmart logout --token-file ${arg(tokenFile)} --forget-keys --client-id TEST123\`.`,
    );
    if (posix) expect(statSync(keysFile).mode & 0o777).toBe(0o600);
    for (const line of allOutput(h)) expect(line).not.toContain(SECRET);
  });

  it("asks for the client id when neither a flag nor the environment has it", async () => {
    const port = await freePort();
    const h = harness({
      env: KEYS,
      browser: redirecting(port),
      answers: { "Client id": "TEST123" },
    });
    expect(await runCli(["login", "--token-file", tokenFile, "--port", String(port)], h.io)).toBe(
      0,
    );
    expect(h.asked[0]).toEqual({ question: "Client id: ", echo: true });
  });

  it("no client id at all exits 2", async () => {
    const h = harness({ env: KEYS });
    expect(await runCli(["login", "--token-file", tokenFile], h.io)).toBe(2);
    expect(h.err).toContain("No client id given: pass --client-id or set TRADESMART_CLIENT_ID.");
  });

  it("no app key at the prompt exits 2 saying how to give it", async () => {
    const h = harness({ env: { TRADESMART_SECRET_KEY: SECRET } });
    expect(await runCli(loginArgs(await freePort()), h.io)).toBe(2);
    expect(h.err).toContain("No app key given: pass --app-key or set TRADESMART_APP_KEY.");
  });

  it("no secret key at the prompt exits 2 naming only the environment variable", async () => {
    const h = harness({ env: { TRADESMART_APP_KEY: APP } });
    expect(await runCli(loginArgs(await freePort()), h.io)).toBe(2);
    expect(h.err).toContain("No secret key given: set TRADESMART_SECRET_KEY.");
  });

  it("a blank key exits 2", async () => {
    const h = harness({ env: { TRADESMART_SECRET_KEY: SECRET }, answers: { "App key": "   " } });
    expect(await runCli(loginArgs(await freePort()), h.io)).toBe(2);
    expect(h.err).toContain("The app key must not be empty.");
  });

  it("--app-key is saved, the environment's secret key is not", async () => {
    const port = await freePort();
    const h = harness({ env: { TRADESMART_SECRET_KEY: SECRET }, browser: redirecting(port) });
    expect(await runCli(loginArgs(port, "--app-key", APP), h.io)).toBe(0);
    expect(JSON.parse(readFileSync(path.join(dir, "credentials.json"), "utf8"))).toEqual({
      version: 1,
      clients: { TEST123: { app_key: APP } },
    });
    expect(h.out.join("\n")).toContain("Saved the App Key for TEST123 to ");
  });

  it("--no-save-keys saves nothing", async () => {
    const port = await freePort();
    const h = harness({
      browser: redirecting(port),
      answers: { "App key": APP, "Secret key": SECRET },
    });
    expect(await runCli(loginArgs(port, "--no-save-keys"), h.io)).toBe(0);
    expect(existsSync(path.join(dir, "credentials.json"))).toBe(false);
  });

  it("uses saved keys without asking and says where they came from", async () => {
    const keysFile = path.join(dir, "credentials.json");
    await saveKeys(keysFile, "TEST123", { appKey: APP, secretKey: SECRET });
    const port = await freePort();
    const h = harness({ browser: redirecting(port) });
    expect(await runCli(loginArgs(port), h.io)).toBe(0);
    expect(h.asked).toEqual([]);
    expect(h.out[0]).toBe(`Using the App Key and Secret key saved for TEST123 in ${keysFile}.`);
    expect(h.session.bodies[0]).toContain(computeChecksum(APP, SECRET, CODE));
  });

  it("a failed login with saved keys names how to forget them", async () => {
    const keysFile = path.join(dir, "credentials.json");
    await saveKeys(keysFile, "TEST123", { appKey: APP, secretKey: SECRET });
    const h = harness({
      replies: [{ body: '{"stat":"Not_Ok","emsg":"Invalid code"}' }],
      answers: { "code or URL": CODE },
    });
    expect(await runCli(loginArgs(await freePort(), "--no-browser"), h.io)).toBe(1);
    expect(h.err).toContain(
      `The keys saved for TEST123 in ${keysFile} were used. If they are wrong or were changed on the API Dashboard, forget them with \`npx tradesmart logout --token-file ${arg(tokenFile)} --forget-keys --client-id TEST123\` and log in again.`,
    );
    expect(existsSync(keysFile)).toBe(true);
  });

  it("an unusable saved-keys file exits 2 before any request and is left alone", async () => {
    const keysFile = path.join(dir, "credentials.json");
    writeFileSync(keysFile, "{not json", { mode: 0o600 });
    const h = harness({});
    expect(await runCli(loginArgs(await freePort()), h.io)).toBe(2);
    expect(h.err[0]).toMatch(
      /^Cannot log in with saved keys: .+ Remove that file with `npx tradesmart logout/,
    );
    expect(readFileSync(keysFile, "utf8")).toBe("{not json");
    expect(h.session.hits).toBe(0);
  });

  it.runIf(posix)("a credentials.json linked to another environment's keys exits 2", async () => {
    writeFileSync(path.join(dir, "uat-credentials.json"), "{}", { mode: 0o600 });
    symlinkSync(path.join(dir, "uat-credentials.json"), path.join(dir, "credentials.json"));
    const h = harness({ env: KEYS });
    expect(await runCli(loginArgs(await freePort()), h.io)).toBe(2);
    expect(h.err[0]).toMatch(/^Cannot use the saved keys: .*another environment's saved keys/);
    expect(h.session.hits).toBe(0);
  });

  it("a keys file that cannot be saved only warns and still exits 0", async () => {
    mkdirSync(path.join(dir, "credentials.json")); // a directory where the file should go
    const port = await freePort();
    const h = harness({ env: { TRADESMART_SECRET_KEY: SECRET }, browser: redirecting(port) });
    expect(await runCli(loginArgs(port, "--app-key", APP), h.io)).toBe(0);
    expect(h.err.join("\n")).toMatch(
      /The keys could not be saved to .+; the next login asks for them again\./,
    );
    expect(existsSync(tokenFile)).toBe(true);
  });
});

describe("cancelling", () => {
  it("Ctrl-C at a prompt prints Cancelled. and exits 1", async () => {
    const h = harness({ answers: { "App key": CliCancelled } });
    expect(await runCli(loginArgs(await freePort()), h.io)).toBe(1);
    expect(h.err).toEqual(["Cancelled."]);
  });

  it("an interrupt while waiting for the redirect cancels and frees the port", async () => {
    const port = await freePort();
    const controller = new AbortController();
    const h = harness({
      env: KEYS,
      interrupt: controller.signal,
      browser: () => {
        setTimeout(() => {
          controller.abort();
        }, 20);
        return true;
      },
    });
    expect(await runCli(loginArgs(port), h.io)).toBe(1);
    expect(h.err).toEqual(["Cancelled."]);
    expect(h.session.hits).toBe(0);
    const again = http.createServer();
    await new Promise<void>((resolve, reject) => {
      again.once("error", reject);
      again.listen(port, "127.0.0.1", resolve);
    });
    again.close();
  });
});

describe("token-path and logout", () => {
  it("token-path prints the file", async () => {
    const h = harness({});
    expect(await runCli(["token-path", "--token-file", tokenFile], h.io)).toBe(0);
    expect(h.out).toEqual([tokenFile]);
  });

  it("token-path without a flag follows TRADESMART_TOKEN_FILE, then the platform default", async () => {
    const withEnv = harness({ env: { TRADESMART_TOKEN_FILE: "rel/t.json" } });
    await runCli(["token-path"], withEnv.io);
    expect(withEnv.out).toEqual([path.join(dir, "rel", "t.json")]);
    const plain = harness({ env: { XDG_CONFIG_HOME: dir } });
    await runCli(["token-path"], plain.io);
    // Windows: %APPDATA% (unset here), else <home>\AppData\Roaming; elsewhere $XDG_CONFIG_HOME.
    const base = posix ? dir : path.join(dir, "AppData", "Roaming");
    expect(plain.out).toEqual([path.join(base, "tradesmart", "token.json")]);
  });

  it("logout removes the token and says so, then says there is none", async () => {
    writeFileSync(tokenFile, "{}", { mode: 0o600 });
    const h = harness({});
    expect(await runCli(["logout", "--token-file", tokenFile], h.io)).toBe(0);
    expect(h.out).toEqual([`Removed the saved login at ${tokenFile}.`]);
    expect(await runCli(["logout", "--token-file", tokenFile], h.io)).toBe(0);
    expect(h.out.at(-1)).toBe(`No saved login at ${tokenFile}.`);
  });

  it("logout keeps the saved keys unless --forget-keys is given", async () => {
    const keysFile = path.join(dir, "credentials.json");
    await saveKeys(keysFile, "TEST123", { appKey: APP, secretKey: SECRET });
    await saveKeys(keysFile, "OTHER9", { appKey: APP });
    const h = harness({});
    await runCli(["logout", "--token-file", tokenFile], h.io);
    expect(existsSync(keysFile)).toBe(true);

    const forget = ["logout", "--token-file", tokenFile, "--forget-keys"];
    expect(await runCli([...forget, "--client-id", "test123"], h.io)).toBe(0);
    expect(h.out.at(-1)).toBe(`Forgot the saved keys for test123 in ${keysFile}.`);
    expect(JSON.parse(readFileSync(keysFile, "utf8"))).toEqual({
      version: 1,
      clients: { OTHER9: { app_key: APP } },
    });
    expect(await runCli([...forget, "--client-id", "NOBODY"], h.io)).toBe(0);
    expect(h.out.at(-1)).toBe(`No saved keys for NOBODY in ${keysFile}.`);

    expect(await runCli(forget, h.io)).toBe(0);
    expect(h.out.at(-1)).toBe(
      `Forgot the saved keys of every client id (OTHER9): removed ${keysFile}.`,
    );
    expect(existsSync(keysFile)).toBe(false);
    expect(await runCli(forget, h.io)).toBe(0);
    expect(h.out.at(-1)).toBe(`No saved keys at ${keysFile}.`);
  });

  it("--forget-keys on an unreadable file removes it and says it was unreadable", async () => {
    const keysFile = path.join(dir, "credentials.json");
    writeFileSync(keysFile, "{bad", { mode: 0o600 });
    const h = harness({});
    expect(await runCli(["logout", "--token-file", tokenFile, "--forget-keys"], h.io)).toBe(0);
    expect(h.out.at(-1)).toBe(`Removed the unreadable saved keys file ${keysFile}.`);
  });

  it("forgetting one client id in an unusable file exits 1 and advises forgetting all", async () => {
    const keysFile = path.join(dir, "credentials.json");
    writeFileSync(keysFile, "{bad", { mode: 0o600 });
    const h = harness({});
    const args = ["logout", "--token-file", tokenFile, "--forget-keys", "--client-id", "TEST123"];
    expect(await runCli(args, h.io)).toBe(1);
    expect(h.err[0]).toMatch(/^Cannot forget the keys of TEST123: .+ Run `npx tradesmart logout/);
    expect(readFileSync(keysFile, "utf8")).toBe("{bad");
  });

  it("--client-id without --forget-keys, or blank, exits 2 and removes nothing", async () => {
    writeFileSync(tokenFile, "{}", { mode: 0o600 });
    const h = harness({});
    expect(
      await runCli(["logout", "--token-file", tokenFile, "--client-id", "TEST123"], h.io),
    ).toBe(2);
    const blank = ["logout", "--token-file", tokenFile, "--forget-keys", "--client-id", " "];
    expect(await runCli(blank, h.io)).toBe(2);
    expect(existsSync(tokenFile)).toBe(true);
  });

  it.runIf(posix)("a token file that cannot be removed exits 1", async () => {
    const file = path.join(dir, "a-directory");
    mkdirSync(file);
    writeFileSync(path.join(file, "inside"), "x");
    chmodSync(file, 0o700);
    const h = harness({});
    // unlink of a non-empty directory fails with EISDIR / EPERM on every POSIX system.
    expect(await runCli(["logout", "--token-file", file], h.io)).toBe(1);
    expect(h.err[0]).toMatch(/^Could not remove the saved login at /);
  });
});

describe("usage errors", () => {
  it("print the message and exit 2", async () => {
    const h = harness({});
    expect(await runCli(["login", "--port", "0"], h.io)).toBe(2);
    expect(h.err.join("\n")).toMatch(/--port/);
    expect(await runCli(["login", "--bogus"], h.io)).toBe(2);
  });

  it("--help prints usage on stdout and exits 0", async () => {
    const h = harness({});
    expect(await runCli(["--help"], h.io)).toBe(0);
    expect(h.out.join("\n")).toContain("npx tradesmart");
  });
});
