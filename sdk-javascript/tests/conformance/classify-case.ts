// Shared runner for the two classification vector files (not_ok_classification.json and
// success_words.json): classify `input.body` and assert the expected result or error.
import { expect } from "vitest";
import { classifyResponse } from "../../src/lib/classify.js";
import { canonicalEndpoint } from "../../src/lib/names.js";
import { APIError, OrderStatusUnknownError, ResponseParseError } from "../../src/errors.js";
import { JsonNumber } from "../../src/lib/json.js";
import type { VectorCase } from "./vectors.js";

interface Input {
  allow_empty?: boolean;
  body: string;
  endpoint: string;
  expect: "object" | "list";
  http_status: JsonNumber;
  state_changing?: boolean;
}
interface Expected {
  error?: string;
  emsg?: string | null;
  message?: string;
  returns?: unknown;
}

export function runClassifyCase(c: VectorCase, successWordsFile: boolean): void {
  const input = c.input as Input;
  const expected = c.expected as Expected;
  const info = canonicalEndpoint(input.endpoint);
  const httpStatus = Number(input.http_status.text);
  const call = (): unknown =>
    classifyResponse({
      endpoint: input.endpoint,
      httpStatus,
      bodyText: input.body,
      // success_words.json: state-changing as the endpoint is, allow_empty false.
      stateChanging: successWordsFile ? info.stateChanging : input.state_changing === true,
      expect: input.expect,
      allowEmpty: successWordsFile ? false : input.allow_empty === true,
    });

  if (expected.error === undefined) {
    const result = call() as { kind: string; body?: unknown };
    expect(result.kind === "ok" || result.kind === "empty").toBe(true);
    const returned = result.kind === "empty" ? [] : result.body;
    expect(returned).toEqual(expected.returns);
    return;
  }

  let thrown: unknown;
  try {
    call();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, "an error is expected").toBeInstanceOf(Error);
  const error = thrown as Error;
  expect(error.name).toBe(expected.error);
  if (expected.message !== undefined) expect(error.message).toBe(expected.message);
  if (error instanceof APIError) {
    expect(error.httpStatus).toBe(httpStatus);
    if ("emsg" in expected) expect(error.emsg).toBe(expected.emsg);
  } else if (error instanceof OrderStatusUnknownError || error instanceof ResponseParseError) {
    expect(error.httpStatus).toBe(httpStatus);
    expect("emsg" in expected, "a vector gives emsg for a non-API error").toBe(false);
  }
}
