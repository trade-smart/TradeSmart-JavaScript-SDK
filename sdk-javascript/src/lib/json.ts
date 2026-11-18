/** A JSON number kept as its exact source text (never read through a float). */
export class JsonNumber {
  constructor(readonly text: string) {}

  toString(): string {
    return this.text;
  }
}

/**
 * The `JSON.parse` reviver of `parseJsonLossless`. A number without source text would have to be
 * a float, so it throws rather than lose precision silently.
 */
export function losslessReviver(
  _key: string,
  value: unknown,
  context?: { source?: string },
): unknown {
  if (typeof value !== "number") return value;
  if (context?.source === undefined) throw new Error("lossless JSON needs reviver source text");
  return new JsonNumber(context.source);
}

/** `JSON.parse` where every number becomes a `JsonNumber` holding its exact source text. */
export function parseJsonLossless(text: string): unknown {
  return JSON.parse(text, losslessReviver);
}
