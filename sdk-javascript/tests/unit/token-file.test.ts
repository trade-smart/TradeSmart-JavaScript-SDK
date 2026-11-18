import {
  chmodSync,
  chownSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AccessToken } from "../../src/auth.js";
import {
  defaultTokenFilePath,
  formatTokenTimestamp,
  readTokenFile,
  TokenFileError,
  writeTokenFile,
} from "../../src/token-store/token-file.js";

const root = mkdtempSync(path.join(os.tmpdir(), "tradesmart-tf-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const posix = process.platform !== "win32";
const NOW = new Date("2026-11-10T04:00:00Z");
const issued = new Date("2026-11-10T03:45:30Z");

function body(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    client_id: "SYNTH01",
    access_token: "synthetic-token",
    issued_at: "2026-11-10T09:15:30+05:30",
    expires_at: "2026-11-11T06:00:00+05:30",
    ...over,
  });
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(root, "t-"));
});

function put(text: string, mode = 0o600): string {
  const file = path.join(dir, "token.json");
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
  return file;
}

describe("readTokenFile", () => {
  it("reads a well-formed file", () => {
    const login = readTokenFile(put(body()), NOW);
    expect(login.clientId).toBe("SYNTH01");
    expect(login.accessToken.accessToken.reveal()).toBe("synthetic-token");
    expect(login.accessToken.issuedAt).toEqual(issued);
  });

  it.skipIf(!posix)("accepts mode 0600 and refuses 0644", () => {
    expect(readTokenFile(put(body(), 0o600), NOW).clientId).toBe("SYNTH01");
    expect(() => readTokenFile(put(body(), 0o644), NOW)).toThrow(/unsafe permissions/);
  });

  it.skipIf(!posix)("refuses group-only and other-only access", () => {
    expect(() => readTokenFile(put(body(), 0o640), NOW)).toThrow(TokenFileError);
    expect(() => readTokenFile(put(body(), 0o604), NOW)).toThrow(TokenFileError);
  });

  // Only root may hand a file to another user (GitHub runners are not root; Docker is).
  it.skipIf(!posix || process.geteuid?.() !== 0)("refuses a file owned by another user", () => {
    const file = put(body());
    const uid = statSync(file).uid;
    chownSync(file, uid + 1, statSync(file).gid);
    expect(() => readTokenFile(file, NOW)).toThrow(/owned by another user/);
  });

  it("a missing file is a TokenFileError that says so", () => {
    try {
      readTokenFile(path.join(dir, "absent.json"), NOW);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TokenFileError);
      expect((error as TokenFileError).missing).toBe(true);
    }
  });

  it("refuses bad content without echoing it", () => {
    const secret = "synthetic-token";
    for (const text of [
      "{not json",
      "[1]",
      "null",
      body({ access_token: "  " }),
      body({ client_id: 5 }),
    ]) {
      try {
        readTokenFile(put(text), NOW);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(TokenFileError);
        expect((error as TokenFileError).missing).toBe(false);
        expect((error as Error).message).not.toContain(secret);
        expect((error as Error).message).not.toContain("not json");
      }
    }
  });

  it("refuses a file that is not valid UTF-8", () => {
    const file = path.join(dir, "token.json");
    writeFileSync(file, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), { mode: 0o600 });
    expect(() => readTokenFile(file, NOW)).toThrow(TokenFileError);
  });

  it("refuses an impossible calendar date", () => {
    expect(() => readTokenFile(put(body({ issued_at: "2026-02-30T09:15:30+05:30" })), NOW)).toThrow(
      TokenFileError,
    );
    expect(() => readTokenFile(put(body({ issued_at: "2026-13-10T09:15:30+05:30" })), NOW)).toThrow(
      TokenFileError,
    );
  });

  it("refuses an issued_at more than 5 minutes ahead of now, accepts 4", () => {
    const text = (d: Date): string => body({ issued_at: d.toISOString().replace(/\.\d+Z$/, "Z") });
    const now = new Date("2026-11-10T04:00:00Z");
    expect(() => readTokenFile(put(text(new Date(now.getTime() + 6 * 60_000))), now)).toThrow(
      /in the future/,
    );
    expect(readTokenFile(put(text(new Date(now.getTime() + 4 * 60_000))), now).clientId).toBe(
      "SYNTH01",
    );
  });
});

describe("writeTokenFile", () => {
  const login = {
    clientId: "SYNTH01",
    accessToken: AccessToken.fromResponse({ access_token: "synthetic-token" }, issued),
  };

  it("round-trips and writes the documented JSON shape", async () => {
    const file = path.join(dir, "sub", "token.json");
    await writeTokenFile(file, login);
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    expect(Object.keys(stored).sort()).toEqual([
      "access_token",
      "client_id",
      "expires_at",
      "issued_at",
    ]);
    expect(stored["issued_at"]).toBe("2026-11-10T09:15:30+05:30");
    expect(stored["expires_at"]).toBe("2026-11-11T06:00:00+05:30");
    expect(readTokenFile(file, NOW).accessToken.expiresAt).toEqual(login.accessToken.expiresAt);
  });

  it.skipIf(!posix)("creates a 0700 directory and a 0600 file", async () => {
    const file = path.join(dir, "newdir", "token.json");
    await writeTokenFile(file, login);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("replaces an existing file", async () => {
    const file = put("old");
    await writeTokenFile(file, login);
    expect(readTokenFile(file, NOW).clientId).toBe("SYNTH01");
    expect(readdirSync(dir)).toEqual(["token.json"]);
  });

  it("leaves no temp file when the rename fails, and rethrows", async () => {
    const file = path.join(dir, "token.json");
    const boom = new Error("rename failed");
    await expect(
      writeTokenFile(file, login, {
        rename: () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("formatTokenTimestamp", () => {
  it("drops fractions and writes a colon offset, never Z", () => {
    const d = new Date("2026-11-10T03:45:30.987Z");
    expect(formatTokenTimestamp(d, 330)).toBe("2026-11-10T09:15:30+05:30");
    expect(formatTokenTimestamp(d, 0)).toBe("2026-11-10T03:45:30+00:00");
    expect(formatTokenTimestamp(d, -300)).toBe("2026-11-09T22:45:30-05:00");
  });
});

describe("defaultTokenFilePath", () => {
  it("uses %APPDATA% on win32 and falls back to the roaming folder", () => {
    const home = "C:\\Users\\synth";
    expect(defaultTokenFilePath({ APPDATA: "D:\\Roam" }, "win32", home, "C:\\work")).toBe(
      "D:\\Roam\\tradesmart\\token.json",
    );
    expect(defaultTokenFilePath({}, "win32", home, "C:\\work")).toBe(
      "C:\\Users\\synth\\AppData\\Roaming\\tradesmart\\token.json",
    );
  });

  it("uses XDG_CONFIG_HOME, else ~/.config, elsewhere", () => {
    expect(defaultTokenFilePath({ XDG_CONFIG_HOME: "/x/cfg" }, "linux", "/home/u", "/w")).toBe(
      "/x/cfg/tradesmart/token.json",
    );
    expect(defaultTokenFilePath({}, "linux", "/home/u", "/w")).toBe(
      "/home/u/.config/tradesmart/token.json",
    );
    expect(defaultTokenFilePath({ XDG_CONFIG_HOME: "  " }, "darwin", "/Users/u", "/w")).toBe(
      "/Users/u/.config/tradesmart/token.json",
    );
  });

  it("TRADESMART_TOKEN_FILE wins, is stripped, expands ~ and is made absolute", () => {
    expect(
      defaultTokenFilePath({ TRADESMART_TOKEN_FILE: "~/t.json" }, "linux", "/home/u", "/w"),
    ).toBe("/home/u/t.json");
    expect(defaultTokenFilePath({ TRADESMART_TOKEN_FILE: " ~ " }, "linux", "/home/u", "/w")).toBe(
      "/home/u",
    );
    expect(
      defaultTokenFilePath({ TRADESMART_TOKEN_FILE: "rel/t.json" }, "linux", "/home/u", "/w"),
    ).toBe("/w/rel/t.json");
    expect(
      defaultTokenFilePath({ TRADESMART_TOKEN_FILE: "/abs/t.json" }, "linux", "/home/u", "/w"),
    ).toBe("/abs/t.json");
    expect(
      defaultTokenFilePath(
        { TRADESMART_TOKEN_FILE: "~\\t.json" },
        "win32",
        "C:\\Users\\s",
        "C:\\w",
      ),
    ).toBe("C:\\Users\\s\\t.json");
  });

  it("a blank TRADESMART_TOKEN_FILE counts as unset", () => {
    expect(defaultTokenFilePath({ TRADESMART_TOKEN_FILE: "   " }, "linux", "/home/u", "/w")).toBe(
      "/home/u/.config/tradesmart/token.json",
    );
  });

  it.skipIf(!posix)("does not resolve a symbolic link", () => {
    expect(
      defaultTokenFilePath({ TRADESMART_TOKEN_FILE: "/tmp/../tmp/./l.json" }, "linux", "/h", "/w"),
    ).toBe("/tmp/l.json");
  });
});
