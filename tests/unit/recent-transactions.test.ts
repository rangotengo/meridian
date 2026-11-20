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

  it("falls back to the description when no merchant is stored (Quick Add entries)", () => {
    const quickAddOnly = [
      { merchant: null, name: "Corner Store", categoryId: "c1", categoryName: "Groceries" },
      { merchant: null, name: "Cafe", categoryId: null, categoryName: null },
      { merchant: null, name: "  ", categoryId: null, categoryName: null },
      { merchant: null, name: null, categoryId: null, categoryName: null }
    ];
    expect(recentPayees(quickAddOnly)).toEqual([
      { name: "Corner Store", categoryId: "c1" },
      { name: "Cafe", categoryId: null }
    ]);
  });

  it("prefers the stored merchant over the description when both are present", () => {
    const mixed = [
      {
        merchant: "Bhatbhateni",
        name: "Weekly groceries",
        categoryId: "c1",
        categoryName: "Groceries"
      }
    ];
    expect(recentPayees(mixed)).toEqual([{ name: "Bhatbhateni", categoryId: "c1" }]);
  });

  it("dedupes a payee seen once as a merchant and once as a description", () => {
    const mixed = [
      { merchant: null, name: "Cafe", categoryId: "c2", categoryName: "Transport" },
      { merchant: "Cafe", categoryId: "c1", categoryName: "Groceries" }
    ];
    expect(recentPayees(mixed)).toEqual([{ name: "Cafe", categoryId: "c2" }]);
  });

  it("refreshes recency when a chip payee is used again through its description", () => {
    const reused = [
      { merchant: null, name: "Cafe", categoryId: "c2", categoryName: "Transport" },
      { merchant: null, name: "Corner Store", categoryId: "c1", categoryName: "Groceries" },
      { merchant: "Cafe", categoryId: "c1", categoryName: "Groceries" }
    ];
    expect(recentPayees(reused)).toEqual([
      { name: "Cafe", categoryId: "c2" },
      { name: "Corner Store", categoryId: "c1" }
    ]);
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
