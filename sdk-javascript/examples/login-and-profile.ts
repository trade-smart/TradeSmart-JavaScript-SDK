// Your first call: who am I, and how much cash do I have? Read-only; nothing is placed.
//
// Credentials: `TradeSmart.fromEnv()` uses the login you saved once today (`npx tradesmart login`
// or the Python SDK's `python -m tradesmart login`, see docs/getting-started.md), or
// TRADESMART_CLIENT_ID together with TRADESMART_ACCESS_TOKEN. No keys or tokens appear in this file.
//
// Run it from a project that has `tradesmart` installed (Node 22.18 or newer, or Node 24):
//   node login-and-profile.ts
import { AuthenticationError, ConfigurationError, TradeSmart } from "tradesmart";

try {
  const client = TradeSmart.fromEnv();
  try {
    const profile = await client.profile();
    console.log(`Logged in as ${profile.uname ?? "unknown"} (${profile.userId ?? "unknown"})`);
    const limits = await client.margins();
    console.log(`Cash balance: ${limits.cash?.toFixed(2) ?? "not reported"}`);
  } finally {
    await client.close();
  }
} catch (error) {
  if (error instanceof ConfigurationError || error instanceof AuthenticationError) {
    // No saved login, an expired one (tokens end at 06:00 IST) or a refused token.
    console.error(`Cannot log in: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
