import { afterEach, describe, expect, it, vi } from "vitest";
import { makeLog, noopLogger, type LogContext, type Logger } from "../../src/lib/log.js";

interface Call {
  level: string;
  msg: string;
  ctx: LogContext | undefined;
}

function capture(): { logger: Logger; calls: Call[] } {
  const calls: Call[] = [];
  const at =
    (level: string) =>
    (msg: string, ctx?: LogContext): void => {
      calls.push({ level, msg, ctx });
    };
  return {
    calls,
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("makeLog", () => {
  it("redacts the message and tags the context with the logger name", () => {
    const { logger, calls } = capture();
    makeLog(logger, "tradesmart.orders").info("tok=Bearer xyz");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.level).toBe("info");
    expect(calls[0]?.msg).toBe("tok=Bearer ***");
    expect(calls[0]?.ctx?.logger).toBe("tradesmart.orders");
  });

  it("redacts the context values and keeps the logger name authoritative", () => {
    const { logger, calls } = capture();
    makeLog(logger, "tradesmart.transport").warn("m", {
      logger: "tradesmart.stream",
      access_token: "abc",
      note: "Bearer q",
      status: 500,
    });
    expect(calls[0]?.ctx).toEqual({
      logger: "tradesmart.transport",
      access_token: "***",
      note: "Bearer ***",
      status: 500,
    });
  });

  it("forwards all four levels", () => {
    const { logger, calls } = capture();
    const log = makeLog(logger, "tradesmart");
    log.debug("a");
    log.info("b");
    log.warn("c");
    log.error("d");
    expect(calls.map((c) => c.level)).toEqual(["debug", "info", "warn", "error"]);
  });

  it("never lets a throwing logger break the caller", () => {
    const thrower: Logger = {
      debug: () => {
        throw new Error("boom");
      },
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    expect(() => {
      makeLog(thrower, "tradesmart").debug("x");
    }).not.toThrow();
  });
});

describe("noopLogger", () => {
  it("writes nothing to console", () => {
    const spies = (["debug", "info", "warn", "error", "log"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    noopLogger.debug("a");
    noopLogger.info("b", { logger: "tradesmart" });
    noopLogger.warn("c");
    noopLogger.error("d");
    makeLog(noopLogger, "tradesmart.stream").error("e");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
