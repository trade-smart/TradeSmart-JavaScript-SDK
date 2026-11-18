// The one place a conformance case may be skipped. A case is skipped only when its input cannot be
// represented in JavaScript at all; every conformance test skips through `skipInexpressible`.

/** Vector case id `"<file>:<case name>"` to the reason it cannot run in JavaScript. */
export const INEXPRESSIBLE: Readonly<Record<string, string>> = {
  "config_defaults.json:max_retries_float_is_rejected": "JavaScript cannot tell 2.0 from 2",
  "config_defaults.json:max_connections_float_is_rejected": "JavaScript cannot tell 2.0 from 2",
  "config_defaults.json:script_master_recheck_minutes_float_is_rejected":
    "JavaScript cannot tell 2.0 from 2",
  "config_defaults.json:order_rate_limit_per_second_float_is_rejected":
    "JavaScript cannot tell 2.0 from 2",
};

/** The reason a case is skipped, or `undefined` when it must run. */
export function inexpressibleReason(file: string, caseName: string): string | undefined {
  return INEXPRESSIBLE[`${file}:${caseName}`];
}

/**
 * Assert that `file:caseName` is a listed inexpressible case. Call it before skipping a case; it
 * throws when the case is not in `INEXPRESSIBLE`, so a case can never be skipped unlisted.
 */
export function skipInexpressible(file: string, caseName: string): void {
  if (inexpressibleReason(file, caseName) === undefined) {
    throw new Error(`conformance case ${file}:${caseName} is not listed in INEXPRESSIBLE`);
  }
}
