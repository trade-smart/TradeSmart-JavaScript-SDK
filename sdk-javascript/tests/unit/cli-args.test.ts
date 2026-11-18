import { describe, expect, it } from "vitest";
import { parseCli } from "../../src/cli/args.js";
import { extractCode } from "../../src/cli/callback.js";

function run(...argv: string[]) {
  const result = parseCli(argv);
  if (result.kind !== "run") throw new Error(`expected a command, got ${result.kind}`);
  return result.command;
}
function usage(...argv: string[]): string {
  const result = parseCli(argv);
  if (result.kind !== "usage") throw new Error(`expected a usage error, got ${result.kind}`);
  return result.message;
}

describe("command selection", () => {
  it("login is the default with defaults for every option", () => {
    expect(run()).toEqual({
      command: "login",
      tokenFile: undefined,
      clientId: undefined,
      appKey: undefined,
      port: 8080,
      noBrowser: false,
      listenHost: "127.0.0.1",
      noSaveKeys: false,
    });
  });

  it("a first argument that is not a command means login", () => {
    expect(run("--port", "9000")).toMatchObject({ command: "login", port: 9000 });
    expect(run("--no-browser")).toMatchObject({ command: "login", noBrowser: true });
  });

  it("a stray word after the default command is a usage error", () => {
    expect(usage("whatever")).toMatch(/unexpected argument/i);
  });

  it("token-path and logout", () => {
    expect(run("token-path", "--token-file", "x.json")).toEqual({
      command: "token-path",
      tokenFile: "x.json",
    });
    expect(run("logout")).toEqual({
      command: "logout",
      tokenFile: undefined,
      forgetKeys: false,
      clientId: undefined,
    });
  });

  it("--help prints usage and is not an error", () => {
    const result = parseCli(["--help"]);
    expect(result.kind).toBe("help");
    expect(parseCli(["logout", "-h"]).kind).toBe("help");
  });

  it("an unknown option is a usage error", () => {
    expect(usage("login", "--nope")).toMatch(/--nope/);
    expect(usage("token-path", "--client-id", "X")).toMatch(/--client-id/);
  });
});

describe("login options", () => {
  it("takes the documented flags", () => {
    expect(
      run(
        "login",
        "--client-id",
        "TEST123",
        "--app-key",
        "k",
        "--port",
        "65535",
        "--listen-host",
        "0.0.0.0",
        "--no-browser",
        "--no-save-keys",
        "--token-file",
        "~/t.json",
      ),
    ).toEqual({
      command: "login",
      tokenFile: "~/t.json",
      clientId: "TEST123",
      appKey: "k",
      port: 65535,
      noBrowser: true,
      listenHost: "0.0.0.0",
      noSaveKeys: true,
    });
  });

  it.each(["0", "65536", "-1", "abc", "", "80.5"])("--port %j is refused", (port) => {
    expect(usage("login", "--port", port)).toMatch(/--port/);
  });

  it("--port 1 is accepted", () => {
    expect(run("login", "--port", "1")).toMatchObject({ port: 1 });
  });

  it.each(["::1", "[::1]", "fe80::1", "localhost", "example.com", "127.1", "010.0.0.1", ""])(
    "--listen-host %j is refused as not an IPv4 address",
    (host) => {
      expect(usage("login", "--listen-host", host)).toMatch(/accepts IPv4 addresses only/);
    },
  );
});

describe("logout options", () => {
  it("--forget-keys with and without --client-id", () => {
    expect(run("logout", "--forget-keys")).toMatchObject({ forgetKeys: true, clientId: undefined });
    expect(run("logout", "--forget-keys", "--client-id", "TEST123")).toMatchObject({
      forgetKeys: true,
      clientId: "TEST123",
    });
  });

  it("--client-id needs --forget-keys", () => {
    expect(usage("logout", "--client-id", "TEST123")).toMatch(/only with --forget-keys/);
  });

  it("a blank --client-id is refused so it can never forget every id", () => {
    expect(usage("logout", "--forget-keys", "--client-id", "   ")).toMatch(/must not be blank/);
    expect(usage("logout", "--forget-keys", "--client-id", "")).toMatch(/must not be blank/);
  });
});

describe("extractCode", () => {
  it.each([
    ["abc123", "abc123"],
    ["  abc123  ", "abc123"],
    ["http://127.0.0.1:8080/callback?code=abc123", "abc123"],
    ["http://127.0.0.1:8080/callback?code=abc123&state=x", "abc123"],
    ["/callback?code=abc123", "abc123"],
    ["?code=abc123", "abc123"],
    ["code=abc123", "abc123"],
    ["http://127.0.0.1:8080/callback?code=a%2Bb", "a+b"],
  ])("%j gives %j", (text, code) => {
    expect(extractCode(text)).toBe(code);
  });

  it.each(["", "   ", "http://127.0.0.1:8080/callback", "http://x/callback?code=", "?other=1"])(
    "%j gives nothing",
    (text) => {
      expect(extractCode(text)).toBeNull();
    },
  );
});
