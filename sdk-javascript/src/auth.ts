// OAuth helpers (sdk-behaviour 6.1-6.3): the authorize URL, the checksum, the token text check and
// the access token with its 06:00 IST expiry. The token-bearing values are `Secret`s and never
// appear in messages, `toString`, `inspect` or JSON.
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { ClientConfig } from "./config.js";
import { ConfigurationError } from "./errors.js";
import { IST_OFFSET_MS } from "./lib/time.js";
import {
  parseAccessToken as parseAccessTokenModel,
  type AccessToken as AccessTokenModel,
} from "./models/generated/auth.js";
import type { Secret } from "./models/base.js";

/** The hint appended to errors that need a fresh login. */
export const LOGIN_HINT =
  "log in with `npx tradesmart login` (or the Python SDK's `python -m tradesmart login`)";

const DAY_MS = 86_400_000;
const SIX_HOURS_MS = 6 * 3_600_000;

/** `encodeURIComponent` plus the five marks it leaves bare: every reserved character is encoded. */
function encodeAll(text: string): string {
  let encoded: string;
  try {
    encoded = encodeURIComponent(text);
  } catch {
    // A lone surrogate; never echo the value.
    throw new ConfigurationError("app_key contains characters that cannot be URL-encoded");
  }
  return encoded.replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/** The URL the user opens in a browser to authorize the app (6.1). */
export function buildAuthorizeUrl(appKey: string, authorizeUrl?: string): string {
  if (appKey === "") throw new ConfigurationError("app_key must not be empty");
  const base = authorizeUrl ?? ClientConfig.create().authorizeUrl;
  return `${base}?client_id=${encodeAll(appKey)}`;
}

/** Lowercase hex SHA-256 of UTF-8(`appKey + secretKey + code`) (6.2). */
export function computeChecksum(appKey: string, secretKey: string, code: string): string {
  if (appKey === "" || secretKey === "" || code === "") {
    throw new ConfigurationError("app_key, secret_key and code must all be non-empty");
  }
  return createHash("sha256")
    .update(appKey + secretKey + code, "utf8")
    .digest("hex");
}

const VISIBLE_ASCII = /^[\x21-\x7e]*$/;

/**
 * A token string stripped of surrounding whitespace (the newline of a token read from a file),
 * which must then be visible ASCII only (U+0021 to U+007E), else `ConfigurationError` (6.3). A
 * blank token returns `""`; the caller treats that as no token. The value is never shown.
 */
export function checkTokenText(token: string): string {
  const text = token.trim();
  assertSendableToken(text);
  return text;
}

/**
 * Throw `ConfigurationError` unless `text` is visible ASCII only (U+0021 to U+007E), as is (not
 * stripped: the `accessToken` of an `AccessToken`, 6.3). The value is never shown.
 */
export function assertSendableToken(text: string): void {
  if (!VISIBLE_ASCII.test(text)) {
    throw new ConfigurationError(
      "access_token must contain only printable ASCII characters (no spaces, control characters " +
        "or non-ASCII); check how the token was copied or read",
    );
  }
}

/** The first 06:00 IST strictly after `after` (IST is a fixed UTC+05:30). */
export function nextIstSixAm(after: Date): Date {
  const ms = after.getTime();
  if (Number.isNaN(ms)) throw new RangeError("issuedAt must be a valid Date");
  const local = ms + IST_OFFSET_MS;
  let candidate = Math.floor(local / DAY_MS) * DAY_MS + SIX_HOURS_MS;
  if (candidate <= local) candidate += DAY_MS;
  return new Date(candidate - IST_OFFSET_MS);
}

/** Result of `GenAcsTok`. Token values are masked in `toString`, `inspect`, JSON and `raw`. */
export class AccessToken {
  readonly accessToken: Secret;
  readonly susertoken: Secret | null;
  readonly refreshToken: Secret | null;
  readonly userId: string | null;
  readonly accountId: string | null;
  readonly uname: string | null;
  readonly expiresIn: string | null;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly raw: Readonly<Record<string, unknown>>;

  private constructor(model: AccessTokenModel, raw: Readonly<Record<string, unknown>>) {
    this.accessToken = model.accessToken;
    this.susertoken = model.susertoken;
    this.refreshToken = model.refreshToken;
    this.userId = model.userId;
    this.accountId = model.accountId;
    this.uname = model.uname;
    this.expiresIn = model.expiresIn;
    this.issuedAt = model.issuedAt;
    this.expiresAt = model.expiresAt;
    this.raw = raw;
  }

  /** True once `now` (default: the current time) has reached `expiresAt`. */
  isExpired(now: Date = new Date()): boolean {
    return now.getTime() >= this.expiresAt.getTime();
  }

  /** Build from a `GenAcsTok` success body; the expiry is the next 06:00 IST after `issuedAt`. */
  static fromResponse(wire: unknown, issuedAt: Date): AccessToken {
    return AccessToken.#build(wire, issuedAt, nextIstSixAm(issuedAt));
  }

  /** Build from a bare token with explicit times (the token file reader and tests). */
  static fromParts(accessToken: string, issuedAt: Date, expiresAt: Date): AccessToken {
    return AccessToken.#build({ access_token: accessToken }, issuedAt, expiresAt);
  }

  static #build(wire: unknown, issuedAt: Date, expiresAt: Date): AccessToken {
    const isObject = typeof wire === "object" && wire !== null && !Array.isArray(wire);
    // The parser also sees the two local times; they are not part of the wire `raw`.
    const augmented = isObject
      ? { ...(wire as Record<string, unknown>), issued_at: issuedAt, expires_at: expiresAt }
      : wire;
    const model = parseAccessTokenModel(augmented, { endpoint: "GenAcsTok" });
    const raw = Object.fromEntries(
      Object.entries(model.raw).filter(([key]) => !(isObject && ownKey(wire, key) === undefined)),
    );
    return new AccessToken(model, Object.freeze(raw));
  }

  toString(): string {
    return `AccessToken(user_id=${this.userId ?? "None"}, expires_at=${this.expiresAt.toISOString()}, access_token=***)`;
  }

  toJSON(): Record<string, unknown> {
    return {
      accessToken: "***",
      userId: this.userId,
      accountId: this.accountId,
      issuedAt: this.issuedAt.toISOString(),
      expiresAt: this.expiresAt.toISOString(),
    };
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/** The own value of `key` on a record, `undefined` when it is not an own key of the original. */
function ownKey(wire: unknown, key: string): unknown {
  return Object.hasOwn(wire as object, key) ? (wire as Record<string, unknown>)[key] : undefined;
}
