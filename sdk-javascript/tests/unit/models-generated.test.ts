import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { generate } from "../../scripts/gen-models.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODELS_JSON = path.resolve(HERE, "../../../specifications/models.json");
const GENERATED_DIR = path.resolve(HERE, "../../src/models/generated");
const HEADER = "GENERATED from specifications/models.json by scripts/gen-models.ts — do not edit";

// Generation runs prettier over every file (about a second, several under coverage load), so it is
// done once here, with a generous timeout, instead of inside each test's default 5 s.
const SLOW = 60_000;
let first: Map<string, string>;
let second: Map<string, string>;
beforeAll(async () => {
  const text = readFileSync(MODELS_JSON, "utf8");
  first = await generate(text);
  second = await generate(text);
}, SLOW);

describe("gen-models", () => {
  it("produces exactly the committed files (fails when stale)", () => {
    const files = first;
    const onDisk = readdirSync(GENERATED_DIR).sort();
    expect([...files.keys()].sort()).toEqual(onDisk);
    for (const [name, content] of files) {
      expect(content, name).toBe(readFileSync(path.join(GENERATED_DIR, name), "utf8"));
    }
  });

  it("writes one file per group plus enums.ts and index.ts, each with the header", () => {
    const files = first;
    for (const name of ["auth.ts", "user.ts", "portfolio.ts", "orders.ts", "gtt.ts", "market.ts"]) {
      expect(files.has(name), name).toBe(true);
    }
    for (const name of ["stream.ts", "enums.ts", "index.ts", "greeks.ts", "analytics.ts"]) {
      expect(files.has(name), name).toBe(true);
    }
    for (const [name, content] of files) {
      expect(content.startsWith(`// ${HEADER}`), name).toBe(true);
    }
  });

  it("is deterministic", () => {
    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  it("parses the fields of a nested record strictly; the parent's field stays lenient", () => {
    // sdk-behaviour.md 2.9: a nested record that fails to parse is null as a whole, so a field
    // of a model another model nests (OcoLegRow, OcoTrigger) must throw, not null itself.
    const gtt = first.get("gtt.ts") ?? "";
    for (const nested of ["OcoTriggerSpec", "OcoLegRowSpec"]) {
      const start = gtt.indexOf(`export const ${nested}: ModelSpec`);
      expect(start, nested).toBeGreaterThanOrEqual(0);
      const body = gtt.slice(start, gtt.indexOf("};", start));
      expect(body, nested).not.toContain("lenient: true");
    }
    expect(gtt).toMatch(/name: "ocoFirst",[^}]*lenient: true/);
    expect(gtt).toMatch(/name: "ocoTriggers",[^}]*lenient: true/);
  });

  it(
    "rejects a type outside the closed vocabulary",
    async () => {
      const spec = JSON.parse(readFileSync(MODELS_JSON, "utf8")) as {
        models: { fields: { type: string }[] }[];
      };
      const field = spec.models[0]?.fields[0];
      if (field === undefined) throw new Error("models.json has no fields");
      field.type = "Mystery";
      await expect(generate(JSON.stringify(spec))).rejects.toThrow(/Mystery/);
    },
    SLOW,
  );
});
