import { describe, expect, it } from "vitest";
import { AccessToken, nextIstSixAm } from "../../src/auth.js";
import { loadVector } from "./vectors.js";

interface ExpiryCase {
  name: string;
  input: {
    function: "next_expiry" | "is_expired";
    issued_at: string;
    expires_at?: string;
    now?: string;
  };
  expected: { expires_at?: string; expired?: boolean; error?: string };
}

/** An ISO 8601 text with an offset to its instant; a naive text has no JavaScript form. */
function aware(text: string): Date {
  if (!/(Z|[+-]\d\d:\d\d)$/.test(text)) throw new RangeError("naive datetime");
  return new Date(text);
}

describe("token_expiry.json", () => {
  for (const c of loadVector("token_expiry.json").cases as unknown as ExpiryCase[]) {
    it(c.name, () => {
      const { input, expected } = c;
      if (input.function === "next_expiry") {
        if (expected.error !== undefined) {
          // A naive instant cannot be expressed as a Date; the conversion refuses it.
          expect(() => nextIstSixAm(aware(input.issued_at))).toThrow(RangeError);
        } else {
          expect(nextIstSixAm(aware(input.issued_at)).getTime()).toBe(
            aware(expected.expires_at as string).getTime(),
          );
        }
      } else {
        const token = AccessToken.fromParts(
          "synthetic-token",
          aware(input.issued_at),
          aware(input.expires_at as string),
        );
        expect(token.isExpired(aware(input.now as string))).toBe(expected.expired);
      }
    });
  }
});
