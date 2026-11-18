import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ResponseParseError } from "../../src/errors.js";
import { parseJsonLossless } from "../../src/lib/json.js";
import {
  T,
  parseAccessToken,
  parseHolding,
  parseModel,
  parseOrder,
  type ModelSpec,
} from "../../src/models/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, "../../../specifications/test-fixtures");

function fixture(name: string): unknown {
  return parseJsonLossless(readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

function holdingWire(): Record<string, unknown> {
  return (fixture("holdings_success.json") as unknown[])[0] as Record<string, unknown>;
}

describe("default redaction of raw", () => {
  it("masks access_token, susertoken and refresh_token in AccessToken.raw", () => {
    const record = fixture("gen_acs_tok_success.json") as Record<string, unknown>;
    const token = parseAccessToken({
      ...record,
      issued_at: new Date(),
      expires_at: new Date(),
    });
    expect(token.raw["access_token"]).toBe("***");
    expect(token.raw["susertoken"]).toBe("***");
    expect(token.raw["refresh_token"]).toBe("***");
    expect(token.raw["uname"]).toBe("Test User");
    expect(JSON.stringify(token.raw)).not.toContain("test-access-token");
  });

  it("masks listed keys in any case, in the raw of nested models and of the parent", () => {
    const wire = holdingWire();
    const holding = parseHolding({
      ...wire,
      Password: "p1",
      exch_tsym: (wire["exch_tsym"] as object[]).map((item) => ({ ...item, Checksum: "c1" })),
    });
    expect(holding.raw["Password"]).toBe("***");
    const instrument = holding.instruments?.[0];
    expect(instrument?.raw["Checksum"]).toBe("***");
    expect(instrument?.raw["token"]).toBe("1001");
    const parentView = holding.raw["exch_tsym"] as { Checksum?: unknown }[];
    expect(parentView[0]?.Checksum).toBe("***");
  });

  it("keeps extra values as received, like the reference model_extra", () => {
    const holding = parseHolding({ ...holdingWire(), code: "visible-in-extra" });
    expect(holding.raw["code"]).toBe("***");
    expect(holding.extra["code"]).toBe("visible-in-extra");
  });

  it("a caller hook can only add to the masking", () => {
    const order = parseOrder(
      { ...((fixture("order_book_success.json") as unknown[])[0] as object), access_token: "tok" },
      { redact: (raw) => ({ ...raw, access_token: "plain", uid: "***" }) },
    );
    expect(order.raw["access_token"]).toBe("***");
    expect(order.raw["uid"]).toBe("***");
  });

  it("masks the wire key of every secret-typed field", () => {
    const spec: ModelSpec = {
      name: "Probe",
      fields: [{ name: "hidden", wire: "my_private_value", type: T.secret }],
    };
    const probe = parseModel(spec, { my_private_value: "s3", other: "o" }) as {
      raw: Record<string, unknown>;
    };
    expect(probe.raw).toEqual({ my_private_value: "***", other: "o" });
  });
});

describe("parse failures", () => {
  it("raise ResponseParseError with a redacted body, never the failing value", () => {
    const wire = {
      ...((fixture("order_book_success.json") as unknown[])[0] as object),
      norenordno: { leak: "value-123" },
      access_token: "tok-456",
    };
    try {
      parseOrder(wire);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ResponseParseError);
      const e = error as ResponseParseError;
      expect(e.protectedKey).toBe(true);
      expect(e.fields).toEqual(["norenordno"]);
      expect(e.model).toBe("Order");
      expect(e.body).toContain("***");
      expect(e.body).not.toContain("tok-456");
      expect(e.message).not.toContain("value-123");
    }
  });
});
