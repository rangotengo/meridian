import { describe, expect, it } from "vitest";
import { filterAndLimit, matchesQuery, PALETTE_RESULT_LIMIT } from "@/lib/palette-filter";

describe("matchesQuery", () => {
  it("matches everything on an empty query", () => {
    expect(matchesQuery(["Food"], "")).toBe(true);
    expect(matchesQuery(["Food"], "   ")).toBe(true);
  });

  it("matches case-insensitively on any of the texts", () => {
    expect(matchesQuery(["Groceries", "Food"], "food")).toBe(true);
    expect(matchesQuery(["Groceries", "Food"], "GROC")).toBe(true);
    expect(matchesQuery(["Groceries"], "rent")).toBe(false);
  });

  it("ignores null and undefined texts", () => {
    expect(matchesQuery([null, undefined, "Rent"], "rent")).toBe(true);
    expect(matchesQuery([null, undefined], "rent")).toBe(false);
  });
});

describe("filterAndLimit", () => {
  const categories = Array.from({ length: 15 }, (_, i) => ({
    id: `cat-${i + 1}`,
    name: `Category ${i + 1}`,
    parentName: null as string | null
  }));
  const textOf = (c: (typeof categories)[number]) => [c.name, c.parentName];

  it("finds a match past the render cap — the PR #23 regression", () => {
    // Category 13 sits past the 12-row cap; slicing before filtering
    // hid it from search entirely.
    const result = filterAndLimit(categories, "13", textOf);
    expect(result.total).toBe(1);
    expect(result.shown).toEqual([categories[12]]);
  });

  it("caps rendered rows at the limit but reports the full total", () => {
    const result = filterAndLimit(categories, "category", textOf);
    expect(result.total).toBe(15);
    expect(result.shown).toHaveLength(PALETTE_RESULT_LIMIT);
    expect(result.shown[0]?.name).toBe("Category 1");
    expect(result.shown[11]?.name).toBe("Category 12");
  });

  it("returns the full list when it fits under the limit", () => {
    const result = filterAndLimit(categories.slice(0, 3), "", textOf);
    expect(result.total).toBe(3);
    expect(result.shown).toHaveLength(3);
  });

  it("returns no matches for a query that matches nothing", () => {
    const result = filterAndLimit(categories, "zzz", textOf);
    expect(result.total).toBe(0);
    expect(result.shown).toEqual([]);
  });
});
