// Pure decisions behind the live-run switch (TRADESMART_LIVE_TESTS=1), kept apart from
// vitest.config.ts and network-block.ts so a unit test can assert them without a live run.

/** A live run is requested only by the exact value `1`. */
export function liveEnabled(env: NodeJS.ProcessEnv): boolean {
  return env["TRADESMART_LIVE_TESTS"] === "1";
}

/** The network block (tests/setup/network-block.ts) is lifted only for a live run. */
export function networkBlockEnabled(env: NodeJS.ProcessEnv): boolean {
  return !liveEnabled(env);
}

export interface LiveRunSettings {
  live: boolean;
  include: string[];
  exclude: string[];
  fileParallelism: boolean;
  /** Set to 1 for a live run; left to vitest otherwise. */
  maxWorkers?: number;
}

// A live run must be an explicit one-shot run: vitest defaults to watch mode in a terminal, and
// an endlessly re-running live suite would hammer the real service.
function isOneShotRun(argv: readonly string[]): boolean {
  const args = argv.slice(2);
  const watching = args.some(
    (a) => a === "watch" || a === "-w" || a === "--watch" || a === "--watch=true",
  );
  if (watching) return false;
  return args.some((a) => a === "run" || a === "--run" || a === "--watch=false");
}

/**
 * Test-file selection and worker settings. Default run: the live folders are excluded and files
 * run in parallel. Live run: only tests/live is selected, run in one worker one file at a time (the
 * counterpart of the Python SDK's `-n 0`), and watch mode is refused.
 */
export function liveRunSettings(env: NodeJS.ProcessEnv, argv: readonly string[]): LiveRunSettings {
  if (!liveEnabled(env)) {
    return {
      live: false,
      include: ["tests/**/*.test.ts"],
      exclude: ["node_modules/**", "tests/live/**", "tests/live_orders/**"],
      fileParallelism: true,
    };
  }
  if (!isOneShotRun(argv)) {
    throw new Error(
      "a live run (TRADESMART_LIVE_TESTS=1) is refused in watch mode: use `vitest run`",
    );
  }
  // tests/live_orders/** stays excluded: `vitest run tests/live` is a substring filter and would
  // match it, and order tests need their own opt-in and gate, never this read-only switch.
  return {
    live: true,
    include: ["tests/live/**/*.test.ts"],
    exclude: ["node_modules/**", "tests/live_orders/**"],
    fileParallelism: false,
    maxWorkers: 1,
  };
}
