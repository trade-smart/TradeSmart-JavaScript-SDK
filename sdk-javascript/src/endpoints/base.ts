// Shared pieces of the read endpoint modules (sdk-behaviour.md §2.3, §4.3), mirroring
// sdk-python/src/tradesmart/endpoints/base.py: id checks, call specs and the list decoders.
import { fieldError, ResponseParseError } from "../errors.js";
import type { CallSpec } from "../lib/call.js";
import type { ClassifyResult } from "../lib/classify.js";
import type { WirePayload } from "../lib/codec.js";
import type { RateGroup } from "../lib/names.js";
import { redactedBody } from "../lib/redact.js";
import type { ParseContext } from "../models/base.js";

/** A generated model parser. */
export type Parser<T> = (wire: unknown, ctx?: ParseContext) => T;

/**
 * `value` when it is a string, else a `RequestValidationError` with `loc [field]`. Every value on
 * the wire is a string and ids (order numbers, instrument tokens) are strings in this SDK: a
 * number is never converted (it would travel as a JSON number).
 */
export function requireStr(value: unknown, field: string): string {
  if (typeof value !== "string") throw fieldError(field, "string_type", "must be a string");
  return value;
}

/** How a read call differs from another; the rest of its `CallSpec` is the same for every read. */
export interface ReadOptions<T> {
  endpoint: string;
  payload: WirePayload;
  expect?: "object" | "list";
  allowEmpty?: boolean;
  rateGroup?: RateGroup | null;
  decode: (result: ClassifyResult) => T;
  signal?: AbortSignal | undefined;
}

/** A read call: never state-changing, authenticated, retried by the call path (§5.1). */
export function readSpec<T>(o: ReadOptions<T>): CallSpec<T> {
  return {
    endpoint: o.endpoint,
    payload: o.payload,
    stateChanging: false,
    expect: o.expect ?? "object",
    allowEmpty: o.allowEmpty ?? false,
    rateGroup: o.rateGroup ?? null,
    decode: o.decode,
    signal: o.signal,
  };
}

function parseError(endpoint: string, what: string, body: unknown): ResponseParseError {
  return new ResponseParseError(`${endpoint}: ${what}`, {
    endpoint,
    httpStatus: null,
    body: redactedBody(body),
  });
}

/** Decode a success object into one model. */
export function objectDecoder<T>(
  parse: Parser<T>,
  endpoint: string,
): (result: ClassifyResult) => T {
  return (result) => {
    if (result.kind !== "ok") throw parseError(endpoint, "response has no data", null);
    return parse(result.body, { endpoint });
  };
}

/** Decode a success list into models; the empty signal and a bare `[]` are an empty list. */
export function listDecoder<T>(
  parse: Parser<T>,
  endpoint: string,
): (result: ClassifyResult) => readonly T[] {
  return (result) => {
    if (result.kind === "empty") return Object.freeze([]);
    const body = result.body;
    if (!Array.isArray(body)) throw parseError(endpoint, "expected a JSON list", body);
    return Object.freeze((body as unknown[]).map((item) => parse(item, { endpoint })));
  };
}

/**
 * Decode `{"stat":"Ok","values":[...]}` into models (`SearchScrip`, `GetOptionChain`). The empty
 * signal and a bare `[]` are an empty list, as Python's `_parse_values`.
 */
export function valuesDecoder<T>(
  parse: Parser<T>,
  endpoint: string,
): (result: ClassifyResult) => readonly T[] {
  return (result) => {
    if (result.kind === "empty") return Object.freeze([]);
    const body = result.body;
    if (Array.isArray(body) && body.length === 0) return Object.freeze([]);
    const values =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)["values"]
        : undefined;
    if (!Array.isArray(values)) throw parseError(endpoint, "response has no 'values' list", body);
    return Object.freeze((values as unknown[]).map((item) => parse(item, { endpoint })));
  };
}
