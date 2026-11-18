// A real `TradeSmart` whose script-master downloads are answered by an undici `MockAgent` in turn
// (the last reply repeats), with a private temp folder as `instrumentsDir`, a pinned wall clock
// and every log line recorded. Never touches the network or the developer's real cache folder.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockAgent } from "undici";
import { strToU8, zipSync } from "fflate";
import { TradeSmart } from "../../src/client.js";
import { ClientConfig, type ClientConfigInit } from "../../src/config.js";
import { instrumentsContext, type InstrumentsContext } from "../../src/instruments/download.js";
import { dispatcherFailure, recordingLogger, type LogLine } from "./scripted-client.js";

export const SM_ORIGIN = "https://sm.example.test";

/** The usual script-master text of the tests (one NSE row). */
export const NSE_TEXT =
  "Exchange,Token,LotSize,Symbol,TradingSymbol,Instrument,TickSize,\nNSE,22,1,ACC,ACC-EQ,EQ,0.05,\n";

/** A zip holding `members` (name to text). */
export function zipOf(members: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(members).map(([k, v]) => [k, strToU8(v)])));
}

export interface SmReply {
  status?: number;
  body?: Uint8Array | string;
  headers?: Record<string, string>;
  /** A dispatcher failure kind of scripted-client.ts. */
  failure?: string;
  /** Remove this file before answering (the cached file vanishing mid-request). */
  deleteFile?: string;
}

export interface SmScripted {
  client: TradeSmart;
  ctx: InstrumentsContext;
  agent: MockAgent;
  lines: LogLine[];
  dir: string;
  /** The file `downloadInstruments("NSE")` writes in `dir`. */
  file: string;
  /** Each request that reached the mock server. */
  requests: { path: string; headers: Record<string, string> }[];
  cleanup(): Promise<void>;
}

export function scriptMasterClient(
  replies: readonly SmReply[],
  options: { config?: ClientConfigInit; dir?: string; noInstrumentsDir?: boolean } = {},
): SmScripted {
  const dir = options.dir ?? mkdtempSync(path.join(tmpdir(), "tradesmart-sm-"));
  const lines: LogLine[] = [];
  const requests: SmScripted["requests"] = [];
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get(SM_ORIGIN)
    .intercept({ path: () => true, method: "GET" })
    .reply((opts) => {
      requests.push({
        path: opts.path,
        headers: Object.fromEntries(
          Object.entries(opts.headers as Record<string, string>).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        ),
      });
      const step = replies[Math.min(requests.length, replies.length) - 1] ?? {};
      if (step.deleteFile !== undefined) rmSync(step.deleteFile, { force: true });
      if (step.failure !== undefined) throw dispatcherFailure(step.failure);
      return {
        statusCode: step.status ?? 200,
        data: step.body === undefined ? "" : Buffer.from(step.body),
        responseOptions: { headers: step.headers ?? {} },
      };
    })
    .persist();

  const config = ClientConfig.create({
    scriptMasterBaseUrl: SM_ORIGIN,
    ...(options.noInstrumentsDir === true ? {} : { instrumentsDir: dir }),
    logger: recordingLogger(lines),
    ...options.config,
  });
  const client = new TradeSmart("TEST123", { config, httpDispatcher: agent });
  const ctx = instrumentsContext(client);
  // Pinned wall clock: a Last-Modified of 2026-11-10 07:00 IST is fresh at this instant.
  ctx.now = () => new Date("2026-11-10T10:00:00+05:30");
  return {
    client,
    ctx,
    agent,
    lines,
    dir,
    file: path.join(dir, "NSE_symbols.txt"),
    requests,
    async cleanup() {
      await client.close();
      await agent.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
