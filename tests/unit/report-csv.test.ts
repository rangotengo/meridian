import { describe, it, expect } from "vitest";
import { incomeExpenseCsv, categorySpendingCsv } from "@/lib/report-csv";

describe("incomeExpenseCsv", () => {
  it("writes one row per month in major units", () => {
    const csv = incomeExpenseCsv(
      [
        { monthKey: "2026-10", incomeMinor: 150050, expenseMinor: 80025 },
        { monthKey: "2026-11", incomeMinor: 0, expenseMinor: 0 }
      ],
      "NPR"
    );
    expect(csv).toBe(
      "Month,Income (NPR),Spending (NPR),Net (NPR)\n" +
        "October 2026,1500.50,800.25,700.25\n" +
        "November 2026,0.00,0.00,0.00\n"
    );
  });

  it("handles an empty period", () => {
    expect(incomeExpenseCsv([], "USD")).toBe("Month,Income (USD),Spending (USD),Net (USD)\n");
  });
});

describe("categorySpendingCsv", () => {
  it("writes one row per category and escapes commas and quotes", () => {
    const csv = categorySpendingCsv(
      [
        { name: "Groceries", totalMinor: 123456 },
        { name: 'Café, "Central"', totalMinor: 5000 }
      ],
      "USD"
    );
    expect(csv).toBe(
      "Category,Spending (USD)\nGroceries,1234.56\n\"Café, \"\"Central\"\"\",50.00\n"
    );
  });
});
