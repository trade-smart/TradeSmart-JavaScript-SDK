import { describe, expect, it } from "vitest";
import { FieldParseError, parseEpochTime, parseIstDateTime } from "../../src/lib/fieldtypes.js";
import { RequestValidationError } from "../../src/errors.js";
import { JsonNumber } from "../../src/lib/json.js";
import { istDate, toEpochSeconds } from "../../src/lib/time.js";
import { loadVector } from "./vectors.js";

interface Input {
  function: "to_epoch" | "parse_ist" | "parse_epoch";
  value: unknown;
}

function requestTime(value: unknown): unknown {
  const v = value as Record<string, unknown>;
  if (typeof v["datetime"] === "string") {
    // A naive datetime (no offset) has no JavaScript form: it stays a string and is rejected.
    return /(Z|[+-]\d\d:\d\d)$/.test(v["datetime"]) ? new Date(v["datetime"]) : v["datetime"];
  }
  if (typeof v["date"] === "string") return istDate(v["date"]);
  if (v["epoch"] instanceof JsonNumber) return Number(v["epoch"].text);
  throw new Error("unknown vector value");
}

function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

function instant(text: string | null): string | null {
  return text === null ? null : new Date(text).toISOString();
}

describe("time_conversion.json", () => {
  const vector = loadVector("time_conversion.json");
  for (const c of vector.cases) {
    it(c.name, () => {
      const input = c.input as Input;
      const expected = c.expected as Record<string, unknown>;
      const run = (): unknown => {
        switch (input.function) {
          case "to_epoch":
            return String(toEpochSeconds(requestTime(input.value)));
          case "parse_ist":
            return iso(parseIstDateTime(input.value, () => undefined));
          case "parse_epoch":
            return iso(parseEpochTime(input.value));
        }
      };
      if ("error" in expected) {
        expect(run).toThrow(
          input.function === "to_epoch" ? RequestValidationError : FieldParseError,
        );
      } else if ("epoch" in expected) {
        expect(run()).toBe(expected["epoch"]);
      } else {
        expect(run()).toBe(instant(expected["datetime"] as string | null));
      }
    });
  }
});
