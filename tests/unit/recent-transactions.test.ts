import { describe, it, expect } from "vitest";
import { recentPayees, recentCategories } from "@/lib/recent-transactions";

const items = [
  { merchant: "Corner Store", categoryId: "c1", categoryName: "Groceries" },
  { merchant: "Corner Store", categoryId: "c1", categoryName: "Groceries" },
  { merchant: null, categoryId: "c2", categoryName: "Transport" },
  { merchant: "  ", categoryId: null, categoryName: null },
  { merchant: "Cafe", categoryId: null, categoryName: null },
  { merchant: "Old Mart", categoryId: "c2", categoryName: "Transport" }
];

describe("recentPayees", () => {
  it("dedupes merchants most-recent-first with their latest category", () => {
    expect(recentPayees(items)).toEqual([
      { name: "Corner Store", categoryId: "c1" },
      { name: "Cafe", categoryId: null },
      { name: "Old Mart", categoryId: "c2" }
    ]);
  });

  it("respects the limit", () => {
    expect(recentPayees(items, 1)).toEqual([{ name: "Corner Store", categoryId: "c1" }]);
    expect(recentPayees([], 6)).toEqual([]);
  });
});

describe("recentCategories", () => {
  it("dedupes categories most-recent-first, skipping uncategorised rows", () => {
    expect(recentCategories(items)).toEqual([
      { id: "c1", name: "Groceries" },
      { id: "c2", name: "Transport" }
    ]);
  });

  it("respects the limit", () => {
    expect(recentCategories(items, 1)).toEqual([{ id: "c1", name: "Groceries" }]);
  });
});
