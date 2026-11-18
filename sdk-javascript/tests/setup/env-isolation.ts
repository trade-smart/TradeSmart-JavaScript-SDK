// Pure helper behind token-isolation.ts, kept apart so a unit test can exercise both branches.
import path from "node:path";

/**
 * Default run: delete every TRADESMART_* variable and point TRADESMART_TOKEN_FILE into `tokenDir`.
 * Live run (TRADESMART_LIVE_TESTS=1): leave the environment alone, so the live suites see the
 * credentials and the real saved login. Returns true when the isolation was applied.
 */
export function isolateEnv(env: NodeJS.ProcessEnv, tokenDir: string): boolean {
  if (env["TRADESMART_LIVE_TESTS"] === "1") return false;
  for (const key of Object.keys(env)) {
    if (key.startsWith("TRADESMART_")) Reflect.deleteProperty(env, key);
  }
  env["TRADESMART_TOKEN_FILE"] = path.join(tokenDir, "token.json");
  return true;
}
