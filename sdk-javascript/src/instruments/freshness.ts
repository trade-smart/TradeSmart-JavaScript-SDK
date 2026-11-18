// Script-master freshness (sdk-behaviour.md §8.2; Python: instruments.py `_request_headers`): the
// last daily refresh, the `.checked` sidecar and the decision whether a request is due. Also the
// atomic file writer every instruments file goes through.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, utimes, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ClientConfig } from "../config.js";
import { IST_OFFSET_MS } from "../lib/time.js";
import type { Logger } from "../lib/log.js";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/**
 * Write `data` to `target` atomically: a temp file in the same folder, then a rename. The folder
 * is created when needed; no partial file is left on failure.
 */
export async function writeFileAtomic(target: string, data: Uint8Array | string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, data, { flag: "wx" });
    await rename(temp, target);
  } catch (e) {
    await unlink(temp).catch(() => undefined);
    throw e;
  }
}

/** The most recent daily refresh instant (`HH:MM` IST) at or before `now`. */
export function lastRefresh(now: Date, refreshTime: string): Date {
  const [hour = 0, minute = 0] = refreshTime.split(":").map(Number);
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const today =
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hour, minute) -
    IST_OFFSET_MS;
  return new Date(now.getTime() >= today ? today : today - DAY_MS);
}

/** The file's modification time in ms, or `null` when it is not a regular file. */
export async function fileMtimeMs(file: string): Promise<number | null> {
  try {
    const st = await stat(file);
    return st.isFile() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

/** The sidecar recording when the server was last asked about `file`. */
export function checkedPath(file: string): string {
  return `${file}.checked`;
}

// ISO 8601 with a mandatory zone (`Z` or `+HH:MM`); a naive stamp is no stamp.
const STAMP =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

/** When the server was last checked for `file`; `null` when unknown, unreadable or naive. */
export async function lastChecked(file: string): Promise<Date | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(checkedPath(file));
  } catch {
    return null; // missing, a directory, unreadable
  }
  if (bytes.some((b) => b > 0x7f)) return null; // not ASCII
  const text = bytes.toString("ascii").trim();
  if (!STAMP.test(text)) return null;
  const ms = Date.parse(text.replace(" ", "T"));
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** `now` as UTC ISO 8601 with a `+00:00` zone (`2026-11-10T04:30:00+00:00`). */
export function formatStamp(now: Date): string {
  const iso = now.toISOString(); // 2026-11-10T04:30:00.000Z
  const fraction = iso.slice(19, 23) === ".000" ? "" : iso.slice(19, 23);
  return `${iso.slice(0, 19)}${fraction}+00:00`;
}

/** Record `now` as the last check of `file`; never fails the call. */
export async function markChecked(file: string, now: Date, log: Logger): Promise<void> {
  try {
    await writeFileAtomic(checkedPath(file), formatStamp(now));
  } catch {
    log.debug(`Could not record the check time of ${path.basename(file)}`);
  }
}

/** Set the file's modification time; `false` when it could not be set. */
export async function setMtime(file: string, when: Date): Promise<boolean> {
  try {
    await utimes(file, when, when);
    return true;
  } catch {
    return false;
  }
}

/**
 * The extra request headers for a download of `file`, or `null` when no request is due. `{}` asks
 * for a full download (`force`, or no file). A file written at or after the last refresh is fresh.
 * An older one is used as is while the server was checked less than `scriptMasterRecheckMinutes`
 * ago; otherwise it is re-checked with `If-Modified-Since` (its mtime is the server's
 * `Last-Modified`).
 */
export async function requestHeaders(
  file: string,
  options: { force: boolean; config: ClientConfig; now: Date },
): Promise<Record<string, string> | null> {
  const { force, config, now } = options;
  const mtime = await fileMtimeMs(file);
  if (force || mtime === null) return {};
  if (mtime >= lastRefresh(now, config.scriptMasterRefreshTime).getTime()) return null;
  const checked = await lastChecked(file);
  if (checked !== null) {
    const age = now.getTime() - checked.getTime();
    if (age >= 0 && age < config.scriptMasterRecheckMinutes * MINUTE_MS) return null;
  }
  return { "If-Modified-Since": new Date(mtime).toUTCString() };
}
