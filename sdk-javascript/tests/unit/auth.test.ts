import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  AccessToken,
  buildAuthorizeUrl,
  checkTokenText,
  computeChecksum,
  nextIstSixAm,
} from "../../src/auth.js";
import { ConfigurationError, ResponseParseError } from "../../src/errors.js";

describe("buildAuthorizeUrl", () => {
  it("percent-encodes the app key", () => {
    expect(buildAuthorizeUrl("a b/c")).toMatch(/\?client_id=a%20b%2Fc$/);
  });
  it("encodes the characters encodeURIComponent leaves alone", () => {
    expect(buildAuthorizeUrl("a!'()*b")).toMatch(/client_id=a%21%27%28%29%2Ab$/);
  });
  it("keeps unreserved characters and uses the configured default URL", () => {
    expect(buildAuthorizeUrl("AB-c_d.e~1")).toBe(
      "https://v2api.tradesmartonline.in/OAuthlogin/authorize/oauth?client_id=AB-c_d.e~1",
    );
  });
  it("uses a given authorize URL", () => {
    expect(buildAuthorizeUrl("k", "https://x.example/auth")).toBe(
      "https://x.example/auth?client_id=k",
    );
  });
  it("refuses an empty app key", () => {
    expect(() => buildAuthorizeUrl("")).toThrow(ConfigurationError);
  });
  it("refuses a key that cannot be encoded", () => {
    expect(() => buildAuthorizeUrl("\ud800")).toThrow(ConfigurationError);
  });
});

describe("computeChecksum", () => {
  it("is the SHA-256 of the plain concatenation", () => {
    expect(computeChecksum("a", "b", "c")).toBe(createHash("sha256").update("abc").digest("hex"));
  });
  it("refuses any empty part", () => {
    expect(() => computeChecksum("", "b", "c")).toThrow(ConfigurationError);
    expect(() => computeChecksum("a", "", "c")).toThrow(ConfigurationError);
  });
});

describe("checkTokenText", () => {
  it("strips surrounding whitespace", () => {
    expect(checkTokenText("tok\r\n")).toBe("tok");
  });
  it("refuses non-ASCII without echoing it", () => {
    let message = "";
    try {
      checkTokenText("tök");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("tök");
    expect(message).toContain("printable ASCII");
  });
  it("refuses inner spaces and control characters", () => {
    expect(() => checkTokenText("a b")).toThrow(ConfigurationError);
    expect(() => checkTokenText("a\tb")).toThrow(ConfigurationError);
    expect(() => checkTokenText("a\x7fb")).toThrow(ConfigurationError);
  });
  it("returns a blank token as an empty string", () => {
    expect(checkTokenText("  \n")).toBe("");
  });
});

describe("nextIstSixAm", () => {
  it("refuses an invalid date", () => {
    expect(() => nextIstSixAm(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe("AccessToken", () => {
  const issued = new Date("2026-11-10T09:15:30+05:30");
  const wire = {
    access_token: "synthetic-access",
    susertoken: "synthetic-susertoken",
    refresh_token: "synthetic-refresh",
    expires_in: "3600",
    uid: "SYNTH01",
    actid: "SYNTH01",
    uname: "Synthetic User",
    stat: "Ok",
  };

  it("builds from a GenAcsTok body with the 06:00 IST expiry", () => {
    const token = AccessToken.fromResponse(wire, issued);
    expect(token.accessToken.reveal()).toBe("synthetic-access");
    expect(token.susertoken?.reveal()).toBe("synthetic-susertoken");
    expect(token.refreshToken?.reveal()).toBe("synthetic-refresh");
    expect(token.userId).toBe("SYNTH01");
    expect(token.accountId).toBe("SYNTH01");
    expect(token.uname).toBe("Synthetic User");
    expect(token.expiresIn).toBe("3600");
    expect(token.issuedAt).toEqual(issued);
    expect(token.expiresAt.toISOString()).toBe("2026-11-11T00:30:00.000Z");
  });

  it("masks every secret in raw, toString, inspect and JSON", () => {
    const token = AccessToken.fromResponse(wire, issued);
    expect(token.raw["access_token"]).toBe("***");
    expect(token.raw["issued_at"]).toBeUndefined();
    const shown = [String(token), inspect(token), JSON.stringify(token), JSON.stringify(token.raw)];
    for (const text of shown) {
      expect(text).not.toContain("synthetic-access");
      expect(text).not.toContain("synthetic-susertoken");
      expect(text).not.toContain("synthetic-refresh");
    }
  });

  it("isExpired is true at the exact expiry instant", () => {
    const token = AccessToken.fromResponse(wire, issued);
    expect(token.isExpired(new Date(token.expiresAt.getTime() - 1))).toBe(false);
    expect(token.isExpired(token.expiresAt)).toBe(true);
  });

  it("refuses a body without an access token", () => {
    expect(() => AccessToken.fromResponse({ stat: "Ok" }, issued)).toThrow(ResponseParseError);
    expect(() => AccessToken.fromResponse("nope", issued)).toThrow(ResponseParseError);
  });
});
