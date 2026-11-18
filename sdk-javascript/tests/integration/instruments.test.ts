// instruments() / downloadInstruments() and the parsed-row cache against an in-memory transport
// (sdk-behaviour.md §8, §3.1, §13, §2.3). Every file lives in a private temp folder.
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APIError,
  AuthenticationError,
  ConfigurationError,
  NotFoundError,
  RateLimitError,
  ResponseParseError,
  ServerError,
} from "../../src/errors.js";
import { defaultInstrumentsDir } from "../../src/instruments/download.js";
import { getParsedRows } from "../../src/instruments/cache.js";
import { VERSION } from "../../src/version.js";
import {
  NSE_TEXT,
  scriptMasterClient,
  zipOf,
  type SmReply,
  type SmScripted,
} from "../helpers/script-master-client.js";

const open: SmScripted[] = [];
const temps: string[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.cleanup();
  while (temps.length > 0) rmSync(temps.pop() ?? "", { recursive: true, force: true });
});

function sm(replies: readonly SmReply[], options: Parameters<typeof scriptMasterClient>[1] = {}) {
  const s = scriptMasterClient(replies, options);
  open.push(s);
  return s;
}
const okZip = (text = NSE_TEXT): SmReply => ({
  body: zipOf({ "NSE_symbols.txt": text }),
  headers: { "last-modified": "Tue, 10 Nov 2026 01:30:00 GMT" },
});
const reject = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};

describe("download and parse", () => {
  it("downloads, extracts and parses a zip", async () => {
    const s = sm([okZip()]);
    const rows = await s.client.instruments("NSE");
    expect(rows).toEqual([
      {
        "": "",
        Exchange: "NSE",
        Token: "22",
        LotSize: "1",
        Symbol: "ACC",
        TradingSymbol: "ACC-EQ",
        Instrument: "EQ",
        TickSize: "0.05",
      },
    ]);
    expect(readFileSync(s.file, "utf8")).toBe(NSE_TEXT);
    expect(readdirSync(s.dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("sends a GET with the SDK User-Agent and no Authorization", async () => {
    const s = sm([okZip()]);
    await s.client.downloadInstruments("nse");
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]?.path).toBe("/NSE_symbols.txt.zip");
    expect(s.requests[0]?.headers["user-agent"]).toBe(`tradesmart-javascript/${VERSION}`);
    expect(s.requests[0]?.headers["authorization"]).toBeUndefined();
  });

  it("returns a fresh list on every call", async () => {
    const s = sm([okZip()]);
    const a = await s.client.instruments("NSE");
    const b = await s.client.instruments("NSE");
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    expect(s.requests).toHaveLength(1); // the second call used the fresh file
  });

  it("prefers the member named like the exchange, else the first .txt, matching case-insensitively", async () => {
    const a = sm([{ body: zipOf({ "README.TXT": "X\n1\n", "dir/nse_SYMBOLS.Txt": NSE_TEXT }) }]);
    expect(readFileSync(await a.client.downloadInstruments("NSE"), "utf8")).toBe(NSE_TEXT);
    const b = sm([{ body: zipOf({ "other.txt": "A\n1\n" }) }]);
    expect(readFileSync(await b.client.downloadInstruments("NSE"), "utf8")).toBe("A\n1\n");
  });

  it("never uses a member path for writing", async () => {
    const s = sm([{ body: zipOf({ "../../evil.txt": "A\n1\n" }) }]);
    const written = await s.client.downloadInstruments("NSE");
    expect(written).toBe(s.file);
    expect(readdirSync(s.dir).sort()).toEqual(["NSE_symbols.txt", "NSE_symbols.txt.checked"]);
  });

  it("a zip without a .txt member or a body that is not a zip is a ResponseParseError", async () => {
    const none = sm([{ body: zipOf({ "a.csv": "x" }) }]);
    expect(await reject(none.client.downloadInstruments("NSE"))).toBeInstanceOf(ResponseParseError);
    const bad = sm([{ body: "this is not a zip" }]);
    expect(await reject(bad.client.downloadInstruments("NSE"))).toBeInstanceOf(ResponseParseError);
    expect(existsSync(bad.file)).toBe(false);
  });

  it("sets the file time to Last-Modified, never later than now", async () => {
    const past = sm([okZip()]);
    past.ctx.now = () => new Date("2026-11-10T10:00:00+05:30");
    await past.client.downloadInstruments("NSE");
    expect(statSync(past.file).mtimeMs).toBe(Date.parse("2026-11-10T01:30:00Z"));

    const future = sm([
      {
        body: zipOf({ "NSE_symbols.txt": NSE_TEXT }),
        headers: { "last-modified": "Wed, 11 Nov 2026 01:30:00 GMT" },
      },
    ]);
    future.ctx.now = () => new Date("2026-11-10T10:00:00+05:30");
    await future.client.downloadInstruments("NSE");
    expect(statSync(future.file).mtimeMs).toBeLessThanOrEqual(Date.parse("2026-11-10T04:30:00Z"));
  });

  it("creates the destination folder when needed", async () => {
    const s = sm([okZip()]);
    const dest = path.join(s.dir, "a", "b");
    expect(await s.client.downloadInstruments("NSE", { destDir: dest })).toBe(
      path.join(dest, "NSE_symbols.txt"),
    );
  });
});

describe("redirects and errors", () => {
  it("does not follow a redirect: a ResponseParseError after one request", async () => {
    const s = sm([{ status: 302, headers: { location: "https://elsewhere.example.test/x" } }]);
    const e = await reject(s.client.downloadInstruments("NSE"));
    expect(e).toBeInstanceOf(ResponseParseError);
    expect((e as Error).message).toContain("redirected");
    expect(s.requests).toHaveLength(1);
    expect(existsSync(s.file)).toBe(false);
  });

  it("maps the HTTP status like a REST read", async () => {
    const cases: [number, new (...a: never[]) => Error][] = [
      [401, AuthenticationError],
      [403, AuthenticationError],
      [404, NotFoundError],
      [429, RateLimitError],
      [500, ServerError],
      [418, APIError],
    ];
    for (const [status, type] of cases) {
      const s = sm([{ status }]);
      expect(await reject(s.client.downloadInstruments("NSE"))).toBeInstanceOf(type);
    }
  });

  it("downloads are not retried", async () => {
    const s = sm([{ status: 503 }, okZip()]);
    await reject(s.client.downloadInstruments("NSE"));
    expect(s.requests).toHaveLength(1);
  });

  it("redacts the error body first and cuts it to 500: a secret straddling the cut stays masked", async () => {
    const secret = "TOPSECRETVALUEABCDEFGHIJ";
    const body = `${"x".repeat(470)} {"access_token": "${secret}", "n": "${"y".repeat(100)}"}`;
    const s = sm([{ status: 404, body }]);
    const e = (await reject(s.client.downloadInstruments("NSE"))) as APIError;
    const raw = e.raw as string;
    expect(raw.length).toBeLessThanOrEqual(500);
    expect(raw).toContain("***");
    expect(raw).not.toContain("TOPSECRET");
    expect(raw).not.toContain("SECRETVALUE");
  });
});

describe("arguments", () => {
  it("an unknown exchange is a RangeError naming the parameter, not the value; nothing is downloaded", async () => {
    const s = sm([okZip()]);
    for (const call of [
      () => s.client.instruments("XYZ-SENTINEL"),
      () => s.client.downloadInstruments("XYZ-SENTINEL"),
      () => s.client.downloadInstruments(42 as unknown as string),
    ]) {
      const e = await reject(call());
      expect(e).toBeInstanceOf(RangeError);
      expect((e as Error).message).toContain("exchange");
      expect((e as Error).message).not.toContain("SENTINEL");
    }
    expect(s.requests).toHaveLength(0);
  });

  it("a closed client rejects with ConfigurationError", async () => {
    const s = sm([okZip()]);
    await s.client.close();
    expect(await reject(s.client.downloadInstruments("NSE"))).toBeInstanceOf(ConfigurationError);
    expect(s.requests).toHaveLength(0);
  });

  it("an abort before the send rejects with the reason and sends nothing", async () => {
    const s = sm([okZip()]);
    const reason = new Error("stop");
    const ac = new AbortController();
    ac.abort(reason);
    expect(await reject(s.client.downloadInstruments("NSE", { signal: ac.signal }))).toBe(reason);
    expect(await reject(s.client.instruments("NSE", { signal: ac.signal }))).toBe(reason);
    expect(s.requests).toHaveLength(0);
  });

  it("destDir wins over instrumentsDir, and a leading ~ is expanded", async () => {
    const s = sm([okZip()]);
    const home = mkdtempSync(path.join(tmpdir(), "tradesmart-home-"));
    temps.push(home);
    s.ctx.home = () => home;
    const written = await s.client.downloadInstruments("NSE", { destDir: "~/sub" });
    expect(written).toBe(path.join(home, "sub", "NSE_symbols.txt"));
    expect(existsSync(s.file)).toBe(false);
  });

  it("without destDir or instrumentsDir the user cache folder is used", async () => {
    const s = sm([okZip()], { noInstrumentsDir: true });
    const home = mkdtempSync(path.join(tmpdir(), "tradesmart-home-"));
    temps.push(home);
    s.ctx.home = () => home;
    s.ctx.env = {};
    s.ctx.platform = "linux";
    const written = await s.client.downloadInstruments("NSE");
    expect(written).toBe(path.join(home, ".cache", "tradesmart", "NSE_symbols.txt"));
    expect(existsSync(written)).toBe(true);
  });
});

describe("defaultInstrumentsDir", () => {
  it("Linux and macOS: XDG_CACHE_HOME, else ~/.cache", () => {
    expect(defaultInstrumentsDir({ XDG_CACHE_HOME: "/x/cache" }, "linux", "/home/u")).toBe(
      "/x/cache/tradesmart",
    );
    expect(defaultInstrumentsDir({}, "linux", "/home/u")).toBe("/home/u/.cache/tradesmart");
    expect(defaultInstrumentsDir({ XDG_CACHE_HOME: "" }, "darwin", "/Users/u")).toBe(
      "/Users/u/.cache/tradesmart",
    );
    expect(defaultInstrumentsDir({ XDG_CACHE_HOME: "relative" }, "linux", "/home/u")).toBe(
      "/home/u/.cache/tradesmart",
    );
  });

  it("Windows: %LOCALAPPDATA%\\tradesmart\\Cache, else under the home folder", () => {
    expect(
      defaultInstrumentsDir(
        { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
        "win32",
        "C:\\Users\\u",
      ),
    ).toBe("C:\\Users\\u\\AppData\\Local\\tradesmart\\Cache");
    expect(defaultInstrumentsDir({}, "win32", "C:\\Users\\u")).toBe(
      "C:\\Users\\u\\AppData\\Local\\tradesmart\\Cache",
    );
  });
});

describe("reading the file", () => {
  it("downloads once more when the file vanished before the read, and fails when it vanishes again", async () => {
    const s = sm([okZip()]);
    // Removed behind the SDK's back between the download and the read, the first time only.
    let calls = 0;
    s.ctx.afterDownload = (p) => {
      calls += 1;
      if (calls === 1) rmSync(p, { force: true });
    };
    const rows = await s.client.instruments("NSE");
    expect(rows).toHaveLength(1);
    expect(calls).toBe(2);
    expect(s.requests).toHaveLength(2);

    const t = sm([okZip()]);
    t.ctx.afterDownload = (p) => {
      rmSync(p, { force: true });
    };
    const e = await reject(t.client.instruments("NSE"));
    expect(e).toBeInstanceOf(ResponseParseError);
    expect((e as Error).message).toContain("was removed before it could be read");
    expect((e as Error).message).toContain("NSE_symbols.txt");
  });

  it("a cached file that is not UTF-8 text is a ResponseParseError (no raw decoding error)", async () => {
    const s = sm([okZip()]);
    writeFileSync(s.file, Buffer.from([0x45, 0x0a, 0xff, 0x0a]));
    const e = await reject(s.client.instruments("NSE"));
    expect(e).toBeInstanceOf(ResponseParseError);
    expect((e as Error).message).toContain("is not valid UTF-8 text");
    expect(s.requests).toHaveLength(0);
  });
});

describe("parsed-row cache (§8.4)", () => {
  it("parses once per file version, concurrent callers share one parse, a refreshed file is parsed again", async () => {
    const s = sm([okZip()]);
    await s.client.downloadInstruments("NSE");
    const [a, b] = await Promise.all([getParsedRows(s.ctx, "NSE"), getParsedRows(s.ctx, "NSE")]);
    expect(a).toBe(b);
    expect(await getParsedRows(s.ctx, "nse")).toBe(a);
    expect(s.requests).toHaveLength(1);

    // A new file version (other mtime) gives a new parse.
    writeFileSync(s.file, "Exchange,Token\nNSE,99\n");
    const later = new Date(Date.now() + 5_000);
    utimesSync(s.file, later, later);
    s.ctx.now = () => new Date(later.getTime() + 1_000);
    const c = await getParsedRows(s.ctx, "NSE");
    expect(c).not.toBe(a);
    expect(c).toEqual([{ Exchange: "NSE", Token: "99" }]);
  });

  it("a failed parse reaches the caller and is retried by the next call", async () => {
    const s = sm([okZip()]);
    writeFileSync(s.file, Buffer.from([0xff, 0xfe, 0x0a]));
    expect(await reject(getParsedRows(s.ctx, "NSE"))).toBeInstanceOf(ResponseParseError);
    writeFileSync(s.file, NSE_TEXT);
    expect(await getParsedRows(s.ctx, "NSE")).toHaveLength(1);
  });

  it("an unknown exchange is a RangeError", async () => {
    const s = sm([okZip()]);
    expect(await reject(getParsedRows(s.ctx, "NOPE"))).toBeInstanceOf(RangeError);
  });
});
