// The live suite is read-only (sdk-behaviour §14 "Live read-only suite"): no file under
// tests/live/** may name a state-changing client method, the raw `request(` escape hatch or
// `generateSession`. The scan is deliberately crude (any mention counts, comments included), so
// a forbidden call cannot hide behind formatting, an alias or a computed key.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { liveRunSettings } from "../setup/live-mode.js";

const LIVE_DIR = path.resolve(import.meta.dirname, "..", "live");

const FORBIDDEN_METHODS = [
  "placeOrder",
  "modifyOrder",
  "cancelOrder",
  "exitOrder",
  "placeSlicedOrder",
  "placeGtt",
  "modifyGtt",
  "cancelGtt",
  "generateSession",
];

/** Every forbidden construct found in `source`, as readable labels. */
function forbiddenIn(source: string): string[] {
  const found: string[] = [];
  for (const name of FORBIDDEN_METHODS) {
    if (new RegExp(`\\b${name}\\b`).test(source)) found.push(name);
  }
  // `request(`: a call, or the method name as a quoted/computed key.
  if (/\brequest\s*\(/.test(source) || /["'`]request["'`]/.test(source)) found.push("request(");
  return found;
}

function liveFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return liveFiles(full);
    return isScannedFile(entry.name) ? [full] : [];
  });
}

/** Every source extension the live scan reads (TypeScript and JavaScript, module variants too). */
function isScannedFile(name: string): boolean {
  return /\.(ts|mts|cts|js|mjs|cjs|tsx)$/.test(name);
}

describe("scanned extensions", () => {
  it.each(["a.ts", "a.mts", "a.cts", "a.js", "a.mjs", "a.cjs", "a.tsx"])("scans %s", (name) => {
    expect(isScannedFile(name)).toBe(true);
  });
  it.each(["a.json", "a.md", "a.d.txt", "a.mtsx"])("skips %s", (name) => {
    expect(isScannedFile(name)).toBe(false);
  });
});

describe("scanner", () => {
  it.each([
    ["client.placeOrder(p)", ["placeOrder"]],
    ["await c . modifyOrder (x)", ["modifyOrder"]],
    ["c.cancelOrder(id)", ["cancelOrder"]],
    ["c.exitOrder(id)", ["exitOrder"]],
    ["c.placeSlicedOrder(p)", ["placeSlicedOrder"]],
    ["c.placeGtt(p)", ["placeGtt"]],
    ["c.modifyGtt(p)", ["modifyGtt"]],
    ["c.cancelGtt(id)", ["cancelGtt"]],
    ["c.generateSession(code)", ["generateSession"]],
    ["c.request('PlaceOrder', {})", ["request("]],
    ["c.request (\n'X')", ["request("]],
    ['c["request"]("X")', ["request("]],
    ['c["placeOrder"](p)', ["placeOrder"]],
  ])("flags %j", (source, expected) => {
    expect(forbiddenIn(source)).toEqual(expected);
  });

  it("passes the read methods and similar words", () => {
    expect(
      forbiddenIn("c.orders(); c.profile(); const request_time = 1; c.margins(); orderHistory(x)"),
    ).toEqual([]);
  });
});

describe("tests/live_orders", () => {
  // `vitest run tests/live` is a substring filter and would also pick up tests/live_orders/, so the
  // folder stays excluded from every run (vitest.config.ts). It holds only the live-order driver,
  // a program the matrix starts as a child process, never a test file.
  const ORDERS_DIR = path.resolve(LIVE_DIR, "..", "live_orders");
  const driverSource = (): string => readFileSync(path.join(ORDERS_DIR, "driver.ts"), "utf8");

  it("holds only driver.ts", () => {
    expect(existsSync(ORDERS_DIR)).toBe(true);
    expect(readdirSync(ORDERS_DIR).sort()).toEqual(["driver.ts"]);
  });

  it("is excluded from the default run and from the live run, and driver.ts is no test file", () => {
    for (const env of [{}, { TRADESMART_LIVE_TESTS: "1" }]) {
      const settings = liveRunSettings(env, ["node", "vitest", "run"]);
      expect(settings.exclude).toContain("tests/live_orders/**");
      expect(settings.include.some((pattern) => pattern.includes("live_orders"))).toBe(false);
      expect(settings.include.every((pattern) => pattern.endsWith(".test.ts"))).toBe(true);
    }
  });

  it("checks the nonce and both opt-ins before it builds a client", () => {
    const source = driverSource();
    const program = source.slice(source.indexOf("export async function runProgram"));
    const check = program.indexOf("startRefusal(env)");
    const build = program.indexOf("build(env)");
    expect(check).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(check);
    // Every client construction is inside the builder that runProgram calls only after the check.
    const builder = source.indexOf("export async function buildFromEnvironment");
    const constructions = [...source.matchAll(/TradeSmart\.fromEnv\(|new sdk\.TradeSmart\(/g)];
    expect(constructions.length).toBeGreaterThan(0);
    for (const match of constructions) expect(match.index).toBeGreaterThan(builder);
    // The nonce and the opt-ins are the ones the protocol document names.
    for (const name of [
      "TRADESMART_LIVE_DRIVER_RUN",
      "TRADESMART_LIVE_TESTS",
      "TRADESMART_LIVE_ORDER_TESTS",
    ]) {
      expect(source).toContain(name);
    }
  });

  it("names each state-changing client method once (its row of the protocol table)", () => {
    // tests/live/** is scanned above for forbidden calls; the driver is the one file that must
    // name them, so it is pinned the other way round: one call site each, none for the login.
    const source = driverSource();
    for (const method of FORBIDDEN_METHODS.filter((name) => name !== "generateSession")) {
      expect(source.match(new RegExp(`\\.${method}\\(`, "g"))?.length ?? 0).toBe(1);
    }
    expect(source).not.toContain("generateSession");
  });
});

describe("tests/live/**", () => {
  const files = liveFiles(LIVE_DIR);

  it("has the suite and the recorder", () => {
    const names = files.map((f) => path.basename(f));
    expect(names).toContain("read-only.test.ts");
    expect(names).toContain("recorder.ts");
  });

  it.each(files.map((f) => [path.relative(LIVE_DIR, f), f] as const))(
    "%s makes no state-changing call",
    (_name, file) => {
      expect(forbiddenIn(readFileSync(file, "utf8"))).toEqual([]);
    },
  );
});
