// The one generic model engine (sdk-behaviour.md §7): the generated `parseX` functions hand their
// `ModelSpec` data to `parseModel`, which applies the field types, required fields, leniency,
// protected keys, nested models, `extra` and a frozen, redacted `raw`.
import { inspect } from "node:util";
import { ResponseParseError } from "../errors.js";
import { maskKeys, redactedBody } from "../lib/redact.js";
import {
  parseEnum,
  parseEpochTime,
  parseIstDateTime,
  parsePrice,
  parseQuantity,
  parseStr,
  parseStreamPrice,
  parseVolume,
  type EnumParser,
} from "../lib/fieldtypes.js";

/** A secret string (`secret str`): prints as `***` everywhere; `reveal()` returns the value. */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The secret value itself. Never log it. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "***";
  }

  toJSON(): string {
    return "***";
  }

  [Symbol.toPrimitive](): string {
    return "***";
  }

  [inspect.custom](): string {
    return "***";
  }
}

/** A wire enum field: a known member, or the original string when the value is unknown. */
export type OpenEnum<E extends string> = E | (string & Record<never, never>);

/** Hooks of one parse; every one is optional. */
export interface ParseContext {
  /** Endpoint named in errors (default: the model name). */
  readonly endpoint?: string;
  /**
   * Extra masking of every record's `raw`, applied after the engine's own: every redacted key of
   * sdk-behaviour 13 (any case, any depth) and every `secret` field are always masked first, and
   * again after this hook, so the hook can only add to the masking.
   */
  readonly redact?: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown>;
  /** Called once per record whose lenient fields failed and became null (wire keys, never values). */
  readonly onLenientFields?: (model: string, wireKeys: readonly string[]) => void;
  /** Called once per unrecognised date-time shape (digits as `9`, never the value). */
  readonly onUnknownTimeShape?: (shape: string) => void;
}

/** A parser of one generated model. */
export type ModelParser = (wire: unknown, ctx?: ParseContext) => object;

/** The type of one model field (the closed vocabulary of `models.json`). */
export type FieldType =
  | {
      readonly kind:
        | "Price"
        | "StreamPrice"
        | "Volume"
        | "Quantity"
        | "EpochTime"
        | "ISTDateTime"
        | "str"
        | "secret"
        | "datetime"
        | "object";
    }
  | { readonly kind: "enum"; readonly parse: EnumParser }
  | { readonly kind: "list"; readonly item: FieldType }
  | { readonly kind: "model"; readonly parse: ModelParser };

/** Field types used by the generated specs. */
export const T = {
  Price: { kind: "Price" },
  StreamPrice: { kind: "StreamPrice" },
  Volume: { kind: "Volume" },
  Quantity: { kind: "Quantity" },
  EpochTime: { kind: "EpochTime" },
  ISTDateTime: { kind: "ISTDateTime" },
  str: { kind: "str" },
  secret: { kind: "secret" },
  datetime: { kind: "datetime" },
  object: { kind: "object" },
  enum: (values: Readonly<Record<string, string>>): FieldType => ({
    kind: "enum",
    parse: parseEnum(new Set(Object.values(values))),
  }),
  list: (item: FieldType): FieldType => ({ kind: "list", item }),
  model: (parse: ModelParser): FieldType => ({ kind: "model", parse }),
} as const satisfies Record<string, FieldType | ((...args: never[]) => FieldType)>;

/** One field of a model; flags left out take the usual value. */
export interface FieldSpec {
  /** camelCase property name. */
  readonly name: string;
  /** Wire key. */
  readonly wire: string;
  readonly type: FieldType;
  /** Must be present (default false). */
  readonly required?: boolean;
  /** May be null (default true). */
  readonly nullable?: boolean;
  /** A failure nulls the field instead of failing the record (default false). */
  readonly lenient?: boolean;
  /** An identity key: a failure always fails the record (default false). */
  readonly protected?: boolean;
  /** Value when the wire key is absent (default null). */
  readonly default?: string;
}

export interface ModelSpec {
  readonly name: string;
  readonly fields: readonly FieldSpec[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class FieldFailure extends Error {
  constructor(readonly paths: readonly string[]) {
    super("field failure");
  }
}

function parseValue(type: FieldType, value: unknown, ctx: ParseContext): unknown {
  switch (type.kind) {
    case "Price":
      return parsePrice(value);
    case "StreamPrice":
      return parseStreamPrice(value);
    case "Volume":
      return parseVolume(value);
    case "Quantity":
      return parseQuantity(value);
    case "EpochTime":
      return parseEpochTime(value);
    case "ISTDateTime":
      return parseIstDateTime(value, ctx.onUnknownTimeShape);
    case "str":
      return parseStr(value);
    case "enum":
      return type.parse(value);
    case "secret":
      if (value === null || value === undefined) return null;
      if (typeof value !== "string") throw new FieldFailure([]);
      return new Secret(value);
    case "datetime":
      if (value === null || value === undefined) return null;
      if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new FieldFailure([]);
      return value;
    case "object":
      if (value === null || value === undefined) return null;
      if (!isRecord(value)) throw new FieldFailure([]);
      return Object.freeze({ ...value });
    case "list":
      return parseList(type.item, value, ctx);
    case "model":
      return parseNested(type.parse, value, ctx);
  }
}

function parseList(item: FieldType, value: unknown, ctx: ParseContext): unknown {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw new FieldFailure([]);
  const items = (value as unknown[]).map((element, index) => {
    try {
      const parsed = parseValue(item, element, ctx);
      if (parsed === null) throw new FieldFailure([]);
      return parsed;
    } catch (error) {
      throw new FieldFailure(subPaths(String(index), error));
    }
  });
  return Object.freeze(items);
}

function parseNested(parse: ModelParser, value: unknown, ctx: ParseContext): unknown {
  if (value === null || value === undefined) return null;
  return parse(value, ctx);
}

/** Dotted paths below `prefix` named by a nested failure. */
function subPaths(prefix: string, error: unknown): string[] {
  const inner =
    error instanceof FieldFailure
      ? error.paths
      : error instanceof ResponseParseError
        ? error.fields
        : [];
  return inner.length === 0 ? [prefix] : inner.map((path) => `${prefix}.${path}`);
}

function parseFailure(
  spec: ModelSpec,
  wire: unknown,
  fields: readonly string[],
  protectedKey: boolean,
  endpoint: string | null,
): ResponseParseError {
  const subject = endpoint ?? spec.name;
  return new ResponseParseError(
    fields.length === 0
      ? `Could not parse ${subject} response (expected a JSON object)`
      : `Could not parse ${subject} response (fields: ${fields.join(", ")})`,
    {
      endpoint: subject,
      httpStatus: null,
      body: redactedBody(wire),
      model: spec.name,
      fields,
      protectedKey,
    },
  );
}

/**
 * Parse one wire record by its spec. Throws `ResponseParseError` (never with values) when the wire
 * value is not a JSON object, a required field is missing, a protected key fails, or a strict
 * field fails; a failing lenient field becomes null (its value stays in `raw`).
 */
export function parseModel(spec: ModelSpec, wire: unknown, ctx: ParseContext = {}): object {
  const endpoint = ctx.endpoint ?? null;
  if (!isRecord(wire)) throw parseFailure(spec, wire, [], false, endpoint);
  const result: Record<string, unknown> = {};
  const failed: string[] = [];
  const nulled: string[] = [];
  let protectedFailed = false;
  for (const field of spec.fields) {
    const value = wire[field.wire];
    if (value === undefined) {
      if (field.required === true) failed.push(field.wire);
      result[field.name] = field.default ?? null;
      continue;
    }
    let parsed: unknown;
    let paths: string[] | null = null;
    try {
      parsed = parseValue(field.type, value, ctx);
      if (parsed === null && field.nullable === false) paths = [field.wire];
    } catch (error) {
      paths = subPaths(field.wire, error);
    }
    if (paths === null) {
      result[field.name] = parsed;
    } else if (field.protected === true) {
      protectedFailed = true;
      failed.push(...paths);
    } else if (field.lenient === true && field.nullable !== false) {
      result[field.name] = null;
      nulled.push(field.wire);
    } else {
      failed.push(...paths);
    }
  }
  if (failed.length > 0) {
    throw parseFailure(spec, wire, [...failed].sort(), protectedFailed, endpoint);
  }
  if (nulled.length > 0) ctx.onLenientFields?.(ctx.endpoint ?? spec.name, nulled);
  const known = new Set(spec.fields.map((field) => field.wire));
  // fromEntries defines own properties, so a wire key `__proto__` never sets the prototype.
  const extra = Object.fromEntries(Object.entries(wire).filter(([key]) => !known.has(key)));
  // `extra` keeps the wire values as they are, like the reference SDK's `model_extra`.
  const secretKeys = spec.fields.filter((f) => f.type.kind === "secret").map((f) => f.wire);
  const masked = maskKeys(wire, secretKeys);
  result["raw"] = Object.freeze(ctx.redact ? maskKeys(ctx.redact(masked), secretKeys) : masked);
  result["extra"] = Object.freeze(extra);
  return Object.freeze(result);
}
