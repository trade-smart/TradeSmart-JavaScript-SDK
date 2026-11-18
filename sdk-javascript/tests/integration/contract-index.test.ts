// The indexes of the parsed-row cache (sdk-behaviour.md §8.4): option rows by upper-cased
// TradingSymbol, future rows by (Symbol, Exchange) and the first row of every instrument by
// trimmed upper-cased TradingSymbol; built once per parse and shared.
import { utimesSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { futureKey, getContractIndex, getParsedRows } from "../../src/instruments/cache.js";
import { scriptMasterClient, type SmScripted } from "../helpers/script-master-client.js";

const TEXT = [
  "Exchange,Token,LotSize,Symbol,TradingSymbol,Instrument,TickSize,",
  "NFO,1,65,NIFTY,NIFTY26NOVFUT,FUTIDX,0.05,",
  "NFO,2,65,NIFTY,NIFTY26DEC FUT,FUTIDX,0.05,",
  "NFO,3,65,NIFTY,nifty26nov24000ce,OPTIDX,0.05,",
  "NFO,4,65,NIFTY,NIFTY26NOV24000CE,OPTIDX,0.05,",
  "NFO,5,1,ACC,  ACC-EQ ,EQ,0.05,",
  "NFO,6,1,ACC,ACC-EQ,EQ,0.05,",
  "NFO,7,1,ZZ,,EQ,0.05,",
  "",
].join("\n");

const open: SmScripted[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.cleanup();
});

function seeded(text = TEXT): SmScripted {
  const s = scriptMasterClient([]);
  open.push(s);
  s.ctx.now = () => new Date("2026-11-10T10:00:00+05:30");
  const nfo = s.file.replace("NSE_symbols", "NFO_symbols");
  writeFileSync(nfo, text);
  const stamp = new Date("2026-11-10T08:00:00+05:30");
  utimesSync(nfo, stamp, stamp);
  return s;
}

describe("contract index (§8.4)", () => {
  it("indexes every instrument by trimmed upper-cased TradingSymbol, the first row winning", async () => {
    const s = seeded();
    const index = await getContractIndex(s.ctx, "NFO");
    expect(index.instruments.get("ACC-EQ")?.["Token"]).toBe("5");
    expect(index.instruments.get("NIFTY26NOVFUT")?.["Token"]).toBe("1");
    expect(index.instruments.get("NIFTY26NOV24000CE")?.["Token"]).toBe("3");
    expect(index.instruments.has("")).toBe(false);
    expect(s.requests).toHaveLength(0);
  });

  it("indexes option rows by upper-cased TradingSymbol and future rows by (Symbol, Exchange), in file order", async () => {
    const s = seeded();
    const index = await getContractIndex(s.ctx, "NFO");
    expect(index.options.get("NIFTY26NOV24000CE")?.map((r) => r["Token"])).toEqual(["3", "4"]);
    expect(index.options.has("nifty26nov24000ce")).toBe(false);
    expect(index.futures.get(futureKey("nifty", "nfo"))?.map((r) => r["Token"])).toEqual([
      "1",
      "2",
    ]);
    expect(index.futures.get(futureKey("ACC", "NFO"))).toBeUndefined();
  });

  it("is built once per parse: the same object and rows until the file changes", async () => {
    const s = seeded();
    const a = await getContractIndex(s.ctx, "NFO");
    expect(await getContractIndex(s.ctx, "nfo")).toBe(a);
    expect(await getParsedRows(s.ctx, "NFO")).toBe(a.rows);
    const [b, c] = await Promise.all([
      getContractIndex(s.ctx, "NFO"),
      getContractIndex(s.ctx, "NFO"),
    ]);
    expect(b).toBe(a);
    expect(c).toBe(a);

    const nfo = s.file.replace("NSE_symbols", "NFO_symbols");
    writeFileSync(nfo, TEXT.replace("NFO,5,", "NFO,55,"));
    const later = new Date(Date.now() + 5_000);
    utimesSync(nfo, later, later);
    s.ctx.now = () => new Date(later.getTime() + 1_000);
    const d = await getContractIndex(s.ctx, "NFO");
    expect(d).not.toBe(a);
    expect(d.instruments.get("ACC-EQ")?.["Token"]).toBe("55");
  });
});
