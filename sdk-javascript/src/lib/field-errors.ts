/**
 * Internal signal of the response field parsers: a wire value cannot be read as its field type.
 * The model engine catches it and decides (null a lenient field, fail the record with a
 * `ResponseParseError`); it never reaches the caller. The message never holds the value.
 */
export class FieldParseError extends Error {
  override name = "FieldParseError";

  constructor(readonly expected: string) {
    super(`invalid ${expected}`);
  }
}
