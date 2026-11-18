import { describe, expect, it } from "vitest";
import { computeChecksum } from "../../src/auth.js";
import { ConfigurationError } from "../../src/errors.js";
import { loadVector } from "./vectors.js";

interface ChecksumCase {
  name: string;
  input: { app_key: string; secret_key: string; code: string };
  expected: { checksum?: string; error?: string };
}

describe("checksum.json", () => {
  for (const c of loadVector("checksum.json").cases as unknown as ChecksumCase[]) {
    it(c.name, () => {
      const { app_key: appKey, secret_key: secretKey, code } = c.input;
      if (c.expected.error !== undefined) {
        expect(c.expected.error).toBe("ConfigurationError");
        expect(() => computeChecksum(appKey, secretKey, code)).toThrow(ConfigurationError);
      } else {
        expect(computeChecksum(appKey, secretKey, code)).toBe(c.expected.checksum);
      }
    });
  }
});
