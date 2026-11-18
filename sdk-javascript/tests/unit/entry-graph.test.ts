// The main entry must stay light: importing "tradesmart" never loads the login CLI or
// node:readline (phase-2 global constraint). The static import graph from src/index.ts is walked.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\bimport\s+)["']([^"']+)["']/g;

/** Every module reachable from `entry` through relative imports, with the bare specifiers seen. */
function walk(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1] as string;
      if (specifier.startsWith(".")) {
        queue.push(path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts")));
      } else bare.add(specifier);
    }
  }
  return { files, bare };
}

describe("the main entry's import graph", () => {
  const { files, bare } = walk(path.join(SRC, "index.ts"));

  it("walks the real module graph", () => {
    expect(files.size).toBeGreaterThan(30);
    expect(files.has(path.join(SRC, "client.ts"))).toBe(true);
  });

  it("never reaches src/cli", () => {
    const cli = [...files].filter((f) => f.startsWith(path.join(SRC, "cli") + path.sep));
    expect(cli).toEqual([]);
  });

  it("never reaches src/testing", () => {
    const testing = [...files].filter((f) => f.startsWith(path.join(SRC, "testing") + path.sep));
    expect(testing).toEqual([]);
  });

  it("the walker does see the offline broker from its own entry", () => {
    const graph = walk(path.join(SRC, "testing", "index.ts"));
    expect(graph.files.has(path.join(SRC, "testing", "rest.ts"))).toBe(true);
    expect(graph.files.has(path.join(SRC, "client.ts"))).toBe(true);
  });

  it("never reaches node:readline", () => {
    expect([...bare].filter((s) => s === "node:readline" || s === "readline")).toEqual([]);
  });

  it("the walker does see the CLI from its own entry (the check can fail)", () => {
    const graph = walk(path.join(SRC, "cli", "main.ts"));
    expect(graph.bare.has("node:readline")).toBe(true);
  });
});
