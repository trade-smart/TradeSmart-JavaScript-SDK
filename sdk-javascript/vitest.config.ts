import { defineConfig } from "vitest/config";

import { liveRunSettings } from "./tests/setup/live-mode.js";

// Live suites are included only for TRADESMART_LIVE_TESTS=1, then run in one worker, one file at
// a time (like the Python SDK's `-n 0`), and a live run in watch mode is refused.
const settings = liveRunSettings(process.env, process.argv);

export default defineConfig({
  test: {
    include: settings.include,
    exclude: settings.exclude,
    setupFiles: ["tests/setup/network-block.ts", "tests/setup/token-isolation.ts"],
    pool: "forks",
    // The slowest offline tests read the whole test tree or the built SDK, or start a child Node
    // process: 1-3 s warm, but past vitest's 5 s default on a cold or loaded machine (right after
    // `npm ci && npm run build`, under coverage, or next to another suite), which failed them
    // with "Test timed out in 5000ms". No test relies on the limit to detect anything.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: settings.fileParallelism,
    ...(settings.maxWorkers === undefined ? {} : { maxWorkers: settings.maxWorkers }),
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text"],
      // Floor set at the end of phase 1 from the measured values (94.64 / 91.08 / 96.89 / 96.85),
      // rounded down; raise it when coverage rises, never lower it.
      thresholds: { statements: 94, branches: 91, functions: 96, lines: 96 },
    },
  },
});
