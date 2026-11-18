import { describe, expect, it } from "vitest";
import { canonicalEndpoint, isSuccessWord } from "../../src/lib/names.js";
import { ConfigurationError } from "../../src/errors.js";
import { type JsonNumber, parseJsonLossless } from "../../src/lib/json.js";
import { loadVector } from "../conformance/vectors.js";

const STATE_CHANGING = [
  "PlaceOrder",
  "PlaceMultiOrder",
  "ModifyOrder",
  "CancelOrder",
  "ExitSNOOrder",
  "GenAcsTok",
  "PlaceGTTOrder",
  "ModifyGTTOrder",
  "CancelGTTOrder",
  "PlaceIceBergOrder",
  "ModifyIceBergOrder",
  "CancelIceBergOrder",
];

describe("canonicalEndpoint", () => {
  it("returns a frozen object with frozen success words", () => {
    const info = canonicalEndpoint("placegttorder");
    expect(Object.isFrozen(info)).toBe(true);
    expect(Object.isFrozen(info.successWords)).toBe(true);
    expect(() => {
      (info as { endpoint: string }).endpoint = "x";
    }).toThrow(TypeError);
  });

  it("marks exactly the twelve state-changing names, in any case", () => {
    for (const name of STATE_CHANGING) {
      expect(canonicalEndpoint(name.toUpperCase()).stateChanging).toBe(true);
      expect(canonicalEndpoint(name.toLowerCase()).endpoint).toBe(name);
    }
    for (const name of ["Limits", "OrderBook", "GetQuotes", "TPSeries", "GetPendingGTTOrder"]) {
      expect(canonicalEndpoint(name).stateChanging).toBe(false);
    }
  });

  it("covers the GTT and iceberg success words and the GTT ack field", () => {
    const place = canonicalEndpoint("PlaceGTTOrder");
    expect(place.successWords).toEqual(["Oi created"]);
    expect(place.requiresAckId).toBe("al_id");
    expect(place.ignoreCase).toBe(true);
    expect(canonicalEndpoint("ModifyGTTOrder").successWords).toEqual(["Oi replaced"]);
    expect(canonicalEndpoint("CancelGTTOrder").successWords).toEqual(["Oi delete success"]);
    for (const name of ["PlaceIceBergOrder", "ModifyIceBergOrder", "CancelIceBergOrder"]) {
      const info = canonicalEndpoint(name);
      expect(info.successWords).toEqual(["true"]);
      expect(info.ignoreCase).toBe(false);
      expect(info.requiresAckId).toBeNull();
      expect(info.rateGroup).toBeNull();
    }
    const other = canonicalEndpoint("Limits");
    expect(other.successWords).toEqual(["Ok"]);
    expect(other.ignoreCase).toBe(false);
  });

  it("assigns the rate groups by name", () => {
    expect(canonicalEndpoint("placemultiorder").rateGroup).toBe("orders");
    expect(canonicalEndpoint("getquotesmultiple").rateGroup).toBe("quotes");
    expect(canonicalEndpoint("tpseries").rateGroup).toBe("tpseries");
    expect(canonicalEndpoint("ModifyOrder").rateGroup).toBeNull();
  });

  it("trims whitespace and slashes and rejects anything but ASCII letters", () => {
    expect(canonicalEndpoint(" //Limits/ ").endpoint).toBe("Limits");
    for (const bad of ["", " / ", "a b", "a/b", "a.b", "a1", "Plàce", "ＰＬＡＣＥ"]) {
      expect(() => canonicalEndpoint(bad)).toThrow(ConfigurationError);
    }
  });

  it("does not put the rejected name in the error message", () => {
    try {
      canonicalEndpoint("secret.name");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("secret");
    }
  });
});

describe("isSuccessWord", () => {
  it("compares the GTT words ignoring letter case only", () => {
    expect(isSuccessWord("PlaceGTTOrder", "Oi created")).toBe(true);
    expect(isSuccessWord("PlaceGTTOrder", "OI created")).toBe(true);
    expect(isSuccessWord("PlaceGTTOrder", "oi CREATED")).toBe(true);
    expect(isSuccessWord("PlaceGTTOrder", "Oi  created")).toBe(false);
    expect(isSuccessWord("PlaceGTTOrder", " Oi created")).toBe(false);
    expect(isSuccessWord("PlaceGTTOrder", "Oi created ")).toBe(false);
    expect(isSuccessWord("PlaceGTTOrder", "Oi replaced")).toBe(false);
    expect(isSuccessWord("CancelGTTOrder", "OI deleted")).toBe(false);
    expect(isSuccessWord("CancelGTTOrder", "OI DELETE SUCCESS")).toBe(true);
  });

  it("folds case like Unicode case folding (long s, sharp s, Kelvin sign)", () => {
    expect(isSuccessWord("CancelGTTOrder", "Oi delete ſuccess")).toBe(true);
    expect(isSuccessWord("CancelGTTOrder", "Oi delete suKcess")).toBe(false);
    expect(isSuccessWord("CancelGTTOrder", "Oi delete success")).toBe(true);
  });

  it("matches Python casefold() exactly for look-alike characters (results confirmed in Python)", () => {
    const c = (...codes: number[]): string => String.fromCodePoint(...codes);
    const cancel = "CancelGTTOrder";
    const place = "PlaceGTTOrder";
    // Python accepts: long s, sharp s (both cases) fold to "s" / "ss".
    expect(isSuccessWord(cancel, `Oi delete ${c(0x17f)}uccess`)).toBe(true);
    expect(isSuccessWord(cancel, `Oi delete succe${c(0xdf)}`)).toBe(true);
    expect(isSuccessWord(cancel, `Oi delete succe${c(0x1e9e)}`)).toBe(true);
    // Python rejects: dotless i stays itself, dotted I folds to i + U+0307, fullwidth letters
    // fold to fullwidth, Kelvin sign folds to "k".
    expect(isSuccessWord(place, `O${c(0x131)} created`)).toBe(false);
    expect(isSuccessWord("ModifyGTTOrder", `O${c(0x131)} replaced`)).toBe(false);
    expect(isSuccessWord(cancel, `O${c(0x131)} delete success`)).toBe(false);
    expect(isSuccessWord(place, `${c(0x130)}i created`)).toBe(false);
    expect(isSuccessWord(place, `${c(0xff2f, 0xff49)} created`)).toBe(false);
    expect(isSuccessWord(cancel, `Oi delete su${c(0x212a)}cess`)).toBe(false);
    // Python: the ligature U+FB06 folds to "st"; no GTT word contains it, so nothing matches.
    expect(isSuccessWord(place, `Oi cr${c(0xfb06)}`)).toBe(false);
  });

  it("keeps the iceberg true and every other word exact", () => {
    expect(isSuccessWord("PlaceIceBergOrder", "true")).toBe(true);
    expect(isSuccessWord("PlaceIceBergOrder", "True")).toBe(false);
    expect(isSuccessWord("PlaceIceBergOrder", "TRUE")).toBe(false);
    expect(isSuccessWord("PlaceIceBergOrder", "Ok")).toBe(false);
    expect(isSuccessWord("PlaceOrder", "Ok")).toBe(true);
    expect(isSuccessWord("PlaceOrder", "ok")).toBe(false);
    expect(isSuccessWord("PlaceOrder", "true")).toBe(false);
    expect(isSuccessWord("PlaceOrder", "Oi created")).toBe(false);
    expect(isSuccessWord("Limits", "Ok")).toBe(true);
  });

  it("is false for anything that is not a string", () => {
    for (const stat of [true, false, null, undefined, 1, {}, ["Ok"]]) {
      expect(isSuccessWord("PlaceOrder", stat)).toBe(false);
      expect(isSuccessWord("PlaceIceBergOrder", stat)).toBe(false);
    }
  });
});

// The cases of success_words.json that depend on the word alone: a JSON object with a string or
// non-string `stat`, where the other success conditions (`al_id`, `emsg`) hold, so the word decides.
describe("isSuccessWord against success_words.json", () => {
  const vector = loadVector("success_words.json");
  const ACK = new Set(["PlaceGTTOrder", "ModifyGTTOrder", "CancelGTTOrder"]);
  let checked = 0;
  for (const c of vector.cases) {
    const input = c.input as { body: string; endpoint: string; http_status: JsonNumber };
    const expected = c.expected as { returns?: unknown; error?: string };
    let body: unknown;
    try {
      body = parseJsonLossless(input.body);
    } catch {
      continue;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) continue;
    if (input.http_status.text !== "200") continue;
    const record = body as Record<string, unknown>;
    const word = ACK.has(input.endpoint)
      ? typeof record["al_id"] === "string" &&
        record["al_id"].trim() !== "" &&
        (record["emsg"] === undefined || record["emsg"] === null || record["emsg"] === "")
      : true;
    if (!word) continue;
    // Every other outcome (unknown, rejected, parse error) means the word is no success word.
    const success = expected.returns !== undefined;
    checked += 1;
    it(c.name, () => {
      expect(isSuccessWord(input.endpoint, record["stat"])).toBe(success);
    });
  }
  it("checked a meaningful number of cases", () => {
    expect(checked).toBeGreaterThan(50);
  });
});
