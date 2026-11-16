import { describe, expect, it } from "vitest";
import { parseHoldingsCsv } from "@/server/domain/holdings-import";
import {
  formatQuantity,
  holdingValueMinor,
  parseQuantity,
  summarizeHoldings
} from "@/server/domain/holdings";
import type { PortfolioHoldingRow } from "@/server/domain/holdings";

describe("parseQuantity / formatQuantity", () => {
  it("parses and normalizes decimal quantities exactly", () => {
    expect(parseQuantity("100")).toMatchObject({ normalized: "100" });
    expect(parseQuantity("50.5000")).toMatchObject({ normalized: "50.5" });
    expect(parseQuantity("0.000001")).toMatchObject({ normalized: "0.000001" });
    expect(parseQuantity("1,234.25")).toMatchObject({ normalized: "1234.25" });
    expect(formatQuantity(parseQuantity("1234.25").scaled)).toBe("1234.25");
  });

  it("rejects signs, exponents, and more than 6 decimal places", () => {
    expect(() => parseQuantity("-5")).toThrow(/not a valid quantity/);
    expect(() => parseQuantity("1e3")).toThrow(/not a valid quantity/);
    expect(() => parseQuantity("1.0000001")).toThrow(/at most 6 decimal places/);
    expect(() => parseQuantity("abc")).toThrow(/not a valid quantity/);
  });

  it("values holdings with exact scaled math and half-up rounding", () => {
    // 50.5 × 100.00 = 5,050.00 exactly.
    expect(holdingValueMinor(parseQuantity("50.5").scaled, 100_00)).toBe(505_000);
    // 0.000001 × 1.00 = 0.0001 minor → rounds to 0; 1.5 minor rounds up.
    expect(holdingValueMinor(parseQuantity("0.000001").scaled, 100)).toBe(0);
    expect(holdingValueMinor(parseQuantity("1.5").scaled, 1)).toBe(2);
  });
});

describe("summarizeHoldings", () => {
  const row = (partial: Partial<PortfolioHoldingRow>): PortfolioHoldingRow =>
    ({
      id: "h",
      accountId: "a",
      ticker: "X",
      companyName: null,
      quantity: "1",
      averageCostMinor: null,
      currentPriceMinor: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...partial
    }) as PortfolioHoldingRow;

  it("computes value, cost, and gain with a partial-cost footnote flag", () => {
    const summary = summarizeHoldings([
      row({ ticker: "A", quantity: "100", averageCostMinor: 200_00, currentPriceMinor: 250_00 }),
      row({ ticker: "B", quantity: "10", averageCostMinor: null, currentPriceMinor: 50_00 })
    ]);
    expect(summary.totalValueMinor).toBe(2_500_000 + 50_000);
    expect(summary.totalCostMinor).toBe(2_000_000);
    expect(summary.partialCost).toBe(true);
    // Gain covers only the cost-known holding: 2,500,000 − 2,000,000.
    expect(summary.unrealizedGainMinor).toBe(500_000);
    expect(summary.unrealizedGainPercent).toBeCloseTo(25);
  });

  it("falls back to average cost when no current price is set", () => {
    const summary = summarizeHoldings([
      row({ quantity: "10", averageCostMinor: 100_00, currentPriceMinor: null })
    ]);
    expect(summary.totalValueMinor).toBe(100_000);
    expect(summary.unrealizedGainMinor).toBe(0);
  });
});

describe("parseHoldingsCsv", () => {
  it("parses a valid file, converting major-unit prices to minor", () => {
    const parsed = parseHoldingsCsv(
      [
        "ticker,quantity,average_cost,current_price,company_name",
        "NABIL,100,200.00,250.50,Nabil Bank Limited",
        "hidcl,50.5,99.99,,Hydroelectricity Investment and Development Company"
      ].join("\n"),
      "USD"
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      row: 2,
      ticker: "NABIL",
      quantity: "100",
      averageCostMinor: 200_00,
      currentPriceMinor: 250_50,
      companyName: "Nabil Bank Limited"
    });
    // Tickers normalize; an empty price cell means unknown.
    expect(parsed.rows[1]).toMatchObject({
      row: 3,
      ticker: "HIDCL",
      quantity: "50.5",
      averageCostMinor: 99_99,
      currentPriceMinor: null
    });
  });

  it("handles quoted fields, commas inside names, and blank lines", () => {
    const parsed = parseHoldingsCsv(
      'ticker,quantity,average_cost,current_price,company_name\n"NABIL","1,000","200.00","250.00","Nabil Bank, Ltd."\n\n',
      "USD"
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({
      ticker: "NABIL",
      quantity: "1000",
      companyName: "Nabil Bank, Ltd."
    });
  });

  it("throws when the file or its required header columns are missing", () => {
    expect(() => parseHoldingsCsv("", "USD")).toThrow(/Choose a CSV file/);
    expect(() => parseHoldingsCsv("   \n", "USD")).toThrow(/Choose a CSV file/);
    expect(() => parseHoldingsCsv("symbol,shares\nNABIL,10", "USD")).toThrow(
      /must include ticker and quantity/
    );
    expect(() => parseHoldingsCsv('ticker,quantity\n"NABIL,10', "USD")).toThrow(/unterminated/);
  });

  it("reports bad rows with row numbers while valid rows still parse", () => {
    const parsed = parseHoldingsCsv(
      [
        "ticker,quantity,average_cost,current_price",
        "NABIL,100,200.00,250.00",
        ",10,100.00,100.00",
        "HIDCL,not-a-number,100.00,100.00",
        "API,10,-5.00,100.00",
        "SANIMA,0,100.00,100.00",
        "NIFRA,25,10.50,12.00"
      ].join("\n"),
      "USD"
    );
    expect(parsed.rows.map((r) => r.ticker)).toEqual(["NABIL", "NIFRA"]);
    expect(parsed.errors.map((e) => e.row)).toEqual([3, 4, 5, 6]);
    expect(parsed.errors[0]!.message).toMatch(/Missing ticker/);
    expect(parsed.errors[1]!.message).toMatch(/not a valid quantity/);
    expect(parsed.errors[2]!.message).toMatch(/negative/);
    expect(parsed.errors[3]!.message).toMatch(/greater than zero/);
  });

  it("accepts a header without the optional price columns", () => {
    const parsed = parseHoldingsCsv("ticker,quantity\nNABIL,10", "USD");
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({
      ticker: "NABIL",
      averageCostMinor: null,
      currentPriceMinor: null,
      companyName: null
    });
  });
});
