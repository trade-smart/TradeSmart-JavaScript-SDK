// Script-master download (sdk-behaviour.md §8.1, §8.2, §3.1, §13; design §7.7; Python:
// instruments.py). A GET to the script-master origin through the client's own transport (so an
// injected dispatcher works), never following a redirect, never retried, no `Authorization`.
// The zip is unpacked with `fflate`; the text file is saved atomically into the instruments folder.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import type { ClientConfig } from "../config.js";
import { Exchange } from "../enums.js";
import {
  APIError,
  AuthenticationError,
  ConfigurationError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  RequestTimeoutError,
  ResponseParseError,
  ServerError,
} from "../errors.js";
import type { Logger } from "../lib/log.js";
import { redactText } from "../lib/redact.js";
import { TransportFailure, mapFailure } from "../transport/failures.js";
import { CLOSED_MESSAGE, type HttpTransport, type TransportResponse } from "../transport/http.js";
import {
  fileMtimeMs,
  markChecked,
  requestHeaders,
  setMtime,
  writeFileAtomic,
} from "./freshness.js";
import {
  parseScriptMaster,
  SCRIPT_MASTER_ENDPOINT,
  scriptMasterParseError,
  vanishedError,
  type ScriptMasterRow,
} from "./parse.js";

/** Script-master error bodies are cut to this many characters (§13), after redaction. */
const ERROR_BODY_LIMIT = 500;

/** Options of `downloadInstruments()`. */
export interface DownloadInstrumentsOptions {
  /** The folder for `<EXCH>_symbols.txt`; default the configured `instrumentsDir`, else the user cache folder. A leading `~` is expanded. */
  destDir?: string | undefined;
  /** Download even when the cached file is fresh. */
  force?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

/** What the instruments functions need from a client; the clock and the platform are seams for tests. */
export interface InstrumentsContext {
  readonly config: ClientConfig;
  readonly transport: HttpTransport;
  /** The `tradesmart.instruments` logger. */
  readonly log: Logger;
  isClosed(): boolean;
  /** The wall clock (an instant; freshness works in IST). */
  now: () => Date;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: () => string;
  /** Called with the file after every download call, before the file is read (a test seam). */
  afterDownload?: ((file: string) => void | Promise<void>) | undefined;
}

/** Internal: the property under which a `TradeSmart` keeps its `InstrumentsContext`. */
export const INSTRUMENTS_CONTEXT: unique symbol = Symbol("tradesmart.instrumentsContext");

/** The `InstrumentsContext` of a client (not public). */
export function instrumentsContext(client: object): InstrumentsContext {
  const ctx = (client as { [INSTRUMENTS_CONTEXT]?: InstrumentsContext })[INSTRUMENTS_CONTEXT];
  if (ctx === undefined) throw new TypeError("not a TradeSmart client");
  return ctx;
}

/** A context with the real clock and the process environment. */
export function createInstrumentsContext(
  config: ClientConfig,
  transport: HttpTransport,
  log: Logger,
  isClosed: () => boolean,
): InstrumentsContext {
  return {
    config,
    transport,
    log,
    isClosed,
    now: () => new Date(),
    env: process.env,
    platform: process.platform,
    home: homedir,
  };
}

/**
 * The exchange code: any case, trimmed. Anything else is a `RangeError` that names the parameter
 * and never echoes the value (JavaScript's counterpart of the contract's `ValueError`, §2.3).
 */
export function exchangeCode(exchange: unknown): string {
  const allowed: readonly string[] = Object.values(Exchange);
  if (typeof exchange === "string") {
    const code = exchange.trim().toUpperCase();
    if (allowed.includes(code)) return code;
  }
  throw new RangeError(`exchange must be one of ${allowed.join(", ")}`);
}

/**
 * The folder used with no `destDir` and no `instrumentsDir`: `$XDG_CACHE_HOME/tradesmart` (else
 * `~/.cache/tradesmart`) on Linux and macOS, `%LOCALAPPDATA%\tradesmart\Cache` on Windows (design 7.7).
 */
export function defaultInstrumentsDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): string {
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"];
    const base =
      local !== undefined && local !== "" ? local : path.win32.join(home, "AppData", "Local");
    return path.win32.join(base, "tradesmart", "Cache");
  }
  const xdg = env["XDG_CACHE_HOME"];
  const base =
    xdg !== undefined && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(home, ".cache");
  return path.posix.join(base, "tradesmart");
}

/** A leading `~` (alone or followed by a separator) means the home folder. */
function expandUser(folder: string, home: string): string {
  if (folder === "~") return home;
  if (folder.startsWith("~/") || folder.startsWith("~\\")) return path.join(home, folder.slice(2));
  return folder;
}

function targetPath(ctx: InstrumentsContext, code: string, destDir: string | undefined): string {
  const home = (): string => ctx.home();
  let folder: string;
  if (destDir !== undefined) folder = expandUser(destDir, home());
  else if (ctx.config.instrumentsDir !== null) {
    folder = expandUser(ctx.config.instrumentsDir, home());
  } else folder = defaultInstrumentsDir(ctx.env, ctx.platform, home());
  return path.join(folder, `${code}_symbols.txt`);
}

/** A conditional re-check got 304, but the cached file was deleted meanwhile. */
class CachedFileGone extends Error {}

function statusError(response: TransportResponse): APIError {
  const status = response.status;
  const options = {
    endpoint: SCRIPT_MASTER_ENDPOINT,
    httpStatus: status,
    // Redacted first, then cut: a secret straddling the cut is still masked.
    raw: redactText(response.bodyText, ERROR_BODY_LIMIT),
  };
  const message = `${SCRIPT_MASTER_ENDPOINT}: HTTP ${String(status)}`;
  if (status === 401 || status === 403) return new AuthenticationError(message, options);
  if (status === 404) return new NotFoundError(message, options);
  if (status === 429) return new RateLimitError(message, options);
  if (status >= 500) return new ServerError(message, options);
  return new APIError(message, options);
}

/** The bytes of the `.txt` member of the zip (member paths are never used for writing). */
function extractTextMember(content: Uint8Array, code: string): Uint8Array {
  const notZip = (): ResponseParseError =>
    scriptMasterParseError("script master response is not a valid zip file");
  const candidates: { name: string; base: string }[] = [];
  try {
    unzipSync(content, {
      filter: (file) => {
        if (!file.name.endsWith("/")) {
          const base = file.name.split(/[\\/]/).pop() ?? "";
          if (base.toLowerCase().endsWith(".txt")) candidates.push({ name: file.name, base });
        }
        return false; // only list the members here
      },
    });
  } catch {
    throw notZip();
  }
  const chosen = candidates.find((c) => c.base.toUpperCase().startsWith(code)) ?? candidates[0];
  if (chosen === undefined) throw scriptMasterParseError("script master zip contains no .txt file");
  try {
    const data = unzipSync(content, { filter: (file) => file.name === chosen.name })[chosen.name];
    if (data === undefined) throw notZip();
    return data;
  } catch {
    throw notZip();
  }
}

/** The `Last-Modified` instant, or `null` when absent or unparseable. */
function parseHttpDate(header: string | undefined): Date | null {
  const text = header?.trim() ?? "";
  if (text === "") return null;
  const zoned = /(?:GMT|UTC|UT|Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text} GMT`;
  const ms = Date.parse(zoned);
  return Number.isNaN(ms) ? null : new Date(ms);
}

async function fetchOnce(
  ctx: InstrumentsContext,
  code: string,
  target: string,
  extra: Record<string, string>,
  now: Date,
  signal: AbortSignal | undefined,
): Promise<string> {
  const conditional = Object.keys(extra).length > 0;
  const url = `${ctx.config.scriptMasterBaseUrl.replace(/\/+$/, "")}/${code}_symbols.txt.zip`;

  /** A failed re-check (network, timeout, 5xx) of a cached file keeps that file. */
  const keepCached = async (error: Error): Promise<boolean> => {
    if (!conditional || (await fileMtimeMs(target)) === null) return false;
    ctx.log.warn(`using the cached script master; re-check failed: ${error.name}`);
    await markChecked(target, now, ctx.log);
    return true;
  };

  let response: TransportResponse;
  try {
    response = await ctx.transport.send(
      { url, method: "GET", headers: extra, body: null },
      { stateChanging: false, signal },
    );
  } catch (caught) {
    if (signal?.aborted === true && caught === signal.reason) throw caught;
    if (!(caught instanceof TransportFailure)) throw caught;
    const error = mapFailure(caught.kind, false, SCRIPT_MASTER_ENDPOINT, caught);
    if (
      (error instanceof NetworkError || error instanceof RequestTimeoutError) &&
      (await keepCached(error))
    ) {
      return target;
    }
    throw error;
  }

  const status = response.status;
  if (conditional && status === 304) {
    if ((await fileMtimeMs(target)) === null) throw new CachedFileGone();
    await markChecked(target, now, ctx.log); // not modified: the file is left untouched
    return target;
  }
  if (status >= 500) {
    const error = statusError(response);
    if (await keepCached(error)) return target;
    throw error;
  }
  if (status >= 400) throw statusError(response);
  if (status !== 200) {
    const message =
      status >= 300 && status < 400 && status !== 304
        ? `script master download was redirected (HTTP ${String(status)}); redirects are never followed`
        : `script master download returned HTTP ${String(status)}, not a zip file`;
    throw new ResponseParseError(message, {
      endpoint: SCRIPT_MASTER_ENDPOINT,
      httpStatus: status,
      body: "",
    });
  }
  await writeFileAtomic(target, extractTextMember(response.bodyBytes, code));
  // Freshness compares the file time with the last daily refresh, so the file takes the server's
  // `Last-Modified` (never later than now: a future-dated header cannot make a stale file look
  // fresh); a failure to set it keeps the write time.
  const modified = parseHttpDate(response.headers["last-modified"]);
  if (modified !== null) {
    const stamp = new Date(Math.min(modified.getTime(), now.getTime()));
    if (!(await setMtime(target, stamp))) {
      ctx.log.debug(
        `Could not set the modification time of ${path.basename(target)}; keeping the write time`,
      );
    }
  }
  await markChecked(target, now, ctx.log);
  return target;
}

/**
 * Download `<EXCH>_symbols.txt` unless the cached file is fresh (§8.2) and return its path. The
 * file is reused while it was written after the last daily refresh; an older one is re-checked
 * with a conditional request at most every `scriptMasterRecheckMinutes`; `force` downloads it.
 */
export async function downloadInstruments(
  ctx: InstrumentsContext,
  exchange: unknown,
  options: DownloadInstrumentsOptions = {},
): Promise<string> {
  const code = exchangeCode(exchange); // validated before any path is built
  const signal = options.signal;
  signal?.throwIfAborted();
  if (ctx.isClosed()) throw new ConfigurationError(CLOSED_MESSAGE);
  const target = targetPath(ctx, code, options.destDir);
  const now = ctx.now();
  const extra = await requestHeaders(target, {
    force: options.force === true,
    config: ctx.config,
    now,
  });
  if (extra === null) return target;
  try {
    return await fetchOnce(ctx, code, target, extra, now, signal);
  } catch (e) {
    if (!(e instanceof CachedFileGone)) throw e;
    ctx.log.debug(`cached ${path.basename(target)} vanished during the re-check; downloading it`);
    return fetchOnce(ctx, code, target, {}, now, signal);
  }
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown }).code === "ENOENT";
}

/**
 * Download (or reuse) the exchange's file and run `use` on it. When the file was removed between
 * the download and the read (a cleanup job, another process) it is downloaded once more; removed
 * again, `ResponseParseError`.
 */
export async function withScriptMasterFile<T>(
  ctx: InstrumentsContext,
  exchange: unknown,
  signal: AbortSignal | undefined,
  use: (file: string) => Promise<T>,
): Promise<T> {
  const code = exchangeCode(exchange);
  let file = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    file = await downloadInstruments(ctx, code, { signal });
    await ctx.afterDownload?.(file);
    try {
      return await use(file);
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
  }
  throw vanishedError(path.basename(file));
}

/** The exchange's rows, parsed afresh on every call (no cache, §8.4). */
export function loadInstruments(
  ctx: InstrumentsContext,
  exchange: unknown,
  signal?: AbortSignal,
): Promise<ScriptMasterRow[]> {
  return withScriptMasterFile(ctx, exchange, signal, async (file) =>
    parseScriptMaster(await readFile(file), path.basename(file)),
  );
}
