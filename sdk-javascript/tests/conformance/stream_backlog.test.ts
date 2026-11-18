// The stream's delivery buffer under backpressure (sdk-behaviour.md §9.7): every case of
// stream_backlog.json — delivered payloads, merge count and WARNINGs.
import { describe, expect, it } from "vitest";
import type { Logger } from "../../src/lib/log.js";
import { DeliveryBuffer, type BufferItem } from "../../src/stream/backlog.js";
import { parseMessage } from "../../src/stream/protocol.js";
import { loadVector } from "./vectors.js";

interface Op {
  put?: Record<string, unknown>;
  take?: { toString(): string };
}

interface Expected {
  delivered: Record<string, unknown>[];
  merged: { toString(): string };
  warnings: string[];
}

function warningLogger(): { logger: Logger; warnings: string[]; other: string[] } {
  const warnings: string[] = [];
  const other: string[] = [];
  const keep = (msg: string): void => {
    other.push(msg);
  };
  return {
    logger: {
      debug: () => undefined,
      info: keep,
      error: keep,
      warn: (msg: string) => {
        if (msg.startsWith("Stream consumer is falling behind")) warnings.push("merging_started");
        else if (msg.startsWith("Stream consumer caught up")) warnings.push("caught_up");
        else other.push(msg);
      },
    },
    warnings,
    other,
  };
}

function payload(item: BufferItem<never> | undefined): Record<string, unknown> {
  if (item === undefined || item.kind === "control") throw new Error("expected a message");
  return { ...item.message.raw };
}

describe("stream_backlog.json", () => {
  const vector = loadVector("stream_backlog.json");
  for (const c of vector.cases) {
    it(c.name, () => {
      const input = c.input as { limit: { toString(): string }; ops: Op[] };
      const expected = c.expected as Expected;
      const log = warningLogger();
      const buffer = new DeliveryBuffer<never>(Number(input.limit.toString()), log.logger);
      const delivered: Record<string, unknown>[] = [];
      for (const op of input.ops) {
        if (op.put !== undefined) {
          buffer.put(parseMessage(JSON.stringify(op.put)));
        } else if (op.take !== undefined) {
          for (let i = 0; i < Number(op.take.toString()); i += 1) {
            delivered.push(payload(buffer.take()));
          }
        }
      }
      for (const item of buffer.drain()) delivered.push(payload(item));
      expect(delivered).toEqual(expected.delivered);
      expect(buffer.mergedCount).toBe(Number(expected.merged.toString()));
      expect(log.warnings).toEqual(expected.warnings);
      expect(log.other).toEqual([]);
    });
  }
});

describe("DeliveryBuffer beyond the vectors", () => {
  it("a merged entry is rebuilt as its model, with the merged fields parsed", () => {
    const log = warningLogger();
    const buffer = new DeliveryBuffer<never>(1, log.logger);
    buffer.put(parseMessage('{"t":"tf","e":"NSE","tk":"22","lp":"1.5","v":"10"}'));
    buffer.put(parseMessage('{"t":"tf","e":"NSE","tk":"22","lp":"2.25"}'));
    const item = buffer.take();
    if (item === undefined || item.kind !== "TouchlineFeed") throw new Error("expected tf");
    expect(item.message.lastPrice?.toString()).toBe("2.25");
    expect(item.message.volume?.toString()).toBe("10");
    expect(buffer.length).toBe(0);
  });

  it("nothing merges across a barrier (a control entry), which is delivered in its place", () => {
    const log = warningLogger();
    const buffer = new DeliveryBuffer<string>(1, log.logger);
    buffer.put(parseMessage('{"t":"tf","e":"NSE","tk":"22","lp":"1"}'));
    buffer.putBarrier("disconnect");
    buffer.put(parseMessage('{"t":"tf","e":"NSE","tk":"22","lp":"2"}'));
    const kinds = buffer
      .drain()
      .map((i) => (i.kind === "control" ? i.control : i.message.raw["lp"]));
    expect(kinds).toEqual(["1", "disconnect", "2"]);
    expect(buffer.mergedCount).toBe(0);
  });

  it("get() waits for the next entry and resolves END once ended and drained", async () => {
    const buffer = new DeliveryBuffer<never>(10, warningLogger().logger);
    const next = buffer.get();
    buffer.put(parseMessage('{"t":"om","norenordno":"1"}'));
    const item = await next;
    expect(item !== DeliveryBuffer.END && item.kind === "OrderUpdate").toBe(true);
    buffer.put(parseMessage('{"t":"om","norenordno":"2"}'));
    buffer.end();
    const second = await buffer.get();
    expect(second !== DeliveryBuffer.END && second.kind).toBe("OrderUpdate");
    expect(await buffer.get()).toBe(DeliveryBuffer.END);
    expect(await buffer.get()).toBe(DeliveryBuffer.END);
  });
});
