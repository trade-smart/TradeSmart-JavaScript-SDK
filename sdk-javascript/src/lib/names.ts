// `request()` endpoint-name canonicalisation and the per-name rules (sdk-behaviour.md §2.5, §4.2.1).
import { ConfigurationError } from "../errors.js";

export type RateGroup = "orders" | "quotes" | "tpseries";

/** What the safety, rate-limit and response rules know about one endpoint name. */
export interface EndpointInfo {
  /** The name to send: the documented spelling for a known name, else the name as given. */
  readonly endpoint: string;
  /** True for the twelve names that change state or credentials (never retried). */
  readonly stateChanging: boolean;
  readonly rateGroup: RateGroup | null;
  /** The `stat` words that mean success (`Ok` for every endpoint without its own word). */
  readonly successWords: readonly string[];
  /** True when the words compare ignoring letter case only (the GTT writes, F32). */
  readonly ignoreCase: boolean;
  /** The field a success reply must carry as a non-blank string (the GTT `al_id`), else `null`. */
  readonly requiresAckId: string | null;
}

const OK_WORDS: readonly string[] = Object.freeze(["Ok"]);
const ICEBERG_WORDS: readonly string[] = Object.freeze(["true"]);

/**
 * The success word of each GTT and OCO write; compared ignoring letter case only. The GTT cancel
 * word is the one observed on the API (`OI deleted`); the documented `Oi delete success` is not.
 */
const ALERT_WORDS: Readonly<Record<string, string>> = Object.freeze({
  PlaceGTTOrder: "Oi created",
  ModifyGTTOrder: "Oi replaced",
  CancelGTTOrder: "OI deleted",
  PlaceOCOOrder: "OI created",
  ModifyOCOOrder: "OI replaced",
  CancelOCOOrder: "OI deleted",
});

/** The definite-failure `stat` of the modify and cancel writes (letter case ignored, untrimmed). */
export const FAILURE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  ModifyGTTOrder: "Invalid Oi",
  CancelGTTOrder: "Invalid Oi",
  ModifyOCOOrder: "Invalid Oi",
  CancelOCOOrder: "Invalid Oi",
});

const ICEBERG_ENDPOINTS: ReadonlySet<string> = new Set([
  "PlaceIceBergOrder",
  "ModifyIceBergOrder",
  "CancelIceBergOrder",
]);

const STATE_CHANGING: ReadonlySet<string> = new Set([
  "PlaceOrder",
  "PlaceMultiOrder",
  "ModifyOrder",
  "CancelOrder",
  "ExitSNOOrder",
  "GenAcsTok",
  "PlaceGTTOrder",
  "ModifyGTTOrder",
  "CancelGTTOrder",
  "PlaceOCOOrder",
  "ModifyOCOOrder",
  "CancelOCOOrder",
  "PlaceIceBergOrder",
  "ModifyIceBergOrder",
  "CancelIceBergOrder",
]);

const RATE_GROUPS: Readonly<Record<string, RateGroup>> = Object.freeze({
  PlaceOrder: "orders",
  PlaceMultiOrder: "orders",
  GetQuotes: "quotes",
  GetQuotesMultiple: "quotes",
  TPSeries: "tpseries",
});

/** Documented spelling of every name the guards know, keyed in lower case. */
const CANONICAL: ReadonlyMap<string, string> = new Map(
  [...STATE_CHANGING, ...Object.keys(RATE_GROUPS)].map((name) => [name.toLowerCase(), name]),
);

const ENDPOINT_NAME = /^[A-Za-z]+$/;

/** Trim whitespace, then slashes (Python `strip().strip("/")`). */
function trimName(endpoint: string): string {
  return endpoint.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Normalise a `request()` endpoint name so the safety guards cannot be bypassed: surrounding
 * whitespace and slashes go, the rest must be ASCII letters only (else `ConfigurationError`), and a
 * known name matches case-insensitively and takes its documented spelling.
 */
export function canonicalEndpoint(name: string): EndpointInfo {
  const trimmed = trimName(name);
  if (!ENDPOINT_NAME.test(trimmed)) {
    throw new ConfigurationError(
      "endpoint must be a TradeSmart endpoint name made of ASCII letters only " +
        "(for example 'Limits'), without slashes, dots or spaces",
    );
  }
  const endpoint = CANONICAL.get(trimmed.toLowerCase()) ?? trimmed;
  const gttWord = ALERT_WORDS[endpoint];
  const iceberg = ICEBERG_ENDPOINTS.has(endpoint);
  return Object.freeze({
    endpoint,
    stateChanging: STATE_CHANGING.has(endpoint),
    rateGroup: RATE_GROUPS[endpoint] ?? null,
    successWords:
      gttWord !== undefined ? Object.freeze([gttWord]) : iceberg ? ICEBERG_WORDS : OK_WORDS,
    ignoreCase: gttWord !== undefined,
    requiresAckId: gttWord !== undefined ? "al_id" : null,
  });
}

/**
 * The non-ASCII characters whose Python `str.casefold()` is pure ASCII (found by scanning every
 * code point in Python): the long s, the sharp s in both cases, the Kelvin sign and the `ff`/`fi`/
 * `fl`/`ffi`/`ffl`/`st` ligatures. Every other non-ASCII character folds to something that is
 * not ASCII (dotless i stays itself, dotted I gives i + U+0307, fullwidth letters stay fullwidth),
 * so it can never equal an ASCII success word and needs no entry.
 */
const ASCII_FOLDS: Readonly<Record<string, string>> = Object.freeze({
  ß: "ss",
  ſ: "s",
  ẞ: "ss",
  K: "k",
  ﬀ: "ff",
  ﬁ: "fi",
  ﬂ: "fl",
  ﬃ: "ffi",
  ﬄ: "ffl",
  ﬅ: "st",
  ﬆ: "st",
});

/**
 * Case folding for comparing against an ASCII word: equal to Python `str.casefold()` whenever the
 * result is ASCII. ASCII letters are lower-cased and the characters of `ASCII_FOLDS` expand; any
 * other character is left as it is (it cannot match an ASCII word either way). This is not a
 * general Unicode case fold.
 */
function fold(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code >= 0x41 && code <= 0x5a) out += String.fromCharCode(code + 0x20);
    else out += ASCII_FOLDS[char] ?? char;
  }
  return out;
}

/**
 * Whether `stat` is the definite-failure word of the endpoint (§4.2.1): `Invalid Oi` on the GTT
 * and OCO modify and cancel only, letter case ignored, nothing trimmed.
 */
export function isFailureWord(endpoint: string, stat: unknown): boolean {
  if (typeof stat !== "string") return false;
  const word = FAILURE_WORDS[endpoint];
  return word !== undefined && fold(word) === fold(stat);
}

/**
 * Whether `stat` is a success word of the endpoint (§4.2.1). `endpoint` is a canonical name from
 * `canonicalEndpoint`. A non-string `stat` (a JSON boolean, a number, `null`) never matches; the
 * GTT words ignore letter case only (nothing trimmed or normalised); every other word is exact.
 * This is the word alone: the GTT `al_id` and `emsg` conditions are checked by the caller.
 */
export function isSuccessWord(endpoint: string, stat: unknown): boolean {
  if (typeof stat !== "string") return false;
  const info = canonicalEndpoint(endpoint);
  if (info.ignoreCase) {
    const folded = fold(stat);
    return info.successWords.some((word) => fold(word) === folded);
  }
  return info.successWords.includes(stat);
}
