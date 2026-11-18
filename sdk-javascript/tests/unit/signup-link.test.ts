// The "open an account" link: one tagged URL per place, in the CLI and the docs
// (the JavaScript twin of the Python SDK's signup-link tests).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { CliIo } from "../../src/cli/io.js";
import { runCli } from "../../src/cli/run.js";
import { SIGNUP_PLACES, signupUrl } from "../../src/lib/links.js";

const SDK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const PLACEMENTS: readonly (readonly [string, string])[] = [
  ["repo-root/README.md", "readme"],
  ["README.md", "registry"],
  ["docs/getting-started.md", "getting_started"],
  ["package.json", "registry_sidebar"],
];
const SIGNUP_URL_RE = /https:\/\/signup\.tradesmartonline\.in\/[^\s)"'>]*/g;

const read = (rel: string): string => readFileSync(path.join(SDK_DIR, rel), "utf8");

describe("signupUrl", () => {
  it("has the SDK tags in the documented order", () => {
    expect(signupUrl("cli")).toBe(
      "https://signup.tradesmartonline.in/?utm_source=TypeScriptSDK&utm_medium=Organic" +
        "&utm_campaign=SDK_Open_Demat&utm_content=cli&channel=Organic&platform=web",
    );
  });

  it("knows exactly the documented places", () => {
    expect([...SIGNUP_PLACES].sort()).toEqual(
      ["cli", "getting_started", "readme", "registry", "registry_sidebar"].sort(),
    );
  });

  it("rejects an unknown place, naming it", () => {
    expect(() => signupUrl("readmee")).toThrow(RangeError);
    expect(() => signupUrl("readmee")).toThrow(/readmee/);
  });
});

describe.each(PLACEMENTS)("%s", (rel, place) => {
  it("carries its tagged signup link", () => {
    expect(read(rel)).toContain(signupUrl(place));
  });

  it("has no untagged or wrongly tagged signup link", () => {
    const found = read(rel).match(SIGNUP_URL_RE) ?? [];
    expect(found.length).toBeGreaterThan(0);
    expect(new Set(found)).toEqual(new Set([signupUrl(place)]));
  });
});

describe("the login hint", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tradesmart-signup-"));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const hint = `No TradeSmart account yet? Open one at ${signupUrl("cli")}`;

  /** A CLI whose input has ended; `log` records what was shown and asked, in order. */
  function setup(env: Record<string, string> = {}) {
    const dir = mkdtempSync(path.join(root, "case-"));
    const log: string[] = [];
    const io: CliIo = {
      env,
      platform: "linux",
      home: dir,
      cwd: dir,
      stdout: (line) => log.push(`out: ${line}`),
      stderr: (line) => log.push(`err: ${line}`),
      prompt: (question) => {
        log.push(`ask: ${question}`);
        return Promise.resolve(null);
      },
      openBrowser: () => Promise.resolve(false),
      now: () => new Date(),
    };
    return { dir, tokenFile: path.join(dir, "token.json"), log, io };
  }

  it("is shown once on a first login, before the Client ID prompt", async () => {
    const t = setup();
    expect(await runCli(["login", "--no-browser", "--token-file", t.tokenFile], t.io)).toBe(2);
    expect(t.log.filter((l) => l === `out: ${hint}`)).toHaveLength(1);
    expect(t.log.indexOf(`out: ${hint}`)).toBeLessThan(
      t.log.findIndex((l) => l.startsWith("ask:")),
    );
  });

  it.each(["flag", "env", "blank_env"])(
    "is not shown when no prompt is needed (%s)",
    async (how) => {
      const t = setup(
        how === "env"
          ? { TRADESMART_CLIENT_ID: "TEST123" }
          : how === "blank_env"
            ? { TRADESMART_CLIENT_ID: "  " }
            : {},
      );
      const argv = ["login", "--no-browser", "--token-file", t.tokenFile];
      if (how === "flag") argv.push("--client-id", "TEST123");
      expect(await runCli(argv, t.io)).toBe(2);
      if (how === "blank_env") {
        expect(t.log.join("\n")).toContain("must not be empty");
      }
      expect(t.log.join("\n")).not.toContain("signup.tradesmartonline.in");
    },
  );

  it("is not shown to a returning user", async () => {
    const t = setup();
    writeFileSync(t.tokenFile, "{}", "utf8");
    expect(await runCli(["login", "--no-browser", "--token-file", t.tokenFile], t.io)).toBe(2);
    expect(t.log.some((l) => l.startsWith("ask:"))).toBe(true);
    expect(t.log.join("\n")).not.toContain("signup.tradesmartonline.in");
  });

  it("is not shown when keys are already saved", async () => {
    const t = setup();
    writeFileSync(path.join(t.dir, "credentials.json"), "{}", "utf8");
    await runCli(["login", "--no-browser", "--token-file", t.tokenFile], t.io);
    expect(t.log.join("\n")).not.toContain("signup.tradesmartonline.in");
  });
});

describe("package metadata", () => {
  it("names the repository and issue tracker beside the sign-up homepage", () => {
    const pkg = JSON.parse(read("package.json")) as Record<string, unknown>;
    expect(pkg["homepage"]).toBe(signupUrl("registry_sidebar"));
    expect(pkg["repository"]).toEqual({
      type: "git",
      url: "git+https://github.com/trade-smart/TradeSmart-JavaScript-SDK.git",
      directory: "sdk-javascript",
    });
    expect(pkg["bugs"]).toEqual({
      url: "https://github.com/trade-smart/TradeSmart-JavaScript-SDK/issues",
    });
  });
});
