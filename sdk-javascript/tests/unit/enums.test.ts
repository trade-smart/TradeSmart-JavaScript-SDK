import { describe, expect, it } from "vitest";
import {
  Buildup,
  Exchange,
  GttAlertType,
  OrderType,
  Product,
  StreamState,
  TransactionType,
  resolveEnum,
} from "../../src/enums.js";
import { RequestValidationError } from "../../src/errors.js";

describe("enum constants", () => {
  it("map member names to wire values", () => {
    expect(Exchange.NSE).toBe("NSE");
    expect(Product.CNC).toBe("C");
    expect(OrderType.SL_M).toBe("SL-MKT");
    expect(TransactionType.SELL).toBe("S");
    expect(GttAlertType.HIGH_52W_ABOVE).toBe("LTP_A_52HIGH_O");
  });

  it("include the value enums", () => {
    expect(Buildup.LONG_BUILDUP).toBe("long_buildup");
    expect(StreamState.CONNECTED).toBe("CONNECTED");
  });

  it("are frozen", () => {
    expect(Object.isFrozen(Exchange)).toBe(true);
  });
});

describe("resolveEnum", () => {
  it("accepts the wire code in any case", () => {
    expect(resolveEnum("Exchange", "nse", "exch")).toBe("NSE");
    expect(resolveEnum("Product", "c", "prd")).toBe("C");
    expect(resolveEnum("OrderType", "sl-lmt", "prctyp")).toBe("SL-LMT");
  });

  it("accepts the listed words in any case, trimmed", () => {
    expect(resolveEnum("Product", "CNC", "prd")).toBe("C");
    expect(resolveEnum("Product", " cnc ", "prd")).toBe("C");
    expect(resolveEnum("TransactionType", "buy", "trantype")).toBe("B");
    expect(resolveEnum("OrderType", "SL-M", "prctyp")).toBe("SL-MKT");
    expect(resolveEnum("OrderType", "slm", "prctyp")).toBe("SL-MKT");
    expect(resolveEnum("GttAlertType", "ltp_above", "ai_t")).toBe("LTP_A_O");
  });

  it("accepts the constants themselves", () => {
    expect(resolveEnum("Product", Product.MIS, "prd")).toBe("I");
  });

  it("rejects an unknown value with loc [field], never echoing the value", () => {
    const resolve = (): string => resolveEnum("Exchange", "XX", "exch");
    expect(resolve).toThrow(RequestValidationError);
    try {
      resolve();
    } catch (error) {
      expect((error as RequestValidationError).errors[0]?.loc).toEqual(["exch"]);
      expect((error as Error).message).not.toContain("XX");
    }
  });

  it("rejects non-strings and blanks", () => {
    expect(() => resolveEnum("Exchange", 1, "exch")).toThrow(RequestValidationError);
    expect(() => resolveEnum("Exchange", null, "exch")).toThrow(RequestValidationError);
    expect(() => resolveEnum("Exchange", "  ", "exch")).toThrow(RequestValidationError);
  });
});
