// The order outcome log (sdk-behaviour.md §5.6; logger `tradesmart.orders`), mirroring
// sdk-python/src/tradesmart/_transport/outcome.py. Only the endpoint, a result word, the order id
// (GTT: the alert id) and the latency are logged: never payloads, prices, symbols or tokens.
import { OrderStatusUnknownError } from "../errors.js";
import { checkHint } from "./classify.js";
import type { WirePayload } from "./codec.js";
import type { Logger } from "./log.js";

/** The result words, decided in this order: accepted, unknown, not_sent, rejected. */
export type OutcomeWord = "accepted" | "unknown" | "not_sent" | "rejected";

/**
 * The order endpoints, whose outcome is logged: every state-changing name except `GenAcsTok`
 * (not an order). By name only: `request(..., { stateChanging: true })` to any other endpoint is
 * never retried but gets no line.
 */
const ORDER_ENDPOINTS: ReadonlySet<string> = new Set([
  "PlaceOrder",
  "PlaceMultiOrder",
  "ModifyOrder",
  "CancelOrder",
  "ExitSNOOrder",
  "PlaceGTTOrder",
  "ModifyGTTOrder",
  "CancelGTTOrder",
  "PlaceIceBergOrder",
  "ModifyIceBergOrder",
  "CancelIceBergOrder",
]);

const GTT_WRITES: ReadonlySet<string> = new Set([
  "PlaceGTTOrder",
  "ModifyGTTOrder",
  "CancelGTTOrder",
]);

/** Whether `endpoint` (canonical spelling) is an order endpoint whose outcome is logged. */
export function isOrderEndpoint(endpoint: string): boolean {
  return ORDER_ENDPOINTS.has(endpoint);
}

/** The id key of the line: `al_id` for the GTT writes, else `order_id`. */
function idKey(endpoint: string): string {
  return GTT_WRITES.has(endpoint) ? "al_id" : "order_id";
}

/**
 * The id the line names: the acknowledgement's id (trimmed, when it is a non-blank string), else
 * the payload's `norenordno` (GTT writes: `al_id`), else `-`.
 */
export function outcomeId(endpoint: string, payload: WirePayload, ackId: unknown): string {
  if (typeof ackId === "string" && ackId.trim() !== "") return ackId.trim();
  const key = GTT_WRITES.has(endpoint) ? "al_id" : "norenordno";
  for (const [name, value] of payload) {
    if (name === key && value !== "") return value;
  }
  return "-";
}

/** The acknowledgement id of a raw `request()` result: the object's `al_id` (GTT) or `norenordno`. */
export function rawAckId(endpoint: string, result: unknown): unknown {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  const key = GTT_WRITES.has(endpoint) ? "al_id" : "norenordno";
  return Object.hasOwn(result, key) ? (result as Record<string, unknown>)[key] : null;
}

/** Writes the outcome lines of the order calls to the `tradesmart.orders` logger. */
export class OutcomeLog {
  constructor(private readonly log: Logger) {}

  /** One INFO line: `<Endpoint> <word> order_id=<id> in <ms> ms` (`al_id=` for the GTT writes). */
  line(endpoint: string, word: OutcomeWord, id: string, elapsedMs: number): void {
    const millis = String(Math.round(Math.max(0, elapsedMs)));
    this.log.info(`${endpoint} ${word} ${idKey(endpoint)}=${id} in ${millis} ms`);
  }

  /**
   * A failed order call: `OrderStatusUnknownError` is `unknown` with its WARNING whatever the send
   * progress; otherwise `not_sent` when nothing reached the server, else `rejected`.
   */
  failure(endpoint: string, error: unknown, sent: boolean, id: string, elapsedMs: number): void {
    if (error instanceof OrderStatusUnknownError) {
      this.line(endpoint, "unknown", id, elapsedMs);
      this.log.warn(
        `${endpoint}: order status unknown; check ${checkHint(endpoint)} before acting`,
      );
    } else {
      this.line(endpoint, sent ? "rejected" : "not_sent", id, elapsedMs);
    }
  }

  /** The call was interrupted (aborted) after the request was handed to the HTTP library. */
  interrupted(endpoint: string, id: string, elapsedMs: number): void {
    this.line(endpoint, "unknown", id, elapsedMs);
    this.log.warn(`${endpoint}: outcome unknown - check ${checkHint(endpoint)}`);
  }
}
