// Secret redaction (sdk-behaviour.md §13, mirroring sdk-python/src/tradesmart/_logging.py):
// the redacted keys (any case) and patterns, and the truncation of error bodies.
import { JsonNumber } from "./json.js";

/** Keys whose values are secrets (lower case; compared case-insensitively). */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "access_token",
  "accesstoken",
  "susertoken",
  "refresh_token",
  "checksum",
  "code",
  "secret_key",
  "app_key",
  "password",
]);

export const MASK = "***";

/** Longest text kept in an error body (500 for script-master errors, pass `maxLen`). */
export const BODY_LIMIT = 2000;

/** Text shown instead of a structure too deep to walk. */
export const TOO_DEEP = "<response nested too deeply to show>";

const MAX_DEPTH = 100;

const KEYS_ALT = [...SENSITIVE_KEYS].join("|");
const BEARER = /Bearer\s+\S+/gi;
// "key": "value" / 'key': 'value' (the value may hold escaped quotes), or "key": bare-token.
const JSON_PAIR = new RegExp(
  `(?<pre>(?<kq>["'])(?:${KEYS_ALT})\\k<kq>\\s*:\\s*)(?:(?<vq>["'])(?:\\\\.|(?!\\k<vq>)[^\\\\])*\\k<vq>|[^,}\\]\\s"']+)`,
  "gi",
);
const PAIR = new RegExp(`\\b(${KEYS_ALT})=[^&\\s]*`, "gi");

/**
 * Mask secrets in text and cut it to `maxLen` characters. Redaction comes first, so a secret
 * is never half-shown at the cut.
 */
export function redactText(text: string, maxLen: number = BODY_LIMIT): string {
  const masked = text
    .replace(BEARER, `Bearer ${MASK}`)
    .replace(JSON_PAIR, (...args: unknown[]) => {
      const groups = args[args.length - 1] as { pre: string; vq?: string };
      return `${groups.pre}${groups.vq === undefined ? MASK : `${groups.vq}${MASK}${groups.vq}`}`;
    })
    .replace(PAIR, (_match, key: string) => `${key}=${MASK}`);
  return masked.length > maxLen ? masked.slice(0, maxLen) : masked;
}

function isSensitive(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

function isPlain(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

class TooDeep extends Error {}

function redactWalk(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactText(value, Number.POSITIVE_INFINITY);
  if (value instanceof Error) {
    return redactText(`${value.name}: ${value.message}`, Number.POSITIVE_INFINITY);
  }
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) throw new TooDeep();
    return (value as unknown[]).map((item) => redactWalk(item, depth + 1));
  }
  if (!isPlain(value)) return value;
  if (depth >= MAX_DEPTH) throw new TooDeep();
  // fromEntries defines own properties, so a `__proto__` key never sets the prototype.
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitive(key) ? MASK : redactWalk(item, depth + 1),
    ]),
  );
}

/**
 * A copy of `value` with secrets masked: values under a redacted key (any case) become `***`,
 * and strings are redacted as text. Never mutates the input. A structure nested too deeply to
 * walk is replaced as a whole by a fixed text.
 */
export function redactObject(value: unknown): unknown {
  try {
    return redactWalk(value, 0);
  } catch (error) {
    if (error instanceof TooDeep) return TOO_DEEP;
    throw error;
  }
}

function maskWalk(value: unknown, depth: number): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (depth >= MAX_DEPTH) return TOO_DEEP;
  if (Array.isArray(value)) return (value as unknown[]).map((item) => maskWalk(item, depth + 1));
  if (!isPlain(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitive(key) ? MASK : maskWalk(item, depth + 1),
    ]),
  );
}

/**
 * Key-only masking for a model's `raw`: a copy with every redacted key (any case) masked at
 * every depth, plus `extraKeys` (wire keys of `secret` fields) masked at the top level. String
 * values are data and stay as they are.
 */
export function maskKeys(
  record: Readonly<Record<string, unknown>>,
  extraKeys: readonly string[] = [],
): Record<string, unknown> {
  const extra = new Set(extraKeys);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      isSensitive(key) || extra.has(key) ? MASK : maskWalk(item, 1),
    ]),
  );
}

/** Serialise a wire value for an error body: redacted, never throwing (numbers by their text). */
export function redactedBody(value: unknown, maxLen: number = BODY_LIMIT): string {
  const masked = redactObject(value);
  if (typeof masked === "string") return redactText(masked, maxLen);
  try {
    const text = JSON.stringify(masked, (_key, item: unknown) =>
      item instanceof JsonNumber ? item.text : typeof item === "bigint" ? item.toString() : item,
    );
    return redactText(text, maxLen);
  } catch {
    return TOO_DEEP;
  }
}
