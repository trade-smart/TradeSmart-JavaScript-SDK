// The `jData` request body encoder (sdk-behaviour.md §3.2). Written by hand, one code point at a
// time: a JSON library's escaping rules (HTML escaping, U+2028, lone surrogates) must not decide
// what goes on the wire.
import { RequestValidationError, type ValidationIssue } from "../errors.js";

/**
 * A wire value (§3.2): a string, or a nested object (a plain object, keys written in insertion
 * order; the OCO keys are never integer-like) or list of such values.
 */
export type WireValue = string | WireObject | readonly WireValue[];

/** A nested object value. */
export interface WireObject {
  readonly [key: string]: WireValue;
}

/** The request payload as ordered `[wire key, wire value]` pairs; the order is sent as given. */
export type WirePayload = ReadonlyArray<readonly [key: string, value: WireValue]>;

const SHORT_ESCAPES: Readonly<Record<number, string>> = {
  0x08: "\\b",
  0x09: "\\t",
  0x0a: "\\n",
  0x0c: "\\f",
  0x0d: "\\r",
};

/** True when a code point is a surrogate: from `for...of` that means an unpaired one. */
function isLoneSurrogate(codePoint: number): boolean {
  return codePoint >= 0xd800 && codePoint <= 0xdfff;
}

/**
 * The text as a JSON string body (no surrounding quotes), or `null` when it holds a lone
 * surrogate and so cannot be written as UTF-8.
 */
function escapeJsonString(text: string): string | null {
  let out = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0) as number;
    if (isLoneSurrogate(codePoint)) return null;
    if (char === '"') out += '\\"';
    else if (char === "\\") out += "\\\\";
    else if (codePoint < 0x20) {
      out += SHORT_ESCAPES[codePoint] ?? `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else out += char;
  }
  return out;
}

/** A key for an error issue: a lone surrogate is shown as U+FFFD so the issue stays valid text. */
function displayKey(key: string): string {
  let out = "";
  for (const char of key) out += isLoneSurrogate(char.codePointAt(0) as number) ? "�" : char;
  return out;
}

/** The value as compact JSON text, or `null` when any string at any depth has a lone surrogate. */
function jsonValue(value: WireValue): string | null {
  if (typeof value === "string") {
    const escaped = escapeJsonString(value);
    return escaped === null ? null : `"${escaped}"`;
  }
  const parts: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value as readonly WireValue[]) {
      const text = jsonValue(item);
      if (text === null) return null;
      parts.push(text);
    }
    return `[${parts.join(",")}]`;
  }
  for (const [key, item] of Object.entries(value as WireObject)) {
    const escapedKey = escapeJsonString(key);
    const text = jsonValue(item);
    if (escapedKey === null || text === null) return null;
    parts.push(`"${escapedKey}":${text}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Encode the payload as the UTF-8 bytes of `jData=<compact JSON>`: keys in the given order, only
 * `% & +` percent-encoded (in that order), everything else raw. A key or value with a lone
 * surrogate raises `RequestValidationError` (one `string_unicode` issue per such key, sorted) and
 * nothing is returned; the value is never echoed.
 */
export function encodeJData(payload: WirePayload): Uint8Array {
  const bad = new Set<string>();
  const members: string[] = [];
  for (const [key, value] of payload) {
    const escapedKey = escapeJsonString(key);
    const escapedValue = jsonValue(value);
    if (escapedKey === null || escapedValue === null) {
      bad.add(displayKey(key));
      continue;
    }
    members.push(`"${escapedKey}":${escapedValue}`);
  }
  if (bad.size > 0) {
    const keys = [...bad].sort();
    const issues: ValidationIssue[] = keys.map((key) => ({
      type: "string_unicode",
      loc: [key],
      msg: "text is not valid UTF-8",
    }));
    throw new RequestValidationError(issues);
  }
  const json = `{${members.join(",")}}`
    .replaceAll("%", "%25")
    .replaceAll("&", "%26")
    .replaceAll("+", "%2B");
  return new TextEncoder().encode(`jData=${json}`);
}
