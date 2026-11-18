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
import util from "node:util";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../../src/errors.js";
import {
  _internals,
  deleteKeyFile,
  forgetKeys,
  KEY_FILE_NAME,
  KeyFileError,
  keyFilePath,
  readSavedKeys,
  type SavedKeys,
  savedClientIds,
  saveKeys,
} from "../../src/token-store/key-file.js";

const root = mkdtempSync(path.join(os.tmpdir(), "tradesmart-kf-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const posix = process.platform !== "win32";
const APP = "synthetic-app-key";
const SECRET = "synthetic-secret-key";

let dir = "";
let file = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(root, "t-"));
  file = path.join(dir, KEY_FILE_NAME);
});

function put(text: string, mode = 0o600): void {
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
}
const doc = (clients: unknown, version: unknown = 1): string =>
  JSON.stringify({ version, clients });

describe("keyFilePath", () => {
  it("is credentials.json beside the token file", () => {
    expect(KEY_FILE_NAME).toBe("credentials.json");
    expect(keyFilePath(path.join("a", "b", "token.json"))).toBe(
      path.join("a", "b", "credentials.json"),
    );
  });
});

describe("saveKeys / readSavedKeys", () => {
  it("writes the Python-shaped JSON and returns the path", async () => {
    expect(await saveKeys(file, "SYNTH01", { appKey: APP, secretKey: SECRET })).toBe(file);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 1,
      clients: { SYNTH01: { app_key: APP, secret_key: SECRET } },
    });
    const keys = await readSavedKeys(file, "SYNTH01");
    expect(keys?.appKey).toBe(APP);
    expect(keys?.secretKey).toBe(SECRET);
  });

  it("returns null with no file or no entry", async () => {
    expect(await readSavedKeys(file, "SYNTH01")).toBeNull();
    await saveKeys(file, "SYNTH01", { appKey: APP });
    expect(await readSavedKeys(file, "OTHER")).toBeNull();
  });

  it("matches client ids ignoring case and keeps a missing key null", async () => {
    await saveKeys(file, "Synth01", { appKey: APP });
    const keys = await readSavedKeys(file, " SYNTH01 ");
    expect(keys?.appKey).toBe(APP);
    expect(keys?.secretKey).toBeNull();
  });

  it("merges: other entries and the key not given are kept; a differently cased entry is replaced", async () => {
    await saveKeys(file, "OTHER", { appKey: "o", secretKey: "p" });
    await saveKeys(file, "synth01", { appKey: APP });
    await saveKeys(file, "SYNTH01", { secretKey: SECRET });
    expect((JSON.parse(readFileSync(file, "utf8")) as { clients: unknown }).clients).toEqual({
      OTHER: { app_key: "o", secret_key: "p" },
      SYNTH01: { app_key: APP, secret_key: SECRET },
    });
  });

  it("trims keys; nothing to save is a RangeError and leaves the file alone", async () => {
    await saveKeys(file, "SYNTH01", { appKey: `  ${APP} ` });
    const before = readFileSync(file);
    await expect(saveKeys(file, "SYNTH01", {})).rejects.toBeInstanceOf(RangeError);
    await expect(saveKeys(file, "SYNTH01", { appKey: "  ", secretKey: "" })).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(readFileSync(file)).toEqual(before);
    expect((await readSavedKeys(file, "SYNTH01"))?.appKey).toBe(APP);
  });

  it("lists client ids sorted", async () => {
    expect(await savedClientIds(file)).toEqual([]);
    await saveKeys(file, "b", { appKey: "x" });
    await saveKeys(file, "A", { appKey: "x" });
    expect(await savedClientIds(file)).toEqual(["A", "b"]);
  });

  it("hides the keys in toString, JSON and inspect", async () => {
    await saveKeys(file, "SYNTH01", { appKey: APP, secretKey: SECRET });
    const keys = (await readSavedKeys(file, "SYNTH01")) as SavedKeys;
    for (const text of [
      keys.toString(),
      JSON.stringify(keys),
      util.inspect(keys),
      util.format("%o", keys),
    ]) {
      expect(text).not.toContain(APP);
      expect(text).not.toContain(SECRET);
    }
    expect(keys.toString()).toContain("***");
  });

  it.skipIf(!posix)("creates a 0700 folder and a 0600 file and leaves no temp file", async () => {
    const nested = path.join(dir, "new", "folder", KEY_FILE_NAME);
    await saveKeys(nested, "SYNTH01", { appKey: APP });
    expect(statSync(path.dirname(nested)).mode & 0o777).toBe(0o700);
    expect(statSync(nested).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(nested))).toEqual([KEY_FILE_NAME]);
  });

  it("is atomic: a failed rename leaves the old file and no temp file, and rethrows", async () => {
    await saveKeys(file, "SYNTH01", { appKey: APP });
    const before = readFileSync(file);
    const boom = new Error("rename failed");
    await expect(
      saveKeys(
        file,
        "SYNTH01",
        { secretKey: SECRET },
        {
          rename: () => {
            throw boom;
          },
        },
      ),
    ).rejects.toBe(boom);
    expect(readFileSync(file)).toEqual(before);
    expect(readdirSync(dir)).toEqual([KEY_FILE_NAME]);
  });

  it("writes exactly the bytes Python's json.dumps(indent=2) writes", async () => {
    await saveKeys(file, "Z\u00e9", { appKey: "k1" });
    await saveKeys(file, "12345", { appKey: "k2", secretKey: "s2" });
    await saveKeys(file, "\u{1F600}", { secretKey: "s3" });
    await saveKeys(file, "z\u00c9", { secretKey: "s4\u007f" });
    // From json.dumps({"version": 1, "clients": {...}}, indent=2): ensure_ascii escapes (lowercase
    // hex, surrogate pairs), 2-space indent, no trailing newline, a replaced entry re-added last.
    const expected = [
      "{",
      '  "version": 1,',
      '  "clients": {',
      '    "12345": {',
      '      "app_key": "k2",',
      '      "secret_key": "s2"',
      "    },",
      String.raw`    "\ud83d\ude00": {`,
      '      "secret_key": "s3"',
      "    },",
      String.raw`    "z\u00c9": {`,
      '      "app_key": "k1",',
      String.raw`      "secret_key": "s4\u007f"`,
      "    }",
      "  }",
      "}",
    ].join("\n");
    expect(readFileSync(file, "utf8")).toBe(expected);
    expect(readFileSync(file).every((byte) => byte < 0x80)).toBe(true);
    expect(await savedClientIds(file)).toEqual(["12345", "z\u00c9", "\u{1F600}"].sort());
  });

  it("refuses, never rewrites, when the key-order scan disagrees with the parsed clients", async () => {
    put(doc({ A: { app_key: APP }, B: { secret_key: SECRET } }));
    const before = readFileSync(file);
    for (const scanned of [["A"], ["A", "B", "C"], ["A", "X"]]) {
      const spy = vi.spyOn(_internals, "clientIdOrder").mockReturnValue(scanned);
      for (const op of [
        () => readSavedKeys(file, "A"),
        () => savedClientIds(file),
        () => saveKeys(file, "A", { secretKey: "n" }),
        () => forgetKeys(file, "A"),
      ]) {
        const error = await op().then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(KeyFileError);
        const message = (error as Error).message;
        expect(message).toContain(file);
        expect(message).not.toContain(APP);
        expect(message).not.toContain(SECRET);
      }
      spy.mockRestore();
    }
    expect(readFileSync(file)).toEqual(before);
  });

  it("keeps file order on rewrite, including an integer-like id after a non-numeric one", async () => {
    put(
      '{"version": 1, "clients": {"b": {"app_key": "x"}, "12345": {"app_key": "y"}, "c": {"app_key": "z"}}}',
    );
    await saveKeys(file, "zz", { appKey: "n" });
    const order = (): string[] =>
      Object.keys((JSON.parse(readFileSync(file, "utf8")) as { clients: object }).clients);
    // JSON.parse alone would list "12345" first; the file text decides.
    expect(readFileSync(file, "utf8").indexOf('"b"')).toBeLessThan(
      readFileSync(file, "utf8").indexOf('"12345"'),
    );
    expect(readFileSync(file, "utf8").indexOf('"12345"')).toBeLessThan(
      readFileSync(file, "utf8").indexOf('"c"'),
    );
    expect(order().sort()).toEqual(["12345", "b", "c", "zz"].sort());
    await saveKeys(file, "B", { secretKey: "s" });
    const text = readFileSync(file, "utf8");
    const at = (id: string): number => text.indexOf(`"${id}"`);
    expect([at("12345"), at("c"), at("zz"), at("B")]).toEqual(
      [at("12345"), at("c"), at("zz"), at("B")].sort((a, b) => a - b),
    );
    expect(at("b")).toBe(-1);
    expect(await forgetKeys(file, "c")).toBe(true);
    const after = readFileSync(file, "utf8");
    expect(after.indexOf('"12345"')).toBeLessThan(after.indexOf('"zz"'));
    expect(after.indexOf('"zz"')).toBeLessThan(after.indexOf('"B"'));
  });

  it("reads, merges and rewrites a Python-shaped CRLF file with a differently cased id", async () => {
    const python = JSON.stringify(
      {
        version: 1,
        clients: {
          synth01: { app_key: "old-app", secret_key: "old-secret" },
          ZED: { app_key: "z-app" },
          Mid: { secret_key: "m-secret" },
        },
      },
      null,
      2,
    ).replace(/\n/g, "\r\n");
    put(python);
    expect((await readSavedKeys(file, "SYNTH01"))?.appKey).toBe("old-app");
    await saveKeys(file, "SYNTH01", { secretKey: SECRET });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 1,
      clients: {
        SYNTH01: { app_key: "old-app", secret_key: SECRET },
        ZED: { app_key: "z-app" },
        Mid: { secret_key: "m-secret" },
      },
    });
    expect(await savedClientIds(file)).toEqual(["Mid", "SYNTH01", "ZED"]);
  });
});

describe("unusable files are refused, named, never echoed and never overwritten", () => {
  const cases: Array<[string, string]> = [
    ["not JSON", `not json ${APP}`],
    [
      "deep nesting (valid JSON)",
      `{"version":1,"clients":${"[".repeat(200_000)}"${APP}"${"]".repeat(200_000)}}`,
    ],
    ["not an object", JSON.stringify([APP])],
    ["no version", JSON.stringify({ clients: {} })],
    ["another version", doc({}, 2)],
    ["version as text", doc({}, "1")],
    ["clients missing", JSON.stringify({ version: 1 })],
    ["clients not an object", doc([APP])],
    ["entry not an object", doc({ A: APP })],
    ["blank client id", doc({ " ": { app_key: APP } })],
    ["key not a string", doc({ A: { app_key: 5, secret_key: SECRET } })],
    ["blank key", doc({ A: { app_key: "  ", secret_key: SECRET } })],
    ["empty entry", doc({ A: {} })],
    ["entry of nulls", doc({ A: { app_key: null, secret_key: null } })],
  ];
  for (const [name, text] of cases) {
    it(
      name,
      async () => {
        put(text);
        const before = readFileSync(file);
        const ops: Array<() => Promise<unknown>> = [
          () => readSavedKeys(file, "A"),
          () => savedClientIds(file),
          () => saveKeys(file, "A", { appKey: "new-key" }),
          () => forgetKeys(file, "A"),
        ];
        for (const op of ops) {
          const error = await op().then(
            () => null,
            (e: unknown) => e,
          );
          expect(error).toBeInstanceOf(KeyFileError);
          expect(error).toBeInstanceOf(ConfigurationError);
          const message = (error as Error).message;
          expect(message).toContain(file);
          expect(message).not.toContain(APP);
          expect(message).not.toContain(SECRET);
        }
        expect(readFileSync(file)).toEqual(before);
      },
      60_000,
    ); // the 200 000-level nesting case can pass 5 s on a loaded machine
  }

  it("refuses bytes that are not UTF-8", async () => {
    writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00]), { mode: 0o600 });
    await expect(readSavedKeys(file, "A")).rejects.toBeInstanceOf(KeyFileError);
  });

  it("refuses a directory in place of the file", async () => {
    await expect(readSavedKeys(dir, "A")).rejects.toBeInstanceOf(KeyFileError);
  });

  it.skipIf(!posix)("refuses a file open to group or others", async () => {
    put(doc({ SYNTH01: { app_key: APP } }), 0o644);
    const before = readFileSync(file);
    await expect(readSavedKeys(file, "SYNTH01")).rejects.toThrow(/unsafe permissions/);
    await expect(saveKeys(file, "SYNTH01", { appKey: "x" })).rejects.toBeInstanceOf(KeyFileError);
    expect(readFileSync(file)).toEqual(before);
    chmodSync(file, 0o600);
    expect((await readSavedKeys(file, "SYNTH01"))?.appKey).toBe(APP);
  });

  // Only root may hand a file to another user (GitHub runners are not root; Docker is).
  it.skipIf(!posix || process.geteuid?.() !== 0)(
    "refuses a file owned by another user",
    async () => {
      put(doc({ SYNTH01: { app_key: APP } }));
      const before = readFileSync(file);
      const uid = process.geteuid?.() ?? 0;
      chownSync(file, uid + 1, statSync(file).gid);
      await expect(readSavedKeys(file, "SYNTH01")).rejects.toThrow(/owned by another user/);
      await expect(saveKeys(file, "SYNTH01", { appKey: "x" })).rejects.toBeInstanceOf(KeyFileError);
      expect(readFileSync(file)).toEqual(before);
    },
  );
});

describe("forgetKeys / deleteKeyFile", () => {
  it("returns false when nothing is saved", async () => {
    expect(await forgetKeys(file, "SYNTH01")).toBe(false);
    await saveKeys(file, "OTHER", { appKey: "x" });
    expect(await forgetKeys(file, "SYNTH01")).toBe(false);
    expect(await savedClientIds(file)).toEqual(["OTHER"]);
  });

  it("removes one entry (case ignored) and deletes the file when none is left", async () => {
    await saveKeys(file, "A", { appKey: "x" });
    await saveKeys(file, "B", { appKey: "y" });
    expect(await forgetKeys(file, "a")).toBe(true);
    expect(await savedClientIds(file)).toEqual(["B"]);
    expect(await forgetKeys(file, "B")).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("deleteKeyFile removes the file whatever it holds", async () => {
    expect(await deleteKeyFile(file)).toBe(false);
    put("garbage");
    expect(await deleteKeyFile(file)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });
});
