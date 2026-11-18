import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AccessToken } from "../../src/auth.js";
import { resolveFromEnv } from "../../src/env.js";
import { AuthenticationError, ConfigurationError } from "../../src/errors.js";

const root = mkdtempSync(path.join(os.tmpdir(), "tradesmart-env-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const NOW = new Date("2026-11-10T04:00:00Z"); // 09:30 IST
let file = "";
beforeEach(() => {
  file = path.join(mkdtempSync(path.join(root, "e-")), "token.json");
});

function save(over: Record<string, unknown> = {}): void {
  writeFileSync(
    file,
    JSON.stringify({
      client_id: "ABC123",
      access_token: "saved-synthetic-token",
      issued_at: "2026-11-10T09:15:30+05:30",
      expires_at: "2026-11-11T06:00:00+05:30",
      ...over,
    }),
  );
  chmodSync(file, 0o600);
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { TRADESMART_TOKEN_FILE: file, ...extra };
}

const client = { kind: "client", now: NOW } as const;

describe("resolveFromEnv", () => {
  it("env client id and token win; no saved login is needed", () => {
    const r = resolveFromEnv(
      env({ TRADESMART_CLIENT_ID: "XYZ", TRADESMART_ACCESS_TOKEN: "tok\n" }),
      client,
    );
    expect(r.clientId).toBe("XYZ");
    expect(r.token).toBe("tok");
    expect(r.tokenFile).toBe(file);
    expect(r.missingTokenReason).toBeNull();
  });

  it("a token without a client id is a ConfigurationError, even with a saved login", () => {
    save();
    expect(() => resolveFromEnv(env({ TRADESMART_ACCESS_TOKEN: "tok" }), client)).toThrow(
      ConfigurationError,
    );
  });

  it("uses the saved login's client id and token when nothing is set", () => {
    save();
    const r = resolveFromEnv(env(), client);
    expect(r.clientId).toBe("ABC123");
    expect(r.token).toBeInstanceOf(AccessToken);
    expect((r.token as AccessToken).accessToken.reveal()).toBe("saved-synthetic-token");
  });

  it("uses the saved login when the client ids match case-insensitively, after trimming", () => {
    save();
    const r = resolveFromEnv(env({ TRADESMART_CLIENT_ID: " abc123 " }), client);
    expect(r.clientId).toBe("abc123");
    expect(r.token).toBeInstanceOf(AccessToken);
  });

  it("an env token beats the saved login", () => {
    save();
    const r = resolveFromEnv(
      env({ TRADESMART_CLIENT_ID: "ABC123", TRADESMART_ACCESS_TOKEN: "envtok" }),
      client,
    );
    expect(r.token).toBe("envtok");
  });

  it("a blank variable counts as unset", () => {
    save();
    const r = resolveFromEnv(
      env({ TRADESMART_CLIENT_ID: "  ", TRADESMART_ACCESS_TOKEN: " \n" }),
      client,
    );
    expect(r.clientId).toBe("ABC123");
    expect(r.token).toBeInstanceOf(AccessToken);
  });

  it("no client id and no saved login is a ConfigurationError naming the login command", () => {
    expect(() => resolveFromEnv(env(), client)).toThrow(/TRADESMART_CLIENT_ID is not set/);
    expect(() => resolveFromEnv(env(), client)).toThrow(/login/);
  });

  it("a different client id does not use the saved login", () => {
    save();
    expect(() => resolveFromEnv(env({ TRADESMART_CLIENT_ID: "OTHER" }), client)).toThrow(
      /different client id/,
    );
  });

  it("an expired saved login without an app key is an AuthenticationError", () => {
    save();
    const later = new Date("2026-11-11T01:00:00Z"); // 06:30 IST next day
    expect(() => resolveFromEnv(env(), { kind: "client", now: later })).toThrow(
      AuthenticationError,
    );
  });

  it("an expired saved login with an app key gives a token-less client and the reason", () => {
    save();
    const later = new Date("2026-11-11T01:00:00Z");
    const r = resolveFromEnv(env({ TRADESMART_APP_KEY: "APP", TRADESMART_SECRET_KEY: "SEC" }), {
      kind: "client",
      now: later,
    });
    expect(r.token).toBeNull();
    expect(r.appKey).toBe("APP");
    expect(r.secretKey).toBe("SEC");
    expect(r.missingTokenReason).toMatch(/expired/);
  });

  it("checkTokenExpiry false keeps an expired saved login", () => {
    save();
    const later = new Date("2026-11-11T01:00:00Z");
    const r = resolveFromEnv(env(), { kind: "client", now: later, checkTokenExpiry: false });
    expect(r.token).toBeInstanceOf(AccessToken);
  });

  it("no token and no app key is a ConfigurationError (nothing saved)", () => {
    expect(() => resolveFromEnv(env({ TRADESMART_CLIENT_ID: "ABC123" }), client)).toThrow(
      ConfigurationError,
    );
  });

  it("an unusable token file is the reason, never its content", () => {
    writeFileSync(file, "garbage-secret-content", { mode: 0o600 });
    try {
      resolveFromEnv(env({ TRADESMART_CLIENT_ID: "ABC123" }), client);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/not valid JSON/);
      expect((error as Error).message).not.toContain("garbage-secret-content");
    }
  });

  it("a stream ignores TRADESMART_APP_KEY", () => {
    const r = resolveFromEnv(
      env({
        TRADESMART_CLIENT_ID: "XYZ",
        TRADESMART_ACCESS_TOKEN: "tok",
        TRADESMART_APP_KEY: "APP",
        TRADESMART_SECRET_KEY: "SEC",
      }),
      { kind: "stream", now: NOW },
    );
    expect(r.appKey).toBeNull();
    expect(r.secretKey).toBeNull();
    expect(r.token).toBe("tok");
  });

  it("a stream without a token and only an app key still fails", () => {
    expect(() =>
      resolveFromEnv(env({ TRADESMART_CLIENT_ID: "XYZ", TRADESMART_APP_KEY: "APP" }), {
        kind: "stream",
        now: NOW,
      }),
    ).toThrow(ConfigurationError);
  });

  it("TRADESMART_TOKEN_FILE selects the file; default path otherwise", () => {
    const r = resolveFromEnv(
      { TRADESMART_CLIENT_ID: "X", TRADESMART_ACCESS_TOKEN: "t", XDG_CONFIG_HOME: "/cfg" },
      { kind: "client", platform: "linux", now: NOW },
    );
    expect(r.tokenFile).toBe("/cfg/tradesmart/token.json");
  });
});
