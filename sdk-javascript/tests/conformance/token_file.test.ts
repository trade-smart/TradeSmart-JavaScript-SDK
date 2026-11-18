import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AccessToken, nextIstSixAm } from "../../src/auth.js";
import {
  formatTokenTimestamp,
  readTokenFile,
  TokenFileError,
  writeTokenFile,
} from "../../src/token-store/token-file.js";
import { loadVector } from "./vectors.js";

interface FileCase {
  name: string;
  input: { function: "write" | "read"; issued_at: string; expires_at?: string };
  expected: { issued_at?: string; expires_at?: string; error?: string };
}

const dir = mkdtempSync(path.join(os.tmpdir(), "tradesmart-tokenfile-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The offset of an ISO 8601 text in minutes (`Z` is 0). */
function offsetMinutes(text: string): number {
  const m = /([+-])(\d\d):(\d\d)$/.exec(text);
  if (m === null) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

describe("token_file.json", () => {
  const cases = loadVector("token_file.json").cases as unknown as FileCase[];
  cases.forEach((c, index) => {
    it(c.name, async () => {
      const file = path.join(dir, `case-${String(index)}.json`);
      if (c.input.function === "write") {
        const issued = new Date(c.input.issued_at);
        await writeTokenFile(file, {
          clientId: "SYNTH01",
          accessToken: AccessToken.fromParts("synthetic-token", issued, nextIstSixAm(issued)),
          issuedOffsetMinutes: offsetMinutes(c.input.issued_at),
        });
        const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
        expect(stored["issued_at"]).toBe(c.expected.issued_at);
        expect(stored["expires_at"]).toBe(c.expected.expires_at);
        expect(formatTokenTimestamp(issued, offsetMinutes(c.input.issued_at))).toBe(
          c.expected.issued_at,
        );
        return;
      }
      writeFileSync(
        file,
        JSON.stringify({
          client_id: "SYNTH01",
          access_token: "synthetic-token",
          issued_at: c.input.issued_at,
          expires_at: c.input.expires_at,
        }),
        { mode: 0o600 },
      );
      if (c.expected.error !== undefined) {
        expect(c.expected.error).toBe("invalid");
        expect(() => readTokenFile(file)).toThrow(TokenFileError);
        return;
      }
      const login = readTokenFile(file);
      // JavaScript dates hold milliseconds: the vector's finer fractions are compared truncated.
      expect(login.accessToken.issuedAt.getTime()).toBe(
        new Date(c.expected.issued_at as string).getTime(),
      );
      expect(login.accessToken.expiresAt.getTime()).toBe(
        new Date(c.expected.expires_at as string).getTime(),
      );
    });
  });
});
