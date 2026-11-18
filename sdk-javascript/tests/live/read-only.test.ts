// Read-only smoke tests against the real service. Opt-in: this folder is part of a run only with
// TRADESMART_LIVE_TESTS=1 (vitest.config.ts), and the owner starts it after logging in:
//   TRADESMART_LIVE_TESTS=1 docker compose run --rm dev npx vitest run tests/live
// Only read methods are used (tests/unit/live-scan.test.ts enforces it). A closed market or a
// missing contract skips a test with the reason; it never fails one. Observations (shapes and
// latencies, ids as *_matches) go to the gitignored .live-results/ and never into the output.
import { beforeAll, describe, expect, it, type TestContext } from "vitest";
import {
  Exchange,
  NotFoundError,
  TradeSmart,
  TradeSmartStream,
  type ScripMatch,
} from "../../src/index.js";
import { liveEnabled } from "../setup/live-mode.js";
import { record, shapeOf } from "./recorder.js";

const SUITE = "readonly";
const STREAM_WAIT_MS = 10_000;

// ctx.skip is typed void; this one is `never`, so the code after it is narrowed.
function skip(ctx: TestContext, reason: string): never {
  ctx.skip(reason);
  throw new Error(`skipped: ${reason}`);
}

describe.skipIf(!liveEnabled(process.env))("live read-only", () => {
  let client!: TradeSmart; // built in beforeAll: a skipped suite must not need credentials
  let ownIds: string[] = [];
  beforeAll(() => {
    client = TradeSmart.fromEnv();
    ownIds = [client.clientId];
  });

  async function observe<T>(test: string, call: () => Promise<T>): Promise<T> {
    const started = performance.now();
    const result = await call();
    const ms = Math.round(performance.now() - started);
    record(SUITE, test, { ms, shape: shapeOf(result, ownIds) }, { ownIds });
    return result;
  }

  // "No data" (a 404 or an empty answer) is an account or market condition, not a failure.
  async function readOrSkip<T>(ctx: TestContext, test: string, call: () => Promise<T>): Promise<T> {
    try {
      return await observe(test, call);
    } catch (error) {
      if (error instanceof NotFoundError) skip(ctx, `${test}: no data (${error.name})`);
      throw error;
    }
  }

  async function infyEquity(ctx: TestContext): Promise<ScripMatch & { token: string }> {
    const matches = await observe("searchInstruments", () => client.searchInstruments("INFY"));
    const match = matches.find(
      (m) => m.exchange === "NSE" && (m.tradingsymbol ?? "").endsWith("-EQ") && m.token !== null,
    );
    if (match?.token == null) skip(ctx, "no NSE -EQ match for INFY in the search results");
    return { ...match, token: match.token };
  }

  it("profile", async () => {
    const details = await observe("profile", () => client.profile());
    expect(details.stat).toBe("Ok");
  });

  it("margins", async () => {
    const limits = await observe("margins", () => client.margins());
    expect(limits.stat).toBe("Ok");
  });

  it("positions", async (ctx) => {
    expect(Array.isArray(await readOrSkip(ctx, "positions", () => client.positions()))).toBe(true);
  });

  it("holdings", async (ctx) => {
    expect(Array.isArray(await readOrSkip(ctx, "holdings", () => client.holdings()))).toBe(true);
  });

  it("orders and the history of the first order", async (ctx) => {
    const orders = await readOrSkip(ctx, "orders", () => client.orders());
    expect(Array.isArray(orders)).toBe(true);
    const first = orders[0];
    if (first?.orderId == null) skip(ctx, "the order book is empty: no order history to read");
    const history = await readOrSkip(ctx, "orderHistory", () =>
      client.orderHistory(first.orderId ?? ""),
    );
    expect(Array.isArray(history)).toBe(true);
  });

  it("trades", async (ctx) => {
    expect(Array.isArray(await readOrSkip(ctx, "trades", () => client.trades()))).toBe(true);
  });

  it("pending and triggered GTTs and the alert types", async (ctx) => {
    expect(Array.isArray(await readOrSkip(ctx, "pendingGtts", () => client.pendingGtts()))).toBe(
      true,
    );
    expect(
      Array.isArray(await readOrSkip(ctx, "triggeredGtts", () => client.triggeredGtts())),
    ).toBe(true);
    expect(
      Array.isArray(await readOrSkip(ctx, "gttAlertTypes", () => client.gttAlertTypes())),
    ).toBe(true);
  });

  it("search and quote", async (ctx) => {
    const match = await infyEquity(ctx);
    const quote = await observe("quote", () => client.quote(Exchange.NSE, match.token));
    expect(quote.stat).toBe("Ok");
  });

  it("security info", async (ctx) => {
    const match = await infyEquity(ctx);
    const info = await readOrSkip(ctx, "securityInfo", () =>
      client.securityInfo(Exchange.NSE, match.token),
    );
    expect(info.stat).toBe("Ok");
  });

  it("intraday and daily history", async (ctx) => {
    const match = await infyEquity(ctx);
    const to = new Date();
    const from = new Date(to.getTime() - 10 * 24 * 3600 * 1000);
    const candles = await readOrSkip(ctx, "historicalData", () =>
      client.historicalData(Exchange.NSE, match.token, { interval: 5, fromDate: from, toDate: to }),
    );
    expect(Array.isArray(candles)).toBe(true);
    const daily = await readOrSkip(ctx, "dailyHistory", () =>
      client.dailyHistory(Exchange.NSE, match.tradingsymbol ?? "INFY-EQ", from, to),
    );
    expect(Array.isArray(daily)).toBe(true);
  });

  describe.each(["NSE", "NFO", "MCX"] as const)("script master %s", (exchange) => {
    it("downloads and has the columns the SDK relies on", async () => {
      const file = await observe(`downloadInstruments:${exchange}`, () =>
        client.downloadInstruments(exchange),
      );
      const rows = await observe(`instruments:${exchange}`, () => client.instruments(exchange));
      const columns = Object.keys(rows[0] ?? {});
      record(SUITE, `script_master:${exchange}`, {
        file: file.split(/[\\/]/).pop(),
        rows: rows.length,
        columns,
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const column of ["Token", "TradingSymbol"]) expect(columns).toContain(column);
    });
  });

  it("option chain of the nearest NIFTY expiry", async (ctx) => {
    const rows = await observe("instruments:NFO", () => client.instruments("NFO"));
    const today = new Date().toISOString().slice(0, 10);
    const options = rows
      .filter(
        (r) =>
          (r["Symbol"] ?? "").toUpperCase() === "NIFTY" &&
          (r["Instrument"] ?? "").toUpperCase().startsWith("OPT") &&
          (r["OptionType"] ?? "").toUpperCase() === "CE",
      )
      .map((r) => ({ row: r, expiry: parseExpiry(r["Expiry"]) }))
      .filter(
        (o): o is { row: Record<string, string>; expiry: string } =>
          o.expiry !== null && o.expiry >= today,
      );
    if (options.length === 0) skip(ctx, "no unexpired NIFTY option in the NFO script master");
    const nearest = options.map((o) => o.expiry).sort()[0];
    const strikes = options.filter((o) => o.expiry === nearest);
    const middle = strikes[Math.floor(strikes.length / 2)]?.row;
    const symbol = middle?.["TradingSymbol"];
    const strike = middle?.["StrikePrice"] ?? middle?.["Strike"];
    if (symbol === undefined || strike === undefined) skip(ctx, "the option row has no strike");
    const chain = await readOrSkip(ctx, "optionChain", () =>
      client.optionChain("NFO", symbol, strike, 2),
    );
    expect(Array.isArray(chain)).toBe(true);
  });

  it("stream: a touchline tick for one NSE token", async (ctx) => {
    const match = await infyEquity(ctx);
    let ticks = 0;
    const state: { error: Error | null } = { error: null };
    const stream = TradeSmartStream.fromEnv({
      onTouchline: (message) => {
        if (message.t === "tf") ticks += 1; // a feed update; the subscription ack is not a tick
      },
      onError: (error: Error) => {
        state.error = error;
      },
    });
    const started = performance.now();
    try {
      await stream.connect();
      await stream.subscribeTouchline([[Exchange.NSE, match.token]]);
      const deadline = Date.now() + STREAM_WAIT_MS;
      while (ticks === 0 && state.error === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } finally {
      await stream.close();
    }
    const ms = Math.round(performance.now() - started);
    record(SUITE, "stream_touchline", {
      ms,
      ticks,
      snapshot: shapeOf(stream.snapshot([Exchange.NSE, match.token])),
    });
    expect(state.error).toBeNull();
    if (ticks === 0)
      skip(ctx, `no touchline tick within ${String(STREAM_WAIT_MS / 1000)} s (market closed?)`);
    expect(ticks).toBeGreaterThan(0);
  });
});

/** `DD-MON-YYYY` (any case) as `YYYY-MM-DD`, or null when blank or unparseable. */
function parseExpiry(text: string | undefined): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec((text ?? "").trim());
  if (m === null) return null;
  const months = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ];
  const month = months.indexOf((m[2] ?? "").toUpperCase());
  if (month < 0) return null;
  return `${m[3] ?? ""}-${String(month + 1).padStart(2, "0")}-${(m[1] ?? "").padStart(2, "0")}`;
}
