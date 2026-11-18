import { fieldError } from "../errors.js";

const TIME_MSG = 'expected a Date, integer epoch seconds or { date: "YYYY-MM-DD" }';

/** IST is a fixed UTC+05:30 (no daylight saving, no tz database needed). */
export const IST_OFFSET_MS = 5.5 * 3_600_000;

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** The instant of an IST wall-clock time, or `null` when the calendar fields do not exist. */
function istInstant(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date | null {
  if (h > 23 || mi > 59 || s > 59) return null;
  const utc = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Date.UTC accepts years 0-99 as 1900+ and rolls 31 Feb over; refuse both.
  if (
    utc.getUTCFullYear() !== y ||
    utc.getUTCMonth() !== mo - 1 ||
    utc.getUTCDate() !== d ||
    y < 100
  ) {
    return null;
  }
  return new Date(utc.getTime() - IST_OFFSET_MS);
}

// The five documented IST text formats of models.md, tried in order.
const TIME_FIRST = /^(\d{1,2}):(\d{1,2}):(\d{1,2}) (\d{1,2})-(\d{1,2})-(\d{4})$/;
const DATE_FIRST = /^(\d{1,2})-(\d{1,2})-(\d{4}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/;
const SLASH = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/;
const DATE_ONLY = /^(\d{1,2})-(\d{1,2})-(\d{4})$/;
const MONTH_NAME = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/;

function nums(m: RegExpExecArray, ...idx: number[]): number[] {
  return idx.map((i) => Number(m[i]));
}

/** Parse one of the documented IST formats (already trimmed); `null` when none matches. */
export function parseIstText(text: string): Date | null {
  let m: RegExpExecArray | null;
  if ((m = TIME_FIRST.exec(text))) {
    const [h, mi, s, d, mo, y] = nums(m, 1, 2, 3, 4, 5, 6) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    return istInstant(y, mo, d, h, mi, s);
  }
  if ((m = DATE_FIRST.exec(text)) ?? (m = SLASH.exec(text))) {
    const [d, mo, y, h, mi, s] = nums(m, 1, 2, 3, 4, 5, 6) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    return istInstant(y, mo, d, h, mi, s);
  }
  if ((m = DATE_ONLY.exec(text))) {
    const [d, mo, y] = nums(m, 1, 2, 3) as [number, number, number];
    return istInstant(y, mo, d);
  }
  if ((m = MONTH_NAME.exec(text))) {
    const mo = MONTHS[(m[2] ?? "").toLowerCase()];
    if (mo === undefined) return null;
    const [d, y] = nums(m, 1, 3) as [number, number];
    return istInstant(y, mo, d);
  }
  return null;
}

const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar date as the request-time input form (00:00 IST that day). */
export function istDate(text: string): { date: string } {
  const m = DATE_TEXT.exec(text);
  if (m === null || istInstant(Number(m[1]), Number(m[2]), Number(m[3])) === null) {
    throw fieldError("time", "time_type", TIME_MSG);
  }
  return { date: text };
}

/**
 * A request time to epoch seconds: a `Date` (fraction truncated), a safe-integer `number`, or
 * `{ date: "YYYY-MM-DD" }` (00:00 IST). Anything else throws a `RequestValidationError` with `loc [field]`
 */
export function toEpochSeconds(input: unknown, field = "time"): number {
  if (input instanceof Date) {
    const ms = input.getTime();
    if (Number.isNaN(ms)) throw fieldError(field, "time_type", TIME_MSG);
    return Math.floor(ms / 1000);
  }
  if (typeof input === "number") {
    if (!Number.isSafeInteger(input)) throw fieldError(field, "time_type", TIME_MSG);
    return input;
  }
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const keys = Object.keys(input);
    const date = (input as { date?: unknown }).date;
    if (keys.length === 1 && keys[0] === "date" && typeof date === "string") {
      const m = DATE_TEXT.exec(date);
      const instant = m && istInstant(Number(m[1]), Number(m[2]), Number(m[3]));
      if (instant) return instant.getTime() / 1000;
    }
  }
  throw fieldError(field, "time_type", TIME_MSG);
}
