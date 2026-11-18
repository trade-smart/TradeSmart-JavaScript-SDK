// Records what a live run observed (response shapes, latencies) as JSON lines in the gitignored
// `sdk-javascript/.live-results/`. Account ids never reach the file: an id field becomes a
// `<key>_matches` boolean (does it equal this run's own id?), and secret-valued keys are
// redacted. Local only; never public. Nothing here touches the network.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Decimal } from "../../src/index.js";

export const RESULTS_DIR = path.resolve(import.meta.dirname, "..", "..", ".live-results");

// Compared after lower-casing and removing `_`, so `client_id` and `clientId` are both ids.
const ID_KEYS = new Set(["clientid", "userid", "accountid", "uid", "actid"]);
const SECRET_KEYS = new Set([
  "accesstoken",
  "susertoken",
  "secret",
  "secretkey",
  "apikey",
  "appkey",
  "checksum",
  "code",
  "authcode",
  "authorization",
  "password",
  "refreshtoken",
  "sessionid",
  "jdata",
  "jkey",
  "key",
]);
const LONG_VALUE = 24;
const REDACTED = "<redacted>";

function norm(key: string): string {
  return key.toLowerCase().replaceAll("_", "");
}

function isSecret(key: string, value: unknown): boolean {
  const k = norm(key);
  if (SECRET_KEYS.has(k)) return true;
  // A bare `token` is usually an instrument token (the script-master column): redact it only when
  // the value looks secret.
  return (
    k === "token" &&
    typeof value === "string" &&
    (value.length >= LONG_VALUE || value.toLowerCase().startsWith("bearer "))
  );
}

function matchesOwn(value: unknown, ownIds: readonly string[]): boolean {
  return typeof value === "string" && value !== "" && ownIds.includes(value);
}

/** A copy of `value` safe to write: ids as `*_matches`, secrets redacted, Decimal/Date as text. */
export function sanitize(value: unknown, ownIds: readonly string[] = []): unknown {
  if (value instanceof Decimal) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => sanitize(v, ownIds));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (ID_KEYS.has(norm(key))) out[`${key}_matches`] = matchesOwn(v, ownIds);
      else if (isSecret(key, v)) out[key] = REDACTED;
      else if (typeof v !== "function") out[key] = sanitize(v, ownIds);
    }
    return out;
  }
  return value;
}

/** The shape of a response: types and array lengths, never values (ids as `*_matches`). */
export function shapeOf(value: unknown, ownIds: readonly string[] = []): unknown {
  if (value === null || value === undefined) return "null";
  if (value instanceof Decimal) return "decimal";
  if (value instanceof Date) return "date";
  if (Array.isArray(value)) {
    if (value.length === 0) return ["empty"];
    return [shapeOf(value[0], ownIds), `length ${String(value.length)}`];
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (ID_KEYS.has(norm(key))) out[`${key}_matches`] = matchesOwn(v, ownIds);
      else out[key] = shapeOf(v, ownIds);
    }
    return out;
  }
  return typeof value;
}

export interface RecordOptions {
  /** Test seam; a live run always uses the default `.live-results/`. */
  dir?: string;
  /** The run's own account id(s), for the `*_matches` booleans. */
  ownIds?: readonly string[];
}

/** Append one sanitised JSON line to `<dir>/<suite>.jsonl` and return the file's path. */
export function record(
  suite: string,
  test: string,
  data: Record<string, unknown>,
  options: RecordOptions = {},
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(suite)) throw new Error("suite must be a plain file name");
  const dir = options.dir ?? RESULTS_DIR;
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${suite}.jsonl`);
  const clean = sanitize(data, options.ownIds ?? []) as Record<string, unknown>;
  const line = { at: new Date().toISOString(), test, ...clean };
  appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
  return file;
}
