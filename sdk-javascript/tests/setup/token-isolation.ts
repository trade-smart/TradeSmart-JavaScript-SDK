// Every default test file gets a fresh, empty temp folder for the saved login, so a default run never
// reads or writes the real saved login, and no TRADESMART_* variable from the host leaks into a
// test. Live runs (TRADESMART_LIVE_TESTS=1) keep the real environment and saved login.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { isolateEnv } from "./env-isolation.js";

if (process.env["TRADESMART_LIVE_TESTS"] !== "1") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tradesmart-test-"));
  isolateEnv(process.env, dir);
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}
