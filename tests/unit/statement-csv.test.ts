import { describe, expect, it } from "vitest";
import {
  detectStatementMapping,
  parseCsv,
  parseStatementAmount,
  parseStatementDate,
  parseStatementRows,
  statementExternalId,
  validateStatementMapping
} from "@/server/domain/statement-csv";

describe("parseCsv", () => {
  it("handles quoted commas, embedded newlines, CRLF, and a BOM", () => {
    const rows = parseCsv(
      '\uFEFFDate,Particulars,Debit\r\n2026-11-01,"ATM, Kathmandu",5000\r\n2026-11-02,"Line one\nLine two",,2000\r\n'
    );
    expect(rows).toEqual([
      ["Date", "Particulars", "Debit"],
      ["2026-11-01", "ATM, Kathmandu", "5000"],
      ["2026-11-02", "Line one\nLine two", "", "2000"]
    ]);
  });

  it("drops trailing blank lines", () => {
    expect(parseCsv("a,b\n1,2\n\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"]
    ]);
  });
});

describe("detectStatementMapping", () => {
  it("detects Nepali bank columns (Date / Particulars / Debit / Credit / Balance)", () => {
    expect(detectStatementMapping(["Date", "Particulars", "Debit", "Credit", "Balance"])).toEqual({
      date: 0,
      description: 1,
      amount: null,
      debit: 2,
      credit: 3
    });
  });

  it("detects a single signed amount column", () => {
    expect(detectStatementMapping(["Transaction Date", "Details", "Amount"])).toEqual({
      date: 0,
      description: 1,
      amount: 2,
      debit: null,
      credit: null
    });
  });

  it("does not mistake a debit amount column for the amount column", () => {
    expect(detectStatementMapping(["Date", "Narration", "Debit Amount", "Credit Amount"])).toEqual({
      date: 0,
      description: 1,
      amount: null,
      debit: 2,
      credit: 3
    });
  });
});

describe("validateStatementMapping", () => {
  it("requires a date and a description", () => {
    expect(() =>
      validateStatementMapping(
        { date: null, description: 1, amount: 2, debit: null, credit: null },
        3
      )
    ).toThrow();
    expect(() =>
      validateStatementMapping(
        { date: 0, description: null, amount: 2, debit: null, credit: null },
        3
      )
    ).toThrow();
  });

  it("rejects amount together with debit/credit, and a lone debit column", () => {
    expect(() =>
      validateStatementMapping({ date: 0, description: 1, amount: 2, debit: 3, credit: 4 }, 5)
    ).toThrow();
    expect(() =>
      validateStatementMapping({ date: 0, description: 1, amount: null, debit: 2, credit: null }, 3)
    ).toThrow();
  });

  it("rejects two roles on the same column", () => {
    expect(() =>
      validateStatementMapping({ date: 0, description: 0, amount: 2, debit: null, credit: null }, 3)
    ).toThrow();
  });
});

describe("parseStatementDate", () => {
  it("accepts ISO, day-first numeric, and named-month dates", () => {
    expect(parseStatementDate("2026-11-09")).toBe("2026-11-09");
    expect(parseStatementDate("09/11/2026")).toBe("2026-11-09");
    expect(parseStatementDate("09-11-2026")).toBe("2026-11-09");
    expect(parseStatementDate("9 Sep 2026")).toBe("2026-09-09");
    expect(parseStatementDate("09 September 2026")).toBe("2026-09-09");
  });

  it("rejects impossible dates and unknown formats", () => {
    expect(parseStatementDate("32/13/2026")).toBeNull();
    expect(parseStatementDate("2026/11/09")).toBeNull();
    expect(parseStatementDate("")).toBeNull();
    expect(parseStatementDate("yesterday")).toBeNull();
  });
});

describe("parseStatementAmount", () => {
  it("parses plain, grouped, parenthesised, and Dr/Cr amounts", () => {
    expect(parseStatementAmount("1,234.56", "NPR")).toBe(123456);
    expect(parseStatementAmount("(1,234.00)", "NPR")).toBe(-123400);
    expect(parseStatementAmount("500 Dr", "NPR")).toBe(-50000);
    expect(parseStatementAmount("500 Cr", "NPR")).toBe(50000);
    expect(parseStatementAmount("NPR 2,500", "NPR")).toBe(250000);
    expect(parseStatementAmount("1,234.56-", "NPR")).toBe(-123456);
  });

  it("returns null for non-numbers and blanks", () => {
    expect(parseStatementAmount("abc", "NPR")).toBeNull();
    expect(parseStatementAmount("", "NPR")).toBeNull();
    expect(parseStatementAmount("12.3456", "NPR")).toBeNull();
  });
});

describe("parseStatementRows", () => {
  const split = { date: 0, description: 1, amount: null, debit: 2, credit: 3 };

  it("turns debits into outflows and credits into inflows", () => {
    const rows = parseStatementRows(
      [
        ["01/11/2026", "ATM Withdrawal", "5000", ""],
        ["02/11/2026", "Salary", "", "20000"]
      ],
      split,
      "NPR"
    );
    expect(rows[0]).toMatchObject({
      date: "2026-11-01",
      name: "ATM Withdrawal",
      amountLedgerMinor: 500000,
      error: null
    });
    expect(rows[1]).toMatchObject({
      date: "2026-11-02",
      name: "Salary",
      amountLedgerMinor: -2000000,
      error: null
    });
  });

  it("turns a signed amount column into ledger amounts", () => {
    const rows = parseStatementRows(
      [["2026-11-01", "Card payment", "-250.50"]],
      { date: 0, description: 1, amount: 2, debit: null, credit: null },
      "NPR"
    );
    expect(rows[0]).toMatchObject({ amountLedgerMinor: 25050, error: null });
  });

  it("rejects rows with both, neither, zero, or bad values instead of recording zero", () => {
    const rows = parseStatementRows(
      [
        ["01/11/2026", "Both", "100", "100"],
        ["01/11/2026", "Neither", "", ""],
        ["01/11/2026", "Zero", "0", ""],
        ["not-a-date", "Bad date", "100", ""],
        ["01/11/2026", "", "100", ""]
      ],
      split,
      "NPR"
    );
    expect(rows.map((r) => r.error)).toEqual([
      "Row has both a debit and a credit.",
      "Row has neither a debit nor a credit.",
      "Amount is zero.",
      'Unrecognized date "not-a-date".',
      "Missing description."
    ]);
    expect(rows.every((r) => r.amountLedgerMinor === null)).toBe(true);
  });
});

describe("statementExternalId", () => {
  it("is stable for the same row and insensitive to name case and spacing", () => {
    const a = statementExternalId("acct", "2026-11-01", 500000, "ATM Withdrawal");
    const b = statementExternalId("acct", "2026-11-01", 500000, "  atm   withdrawal ");
    expect(a).toBe(b);
    expect(a.startsWith("csv_")).toBe(true);
  });

  it("changes when the amount, date, or name changes", () => {
    const base = statementExternalId("acct", "2026-11-01", 500000, "ATM Withdrawal");
    expect(statementExternalId("acct", "2026-11-01", 500001, "ATM Withdrawal")).not.toBe(base);
    expect(statementExternalId("acct", "2026-11-02", 500000, "ATM Withdrawal")).not.toBe(base);
    expect(statementExternalId("acct", "2026-11-01", 500000, "Shop")).not.toBe(base);
  });
});
