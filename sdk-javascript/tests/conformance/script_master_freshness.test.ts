// script_master_freshness.json: the cache decision of `downloadInstruments("NSE")` (sdk-behaviour.md
// §8.2), driven through the real client with an in-memory transport serving `responses` in turn,
// the file's mtime set to `file_mtime` and the exact sidecar text compared.
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  NSE_TEXT,
  scriptMasterClient,
  zipOf,
  type SmReply,
  type SmScripted,
} from "../helpers/script-master-client.js";
import type { JsonNumber } from "../../src/lib/json.js";
import { loadVector } from "./vectors.js";

interface Response {
  status?: JsonNumber;
  last_modified?: string;
  failure?: string;
  delete_file?: boolean;
}
interface Input {
  checked: string | null;
  file_mtime: string | null;
  force: boolean;
  now: string;
  responses: Response[];
}
interface Expected {
  checked: string | null;
  error?: string;
  file?: "downloaded" | "cached";
  file_mtime?: string;
  requests: { if_modified_since: string | null }[];
  warnings: JsonNumber;
}

const OLD_TEXT = "Exchange,Token\nNSE,OLD\n";
const NEW_TEXT = NSE_TEXT;

const open: SmScripted[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.cleanup();
});

describe("script_master_freshness.json", () => {
  for (const c of loadVector("script_master_freshness.json").cases) {
    it(c.name, async () => {
      const input = c.input as Input;
      const expected = c.expected as Expected;
      const replies = input.responses.map((r, i): SmReply => ({
        ...(r.status === undefined ? {} : { status: Number(r.status.text) }),
        ...(r.status !== undefined && Number(r.status.text) === 200
          ? { body: zipOf({ "NSE_symbols.txt": NEW_TEXT }) }
          : {}),
        ...(r.last_modified === undefined ? {} : { headers: { "last-modified": r.last_modified } }),
        ...(r.failure === undefined ? {} : { failure: r.failure }),
        ...(r.delete_file === true ? { deleteFile: `__FILE__${String(i)}` } : {}),
      }));
      const s = scriptMasterClient(replies);
      open.push(s);
      // The file to delete is only known now (the harness chose the folder).
      for (const r of replies) {
        if (r.deleteFile !== undefined) r.deleteFile = s.file;
      }
      s.ctx.now = () => new Date(input.now);
      if (input.file_mtime !== null) {
        writeFileSync(s.file, OLD_TEXT);
        const when = new Date(input.file_mtime);
        utimesSync(s.file, when, when);
      }
      if (input.checked !== null) writeFileSync(`${s.file}.checked`, input.checked);

      let error: string | null = null;
      let result: string | null = null;
      try {
        result = await s.client.downloadInstruments("NSE", { force: input.force });
      } catch (e) {
        error = (e as Error).name;
      }

      expect(error).toBe(expected.error ?? null);
      expect(s.requests.map((r) => r.headers["if-modified-since"] ?? null)).toEqual(
        expected.requests.map((r) => r.if_modified_since),
      );
      expect(s.lines.filter((l) => l.level === "warn")).toHaveLength(
        Number(expected.warnings.text),
      );
      const sidecar = existsSync(`${s.file}.checked`)
        ? readFileSync(`${s.file}.checked`, "ascii")
        : null;
      expect(sidecar).toBe(expected.checked);
      if (expected.error === undefined) {
        expect(result).toBe(s.file);
        expect(readFileSync(s.file, "utf8")).toBe(
          expected.file === "downloaded" ? NEW_TEXT : OLD_TEXT,
        );
        expect(statSync(s.file).mtimeMs).toBe(new Date(expected.file_mtime ?? "").getTime());
      }
    });
  }
});
