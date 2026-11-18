// The tagged "open an account" link shown to people who have no TradeSmart account yet.
// Every place that shows it builds the URL here, so the tags stay identical.

const SIGNUP_BASE = "https://signup.tradesmartonline.in/";

/** Where the link is shown: each place gets its own `utm_content` tag. */
export const SIGNUP_PLACES: ReadonlySet<string> = new Set([
  "readme",
  "registry",
  "getting_started",
  "registry_sidebar",
  "cli",
]);

/** The signup URL tagged with this SDK and the place it is shown (one of `SIGNUP_PLACES`). */
export function signupUrl(place: string): string {
  if (!SIGNUP_PLACES.has(place)) {
    throw new RangeError(`Unknown signup link place: ${JSON.stringify(place)}`);
  }
  const query = new URLSearchParams([
    ["utm_source", "TypeScriptSDK"],
    ["utm_medium", "Organic"],
    ["utm_campaign", "SDK_Open_Demat"],
    ["utm_content", place],
    ["channel", "Organic"],
    ["platform", "web"],
  ]);
  return `${SIGNUP_BASE}?${query.toString()}`;
}
