import { describe, expect, it } from "vitest";
import { ackAccepted } from "../../src/stream/protocol.js";
import { loadVector } from "./vectors.js";

describe("ws_connect_ack.json", () => {
  const vector = loadVector("ws_connect_ack.json");
  for (const c of vector.cases) {
    it(c.name, () => {
      const input = c.input as { s: string };
      const expected = c.expected as { accepted: boolean };
      expect(ackAccepted(input.s)).toBe(expected.accepted);
    });
  }

  it("a missing or non-string s is never accepted", () => {
    expect(ackAccepted(null)).toBe(false);
    expect(ackAccepted(undefined)).toBe(false);
  });
});
