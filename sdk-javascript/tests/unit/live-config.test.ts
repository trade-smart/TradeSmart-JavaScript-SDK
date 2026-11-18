// The live-run decisions, asserted as decisions (no real connection, no live run):
// the network block is lifted only for TRADESMART_LIVE_TESTS=1; a live run uses one worker, in
// order, and is refused in watch mode (the counterpart of the Python SDK's `-n 0` rule).
import { describe, expect, it, vi } from "vitest";
import { liveEnabled, liveRunSettings, networkBlockEnabled } from "../setup/live-mode.js";

const LIVE = { TRADESMART_LIVE_TESTS: "1" };

describe("liveEnabled / networkBlockEnabled", () => {
  it("is live only for exactly 1", () => {
    expect(liveEnabled({ TRADESMART_LIVE_TESTS: "1" })).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes", " 1", "11"]) {
      expect(liveEnabled({ TRADESMART_LIVE_TESTS: value })).toBe(false);
    }
  });

  it("blocks the network unless live", () => {
    expect(networkBlockEnabled({})).toBe(true);
    expect(networkBlockEnabled({ TRADESMART_LIVE_TESTS: "0" })).toBe(true);
    expect(networkBlockEnabled(LIVE)).toBe(false);
  });
});

describe("liveRunSettings", () => {
  it("default run: live folders excluded, files in parallel", () => {
    const s = liveRunSettings({}, ["node", "vitest"]);
    expect(s.live).toBe(false);
    expect(s.include).toEqual(["tests/**/*.test.ts"]);
    expect(s.exclude).toEqual(expect.arrayContaining(["tests/live/**", "tests/live_orders/**"]));
    expect(s.fileParallelism).toBe(true);
    expect(s.maxWorkers).toBeUndefined();
  });

  it("default run is not refused in watch mode", () => {
    expect(() => liveRunSettings({}, ["node", "vitest", "--watch"])).not.toThrow();
  });

  it("live run: live folders included, one worker, in order", () => {
    const s = liveRunSettings(LIVE, ["node", "vitest", "run", "tests/live"]);
    expect(s.live).toBe(true);
    // Live mode selects only the live suite (Python `-m live` parity), never the mocked suite.
    expect(s.include).toEqual(["tests/live/**/*.test.ts"]);
    expect(s.exclude).toEqual(["node_modules/**", "tests/live_orders/**"]);
    expect(s.fileParallelism).toBe(false);
    expect(s.maxWorkers).toBe(1);
  });

  it("live run accepts --run and --watch=false", () => {
    expect(() => liveRunSettings(LIVE, ["node", "vitest", "--run"])).not.toThrow();
    expect(() => liveRunSettings(LIVE, ["node", "vitest", "--watch=false"])).not.toThrow();
  });

  it.each([
    [["node", "vitest"]],
    [["node", "vitest", "watch"]],
    [["node", "vitest", "--watch"]],
    [["node", "vitest", "-w"]],
    [["node", "vitest", "run", "--watch"]],
    [["node", "vitest", "tests/live"]],
  ])("live run refuses watch mode: %j", (argv) => {
    expect(() => liveRunSettings(LIVE, argv)).toThrow(/watch/i);
  });
});

describe("vitest.config.ts wiring", () => {
  // The config reads process.env / process.argv at import, so load it under an injected env and
  // restore both. A live opt-in is set only here, in memory, and no live run is started.
  interface ConfigTest {
    include?: string[];
    exclude?: string[];
    fileParallelism?: boolean;
    maxWorkers?: number;
    testTimeout?: number;
    hookTimeout?: number;
  }

  async function loadConfig(env: Record<string, string | undefined>): Promise<ConfigTest> {
    const saved = process.env["TRADESMART_LIVE_TESTS"];
    const argv = process.argv;
    try {
      if (env["TRADESMART_LIVE_TESTS"] === undefined) delete process.env["TRADESMART_LIVE_TESTS"];
      else process.env["TRADESMART_LIVE_TESTS"] = env["TRADESMART_LIVE_TESTS"];
      process.argv = ["node", "vitest", "run"];
      vi.resetModules();
      const mod = (await import("../../vitest.config.js")) as { default: { test: ConfigTest } };
      return mod.default.test;
    } finally {
      process.argv = argv;
      if (saved === undefined) delete process.env["TRADESMART_LIVE_TESTS"];
      else process.env["TRADESMART_LIVE_TESTS"] = saved;
    }
  }

  it("default env: the config uses liveRunSettings' include, exclude and parallelism", async () => {
    const expected = liveRunSettings({}, ["node", "vitest", "run"]);
    const test = await loadConfig({});
    expect(test.include).toEqual(expected.include);
    expect(test.exclude).toEqual(expected.exclude);
    expect(test.fileParallelism).toBe(expected.fileParallelism);
    expect(test.exclude).toEqual(expect.arrayContaining(["tests/live/**", "tests/live_orders/**"]));
    expect(test.maxWorkers).toBeUndefined();
  });

  it("gives each test and hook a limit that a loaded or cold machine still meets", async () => {
    // The slowest offline tests read the whole test tree, the built SDK or start a child Node
    // process: 1-3 s warm, past vitest's 5 s default on a cold or loaded machine (seen: a 5,010 ms
    // first import of dist/, a 23 s conformance file next to a coverage run).
    const test = await loadConfig({});
    expect(test.testTimeout).toBe(30_000);
    expect(test.hookTimeout).toBe(60_000);
  });

  it("TRADESMART_LIVE_TESTS=1: only the live suites, live_orders excluded, one worker", async () => {
    const expected = liveRunSettings(LIVE, ["node", "vitest", "run"]);
    const test = await loadConfig(LIVE);
    expect(test.include).toEqual(expected.include);
    expect(test.exclude).toEqual(expected.exclude);
    expect(test.fileParallelism).toBe(expected.fileParallelism);
    expect(test.maxWorkers).toBe(expected.maxWorkers);
    expect(test.include).toEqual(["tests/live/**/*.test.ts"]);
    expect(test.exclude).toContain("tests/live_orders/**");
    expect(test.fileParallelism).toBe(false);
    expect(test.maxWorkers).toBe(1);
  });
});
