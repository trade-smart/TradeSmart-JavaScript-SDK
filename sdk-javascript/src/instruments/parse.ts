// Script-master parsing (sdk-behaviour.md §8.3; Python: instruments.py `_load`). Header-based only:
// no column name is assumed. The CSV rules are Python's `csv` module's (RFC 4180 style, non-strict).
import { ResponseParseError } from "../errors.js";

/** The endpoint name script-master errors carry. */
export const SCRIPT_MASTER_ENDPOINT = "script_master";

/** One data row: header cell to value, all strings. */
export type ScriptMasterRow = Readonly<Record<string, string>>;

/** Python's `csv.field_size_limit()` default. */
const FIELD_LIMIT = 131_072;
const SAMPLE_CHARS = 4096;
const DELIMITERS = [",", "|", "\t", ";"] as const;
// The breaks Python's `str.splitlines()` knows (written as a string so the escapes stay escapes).
// eslint-disable-next-line no-control-regex
const LINE_BREAKS = new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]");

const QUOTE = 0x22;
const LF = 0x0a;
const CR = 0x0d;

class CsvError extends Error {}

/** A `ResponseParseError` of the script master (HTTP status 200, empty body). */
export function scriptMasterParseError(message: string): ResponseParseError {
  return new ResponseParseError(message, {
    endpoint: SCRIPT_MASTER_ENDPOINT,
    httpStatus: 200,
    body: "",
  });
}

/** The script master was removed again between its download and its parse. */
export function vanishedError(fileName: string): ResponseParseError {
  return scriptMasterParseError(
    `script master file ${fileName} was removed before it could be read; ` +
      "download the instruments again",
  );
}

/** The delimiter: the candidate most frequent in the first non-blank line, ties by order. */
function chooseDelimiter(text: string): string {
  const sample = Array.from(text.slice(0, SAMPLE_CHARS * 2))
    .slice(0, SAMPLE_CHARS)
    .join("");
  const first = sample.split(LINE_BREAKS).find((ln) => ln.trim() !== "") ?? "";
  let best: string = ",";
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const count = first.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

function checkField(field: string): string {
  if (field.length > FIELD_LIMIT) {
    throw new CsvError(`field larger than field limit (${String(FIELD_LIMIT)})`);
  }
  return field;
}

/**
 * Split `text` into records like Python's `csv.reader` (non-strict): a field starting with `"`
 * is quoted (`""` is one quote, the delimiter and line breaks are literal), a quote elsewhere is
 * literal, characters after a closing quote are appended, `\n`, `\r` and `\r\n` end a record.
 */
function records(text: string, delimiter: string): string[][] {
  const delim = delimiter.charCodeAt(0);
  const n = text.length;
  const out: string[][] = [];
  let i = 0;
  while (i < n) {
    const row: string[] = [];
    for (;;) {
      let field: string;
      if (i < n && text.charCodeAt(i) === QUOTE) {
        i += 1;
        let parts = "";
        let seg = i;
        for (;;) {
          if (i >= n) {
            field = parts + text.slice(seg, i);
            break;
          }
          if (text.charCodeAt(i) !== QUOTE) {
            i += 1;
            continue;
          }
          parts += text.slice(seg, i);
          if (i + 1 < n && text.charCodeAt(i + 1) === QUOTE) {
            parts += '"';
            i += 2;
            seg = i;
            continue;
          }
          i += 1; // the closing quote; the rest of the field up to a delimiter or break is literal
          const tail = i;
          while (i < n) {
            const c = text.charCodeAt(i);
            if (c === delim || c === LF || c === CR) break;
            i += 1;
          }
          field = parts + text.slice(tail, i);
          break;
        }
      } else {
        const start = i;
        while (i < n) {
          const c = text.charCodeAt(i);
          if (c === delim || c === LF || c === CR) break;
          i += 1;
        }
        field = text.slice(start, i);
      }
      row.push(checkField(field));
      if (i >= n) break;
      const c = text.charCodeAt(i);
      i += 1;
      if (c === delim) continue;
      if (c === CR && i < n && text.charCodeAt(i) === LF) i += 1;
      break;
    }
    out.push(row);
  }
  return out;
}

/** Parse script-master text (already decoded) into header-keyed rows. */
function parseText(text: string): ScriptMasterRow[] {
  if (text.includes("\x00")) throw new CsvError("line contains NUL");
  let header: string[] | null = null;
  const rows: ScriptMasterRow[] = [];
  for (const raw of records(text, chooseDelimiter(text))) {
    if (!raw.some((cell) => cell.trim() !== "")) continue;
    if (header === null) {
      header = raw.map((h) => h.trim());
      continue;
    }
    const names = header;
    const width = Math.min(names.length, raw.length);
    const entries: [string, string][] = [];
    for (let k = 0; k < width; k += 1) entries.push([names[k] ?? "", (raw[k] ?? "").trim()]);
    // fromEntries defines own properties (a "__proto__" header never sets the prototype);
    // with duplicate header names the last column wins.
    rows.push(Object.fromEntries(entries));
  }
  return rows;
}

/**
 * Parse a script-master file's bytes: UTF-8 with an optional BOM, then CSV. Not UTF-8 text, or
 * not valid CSV (a NUL byte, a field over the size limit), is a `ResponseParseError` that asks
 * for the file to be deleted and downloaded again. `fileName` is only used in the message.
 */
export function parseScriptMaster(bytes: Uint8Array, fileName: string): ScriptMasterRow[] {
  let text: string;
  try {
    // `ignoreBOM: false` (the default) drops one leading byte-order mark.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw scriptMasterParseError(
      `script master file ${fileName} is not valid UTF-8 text; ` +
        "delete it and download the instruments again",
    );
  }
  try {
    return parseText(text);
  } catch (e) {
    if (!(e instanceof CsvError)) throw e;
    throw scriptMasterParseError(
      `script master file ${fileName} is not a valid script master (${e.message}); ` +
        "delete it and download the instruments again",
    );
  }
}
