// The parsed-row cache (sdk-behaviour.md §8.4; Python: _contract_cache.py): one entry per exchange
// and client, keyed by the file's path, modification time (ns) and size, so a refreshed file is
// parsed again and the old entry dropped. Concurrent first calls parse once; a failed parse
// reaches every caller waiting on it and is retried by the next call. `instruments()` does not
// use it and always parses afresh. Each entry also holds the indexes of §8.4, built once per parse
// and shared (Python: `build_contract_index`).
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { exchangeCode, type InstrumentsContext, withScriptMasterFile } from "./download.js";
import { parseScriptMaster, type ScriptMasterRow } from "./parse.js";

/** All rows of one exchange's script master, in file order (shared: do not modify). */
export type ParsedRows = readonly ScriptMasterRow[];

/** The key of `ContractIndex.futures`: upper-cased, trimmed `Symbol` and `Exchange`. */
export function futureKey(symbol: string, exchange: string): string {
  return `${symbol.trim().toUpperCase()}\u0000${exchange.trim().toUpperCase()}`;
}

/**
 * The indexes of one parsed script master (§8.4), each in file order and shared (do not modify):
 * `options` the option rows by upper-cased `TradingSymbol`; `futures` the future rows by
 * `futureKey(Symbol, Exchange)`; `instruments` the first row of every instrument (equity, future,
 * option, any other) by trimmed, upper-cased `TradingSymbol`, the contract `placeSlicedOrder`
 * resolves (§5.7).
 */
export interface ContractIndex {
  readonly rows: ParsedRows;
  readonly options: ReadonlyMap<string, readonly ScriptMasterRow[]>;
  readonly futures: ReadonlyMap<string, readonly ScriptMasterRow[]>;
  readonly instruments: ReadonlyMap<string, ScriptMasterRow>;
}

function push(map: Map<string, ScriptMasterRow[]>, key: string, row: ScriptMasterRow): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [row]);
  else bucket.push(row);
}

function buildIndex(rows: ParsedRows): ContractIndex {
  const options = new Map<string, ScriptMasterRow[]>();
  const futures = new Map<string, ScriptMasterRow[]>();
  const instruments = new Map<string, ScriptMasterRow>();
  for (const row of rows) {
    const name = (row["TradingSymbol"] ?? "").trim().toUpperCase();
    if (name !== "" && !instruments.has(name)) instruments.set(name, row);
    const instrument = (row["Instrument"] ?? "").toUpperCase();
    if (instrument.startsWith("OPT")) {
      if (name !== "") push(options, name, row);
    } else if (instrument.startsWith("FUT")) {
      push(futures, futureKey(row["Symbol"] ?? "", row["Exchange"] ?? ""), row);
    }
  }
  return { rows, options, futures, instruments };
}

interface Pending {
  key: string;
  promise: Promise<ContractIndex>;
}

class RowCache {
  private readonly entries = new Map<string, { key: string; index: ContractIndex }>();
  private readonly pending = new Map<string, Pending>();

  async get(code: string, file: string): Promise<ContractIndex> {
    // The key is read before the file: content newer than its key only costs a re-parse.
    const st = await stat(file, { bigint: true });
    const key = `${file}|${String(st.mtimeNs)}|${String(st.size)}`;
    const entry = this.entries.get(code);
    if (entry?.key === key) return entry.index;
    const running = this.pending.get(code);
    if (running?.key === key) return running.promise;
    this.entries.delete(code); // never hold two copies of one exchange
    const record: Pending = {
      key,
      promise: readFile(file).then((bytes) =>
        buildIndex(Object.freeze(parseScriptMaster(bytes, path.basename(file)))),
      ),
    };
    this.pending.set(code, record);
    try {
      const index = await record.promise;
      if (this.pending.get(code) === record) this.entries.set(code, { key, index });
      return index;
    } finally {
      if (this.pending.get(code) === record) this.pending.delete(code);
    }
  }
}

const caches = new WeakMap<InstrumentsContext, RowCache>();

/**
 * The parsed rows and indexes of the exchange's script master (downloaded or reused per §8.2,
 * parsed once per file version). The same object is returned until the file changes.
 */
export async function getContractIndex(
  ctx: InstrumentsContext,
  exchange: unknown,
  signal?: AbortSignal,
): Promise<ContractIndex> {
  const code = exchangeCode(exchange);
  let cache = caches.get(ctx);
  if (cache === undefined) {
    cache = new RowCache();
    caches.set(ctx, cache);
  }
  const rows = cache;
  return await withScriptMasterFile(ctx, code, signal, (file) => rows.get(code, file));
}

/** The parsed rows alone (`getContractIndex(...).rows`); the same array until the file changes. */
export async function getParsedRows(
  ctx: InstrumentsContext,
  exchange: unknown,
  signal?: AbortSignal,
): Promise<ParsedRows> {
  return (await getContractIndex(ctx, exchange, signal)).rows;
}
