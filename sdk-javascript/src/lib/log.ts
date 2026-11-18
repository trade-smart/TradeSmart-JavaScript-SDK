// Pluggable logging (design 7.5): the library logs through a caller-supplied `Logger`, never
// through `console`. The default is a no-op; `makeLog` redacts everything before it is passed on.
import { redactObject, redactText } from "./redact.js";

/** The logger names of the library (children of the root `tradesmart`). */
export type LoggerName =
  | "tradesmart"
  | "tradesmart.transport"
  | "tradesmart.orders"
  | "tradesmart.stream"
  | "tradesmart.instruments";

/** Structured context of one log call; `logger` always names the emitting logger. */
export interface LogContext {
  logger: LoggerName;
  [key: string]: unknown;
}

/** What the caller plugs in (pino, winston, `console` wrapped, ...). */
export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
}

/** The default logger: drops everything. */
export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

type Level = "debug" | "info" | "warn" | "error";

/**
 * A logger that redacts the message and the context (secrets per sdk-behaviour 13) before
 * passing them to `logger`, tagged with `name`. A logger that throws never breaks the library.
 */
export function makeLog(logger: Logger, name: LoggerName): Logger {
  const emit =
    (level: Level) =>
    (msg: string, ctx?: Record<string, unknown>): void => {
      try {
        const redacted = ctx === undefined ? {} : redactObject(ctx);
        const safe = typeof redacted === "object" ? (redacted as Record<string, unknown>) : {};
        logger[level](redactText(msg, Number.POSITIVE_INFINITY), { ...safe, logger: name });
      } catch {
        // A failing sink must not disturb the call that logged.
      }
    };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}
