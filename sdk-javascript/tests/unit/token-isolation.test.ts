import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("saved-login isolation", () => {
  it("points TRADESMART_TOKEN_FILE into an empty temp folder", () => {
    const file = process.env["TRADESMART_TOKEN_FILE"];
    expect(file).toBeDefined();
    const dir = path.dirname(file as string);
    expect(path.relative(os.tmpdir(), dir).startsWith("..")).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("clears every other TRADESMART_* variable", () => {
    const others = Object.keys(process.env).filter(
      (k) => k.startsWith("TRADESMART_") && k !== "TRADESMART_TOKEN_FILE",
    );
    expect(others).toEqual([]);
  });
});
