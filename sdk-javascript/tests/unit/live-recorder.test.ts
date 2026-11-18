// The live recorder, with synthetic data only: ids become `*_matches` booleans, secrets are
// redacted, and the default folder is the gitignored `.live-results/`.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "../../src/index.js";
import { RESULTS_DIR, record, sanitize, shapeOf } from "../live/recorder.js";

const OWN = "SYN001";
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "rec-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("sanitize", () => {
  it("replaces id fields with *_matches booleans, never the value", () => {
    const out = sanitize(
      { client_id: OWN, user_id: "OTHER1", account_id: OWN, uid: OWN, actid: "X", stat: "Ok" },
      [OWN],
    );
    expect(out).toEqual({
      client_id_matches: true,
      user_id_matches: false,
      account_id_matches: true,
      uid_matches: true,
      actid_matches: false,
      stat: "Ok",
    });
    expect(JSON.stringify(out)).not.toContain("OTHER1");
    expect(JSON.stringify(out)).not.toContain(OWN);
  });

  it("handles camelCase model keys, nesting and arrays", () => {
    const out = sanitize({ rows: [{ clientId: OWN, userId: "Z", n: 1 }], accountId: OWN }, [OWN]);
    expect(out).toEqual({
      rows: [{ clientId_matches: true, userId_matches: false, n: 1 }],
      accountId_matches: true,
    });
  });

  it("redacts secret-valued keys and long or bearer tokens, keeps an instrument token", () => {
    const out = sanitize(
      {
        access_token: "a",
        susertoken: "b",
        secretKey: "c",
        checksum: "d",
        authorization: "Bearer zzz",
        token: "2885",
        other: { token: "x".repeat(40) },
        bearerTok: { token: "Bearer abc" },
      },
      [],
    );
    expect(out).toEqual({
      access_token: "<redacted>",
      susertoken: "<redacted>",
      secretKey: "<redacted>",
      checksum: "<redacted>",
      authorization: "<redacted>",
      token: "2885",
      other: { token: "<redacted>" },
      bearerTok: { token: "<redacted>" },
    });
  });

  it("redacts refresh token, session id, jData, jKey and key in any case or spelling", () => {
    const out = sanitize(
      { refreshToken: "a", SESSION_ID: "b", jData: "c", jKey: "d", KEY: "e", Refresh_Token: "f" },
      [],
    );
    expect(out).toEqual({
      refreshToken: "<redacted>",
      SESSION_ID: "<redacted>",
      jData: "<redacted>",
      jKey: "<redacted>",
      KEY: "<redacted>",
      Refresh_Token: "<redacted>",
    });
  });

  it("serialises Decimal and Date, drops functions", () => {
    const at = new Date("2026-01-02T03:04:05.000Z");
    expect(sanitize({ p: new Decimal("1.50"), at, f: () => 1 }, [])).toEqual({
      p: "1.5",
      at: at.toISOString(),
    });
  });

  it("does not match a blank own id", () => {
    expect(sanitize({ uid: "" }, [""])).toEqual({ uid_matches: false });
  });
});

describe("shapeOf", () => {
  it("describes types, not values", () => {
    expect(
      shapeOf({ a: "text", b: new Decimal(1), c: [1, 2], d: null, e: new Date(0), f: true }),
    ).toEqual({
      a: "string",
      b: "decimal",
      c: ["number", "length 2"],
      d: "null",
      e: "date",
      f: "boolean",
    });
  });

  it("empty array and nested objects; id keys become *_matches", () => {
    expect(shapeOf({ list: [], inner: { x: 1 } })).toEqual({
      list: ["empty"],
      inner: { x: "number" },
    });
    expect(shapeOf({ uid: "q" }, ["q"])).toEqual({ uid_matches: true });
  });
});

describe("record", () => {
  it("appends one JSON line per call to <suite>.jsonl, sanitised", () => {
    const dir = tmp();
    const file = record("readonly", "profile", { client_id: OWN, ms: 12 }, { dir, ownIds: [OWN] });
    record("readonly", "margins", { stat: "Ok" }, { dir, ownIds: [OWN] });
    expect(file).toBe(path.join(dir, "readonly.jsonl"));
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(first["test"]).toBe("profile");
    expect(first["client_id_matches"]).toBe(true);
    expect(first["ms"]).toBe(12);
    expect(typeof first["at"]).toBe("string");
    expect(lines.join("\n")).not.toContain(OWN);
  });

  it("rejects a suite name that could escape the folder", () => {
    expect(() => record("../x", "t", {}, { dir: tmp() })).toThrow(/suite/);
  });

  it("writes by default only into sdk-javascript/.live-results", () => {
    expect(RESULTS_DIR).toBe(path.resolve(import.meta.dirname, "..", "..", ".live-results"));
    expect(path.basename(path.dirname(RESULTS_DIR))).toBe("sdk-javascript");
  });
});
