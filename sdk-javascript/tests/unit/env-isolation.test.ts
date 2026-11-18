import { describe, expect, it } from "vitest";
import { isolateEnv } from "../setup/env-isolation.js";

describe("isolateEnv", () => {
  it("default run: drops TRADESMART_* and sets the token file", () => {
    const env: NodeJS.ProcessEnv = {
      TRADESMART_CLIENT_ID: "x",
      TRADESMART_TOKEN_FILE: "/real/token.json",
      PATH: "/bin",
    };
    expect(isolateEnv(env, "/tmp/iso")).toBe(true);
    expect(Object.keys(env).sort()).toEqual(["PATH", "TRADESMART_TOKEN_FILE"]);
    expect(env["TRADESMART_TOKEN_FILE"]).toMatch(/iso[\\/]token\.json$/);
  });

  it("live run: leaves every variable, including the token file, untouched", () => {
    const env: NodeJS.ProcessEnv = {
      TRADESMART_LIVE_TESTS: "1",
      TRADESMART_CLIENT_ID: "x",
      TRADESMART_TOKEN_FILE: "/real/token.json",
    };
    const before = { ...env };
    expect(isolateEnv(env, "/tmp/iso")).toBe(false);
    expect(env).toEqual(before);
  });

  it("live run without a token file does not invent one", () => {
    const env: NodeJS.ProcessEnv = { TRADESMART_LIVE_TESTS: "1" };
    isolateEnv(env, "/tmp/iso");
    expect(env["TRADESMART_TOKEN_FILE"]).toBeUndefined();
  });
});
