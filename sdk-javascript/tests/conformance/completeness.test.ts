// Completeness of the conformance suite (sdk-behaviour.md §1.1 and §14): every Required vector has
// a test file, every skip is pinned, and every shared fixture is read by at least one test.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INEXPRESSIBLE, skipInexpressible } from "./skips.js";
import { loadVector } from "./vectors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESTS = path.resolve(HERE, "..");
const SPECS = path.resolve(HERE, "../../../specifications");

type Level = "Required" | "Recommended";

/** The `| \`file.json\` | Required |` rows of the §1.1 table of sdk-behaviour.md. */
function vectorLevels(): Map<string, Level> {
  const text = readFileSync(path.join(SPECS, "sdk-behaviour.md"), "utf8");
  const levels = new Map<string, Level>();
  for (const m of text.matchAll(/^\| `([a-z0-9_]+\.json)` \| (Required|Recommended) \|/gm)) {
    levels.set(m[1] as string, m[2] as Level);
  }
  return levels;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

const vectorFiles = readdirSync(path.join(SPECS, "conformance"))
  .filter((n) => n.endsWith(".json"))
  .sort();
const levels = vectorLevels();
const conformanceTests = readdirSync(HERE).filter((n) => n.endsWith(".test.ts"));
const stemOf = (file: string): string => file.replace(/\.json$/, "");

describe("conformance vectors", () => {
  it("the §1.1 table lists exactly the vector files on disk", () => {
    expect([...levels.keys()].sort()).toEqual(vectorFiles);
  });

  it("every Required vector has tests/conformance/<stem>.test.ts", () => {
    const missing = [...levels]
      .filter(([, level]) => level === "Required")
      .map(([file]) => stemOf(file))
      .filter((stem) => !conformanceTests.includes(`${stem}.test.ts`));
    expect(missing).toEqual([]);
  });

  it("every Recommended vector has tests/conformance/<stem>.test.ts", () => {
    const missing = [...levels]
      .filter(([, level]) => level === "Recommended")
      .map(([file]) => stemOf(file))
      .filter((stem) => !conformanceTests.includes(`${stem}.test.ts`));
    expect(missing).toEqual([]);
  });

  it("every conformance test file belongs to a vector file (or is this one)", () => {
    const stems = new Set([...levels.keys()].map(stemOf));
    const strays = conformanceTests
      .map((n) => n.replace(/\.test\.ts$/, ""))
      .filter((stem) => stem !== "completeness" && !stems.has(stem));
    expect(strays).toEqual([]);
  });
});

describe("pinned skips", () => {
  it("every INEXPRESSIBLE key names an existing case", () => {
    for (const key of Object.keys(INEXPRESSIBLE)) {
      const sep = key.indexOf(":");
      expect(sep, key).toBeGreaterThan(0);
      const file = key.slice(0, sep);
      const name = key.slice(sep + 1);
      expect(vectorFiles, key).toContain(file);
      expect(
        loadVector(file).cases.map((c) => c.name),
        key,
      ).toContain(name);
    }
  });

  it("every INEXPRESSIBLE entry has a reason", () => {
    for (const [key, reason] of Object.entries(INEXPRESSIBLE)) {
      expect(reason.trim().length, key).toBeGreaterThan(0);
    }
  });

  it("skipInexpressible refuses a name that is not listed", () => {
    expect(() => {
      skipInexpressible("config_defaults.json", "defaults");
    }).toThrow(/not listed/);
    expect(() => {
      skipInexpressible("no_such_file.json", "x");
    }).toThrow(/not listed/);
  });

  it("a conformance test skips only through skipInexpressible", () => {
    for (const name of conformanceTests) {
      if (name === "completeness.test.ts") continue;
      const source = readFileSync(path.join(HERE, name), "utf8");
      const skips = /\.skip\(|\.skipIf\(|\.todo\(|\bxit\(|\bxtest\(|\bxdescribe\(|\.runIf\(/.test(
        source,
      );
      if (skips) {
        expect(
          source.includes("skipInexpressible("),
          `${name} skips without skipInexpressible`,
        ).toBe(true);
        // Only the context skip that follows the pinned check; no it.skip / describe.skip / todo.
        expect(source, name).not.toMatch(/\b(it|test|describe)\.(skip|skipIf|todo|runIf)\(/);
        expect(source, name).not.toMatch(/\bx(it|test|describe)\(/);
      }
    }
  });

  it("only the files with a listed case call skipInexpressible", () => {
    const listedFiles = new Set(Object.keys(INEXPRESSIBLE).map((k) => k.split(":")[0]));
    for (const name of conformanceTests) {
      if (name === "completeness.test.ts") continue;
      const source = readFileSync(path.join(HERE, name), "utf8");
      if (source.includes("skipInexpressible(")) {
        expect(listedFiles.has(name.replace(/\.test\.ts$/, ".json")), name).toBe(true);
      }
    }
  });
});

describe("shared fixtures", () => {
  it("every specifications/test-fixtures/*.json is read by at least one test", () => {
    const fixtures = readdirSync(path.join(SPECS, "test-fixtures"))
      .filter((n) => n.endsWith(".json"))
      .sort();
    const self = fileURLToPath(import.meta.url);
    const sources = listFiles(TESTS)
      .filter((f) => f.endsWith(".ts") && f !== self)
      .map((f) => readFileSync(f, "utf8"));
    const unused = fixtures.filter((name) => !sources.some((s) => s.includes(`"${name}"`)));
    expect(unused, `fixtures no test reads: ${unused.join(", ")}`).toEqual([]);
  });
});
