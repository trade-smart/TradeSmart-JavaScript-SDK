// The per-user token file shared with the Python SDK (sdk-behaviour 6.5, 13): the same location
// rules and JSON format, so a login made with either SDK's CLI serves both.
//
// Write: directory 0700, temp file `.<name>.<random>.tmp` created exclusively with mode 0600,
// fsync, atomic rename; no partial file on failure. Read (POSIX): the file is opened once, its
// owner and mode are checked on that handle and it is read from the same handle; a file owned by
// another user or open to group/others is refused. Messages name the file, never its contents.
import { unlink } from "node:fs/promises";
import nodePath from "node:path";
import { AccessToken, nextIstSixAm } from "../auth.js";
import { ConfigurationError } from "../errors.js";
import { readPrivateText, writePrivateFile, type WriteHooks } from "./private-file.js";

/** How far `issued_at` may lie ahead of this computer's clock (small clock differences). */
const ISSUE_SKEW_MS = 5 * 60_000;
/** The login command writes `+05:30`. */
const IST_OFFSET_MINUTES = 330;

/** The token file exists but cannot be used, or does not exist (`missing`). */
export class TokenFileError extends ConfigurationError {
  override name = "TokenFileError";
  /** True when there is simply no file (so no saved login). */
  readonly missing: boolean;

  constructor(message: string, missing = false) {
    super(message);
    this.missing = missing;
  }
}

/** A saved login: the client id and its token. */
export interface StoredLogin {
  clientId: string;
  accessToken: AccessToken;
  /** The offset (minutes) written with `issued_at`; default `+05:30` like the login command. */
  issuedOffsetMinutes?: number;
}

/**
 * Where the token file lives. `TRADESMART_TOKEN_FILE` (stripped; blank is unset; a leading `~`
 * expanded; a relative path made absolute against `cwd`; a symbolic link is not resolved);
 * else `%APPDATA%\tradesmart\token.json` on Windows (fallback `<home>\AppData\Roaming`), else
 * `$XDG_CONFIG_HOME/tradesmart/token.json` (fallback `<home>/.config`).
 */
export function defaultTokenFilePath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  cwd: string,
): string {
  const p = platform === "win32" ? nodePath.win32 : nodePath.posix;
  const override = (env["TRADESMART_TOKEN_FILE"] ?? "").trim();
  if (override !== "") {
    let expanded = override;
    if (override === "~") expanded = home;
    else if (override.startsWith("~/") || (platform === "win32" && override.startsWith("~\\"))) {
      expanded = p.join(home, override.slice(2));
    }
    return p.resolve(cwd, expanded);
  }
  if (platform === "win32") {
    const appdata = env["APPDATA"];
    const base = appdata ? appdata : p.join(home, "AppData", "Roaming");
    return p.join(base, "tradesmart", "token.json");
  }
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg !== undefined && xdg.trim() !== "" ? xdg : p.join(home, ".config");
  return p.join(base, "tradesmart", "token.json");
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/**
 * `YYYY-MM-DDTHH:MM:SS±HH:MM` for the instant `d` at the offset `offsetMinutes`: seconds
 * precision (the fraction is dropped), a numeric offset with a colon, never `Z`.
 */
export function formatTokenTimestamp(d: Date, offsetMinutes: number): string {
  const seconds = Math.floor(d.getTime() / 1000) * 1000;
  const local = new Date(seconds + offsetMinutes * 60_000);
  const text = local.toISOString().slice(0, 19);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${text}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export type { WriteHooks };

/**
 * Write the login to `path` atomically: directory 0700, temp file created exclusively with mode
 * 0600, fsync, rename. No partial file is left on failure; the error is rethrown.
 */
export async function writeTokenFile(
  path: string,
  login: StoredLogin,
  hooks: WriteHooks = {},
): Promise<void> {
  const token = login.accessToken;
  const payload = JSON.stringify({
    client_id: login.clientId,
    access_token: token.accessToken.reveal(),
    issued_at: formatTokenTimestamp(
      token.issuedAt,
      login.issuedOffsetMinutes ?? IST_OFFSET_MINUTES,
    ),
    expires_at: formatTokenTimestamp(token.expiresAt, IST_OFFSET_MINUTES),
  });
  await writePrivateFile(path, payload, hooks);
}

const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|z|[+-]\d{2}:\d{2})$/;

/**
 * The instant of a token-file timestamp, or `null` when the text is not accepted: exactly
 * `YYYY-MM-DDTHH:MM:SS`, optionally `.` and 1 to 9 fraction digits (kept to milliseconds), then
 * `Z`, `z` or `±HH:MM`.
 */
function parseTimestamp(text: string): Date | null {
  const m = TIMESTAMP.exec(text);
  if (m === null) return null;
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i])) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const millis = Number((m[7] ?? "").slice(0, 3).padEnd(3, "0"));
  const zone = m[8] as string;
  let offsetMs = 0;
  if (zone !== "Z" && zone !== "z") {
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offsetMs = (zone.startsWith("-") ? -1 : 1) * (oh * 60 + om) * 60_000;
  }
  const utc = new Date(Date.UTC(y, mo - 1, d, h, mi, s, millis));
  // Date.UTC maps years 0-99 to 1900+ and rolls impossible dates over; refuse both.
  if (
    y < 100 ||
    utc.getUTCFullYear() !== y ||
    utc.getUTCMonth() !== mo - 1 ||
    utc.getUTCDate() !== d ||
    h > 23 ||
    mi > 59 ||
    s > 59
  ) {
    return null;
  }
  return new Date(utc.getTime() - offsetMs);
}

/** The non-blank string `key`, trimmed. */
function field(data: Record<string, unknown>, key: string, where: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new TokenFileError(`the saved login at ${where} has no usable '${key}'`);
  }
  return value.trim();
}

function timestamp(data: Record<string, unknown>, key: string, where: string): Date {
  const value = parseTimestamp(field(data, key, where));
  if (value === null)
    throw new TokenFileError(`the saved login at ${where} has an invalid '${key}'`);
  return value;
}

/**
 * Read the saved login at `path`. Throws `TokenFileError` (`missing` when there is no file) when
 * it cannot be used. `expiresAt` never exceeds the next 06:00 IST after `issuedAt`, and an
 * `issued_at` more than 5 minutes after `now` refuses the file.
 */
export function readTokenFile(path: string, now: Date = new Date()): StoredLogin {
  const text = readPrivateText(path, "saved login", (message) => new TokenFileError(message));
  if (text === null) throw new TokenFileError(`there is no saved login at ${path}`, true);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new TokenFileError(`the saved login at ${path} is not valid JSON`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new TokenFileError(`the saved login at ${path} is not a JSON object`);
  }
  const record = data as Record<string, unknown>;
  const issuedAt = timestamp(record, "issued_at", path);
  if (issuedAt.getTime() > now.getTime() + ISSUE_SKEW_MS) {
    // Otherwise the 06:00 IST cap below, anchored on issued_at, would not bound anything.
    throw new TokenFileError(
      `the saved login at ${path} has an 'issued_at' in the future (check this computer's ` +
        "clock); log in again",
    );
  }
  // An edited file cannot extend the token's local validity past the 06:00 IST rule.
  const stored = timestamp(record, "expires_at", path);
  const cap = nextIstSixAm(issuedAt);
  const expiresAt = stored.getTime() < cap.getTime() ? stored : cap;
  const accessToken = AccessToken.fromParts(
    field(record, "access_token", path),
    issuedAt,
    expiresAt,
  );
  return { clientId: field(record, "client_id", path), accessToken };
}

/** Remove the token file; `false` when there was none. Other failures are rethrown. */
export async function deleteTokenFile(path: string): Promise<boolean> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return true;
}
