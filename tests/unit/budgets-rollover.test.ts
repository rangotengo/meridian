import { describe, it, expect } from "vitest";
import { rolloverCredit, budgetAlertLevel, limitActiveAt } from "@/server/domain/budgets";

describe("rolloverCredit", () => {
  it("rolls last month's unspent amount", () => {
    expect(rolloverCredit(100_000, 60_000)).toBe(40_000);
  });

  it("rolls nothing when last month was fully spent or overspent", () => {
    expect(rolloverCredit(100_000, 100_000)).toBe(0);
    expect(rolloverCredit(100_000, 120_000)).toBe(0);
  });

  it("rolls nothing when there was no budget last month", () => {
    expect(rolloverCredit(null, 0)).toBe(0);
    expect(rolloverCredit(null, 60_000)).toBe(0);
  });
});

describe("budgetAlertLevel", () => {
  it("is ok below 80%, warning from 80%, over at 100%", () => {
    expect(budgetAlertLevel(0)).toBe("ok");
    expect(budgetAlertLevel(0.79)).toBe("ok");
    expect(budgetAlertLevel(0.8)).toBe("warning");
    expect(budgetAlertLevel(0.99)).toBe("warning");
    expect(budgetAlertLevel(1)).toBe("over");
    expect(budgetAlertLevel(1.5)).toBe("over");
  });
});

describe("limitActiveAt", () => {
  const rows = [
    {
      categoryId: "cat-food",
      amountMinor: 100_000,
      active: false,
      createdAt: new Date("2026-09-01T00:00:00Z"),
      updatedAt: new Date("2026-10-20T00:00:00Z")
    },
    {
      categoryId: "cat-food",
      amountMinor: 120_000,
      active: true,
      createdAt: new Date("2026-10-20T00:00:00Z"),
      updatedAt: new Date("2026-10-20T00:00:00Z")
    },
    {
      categoryId: "cat-travel",
      amountMinor: 50_000,
      active: true,
      createdAt: new Date("2026-10-01T00:00:00Z"),
      updatedAt: new Date("2026-10-01T00:00:00Z")
    }
  ];

  it("returns the limit active at the end of the month", () => {
    // At 2026-09-30 the first row was still active.
    expect(limitActiveAt(rows, "cat-food", "2026-09-30")).toBe(100_000);
    // At 2026-10-31 the second row had replaced it.
    expect(limitActiveAt(rows, "cat-food", "2026-10-31")).toBe(120_000);
  });

  it("returns null when no budget existed then or the category differs", () => {
    expect(limitActiveAt(rows, "cat-food", "2026-08-31")).toBeNull();
    expect(limitActiveAt(rows, "cat-other", "2026-10-31")).toBeNull();
    expect(limitActiveAt(rows, "cat-travel", "2026-09-30")).toBeNull();
  });
});
