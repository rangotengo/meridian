import { describe, it, expect } from "vitest";
import {
  parseAmountToMinor,
  tryParseAmountToMinor,
  formatMoney,
  splitEvenly,
  currencyExponent,
  sumMinors
} from "@/lib/money";

describe("money", () => {
  it("parses decimal strings into minor units", () => {
    expect(parseAmountToMinor("10.50", "USD")).toBe(1050);
    expect(parseAmountToMinor("-3", "USD")).toBe(-300);
    expect(parseAmountToMinor("-0.50", "USD")).toBe(-50);
    expect(parseAmountToMinor("-0.00", "USD")).toBe(-0);
    expect(parseAmountToMinor("+0.01", "USD")).toBe(1);
    expect(parseAmountToMinor("1,234.56", "USD")).toBe(123456);
    expect(parseAmountToMinor("1000", "JPY")).toBe(1000);
  });

  it("rejects malformed amounts", () => {
    expect(() => parseAmountToMinor("abc", "USD")).toThrow();
    expect(() => parseAmountToMinor("", "USD")).toThrow();
    expect(() => parseAmountToMinor("1.2.3", "USD")).toThrow();
  });

  it("rejects precision beyond the currency exponent", () => {
    try {
      parseAmountToMinor("1.999", "USD");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("money.invalid");
    }
    try {
      parseAmountToMinor("1000.5", "JPY");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("money.invalid");
    }
    expect(parseAmountToMinor("1000", "JPY")).toBe(1000);
    expect(parseAmountToMinor("1.50", "USD")).toBe(150);
  });

  it("uses correct exponents per currency", () => {
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
  });

  it("formats for display", () => {
    expect(formatMoney(1050, "USD", "en-US")).toContain("10.50");
    const negative = formatMoney(-500, "USD", "en-US");
    expect(negative.startsWith("-")).toBe(true);
    expect(negative).toContain("5.00");
  });

  it("splits evenly with remainder distribution", () => {
    expect(splitEvenly(100, 3)).toEqual([34, 33, 33]);
    expect(splitEvenly(-100, 3)).toEqual([-34, -33, -33]);
    expect(splitEvenly(0, 4)).toEqual([0, 0, 0, 0]);
  });

  it("guards safe-integer range in sums", () => {
    expect(sumMinors([1, 2, 3])).toBe(6);
    expect(() => sumMinors([Number.MAX_SAFE_INTEGER, 1])).toThrow();
  });
});

describe("tryParseAmountToMinor (form input)", () => {
  it("parses valid amounts exactly like parseAmountToMinor", () => {
    expect(tryParseAmountToMinor("10.50", "USD")).toBe(1050);
    expect(tryParseAmountToMinor("-3", "USD")).toBe(-300);
    expect(tryParseAmountToMinor("1,234.56", "USD")).toBe(123456);
    expect(tryParseAmountToMinor("1000", "JPY")).toBe(1000);
  });

  it("returns null instead of throwing for empty or partial input", () => {
    expect(tryParseAmountToMinor("", "USD")).toBeNull();
    expect(tryParseAmountToMinor("   ", "USD")).toBeNull();
    expect(tryParseAmountToMinor("-", "USD")).toBeNull();
    expect(tryParseAmountToMinor("+", "USD")).toBeNull();
  });

  it("returns null instead of throwing for invalid or over-precise input", () => {
    expect(tryParseAmountToMinor("abc", "USD")).toBeNull();
    expect(tryParseAmountToMinor("1.2.3", "USD")).toBeNull();
    expect(tryParseAmountToMinor("1.999", "USD")).toBeNull();
    expect(tryParseAmountToMinor("1000.5", "JPY")).toBeNull();
  });
});
