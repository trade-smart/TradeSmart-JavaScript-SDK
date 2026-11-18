// The read methods against the shared success fixtures, the empty "no data" signal and the
// client-side id checks (sdk-behaviour.md §2.3, §4.3).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { APIError, RequestValidationError, ResponseParseError } from "../../src/errors.js";
import { scriptedClient, type Scripted } from "../helpers/scripted-client.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../specifications/test-fixtures",
);
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf8");
const NO_DATA = '{"stat":"Not_Ok","emsg":"Error Occurred : 5 \\"no data\\""}';

const open: Scripted[] = [];
function scripted(body: string): Scripted {
  const s = scriptedClient([{ body }]);
  open.push(s);
  return s;
}
afterEach(async () => {
  while (open.length > 0) await open.pop()?.agent.close();
});

describe("read methods against the fixtures", () => {
  it("profile", async () => {
    const u = await scripted(fixture("user_details_success.json")).client.profile();
    expect(u.userId).toBe("TEST123");
  });

  it("margins", async () => {
    const l = await scripted(fixture("limits_success.json")).client.margins();
    expect(l.raw).toBeTypeOf("object");
  });

  it("positions, holdings, orders, orderHistory, trades", async () => {
    const p = await scripted(fixture("position_book_success.json")).client.positions();
    expect(p.length).toBeGreaterThan(0);
    const h = await scripted(fixture("holdings_success.json")).client.holdings();
    expect(h.length).toBeGreaterThan(0);
    const o = await scripted(fixture("order_book_success.json")).client.orders();
    expect(o.length).toBe(13);
    const hist = await scripted(fixture("single_ord_hist_success.json")).client.orderHistory(
      "26111000000001",
    );
    expect(hist.length).toBe(2);
    const t = await scripted(fixture("trade_book_success.json")).client.trades();
    expect(t.length).toBe(2);
  });

  it("GTT reads", async () => {
    const pending = await scripted(fixture("pending_gtts_success.json")).client.pendingGtts();
    expect(pending.length).toBe(2);
    const trig = await scripted(fixture("triggered_gtts_success.json")).client.triggeredGtts();
    expect(trig.length).toBeGreaterThan(0);
    const kinds = await scripted(fixture("enabled_gtts_success.json")).client.gttAlertTypes();
    expect(kinds).toEqual(["ATP", "LTP"]);
  });

  it("searchInstruments and optionChain read the values list", async () => {
    const m = await scripted(fixture("search_scrip_success.json")).client.searchInstruments("TCS");
    expect(m.map((x) => x.tradingsymbol)).toEqual(["TCS", "TCS-EQ", "TCS30JUN26F"]);
    const chain = await scripted(fixture("option_chain_success.json")).client.optionChain(
      "NFO",
      "X",
      "2300",
      2,
    );
    expect(chain.length).toBe(4);
  });

  it("quote and securityInfo", async () => {
    const q = await scripted(fixture("get_quotes_success.json")).client.quote("NSE", "2885");
    expect(q.lastPrice).toBeInstanceOf(Decimal);
    const si = await scripted(fixture("security_info_success.json")).client.securityInfo(
      "NSE",
      "2885",
    );
    expect(si.raw).toBeTypeOf("object");
  });

  it("historicalData and dailyHistory", async () => {
    const c = await scripted(fixture("tpseries_success.json")).client.historicalData("NSE", "22");
    expect(c.length).toBe(5);
    expect(c[0]?.into).toBeInstanceOf(Decimal);
    const d = await scripted(fixture("eod_chart_success.json")).client.dailyHistory(
      "NSE",
      "X-EQ",
      { date: "2023-08-01" },
      { date: "2023-08-04" },
    );
    expect(d.length).toBe(3);
    expect(d[0]?.intc?.toFixed()).toBe("573.3");
  });

  it("EODChartData accepts element objects and rejects an element that is not JSON", async () => {
    const ok = await scripted('[{"into":"1.5","ssboe":"1691107200"}]').client.dailyHistory(
      "NSE",
      "X",
      1,
      2,
    );
    expect(ok.length).toBe(1);
    const bad = scripted('["not json"]');
    await expect(bad.client.dailyHistory("NSE", "X", 1, 2)).rejects.toBeInstanceOf(
      ResponseParseError,
    );
  });
});

describe("the empty signal", () => {
  const lists: [string, (s: Scripted) => Promise<readonly unknown[]>][] = [
    ["positions", (s) => s.client.positions()],
    ["holdings", (s) => s.client.holdings()],
    ["orders", (s) => s.client.orders()],
    ["orderHistory", (s) => s.client.orderHistory("1")],
    ["trades", (s) => s.client.trades()],
    ["pendingGtts", (s) => s.client.pendingGtts()],
    ["triggeredGtts", (s) => s.client.triggeredGtts()],
    ["gttAlertTypes", (s) => s.client.gttAlertTypes()],
    ["searchInstruments", (s) => s.client.searchInstruments("ZZZ")],
    ["optionChain", (s) => s.client.optionChain("NFO", "X", "1", 1)],
    ["historicalData", (s) => s.client.historicalData("NSE", "22")],
    ["dailyHistory", (s) => s.client.dailyHistory("NSE", "X", 1, 2)],
  ];
  for (const [name, call] of lists) {
    it(`${name}: Not_Ok "no data" is []`, async () => {
      expect(await call(scripted(NO_DATA))).toEqual([]);
    });
  }

  // A bare [] is empty for the object-expecting allow-empty endpoints too.
  const bare: [string, (s: Scripted) => Promise<readonly unknown[]>][] = [
    ["searchInstruments", (s) => s.client.searchInstruments("ZZZ")],
    ["optionChain", (s) => s.client.optionChain("NFO", "X", "1", 1)],
    ["gttAlertTypes", (s) => s.client.gttAlertTypes()],
    ["positions", (s) => s.client.positions()],
  ];
  for (const [name, call] of bare) {
    it(`${name}: a bare [] is []`, async () => {
      expect(await call(scripted("[]"))).toEqual([]);
    });
  }

  it("an Ok object without ai_ts has no alert types", async () => {
    expect(await scripted('{"stat":"Ok"}').client.gttAlertTypes()).toEqual([]);
  });

  it("an Ok object without a values list is a ResponseParseError", async () => {
    await expect(scripted('{"stat":"Ok"}').client.searchInstruments("A")).rejects.toBeInstanceOf(
      ResponseParseError,
    );
  });

  it("an object read gets no empty signal: no data is an APIError", async () => {
    await expect(scripted(NO_DATA).client.margins()).rejects.toBeInstanceOf(APIError);
    await expect(scripted(NO_DATA).client.quote("NSE", "1")).rejects.toBeInstanceOf(APIError);
  });
});

describe("client-side checks send nothing", () => {
  it("quote with a numeric token is a RequestValidationError on token", async () => {
    const s = scripted("{}");
    const error = await s.client.quote("NSE", 2885 as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestValidationError);
    expect((error as RequestValidationError).errors[0]?.loc).toEqual(["token"]);
    expect(s.sends).toBe(0);
  });

  it("every id parameter must be a string", async () => {
    const s = scripted("{}");
    const calls: [string, () => Promise<unknown>][] = [
      ["token", () => s.client.securityInfo("NSE", 1 as never)],
      ["token", () => s.client.historicalData("NSE", 1 as never)],
      ["norenordno", () => s.client.orderHistory(1 as never)],
      ["stext", () => s.client.searchInstruments(1 as never)],
      ["tsym", () => s.client.dailyHistory("NSE", 1 as never, 1, 2)],
      ["tsym", () => s.client.optionChain("NFO", 1 as never, "1", 1)],
    ];
    for (const [loc, call] of calls) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RequestValidationError);
      expect((error as RequestValidationError).errors[0]?.loc).toEqual([loc]);
    }
    expect(s.sends).toBe(0);
  });

  it("an aborted signal sends nothing", async () => {
    const s = scripted("[]");
    const ac = new AbortController();
    ac.abort();
    await expect(s.client.positions({ signal: ac.signal })).rejects.toBeDefined();
    await expect(s.client.holdings({ signal: ac.signal })).rejects.toBeDefined();
    await expect(s.client.historicalData("NSE", "22", { signal: ac.signal })).rejects.toBeDefined();
    expect(s.sends).toBe(0);
  });
});
