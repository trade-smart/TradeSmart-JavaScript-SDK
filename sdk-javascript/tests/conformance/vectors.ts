// Loader for the shared conformance vectors in ../specifications/conformance/.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Decimal } from "decimal.js";
import { parseJsonLossless } from "../../src/lib/json.js";

export interface VectorCase {
  name: string;
  input: unknown;
  expected: unknown;
}

export interface VectorFile {
  description: string;
  source: string;
  tolerance?: { abs?: number; rel?: number };
  cases: VectorCase[];
}

const VECTOR_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../specifications/conformance",
);

/** Read one vector file by name (e.g. `"round_to_tick.json"`). Numbers come back as `JsonNumber` (exact text). */
export function loadVector(file: string): VectorFile {
  return parseJsonLossless(readFileSync(path.join(VECTOR_DIR, file), "utf8")) as VectorFile;
}

/** Decimal strings are equal as values, ignoring trailing zeros (`"1.50"` equals `"1.5"`). */
export function decimalEqual(a: string, b: string): boolean {
  return new Decimal(a).equals(new Decimal(b));
}
