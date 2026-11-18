// The App Key and Secret key saved per client id by the login command, shared with the Python
// CLI (sdk-behaviour 6.7): `credentials.json` in the folder of the token file,
//
//   {"version": 1, "clients": {"<client id>": {"app_key": "...", "secret_key": "..."}}}
//
// An entry may hold one key only. Client ids are matched ignoring case. Written and read like the
// token file (private-file.ts: folder 0700, file 0600, atomic replace; on POSIX a file owned by
// another user or open to group/others is refused, checked on the one open file). NOT encrypted:
// whoever can read the file can read the keys. No locking: the last write wins.
//
// Nothing here logs or prints; messages name the file, never its contents, and `SavedKeys` never
// shows the keys in `toString`, JSON or `util.inspect`.
import { rm, unlink } from "node:fs/promises";
import nodePath from "node:path";
import { inspect } from "node:util";
import { ConfigurationError } from "../errors.js";
import { readPrivateText, writePrivateFile, type WriteHooks } from "./private-file.js";

export const KEY_FILE_NAME = "credentials.json";
const VERSION = 1;
const FIELDS = ["app_key", "secret_key"] as const;
type Field = (typeof FIELDS)[number];
type Entry = Partial<Record<Field, string>>;

/** The saved-keys file exists but cannot be used (unreadable, corrupt, foreign or unsafe). */
export class KeyFileError extends ConfigurationError {
  override name = "KeyFileError";
}

/** The keys saved for one client id; either may be `null` (not saved). */
export interface SavedKeys {
  /** Never shows the keys. */
  toString(): string;
  readonly appKey: string | null;
  readonly secretKey: string | null;
}

class SavedKeysValue implements SavedKeys {
  constructor(
    readonly appKey: string | null,
    readonly secretKey: string | null,
  ) {}

  private shown(): { appKey: string | null; secretKey: string | null } {
    return {
      appKey: this.appKey === null ? null : "***",
      secretKey: this.secretKey === null ? null : "***",
    };
  }

  toString(): string {
    const s = this.shown();
    return `SavedKeys(appKey=${String(s.appKey)}, secretKey=${String(s.secretKey)})`;
  }

  toJSON(): { appKey: string | null; secretKey: string | null } {
    return this.shown();
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/** The saved-keys file in the folder of `tokenFile`. */
export function keyFilePath(tokenFile: string): string {
  return nodePath.join(nodePath.dirname(tokenFile), KEY_FILE_NAME);
}

function refuse(path: string, why: string): KeyFileError {
  return new KeyFileError(`the saved keys at ${path} ${why}`);
}

/**
 * The client ids of the `clients` object in the order they first appear in the JSON `text`
 * (`JSON.parse` lists integer-like keys such as "12345" first, Python keeps the file order). Run
 * only on text `JSON.parse` accepted; a plain scan with a depth counter, no recursion.
 */
function scanClientIdOrder(text: string): string[] {
  const ids = new Set<string>();
  let depth = 0;
  let active = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      let k = j + 1;
      while (" \t\r\n".includes(text[k] ?? "x")) k += 1;
      if (text[k] === ":") {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (depth === 1) {
          active = key === "clients";
          if (active) ids.clear(); // a repeated "clients" key: the last one wins
        } else if (depth === 2 && active) {
          ids.add(key);
        }
      }
      i = j + 1;
    } else {
      if (c === "{" || c === "[") depth += 1;
      else if (c === "}" || c === "]") depth -= 1;
      i += 1;
    }
  }
  return [...ids];
}

/** All entries, in file order (empty when there is no file). Throws `KeyFileError`. */
function load(path: string): Map<string, Entry> {
  const text = readPrivateText(path, "saved keys", (message) => new KeyFileError(message));
  const entries = new Map<string, Entry>();
  if (text === null) return entries;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // Not JSON at all; a document the parser accepts, however deeply nested, is judged below.
    throw refuse(path, "are not valid JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data) || !("version" in data)) {
    throw refuse(path, "are not a saved-keys file of this SDK");
  }
  const record = data as Record<string, unknown>;
  if (record["version"] !== VERSION) {
    throw refuse(path, "use a format this version of the SDK does not know");
  }
  const clients = record["clients"];
  if (typeof clients !== "object" || clients === null || Array.isArray(clients)) {
    throw refuse(path, "are not in the expected format");
  }
  const table = clients as Record<string, unknown>;
  const scanned = _internals.clientIdOrder(text);
  const parsedIds = Object.keys(table);
  // Fail safe: the scan must see exactly the ids the parser saw, or nothing is read or rewritten.
  if (scanned.length !== parsedIds.length || !parsedIds.every((id) => scanned.includes(id))) {
    throw refuse(path, "are not in the expected format");
  }
  for (const clientId of scanned) {
    const entry = table[clientId];
    if (
      clientId.trim() === "" ||
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry)
    ) {
      throw refuse(path, "are not in the expected format");
    }
    const keys: Entry = {};
    for (const name of FIELDS) {
      const value = (entry as Record<string, unknown>)[name];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" || value.trim() === "") {
        throw refuse(path, "are not in the expected format");
      }
      keys[name] = value.trim();
    }
    if (Object.keys(keys).length === 0) throw refuse(path, "are not in the expected format");
    entries.set(clientId.trim(), keys);
  }
  return entries;
}

/** Python's `ensure_ascii`: every UTF-16 code unit from 0x7f (DEL) up as a lowercase `\uXXXX`. */
function asciiOnly(text: string): string {
  return text.replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * The bytes Python's `json.dumps({"version": 1, "clients": {...}}, indent=2)` writes: 2-space
 * indent, `": "` and `","` separators, entries in map order, no trailing newline, ASCII only.
 */
function serialise(entries: Map<string, Entry>): string {
  const clients = [...entries].map(([id, entry]) => {
    const fields = Object.entries(entry).map(
      ([name, value]) => `      ${JSON.stringify(name)}: ${JSON.stringify(value)}`,
    );
    return `    ${JSON.stringify(id)}: {\n${fields.join(",\n")}\n    }`;
  });
  const body = clients.length === 0 ? "{}" : `{\n${clients.join(",\n")}\n  }`;
  return asciiOnly(`{\n  "version": ${String(VERSION)},\n  "clients": ${body}\n}`);
}

async function write(
  path: string,
  entries: Map<string, Entry>,
  hooks: WriteHooks = {},
): Promise<void> {
  await writePrivateFile(path, serialise(entries), hooks);
}

function matching(entries: Map<string, Entry>, clientId: string): string[] {
  const wanted = clientId.trim().toLowerCase();
  return [...entries.keys()].filter((name) => name.toLowerCase() === wanted);
}

/** The keys saved for `clientId` (case ignored); `null` when there are none. */
// The read is synchronous (one open file); `async` keeps every failure a rejection.
// eslint-disable-next-line @typescript-eslint/require-await
export async function readSavedKeys(path: string, clientId: string): Promise<SavedKeys | null> {
  const entries = load(path);
  const [name] = matching(entries, clientId);
  if (name === undefined) return null;
  const entry = entries.get(name) as Entry;
  return new SavedKeysValue(entry.app_key ?? null, entry.secret_key ?? null);
}

/** The client ids with saved keys, sorted. */
// eslint-disable-next-line @typescript-eslint/require-await
export async function savedClientIds(path: string): Promise<string[]> {
  return [...load(path).keys()].sort();
}

/**
 * Save the given keys for `clientId`; other client ids and a key not given are kept. An entry
 * spelt differently (case) is replaced by `clientId`'s spelling. An unusable existing file is
 * never overwritten (`KeyFileError`); nothing to save is a `RangeError`. Returns `path`.
 */
export async function saveKeys(
  path: string,
  clientId: string,
  keys: { appKey?: string; secretKey?: string },
  hooks: WriteHooks = {},
): Promise<string> {
  const given: Entry = {};
  for (const [name, value] of [
    ["app_key", keys.appKey],
    ["secret_key", keys.secretKey],
  ] as const) {
    if (value !== undefined && value.trim() !== "") given[name] = value.trim();
  }
  if (Object.keys(given).length === 0) {
    throw new RangeError("nothing to save: give appKey and/or secretKey");
  }
  const entries = load(path);
  const merged: Entry = {};
  for (const name of matching(entries, clientId)) {
    Object.assign(merged, entries.get(name));
    entries.delete(name);
  }
  Object.assign(merged, given);
  entries.set(clientId.trim(), merged);
  await write(path, entries, hooks);
  return path;
}

/**
 * Remove the keys of `clientId`; `false` when none were saved. The file is removed when no entry
 * is left. An unusable file throws `KeyFileError`.
 */
export async function forgetKeys(path: string, clientId: string): Promise<boolean> {
  const entries = load(path);
  const names = matching(entries, clientId);
  if (names.length === 0) return false;
  for (const name of names) entries.delete(name);
  if (entries.size > 0) await write(path, entries);
  else await rm(path, { force: true });
  return true;
}

/** Remove the whole file, whatever it holds; `false` when there was none. */
export async function deleteKeyFile(path: string): Promise<boolean> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return true;
}

/** Internal seam for tests (the order scan); not part of any public surface. */
export const _internals = { clientIdOrder: scanClientIdOrder };
