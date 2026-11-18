// Generates src/models/generated/ from specifications/models.json (design spec §7.3).
//   docker compose run --rm dev npm run gen:models
// Output: one file per model `group` (records go to the file of their `module`), `enums.ts` and
// `index.ts`. The files hold ModelSpec data and thin `parseX` wrappers around `parseModel`; the
// output is deterministic and prettier-formatted. `tests/unit/models-generated.test.ts` fails
// when the committed files are stale.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format, resolveConfig } from "prettier";

const HEADER =
  "// GENERATED from specifications/models.json by scripts/gen-models.ts — do not edit";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_DIR = path.join(ROOT, "src", "models", "generated");
const MODELS_JSON = path.resolve(ROOT, "..", "specifications", "models.json");
/** Module of the SDK error classes, as seen from `src/models/generated/`. */
const ERRORS_MODULE = "../../errors.js";

interface ModelField {
  name: string;
  wire: string;
  type: string;
  required: boolean;
  lenient: boolean;
  protected: boolean;
  secret: boolean;
  nullable: boolean;
  default: string | null;
}

interface Model {
  name: string;
  group: string;
  description: string;
  lenient: boolean;
  stream_types: string[];
  extends: string | null;
  fields: ModelField[];
}

interface RecordField {
  name: string;
  type: string;
  nullable: boolean;
}

interface RecordSpec {
  name: string;
  module: string;
  description: string;
  fields: RecordField[];
}

interface EnumMember {
  name: string;
  wire?: string;
  value?: string;
  aliases: string[];
}

interface EnumSpec {
  name: string;
  members: EnumMember[];
}

interface ModelsJson {
  format: number;
  models: Model[];
  records: RecordSpec[];
  enums: EnumSpec[];
  value_enums: EnumSpec[];
}

/** Field types of `models.json` that map to one parser each. */
const SCALARS: Readonly<Record<string, { ts: string; spec: string; decimal?: true }>> = {
  Price: { ts: "Decimal", spec: "T.Price", decimal: true },
  StreamPrice: { ts: "Decimal", spec: "T.StreamPrice", decimal: true },
  Volume: { ts: "Decimal", spec: "T.Volume", decimal: true },
  Quantity: { ts: "number", spec: "T.Quantity" },
  EpochTime: { ts: "Date", spec: "T.EpochTime" },
  ISTDateTime: { ts: "Date", spec: "T.ISTDateTime" },
  datetime: { ts: "Date", spec: "T.datetime" },
  str: { ts: "string", spec: "T.str" },
  "secret str": { ts: "Secret", spec: "T.secret" },
  object: { ts: "Readonly<Record<string, unknown>>", spec: "T.object" },
};

/** Types of the `records` (results computed by the SDK, never parsed from the wire). */
const RECORD_SCALARS: Readonly<Record<string, string>> = {
  Decimal: "Decimal",
  float: "number",
  int: "number",
  bool: "boolean",
  str: "string",
  datetime: "Date",
  object: "Readonly<Record<string, unknown>>",
  TradeSmartError: "TradeSmartError",
};

/** snake_case to camelCase; leading and trailing underscores are dropped. */
export function camelCase(name: string): string {
  const parts = name.replace(/^_+|_+$/g, "").split(/_+/);
  return parts
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

function doc(text: string): string {
  return `/** ${text.replace(/\*\//g, "*\\/")} */`;
}

function quote(text: string): string {
  return JSON.stringify(text);
}

/** One import statement (none when nothing is used); `import type` when only types are. */
function importLine(values: Set<string>, types: Set<string>, from: string): string[] {
  const valueNames = [...values].sort();
  const typeNames = [...types].filter((name) => !values.has(name)).sort();
  if (valueNames.length === 0 && typeNames.length === 0) return [];
  if (valueNames.length === 0) return [`import type { ${typeNames.join(", ")} } from "${from}";`];
  const names = [...valueNames, ...typeNames.map((name) => `type ${name}`)];
  return [`import { ${names.join(", ")} } from "${from}";`];
}

/** Per-file import bookkeeping. */
class Imports {
  readonly base = new Set<string>();
  readonly baseTypes = new Set<string>();
  readonly enums = new Set<string>();
  readonly enumTypes = new Set<string>();
  readonly decimal = { used: false };
  readonly errors = { used: false };
  /** file → names (value) and type names. */
  readonly local = new Map<string, { values: Set<string>; types: Set<string> }>();

  localFrom(file: string): { values: Set<string>; types: Set<string> } {
    let entry = this.local.get(file);
    if (entry === undefined) {
      entry = { values: new Set(), types: new Set() };
      this.local.set(file, entry);
    }
    return entry;
  }

  render(): string {
    const lines: string[] = [];
    if (this.decimal.used) lines.push(`import type { Decimal } from "../../lib/decimal.js";`);
    if (this.errors.used) lines.push(`import type { TradeSmartError } from "${ERRORS_MODULE}";`);
    lines.push(...importLine(this.base, this.baseTypes, "../base.js"));
    lines.push(...importLine(this.enums, this.enumTypes, "./enums.js"));
    for (const file of [...this.local.keys()].sort()) {
      const entry = this.localFrom(file);
      lines.push(...importLine(entry.values, entry.types, `./${file.replace(/\.ts$/, ".js")}`));
    }
    return lines.join("\n");
  }
}

interface Context {
  /** model or record name → its output file. */
  fileOf: Map<string, string>;
  models: Map<string, Model>;
  wireEnums: Set<string>;
  valueEnums: Set<string>;
}

function fail(message: string): never {
  throw new Error(`models.json: ${message}`);
}

function listItem(type: string): string | null {
  const match = /^list\[(.+)\]$/.exec(type);
  return match?.[1] ?? null;
}

/** TypeScript type and spec expression of a model field type. */
function modelFieldType(
  type: string,
  file: string,
  ctx: Context,
  imports: Imports,
  where: string,
): { ts: string; spec: string } {
  const scalar = SCALARS[type];
  if (scalar !== undefined) {
    if (scalar.decimal === true) imports.decimal.used = true;
    if (scalar.ts === "Secret") imports.baseTypes.add("Secret");
    imports.base.add("T");
    return { ts: scalar.ts, spec: scalar.spec };
  }
  const enumMatch = /^enum (\w+)$/.exec(type);
  if (enumMatch?.[1] !== undefined) {
    const name = enumMatch[1];
    if (!ctx.wireEnums.has(name)) fail(`${where}: unknown wire enum ${name}`);
    imports.enums.add(name);
    imports.baseTypes.add("OpenEnum");
    imports.base.add("T");
    return { ts: `OpenEnum<${name}>`, spec: `T.enum(${name})` };
  }
  const item = listItem(type);
  if (item !== null) {
    const inner = modelFieldType(item, file, ctx, imports, where);
    return { ts: `readonly ${inner.ts}[]`, spec: `T.list(${inner.spec})` };
  }
  if (ctx.models.has(type)) {
    const target = ctx.fileOf.get(type) ?? fail(`${where}: no file for ${type}`);
    if (target !== file) {
      const entry = imports.localFrom(target);
      entry.values.add(`parse${type}`);
      entry.types.add(type);
    }
    imports.base.add("T");
    return { ts: type, spec: `T.model(parse${type})` };
  }
  return fail(`${where}: unknown type ${type}`);
}

/** TypeScript type of a record field type. */
function recordFieldType(
  type: string,
  file: string,
  ctx: Context,
  imports: Imports,
  where: string,
): string {
  const scalar = RECORD_SCALARS[type];
  if (scalar !== undefined) {
    if (scalar === "Decimal") imports.decimal.used = true;
    if (scalar === "TradeSmartError") imports.errors.used = true;
    return scalar;
  }
  const enumMatch = /^enum (\w+)$/.exec(type);
  if (enumMatch?.[1] !== undefined) {
    const name = enumMatch[1];
    if (ctx.valueEnums.has(name)) {
      imports.enumTypes.add(name);
      return name;
    }
    if (ctx.wireEnums.has(name)) {
      imports.enumTypes.add(name);
      imports.baseTypes.add("OpenEnum");
      return `OpenEnum<${name}>`;
    }
    return fail(`${where}: unknown enum ${name}`);
  }
  const item = listItem(type);
  if (item !== null) return `readonly ${recordFieldType(item, file, ctx, imports, where)}[]`;
  const dict = /^dict\[(.+), (.+)\]$/.exec(type);
  if (dict?.[1] !== undefined && dict[2] !== undefined) {
    // Decimal keys are keyed by their decimal text (design spec §7.3).
    const key =
      dict[1] === "Decimal" ? "string" : recordFieldType(dict[1], file, ctx, imports, where);
    const value = recordFieldType(dict[2], file, ctx, imports, where);
    return `ReadonlyMap<${key}, ${value}>`;
  }
  const target = ctx.fileOf.get(type);
  if (target !== undefined && !ctx.models.has(type)) {
    if (target !== file) imports.localFrom(target).types.add(type);
    return type;
  }
  return fail(`${where}: unknown type ${type}`);
}

function checkNames(owner: string, names: string[]): void {
  const seen = new Set<string>(["raw", "extra"]);
  for (const name of names) {
    if (seen.has(name)) fail(`${owner}: duplicate or reserved property ${name}`);
    seen.add(name);
  }
}

function renderModel(model: Model, file: string, ctx: Context, imports: Imports): string {
  imports.base.add("parseModel");
  imports.baseTypes.add("ModelSpec");
  imports.baseTypes.add("ParseContext");
  checkNames(
    model.name,
    model.fields.map((field) => camelCase(field.name)),
  );
  const wires = new Set<string>();
  const members: string[] = [];
  const specs: string[] = [];
  for (const field of model.fields) {
    const where = `${model.name}.${field.name}`;
    if (wires.has(field.wire)) fail(`${where}: duplicate wire key ${field.wire}`);
    wires.add(field.wire);
    if (field.default !== null && typeof field.default !== "string") {
      fail(`${where}: only string defaults are supported`);
    }
    const name = camelCase(field.name);
    const { ts, spec } = modelFieldType(field.type, file, ctx, imports, where);
    const nullable = field.nullable;
    if (!nullable && !field.required && field.default === null) {
      fail(`${where}: a non-nullable optional field needs a default`);
    }
    members.push(doc(`Wire key \`${field.wire}\`.`));
    members.push(`readonly ${name}: ${ts}${nullable ? " | null" : ""};`);
    const flags = [`name: ${quote(name)}`, `wire: ${quote(field.wire)}`, `type: ${spec}`];
    if (field.required) flags.push("required: true");
    if (!nullable) flags.push("nullable: false");
    if (field.lenient) flags.push("lenient: true");
    if (field.protected) flags.push("protected: true");
    if (field.default !== null) flags.push(`default: ${quote(field.default)}`);
    specs.push(`{ ${flags.join(", ")} },`);
  }
  members.push(doc("The wire object as received (shallow copy, redacted, frozen)."));
  members.push("readonly raw: Readonly<Record<string, unknown>>;");
  members.push(doc("Wire keys this model does not name, with their values."));
  members.push("readonly extra: Readonly<Record<string, unknown>>;");
  const lenient = model.lenient ? " Lenient record." : "";
  return [
    doc(`${model.description}${lenient}`),
    `export interface ${model.name} {`,
    ...members,
    "}",
    "",
    doc(`Field specification of \`${model.name}\`.`),
    `export const ${model.name}Spec: ModelSpec = {`,
    `name: ${quote(model.name)},`,
    "fields: [",
    ...specs,
    "],",
    "};",
    "",
    doc(`Parse one \`${model.name}\` wire record.`),
    `export function parse${model.name}(wire: unknown, ctx?: ParseContext): ${model.name} {`,
    `return parseModel(${model.name}Spec, wire, ctx) as ${model.name};`,
    "}",
  ].join("\n");
}

function renderRecord(record: RecordSpec, file: string, ctx: Context, imports: Imports): string {
  checkNames(
    record.name,
    record.fields.map((field) => camelCase(field.name)),
  );
  const members: string[] = [];
  for (const field of record.fields) {
    const ts = recordFieldType(field.type, file, ctx, imports, `${record.name}.${field.name}`);
    members.push(`readonly ${camelCase(field.name)}: ${ts}${field.nullable ? " | null" : ""};`);
  }
  return [doc(record.description), `export interface ${record.name} {`, ...members, "}"].join("\n");
}

function renderStreamParsers(models: Model[], imports: Imports): string {
  imports.baseTypes.add("ModelParser");
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    for (const t of model.stream_types) {
      if (seen.has(t)) fail(`stream type ${t} is listed twice`);
      seen.add(t);
      entries.push(`${quote(t)}: parse${model.name},`);
    }
  }
  return [
    doc("Parser of each stream message type (`t`)."),
    "export const STREAM_MESSAGE_PARSERS: Readonly<Record<string, ModelParser>> = Object.freeze({",
    ...entries,
    "});",
  ].join("\n");
}

function renderEnums(spec: ModelsJson): string {
  const out: string[] = [];
  const lookups: string[] = [];
  for (const e of spec.enums) {
    const members = e.members.map(
      (m) => `${m.name}: ${quote(m.wire ?? fail(`${e.name}.${m.name}: no wire`))},`,
    );
    out.push(
      `export const ${e.name} = Object.freeze({`,
      ...members,
      "} as const);",
      `export type ${e.name} = (typeof ${e.name})[keyof typeof ${e.name}];`,
      "",
    );
    // Accepted words (upper case) → wire code: the wire codes first, then the listed words.
    const table = new Map<string, string>();
    for (const m of e.members) {
      const wire = m.wire ?? "";
      if (table.has(wire.toUpperCase())) fail(`${e.name}: duplicate wire code ${wire}`);
      table.set(wire.toUpperCase(), wire);
    }
    for (const m of e.members) {
      for (const alias of m.aliases) {
        const key = alias.toUpperCase();
        const existing = table.get(key);
        if (existing !== undefined && existing !== m.wire)
          fail(`${e.name}: ambiguous word ${alias}`);
        table.set(key, m.wire ?? "");
      }
    }
    const rows = [...table.entries()].map(([key, wire]) => `${quote(key)}: ${quote(wire)},`);
    lookups.push(`${e.name}: {`, ...rows, "},");
  }
  for (const e of spec.value_enums) {
    const members = e.members.map(
      (m) => `${m.name}: ${quote(m.value ?? fail(`${e.name}.${m.name}: no value`))},`,
    );
    out.push(
      doc("Returned by the SDK, never sent: values are exact (case-sensitive)."),
      `export const ${e.name} = Object.freeze({`,
      ...members,
      "} as const);",
      `export type ${e.name} = (typeof ${e.name})[keyof typeof ${e.name}];`,
      "",
    );
  }
  out.push(
    doc(
      "Request lookups of the wire enums: each accepted word (upper case) to its wire code (sdk-behaviour.md §7.3).",
    ),
    "export const ENUM_LOOKUP = {",
    ...lookups,
    "} as const satisfies Readonly<Record<string, Readonly<Record<string, string>>>>;",
  );
  return out.join("\n");
}

function parseSpec(text: string): ModelsJson {
  const spec = JSON.parse(text) as Partial<ModelsJson>;
  if (spec.format !== 1) fail(`unsupported format ${String(spec.format)}`);
  if (
    !Array.isArray(spec.models) ||
    !Array.isArray(spec.records) ||
    !Array.isArray(spec.enums) ||
    !Array.isArray(spec.value_enums)
  ) {
    fail("models, records, enums and value_enums must be arrays");
  }
  return spec as ModelsJson;
}

/** Generate the files of `src/models/generated/` (name → content) from `models.json` text. */
export async function generate(input: string | Uint8Array): Promise<Map<string, string>> {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  const spec = parseSpec(text);
  const ctx: Context = {
    fileOf: new Map(),
    models: new Map(spec.models.map((model) => [model.name, model])),
    wireEnums: new Set(spec.enums.map((e) => e.name)),
    valueEnums: new Set(spec.value_enums.map((e) => e.name)),
  };
  const groups = new Map<string, { models: Model[]; records: RecordSpec[] }>();
  const groupOf = (name: string): { models: Model[]; records: RecordSpec[] } => {
    let group = groups.get(name);
    if (group === undefined) {
      group = { models: [], records: [] };
      groups.set(name, group);
    }
    return group;
  };
  for (const model of spec.models) {
    if (ctx.fileOf.has(model.name)) fail(`duplicate name ${model.name}`);
    ctx.fileOf.set(model.name, `${model.group}.ts`);
    groupOf(model.group).models.push(model);
  }
  for (const record of spec.records) {
    if (ctx.fileOf.has(record.name)) fail(`duplicate name ${record.name}`);
    ctx.fileOf.set(record.name, `${record.module}.ts`);
    groupOf(record.module).records.push(record);
  }
  const streamFiles = new Set(
    spec.models.filter((m) => m.stream_types.length > 0).map((m) => `${m.group}.ts`),
  );
  if (streamFiles.size > 1) fail("stream message models span more than one group");

  const raw = new Map<string, string>();
  for (const [group, { models, records }] of groups) {
    const file = `${group}.ts`;
    if (file === "enums.ts" || file === "index.ts") fail(`reserved group name ${group}`);
    const imports = new Imports();
    const parts = [
      ...models.map((model) => renderModel(model, file, ctx, imports)),
      ...records.map((record) => renderRecord(record, file, ctx, imports)),
    ];
    if (streamFiles.has(file)) parts.push(renderStreamParsers(models, imports));
    raw.set(
      file,
      [HEADER, imports.render(), "", ...parts.flatMap((part) => [part, ""])].join("\n"),
    );
  }
  raw.set("enums.ts", [HEADER, "", renderEnums(spec)].join("\n"));
  const modules = ["enums.ts", ...[...groups.keys()].map((group) => `${group}.ts`).sort()];
  raw.set(
    "index.ts",
    [HEADER, ...modules.map((file) => `export * from "./${file.replace(/\.ts$/, ".js")}";`)].join(
      "\n",
    ),
  );

  const config = (await resolveConfig(path.join(GENERATED_DIR, "index.ts"))) ?? {};
  const files = new Map<string, string>();
  for (const name of [...raw.keys()].sort()) {
    const source = raw.get(name) ?? "";
    files.set(name, await format(source, { ...config, parser: "typescript" }));
  }
  return files;
}

async function main(): Promise<void> {
  const files = await generate(readFileSync(MODELS_JSON));
  mkdirSync(GENERATED_DIR, { recursive: true });
  for (const name of readdirSync(GENERATED_DIR)) {
    if (!files.has(name)) rmSync(path.join(GENERATED_DIR, name));
  }
  for (const [name, content] of files) writeFileSync(path.join(GENERATED_DIR, name), content);
  process.stdout.write(`gen-models: wrote ${String(files.size)} files to src/models/generated/\n`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) await main();
