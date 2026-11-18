// What the login CLI needs from its surroundings, injected so tests never touch the real process,
// terminal, browser or network. `main.ts` wires the real `process` into it.
import type { Dispatcher } from "undici";
import type { ClientConfigInit } from "../config.js";

/** Ctrl-C (or an interrupt) while the CLI waited for the user. */
export class CliCancelled extends Error {
  override name = "CliCancelled";
  constructor() {
    super("Cancelled.");
  }
}

export interface PromptOptions {
  /** False for secrets: nothing typed is shown. */
  echo: boolean;
}

export interface CliIo {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** The user's home folder (for `~` and the default token folder). */
  home: string;
  /** The working folder (relative paths are made absolute against it). */
  cwd: string;
  /** One line of normal output (no newline). */
  stdout(line: string): void;
  /** One line of warning or error output (no newline). */
  stderr(line: string): void;
  /** Ask a question; `null` when the input has ended. Rejects with `CliCancelled` on Ctrl-C. */
  prompt(question: string, options: PromptOptions): Promise<string | null>;
  /** Try to open `url` in a browser; whether one was launched. */
  openBrowser(url: string): Promise<boolean>;
  now(): Date;
  /** The undici dispatcher used for `GenAcsTok` (tests pass a mock). */
  httpDispatcher?: Dispatcher;
  /** Client configuration (tests point it at a mock host). */
  config?: ClientConfigInit;
  /** How long to wait for the redirect, default 120 000 ms. */
  callbackTimeoutMs?: number;
  /** Aborted on Ctrl-C (SIGINT) outside a prompt. */
  interrupt?: AbortSignal;
}

export type ExitCode = 0 | 1 | 2;

const REASONS: Readonly<Record<string, string>> = {
  EADDRINUSE: "address already in use",
  EADDRNOTAVAIL: "address not available",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  EISDIR: "is a directory",
  ENOTDIR: "not a directory",
  ENOTEMPTY: "directory not empty",
  EEXIST: "file exists",
  ENOENT: "no such file or directory",
  EROFS: "read-only file system",
  ENOSPC: "no space left on device",
};

/** An operating-system error in words (never the raw message, which can carry paths). */
export function errnoReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string") return REASONS[code] ?? code;
  return error instanceof Error ? error.name : "error";
}
