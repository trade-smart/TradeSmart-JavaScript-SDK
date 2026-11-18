// Market data reads: `SearchScrip`, `GetQuotes`, `GetSecurityInfo`, `GetOptionChain`, `TPSeries`
// and `EODChartData` (sdk-behaviour.md §2.3), mirroring sdk-python/src/tradesmart/endpoints/market.py.
import { Decimal } from "decimal.js";
import { fieldError, ResponseParseError } from "../errors.js";
import { resolveEnum } from "../enums.js";
import type { CallSpec } from "../lib/call.js";
import type { ClassifyResult } from "../lib/classify.js";
import type { WirePayload } from "../lib/codec.js";
import { toWireDecimal } from "../lib/decimal.js";
import { parseJsonLossless } from "../lib/json.js";
import { redactedBody } from "../lib/redact.js";
import { toEpochSeconds } from "../lib/time.js";
import {
  parseCandle,
  parseDailyCandle,
  parseOptionContract,
  parseQuote,
  parseScripMatch,
  parseSecurityInfo,
  type Candle,
  type DailyCandle,
  type OptionContract,
  type Quote,
  type ScripMatch,
  type SecurityInfo,
} from "../models/generated/market.js";
import { listDecoder, objectDecoder, readSpec, requireStr, valuesDecoder } from "./base.js";

/** A request time: a `Date`, integer epoch seconds, or `{ date: "YYYY-MM-DD" }` (00:00 IST). */
export type TimeInput = Date | number | { date: string };

/** The `TPSeries` intervals in minutes. */
export const TPS_INTERVALS: readonly string[] = Object.freeze([
  "1",
  "3",
  "5",
  "10",
  "15",
  "30",
  "60",
  "120",
  "240",
]);

function exchangeCode(exchange: unknown): string {
  return resolveEnum("Exchange", exchange, "exch");
}

function epochText(value: TimeInput): string {
  return String(toEpochSeconds(value, "time"));
}

/** The `SearchScrip` call. */
export function searchCall(
  uid: string,
  text: unknown,
  signal?: AbortSignal,
): CallSpec<readonly ScripMatch[]> {
  return readSpec({
    endpoint: "SearchScrip",
    payload: [
      ["uid", uid],
      ["stext", requireStr(text, "stext")],
    ],
    allowEmpty: true,
    decode: valuesDecoder(parseScripMatch, "SearchScrip"),
    signal,
  });
}

function exchangeTokenPayload(uid: string, exchange: unknown, token: unknown): WirePayload {
  const exch = exchangeCode(exchange);
  return [
    ["uid", uid],
    ["exch", exch],
    ["token", requireStr(token, "token")],
  ];
}

/** The `GetQuotes` call (`token` is a string such as `"2885"`). */
export function quoteCall(
  uid: string,
  exchange: unknown,
  token: unknown,
  signal?: AbortSignal,
): CallSpec<Quote> {
  return readSpec({
    endpoint: "GetQuotes",
    payload: exchangeTokenPayload(uid, exchange, token),
    rateGroup: "quotes",
    decode: objectDecoder(parseQuote, "GetQuotes"),
    signal,
  });
}

/** The `GetSecurityInfo` call (`token` is a string). */
export function securityInfoCall(
  uid: string,
  exchange: unknown,
  token: unknown,
  signal?: AbortSignal,
): CallSpec<SecurityInfo> {
  return readSpec({
    endpoint: "GetSecurityInfo",
    payload: exchangeTokenPayload(uid, exchange, token),
    decode: objectDecoder(parseSecurityInfo, "GetSecurityInfo"),
    signal,
  });
}

/** The `GetOptionChain` call (`count` is a whole number of at least 1: strikes per side). */
export function optionChainCall(
  uid: string,
  exchange: unknown,
  tradingsymbol: unknown,
  strikePrice: Decimal | string | number,
  count: number,
  signal?: AbortSignal,
): CallSpec<readonly OptionContract[]> {
  const exch = exchangeCode(exchange);
  const tsym = requireStr(tradingsymbol, "tsym");
  const strprc = toWireDecimal(strikePrice, "strprc");
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
    throw fieldError("cnt", "greater_than_equal", "must be a whole number of at least 1");
  }
  return readSpec({
    endpoint: "GetOptionChain",
    payload: [
      ["uid", uid],
      ["exch", exch],
      ["tsym", tsym],
      ["strprc", strprc],
      ["cnt", String(count)],
    ],
    allowEmpty: true,
    decode: valuesDecoder(parseOptionContract, "GetOptionChain"),
    signal,
  });
}

function intervalText(interval: unknown): string {
  const text =
    typeof interval === "number" ? String(interval) : typeof interval === "string" ? interval : "";
  if (!TPS_INTERVALS.includes(text)) {
    throw fieldError(
      "intrv",
      "enum",
      `interval must be one of ${TPS_INTERVALS.join(", ")} (minutes)`,
    );
  }
  return text;
}

/** The `TPSeries` call; `interval` is in minutes (`TPS_INTERVALS`); unset keys are omitted. */
export function historicalDataCall(
  uid: string,
  exchange: unknown,
  token: unknown,
  options: {
    fromDate?: TimeInput | undefined;
    toDate?: TimeInput | undefined;
    interval?: number | string | undefined;
  },
  signal?: AbortSignal,
): CallSpec<readonly Candle[]> {
  const payload: [string, string][] = [...exchangeTokenPayload(uid, exchange, token)].map(
    ([k, v]) => [k, v],
  );
  if (options.fromDate !== undefined) payload.push(["st", epochText(options.fromDate)]);
  if (options.toDate !== undefined) payload.push(["et", epochText(options.toDate)]);
  if (options.interval !== undefined) payload.push(["intrv", intervalText(options.interval)]);
  return readSpec({
    endpoint: "TPSeries",
    payload,
    expect: "list",
    allowEmpty: true,
    rateGroup: "tpseries",
    decode: listDecoder(parseCandle, "TPSeries"),
    signal,
  });
}

/** `EODChartData` is a list of JSON-encoded strings (element objects are accepted too). */
function decodeDaily(result: ClassifyResult): readonly DailyCandle[] {
  const endpoint = "EODChartData";
  if (result.kind === "empty") return Object.freeze([]);
  const fail = (what: string, item: unknown): ResponseParseError =>
    new ResponseParseError(`${endpoint}: ${what}`, {
      endpoint,
      httpStatus: null,
      body: redactedBody(item),
    });
  if (!Array.isArray(result.body)) throw fail("expected a JSON list", result.body);
  const rows = (result.body as unknown[]).map((item) => {
    let decoded: unknown = item;
    if (typeof item === "string") {
      try {
        decoded = parseJsonLossless(item);
      } catch {
        throw fail("element is not valid JSON", item);
      }
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw fail("element is not a JSON object", item);
    }
    return parseDailyCandle(decoded, { endpoint });
  });
  return Object.freeze(rows);
}

/** The `EODChartData` call: `sym` as `EXCH:TSYM`, `from`, `to`; documented without `uid`. */
export function dailyHistoryCall(
  exchange: unknown,
  tradingsymbol: unknown,
  fromDate: TimeInput,
  toDate: TimeInput,
  signal?: AbortSignal,
): CallSpec<readonly DailyCandle[]> {
  const sym = `${exchangeCode(exchange)}:${requireStr(tradingsymbol, "tsym")}`;
  return readSpec({
    endpoint: "EODChartData",
    payload: [
      ["sym", sym],
      ["from", epochText(fromDate)],
      ["to", epochText(toDate)],
    ],
    expect: "list",
    allowEmpty: true,
    decode: decodeDaily,
    signal,
  });
}
