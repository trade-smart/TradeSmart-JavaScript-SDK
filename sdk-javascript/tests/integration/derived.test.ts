// `optionGreeks`, `optionChainSnapshot` and `buildup` through a real client: REST replies are routed
// by endpoint (and token) by an undici MockAgent, the script master is a synthetic file in a
// private folder, and the clock is pinned (sdk-behaviour.md §10.7, §11.3, §11.4).
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { TradeSmart } from "../../src/client.js";
import { ClientConfig } from "../../src/config.js";
import { Buildup } from "../../src/enums.js";
import { AuthenticationError, ResponseParseError } from "../../src/errors.js";
import { maxPain, pcr } from "../../src/analytics/index.js";
import { instrumentsContext } from "../../src/instruments/download.js";
import { callContext } from "../../src/lib/call.js";
import { RateLimiter } from "../../src/lib/ratelimit.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { BASE_URL, ORIGIN, TOKEN } from "../helpers/scripted-client.js";
import { SM_ORIGIN } from "../helpers/script-master-client.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../specifications/test-fixtures",
);
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf8");

const NOW = new Date("2026-11-10T10:00:00+05:30");

const MASTER = [
  "Exchange,Token,LotSize,Symbol,TradingSymbol,Instrument,Expiry,StrikePrice,OptionType,TickSize,",
  "NFO,1,65,NIFTY,NIFTY26NOVFUT,FUTIDX,26-NOV-2026,,,0.05,",
  "NFO,2,65,NIFTY,NIFTY26DECFUT,FUTIDX,31-DEC-2026,,,0.05,",
  "NFO,3,65,NIFTY,NIFTY26NOV24000CE,OPTIDX,26-NOV-2026,24000.00,CE,0.05,",
  "NFO,4,65,NIFTY,NIFTY05NOV24000CE,OPTIDX,05-NOV-2026,24000.00,CE,0.05,",
  "NFO,5,65,NIFTY,NIFTY26DEC24000PE,OPTIDX,31-DEC-2026,24000.00,PE,0.05,",
  "NFO,6,65,NIFTY,NIFTY12NOV24000CE,OPTIDX,12-NOV-2026,24000.00,CE,0.05,",
  "",
].join("\n");

const NOT_OK = '{"stat":"Not_Ok","emsg":"Error Occurred : 5 \\"no data\\""}';
const SESSION = '{"stat":"Not_Ok","emsg":"Session Expired :  Invalid Session Key"}';

interface Sent {
  endpoint: string;
  data: Record<string, string>;
}
interface Reply {
  status?: number;
  body: string;
  delayMs?: number;
}
type Handler = (sent: Sent) => Reply;

interface Rig {
  client: TradeSmart;
  sent: Sent[];
  quoted: () => string[];
  smRequests: number;
  inFlight: { max: number };
}

const dirs: string[] = [];
const agents: MockAgent[] = [];
const clients: TradeSmart[] = [];
afterEach(async () => {
  while (clients.length > 0) await clients.pop()?.close();
  while (agents.length > 0) await agents.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function quoteBody(fields: Record<string, string>): string {
  return JSON.stringify({ stat: "Ok", ...fields });
}

function rig(handler: Handler, master = MASTER): Rig {
  const dir = mkdtempSync(path.join(tmpdir(), "tradesmart-derived-"));
  dirs.push(dir);
  const file = path.join(dir, "NFO_symbols.txt");
  writeFileSync(file, master);
  const stamp = new Date("2026-11-10T08:00:00+05:30");
  utimesSync(file, stamp, stamp);

  const sent: Sent[] = [];
  const state = { smRequests: 0 };
  const inFlight = { now: 0, max: 0 };
  const agent = new MockAgent();
  agent.disableNetConnect();
  agents.push(agent);
  agent
    .get(ORIGIN)
    .intercept({ path: () => true, method: "POST" })
    .reply(async (opts) => {
      const raw =
        typeof opts.body === "string"
          ? opts.body
          : new TextDecoder().decode(opts.body as Uint8Array);
      const item: Sent = {
        endpoint: opts.path.split("/").pop() as string,
        data: JSON.parse(raw.slice("jData=".length)) as Record<string, string>,
      };
      sent.push(item);
      inFlight.now += 1;
      inFlight.max = Math.max(inFlight.max, inFlight.now);
      try {
        const reply = handler(item);
        if (reply.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
        }
        return { statusCode: reply.status ?? 200, data: reply.body };
      } finally {
        inFlight.now -= 1;
      }
    })
    .persist();
  agent
    .get(SM_ORIGIN)
    .intercept({ path: () => true, method: "GET" })
    .reply(() => {
      state.smRequests += 1;
      return { statusCode: 500, data: "" };
    })
    .persist();

  const config = ClientConfig.create({
    baseUrl: BASE_URL,
    scriptMasterBaseUrl: SM_ORIGIN,
    instrumentsDir: dir,
    backoffBase: 1e-6,
    backoffCap: 1e-6,
  });
  const client = new TradeSmart("TEST123", {
    accessToken: TOKEN,
    config,
    httpDispatcher: agent,
  });
  clients.push(client);
  const ctx = callContext(client);
  const clock = new FakeClock();
  ctx.clock = clock;
  ctx.limiter = new RateLimiter(config, clock);
  instrumentsContext(client).now = () => NOW;
  return {
    client,
    sent,
    quoted: () => sent.filter((s) => s.endpoint === "GetQuotes").map((s) => s.data["token"] ?? ""),
    get smRequests() {
      return state.smRequests;
    },
    inFlight,
  };
}

/** GetQuotes replies by token; any other endpoint is a failure of the test. */
function byToken(lp: Record<string, string | null>, extra: Record<string, Reply> = {}): Handler {
  return (s) => {
    if (s.endpoint !== "GetQuotes") throw new Error(`unexpected ${s.endpoint}`);
    const token = s.data["token"] ?? "";
    const special = extra[token];
    if (special !== undefined) return special;
    const price = lp[token];
    if (price === undefined) return { body: NOT_OK };
    return { body: quoteBody(price === null ? { token } : { token, lp: price }) };
  };
}

describe("optionGreeks call order (§10.7)", () => {
  it("checks rates and prices before any request", async () => {
    const r = rig(byToken({}));
    const g = (o: object): Promise<unknown> => r.client.optionGreeks("NFO", "NIFTY26NOV24000CE", o);
    await expect(g({ rate: Number.NaN })).rejects.toThrow(/rate must be a finite number/);
    await expect(g({ rate: Infinity })).rejects.toBeInstanceOf(RangeError);
    await expect(g({ rate: "0.06" })).rejects.toBeInstanceOf(RangeError);
    await expect(g({ rate: null })).rejects.toBeInstanceOf(RangeError);
    await expect(g({ dividendYield: Number.NaN })).rejects.toThrow(/dividendYield/);
    await expect(g({ optionPrice: true })).rejects.toThrow(/optionPrice must be a finite number/);
    await expect(g({ underlyingPrice: "abc" })).rejects.toThrow(/underlyingPrice/);
    await expect(g({ spotPrice: {} })).rejects.toThrow(/spotPrice/);
    await expect(g({ spotPrice: 24000, underlyingPrice: 24000 })).rejects.toThrow(/not both/);
    expect(r.sent).toHaveLength(0);
    expect(r.smRequests).toBe(0);
  });

  it("quotes the future, then the option (two GetQuotes) and uses the same-expiry future as is", async () => {
    const r = rig(byToken({ "1": "24100.00", "3": "420.00" }));
    const g = await r.client.optionGreeks("nfo", "nifty26nov24000ce");
    expect(r.quoted()).toEqual(["1", "3"]);
    expect(r.sent).toHaveLength(2);
    expect(g.model).toBe("black76");
    expect(g.optionTradingsymbol).toBe("NIFTY26NOV24000CE");
    expect(g.underlyingTradingsymbol).toBe("NIFTY26NOVFUT");
    expect(g.sameExpiryFuture).toBe(true);
    expect(g.forward).toBe(24100);
    expect(g.underlyingPrice).toBe(24100);
    expect(g.optionPrice).toBe(420);
    expect(g.rate).toBe(0.065);
    expect(g.dividendYield).toBe(0);
    expect(g.status).toBe("ok");
    expect(g.iv).toBeGreaterThan(0.05);
    expect(g.iv).toBeLessThan(0.5);
    expect(g.expiry.toISOString()).toBe("2026-11-26T10:00:00.000Z");
    expect(g.calculatedAt).toEqual(NOW);
    expect(g.yearsToExpiry).toBeCloseTo(16.0833 / 365, 3);
    expect(r.smRequests).toBe(0);
  });

  it("skips the option quote when optionPrice is given", async () => {
    const r = rig(byToken({ "1": "24100.00" }));
    const g = await r.client.optionGreeks("NFO", "NIFTY26NOV24000CE", { optionPrice: "420.5" });
    expect(r.quoted()).toEqual(["1"]);
    expect(g.optionPrice).toBe(420.5);
  });

  it("uses an underlyingPrice as the forward without selecting a future", async () => {
    const r = rig(byToken({ "3": "420.00" }));
    const g = await r.client.optionGreeks("NFO", "NIFTY26NOV24000CE", { underlyingPrice: 24100 });
    expect(r.quoted()).toEqual(["3"]);
    expect(g.underlyingTradingsymbol).toBeNull();
    expect(g.sameExpiryFuture).toBeNull();
    expect(g.forward).toBe(24100);
    expect(g.model).toBe("black76");
  });

  it("prices a spotPrice with Black-Scholes-Merton and no forward", async () => {
    const r = rig(byToken({ "3": "420.00" }));
    const g = await r.client.optionGreeks("NFO", "NIFTY26NOV24000CE", {
      spotPrice: 24100,
      dividendYield: 0.012,
    });
    expect(r.quoted()).toEqual(["3"]);
    expect(g.model).toBe("bsm");
    expect(g.forward).toBeNull();
    expect(g.underlyingPrice).toBe(24100);
    expect(g.dividendYield).toBe(0.012);
    expect(g.underlyingTradingsymbol).toBeNull();
  });

  it("carries a future of another expiry to the option's expiry", async () => {
    const r = rig(byToken({ "1": "24100.00", "6": "300.00" }));
    const g = await r.client.optionGreeks("NFO", "NIFTY12NOV24000CE");
    expect(g.sameExpiryFuture).toBe(false);
    expect(g.underlyingTradingsymbol).toBe("NIFTY26NOVFUT");
    // exp(-0.065 * 14/365): the future runs 14 days beyond the option.
    expect(g.forward).toBeCloseTo(24100 * Math.exp(-0.065 * (14 / 365)), 6);
    expect(g.underlyingPrice).toBe(24100);
  });

  it("does not carry on MCX-like exchanges: no option rows there means an unknown option", async () => {
    const r = rig(byToken({}));
    await expect(r.client.optionGreeks("NFO", "NOSUCH")).rejects.toThrow(/not found/);
    expect(r.sent).toHaveLength(0);
  });

  it("an expired contract is not quoted for the option; intrinsic value from the underlying", async () => {
    const r = rig(byToken({ "1": "24100.00" }));
    const g = await r.client.optionGreeks("NFO", "NIFTY05NOV24000CE");
    expect(r.quoted()).toEqual(["1"]);
    expect(g.status).toBe("expired");
    expect(g.optionPrice).toBeNull();
    // The future (26-NOV) is carried back to the option expiry (05-NOV), 21 days earlier.
    expect(g.price).toBeCloseTo(24100 * Math.exp((-0.065 * 21) / 365) - 24000, 6);
    const given = await r.client.optionGreeks("NFO", "NIFTY05NOV24000CE", { optionPrice: 99 });
    expect(given.optionPrice).toBe(99);
  });

  it("an expired contract whose future quote fails for that contract is no_price", async () => {
    for (const body of [NOT_OK, "not json"]) {
      const r = rig(byToken({}, { "1": { body } }));
      const g = await r.client.optionGreeks("NFO", "NIFTY05NOV24000CE");
      expect(r.quoted()).toEqual(["1"]);
      expect(g.status).toBe("no_price");
      expect(g.underlyingPrice).toBeNull();
    }
    const r404 = rig(byToken({}, { "1": { status: 404, body: "{}" } }));
    expect((await r404.client.optionGreeks("NFO", "NIFTY05NOV24000CE")).status).toBe("no_price");
  });

  it("a future quote failure propagates when the contract has not expired or is not contract-specific", async () => {
    const live = rig(byToken({}, { "1": { body: NOT_OK } }));
    await expect(live.client.optionGreeks("NFO", "NIFTY26NOV24000CE")).rejects.toMatchObject({
      name: "APIError",
    });
    expect(live.quoted()).toEqual(["1"]);
    const expired = rig(byToken({}, { "1": { body: SESSION } }));
    await expect(expired.client.optionGreeks("NFO", "NIFTY05NOV24000CE")).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it("a quote without a last price is no_price, not an exception", async () => {
    const r = rig(byToken({ "1": "24100.00", "3": null }));
    const g = await r.client.optionGreeks("NFO", "NIFTY26NOV24000CE");
    expect(g.status).toBe("no_price");
    expect(g.optionPrice).toBeNull();
    const none = rig(byToken({ "1": null, "3": "420" }));
    const h = await none.client.optionGreeks("NFO", "NIFTY26NOV24000CE");
    expect(h.status).toBe("no_price");
    expect(h.forward).toBeNull();
  });

  it("a non-finite price counts as no price", async () => {
    const r = rig(byToken({ "3": "420" }));
    const g = await r.client.optionGreeks("NFO", "NIFTY26NOV24000CE", {
      underlyingPrice: Infinity,
    });
    expect(g.status).toBe("no_price");
    expect(g.underlyingPrice).toBeNull();
    const h = await r.client.optionGreeks("NFO", "NIFTY26NOV24000CE", {
      underlyingPrice: 24100,
      optionPrice: Number.NaN,
    });
    expect(h.status).toBe("no_price");
    expect(h.optionPrice).toBeNull();
    const big = await r.client.optionGreeks("NFO", "NIFTY26NOV24000CE", {
      spotPrice: "1e400",
    });
    expect(big.status).toBe("no_price");
  });

  it("a carry factor that overflows is a RangeError (§10.3); a price that overflows leaves no forward", async () => {
    const r = rig(byToken({ "1": "24100.00", "6": "300.00" }));
    await expect(
      r.client.optionGreeks("NFO", "NIFTY12NOV24000CE", { rate: -1e6 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(r.client.optionGreeks("NFO", "NIFTY12NOV24000CE", { rate: -1e6 })).rejects.toThrow(
      /^rate - dividendYield is out of range: /,
    );
    // A finite factor (a little above 1) times a price near the largest double overflows.
    const huge = rig(byToken({ "1": "1.79e308", "6": "300.00" }));
    const g = await huge.client.optionGreeks("NFO", "NIFTY12NOV24000CE", { rate: -0.5 });
    expect(g.forward).toBeNull();
    expect(g.status).toBe("no_price");
    expect(g.underlyingPrice).toBe(1.79e308);
  });

  it("a stated expiryTime overrides the exchange close", async () => {
    const r = rig(byToken({ "1": "24100.00" }));
    // 2026-11-10 10:00 IST is before 15:30 on 05-NOV? no: it is after; use the 26th with 09:00 today.
    await expect(
      r.client.optionGreeks("NFO", "NIFTY26NOV24000CE", { expiryTime: "25:00" }),
    ).rejects.toBeInstanceOf(RangeError);
    const g = await r.client.optionGreeks("NFO", "NIFTY26NOV24000CE", {
      expiryTime: "09:15",
      optionPrice: 400,
    });
    expect(g.expiry.toISOString()).toBe("2026-11-26T03:45:00.000Z");
  });
});

function chainJson(contracts: Record<string, string>[]): string {
  return JSON.stringify({ stat: "Ok", values: contracts });
}

function contract(
  i: number,
  strike: string,
  type: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    exch: "NFO",
    token: String(1000 + i),
    tsym: `X${strike}${type}`,
    optt: type,
    strprc: strike,
    ls: "50",
    ti: "0.05",
    ...extra,
  };
}

function snapshotHandler(
  chain: string,
  quotes: Record<string, Reply | Record<string, string>>,
): Handler {
  return (s) => {
    if (s.endpoint === "GetOptionChain") return { body: chain };
    if (s.endpoint !== "GetQuotes") throw new Error(`unexpected ${s.endpoint}`);
    const q = quotes[s.data["token"] ?? ""];
    if (q === undefined) return { body: NOT_OK };
    if ("body" in q && typeof q.body === "string") return q as Reply;
    return { body: quoteBody(q as Record<string, string>) };
  };
}

describe("optionChainSnapshot (§11.4)", () => {
  it("reads the chain once, then one quote per contract; rows by strike, CE before PE", async () => {
    const r = rig((s) => {
      if (s.endpoint === "GetOptionChain") return { body: fixture("option_chain_success.json") };
      const token = s.data["token"] ?? "";
      return {
        body: quoteBody({
          token,
          lp: "10.5",
          oi: token === "144183" ? "300" : "100",
          v: "7",
          c: "9",
        }),
      };
    });
    const snap = await r.client.optionChainSnapshot("NFO", "TCS30JUN26C2300", "2300", { count: 2 });
    expect(r.sent.filter((s) => s.endpoint === "GetOptionChain")).toHaveLength(1);
    expect(r.sent[0]?.data).toMatchObject({
      exch: "NFO",
      tsym: "TCS30JUN26C2300",
      strprc: "2300",
      cnt: "2",
    });
    expect(r.quoted().sort()).toEqual(["144182", "144183", "175200", "175201"]);
    expect(snap.rows.map((x) => `${x.strike.toFixed()} ${x.optionType}`)).toEqual([
      "2280 CE",
      "2280 PE",
      "2300 CE",
      "2300 PE",
    ]);
    expect(snap.missing).toEqual([]);
    expect(snap.exchange).toBe("NFO");
    expect(snap.tradingsymbol).toBe("TCS30JUN26C2300");
    expect(snap.fetchedAt).toEqual(NOW);
    const row = snap.rows[3];
    expect(row?.tradingsymbol).toBe("TCS30JUN26P2300");
    expect(row?.token).toBe("144183");
    expect(row?.lastPrice?.toFixed()).toBe("10.5");
    expect(row?.openInterest?.toFixed()).toBe("300");
    expect(row?.volume?.toFixed()).toBe("7");
    expect(row?.close?.toFixed()).toBe("9");
    // The helpers are the analytics functions on the snapshot.
    expect(snap.pcr()?.toFixed()).toBe(pcr(snap)?.toFixed());
    expect(snap.pcr({ by: "volume" })?.toFixed()).toBe("1");
    expect(snap.maxPain()?.strike.toFixed()).toBe(maxPain(snap)?.strike.toFixed());
    expect(() => snap.pcr({ by: "bad" as "oi" })).toThrow(RangeError);
  });

  it("lists contract-specific failures in missing, named by symbol, token or strike and side", async () => {
    const chain = chainJson([
      contract(1, "100", "CE"),
      contract(2, "100", "PE"),
      contract(3, "110", "CE"),
      contract(4, "110", "PE"),
      contract(5, "120", "CE", { tsym: "" }),
      { exch: "NFO", strprc: "130.00", optt: "CE" },
      { exch: "NFO", token: "1007", tsym: "NOSTRIKE", optt: "CE" },
      contract(8, "140", "XX"),
      contract(9, "150", "CE", { tsym: "", token: "" }),
    ]);
    const r = rig(
      snapshotHandler(chain, {
        "1001": { lp: "1" },
        "1002": { body: NOT_OK },
        "1003": { body: "not json" },
        "1004": { status: 404, body: "{}" },
        "1005": { lp: "2" },
        "1007": { lp: "3" },
        "1008": { lp: "4" },
      }),
    );
    const snap = await r.client.optionChainSnapshot("NFO", "X", "100");
    expect(snap.rows.map((x) => x.token)).toEqual(["1001", "1005"]);
    expect(snap.missing).toEqual([
      "X100PE",
      "X110CE",
      "X110PE",
      "130.00 CE",
      "NOSTRIKE",
      "X140XX",
      "150 CE",
    ]);
    // No token: no quote request for it.
    expect(r.quoted().sort()).toEqual(["1001", "1002", "1003", "1004", "1005", "1007", "1008"]);
  });

  it("propagates every other error and stops asking for the rest", async () => {
    const contracts = Array.from({ length: 30 }, (_, i) => contract(i, String(100 + i), "CE"));
    const r = rig(
      snapshotHandler(chainJson(contracts), {
        ...Object.fromEntries(
          contracts.map((c) => [
            c["token"] as string,
            { body: quoteBody({ lp: "1" }), delayMs: 30 },
          ]),
        ),
        "1003": { body: SESSION, delayMs: 1 },
      }),
    );
    await expect(r.client.optionChainSnapshot("NFO", "X", "100")).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    expect(r.quoted().length).toBeLessThan(30);
  });

  it("an error that is neither a plain APIError, NotFoundError nor ResponseParseError is not missing", async () => {
    const chain = chainJson([contract(1, "100", "CE")]);
    const r = rig(snapshotHandler(chain, { "1001": { status: 500, body: "{}" } }));
    const done = await r.client.optionChainSnapshot("NFO", "X", "100").catch((e: unknown) => e);
    expect((done as Error).name).toBe("ServerError");
    const p = rig(snapshotHandler(chain, { "1001": { body: "nope" } }));
    const snap = await p.client.optionChainSnapshot("NFO", "X", "100");
    expect(snap.missing).toEqual(["X100CE"]);
    // The same unparseable quote body, asked for directly, is a ResponseParseError: only inside the
    // snapshot is it a missing quote.
    await expect(p.client.quote("NFO", "1001")).rejects.toBeInstanceOf(ResponseParseError);
  });

  it("has at most 10 quotes in flight", async () => {
    const contracts = Array.from({ length: 25 }, (_, i) => contract(i, String(100 + i), "PE"));
    const r = rig((s) => {
      if (s.endpoint === "GetOptionChain") return { body: chainJson(contracts) };
      return { body: quoteBody({ lp: "1" }), delayMs: 15 };
    });
    const snap = await r.client.optionChainSnapshot("NFO", "X", "100");
    expect(snap.rows).toHaveLength(25);
    expect(r.inFlight.max).toBeGreaterThan(1);
    expect(r.inFlight.max).toBeLessThanOrEqual(10);
  });

  it("an empty chain is an empty snapshot; count defaults to 25", async () => {
    const r = rig((s) => {
      if (s.endpoint === "GetOptionChain") return { body: chainJson([]) };
      throw new Error("no quote expected");
    });
    const snap = await r.client.optionChainSnapshot("NFO", "X", "100");
    expect(snap.rows).toEqual([]);
    expect(snap.missing).toEqual([]);
    expect(r.sent[0]?.data["cnt"]).toBe("25");
    expect(snap.pcr()).toBeNull();
    expect(snap.maxPain()).toBeNull();
  });
});

describe("buildup (§11.3)", () => {
  it("one GetQuotes and one TPSeries from 00:00 IST to now at interval 1", async () => {
    const r = rig((s) =>
      s.endpoint === "GetQuotes"
        ? { body: fixture("get_quotes_success.json") }
        : { body: fixture("tpseries_success.json") },
    );
    const b = await r.client.buildup("NSE", "11536");
    expect(r.sent.map((s) => s.endpoint)).toEqual(["GetQuotes", "TPSeries"]);
    expect(r.sent[1]?.data).toMatchObject({
      exch: "NSE",
      token: "11536",
      st: String(Date.parse("2026-11-09T18:30:00Z") / 1000),
      et: String(NOW.getTime() / 1000),
      intrv: "1",
    });
    expect(b.basis).toBe("since_open");
    expect(b.priceChange?.toFixed()).toBe("-26");
    const candles = JSON.parse(fixture("tpseries_success.json")) as { intoi?: string }[];
    const sum = candles.reduce((a, c) => a + Number(c.intoi ?? 0), 0);
    expect(b.oiChange?.toNumber()).toBe(sum);
  });

  it("sums intoi: price down and OI up is a short buildup; no candles leave the OI change null", async () => {
    const candles = JSON.stringify([
      { stat: "Ok", time: "10-11-2026 09:15:00", intoi: "100" },
      { stat: "Ok", time: "10-11-2026 09:16:00", intoi: "50" },
      { stat: "Ok", time: "10-11-2026 09:17:00" },
    ]);
    const r = rig((s) =>
      s.endpoint === "GetQuotes" ? { body: quoteBody({ lp: "98", c: "100" }) } : { body: candles },
    );
    const b = await r.client.buildup("NFO", "1");
    expect(b.priceChange?.toFixed()).toBe("-2");
    expect(b.oiChange?.toFixed()).toBe("150");
    expect(b.state).toBe(Buildup.SHORT_BUILDUP);
    const none = rig((s) =>
      s.endpoint === "GetQuotes" ? { body: quoteBody({ lp: "98" }) } : { body: NOT_OK },
    );
    const n = await none.client.buildup("NFO", "1");
    expect(n.priceChange).toBeNull();
    expect(n.oiChange).toBeNull();
    expect(n.state).toBe(Buildup.NEUTRAL);
  });
});
