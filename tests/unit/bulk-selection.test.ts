import { describe, it, expect } from "vitest";
import {
  toggleSelection,
  selectAllOnPage,
  deselectAllOnPage,
  formatBulkDeleteSummary,
  formatBulkRecategoriseSummary
} from "@/lib/bulk-selection";

describe("toggleSelection", () => {
  it("adds a missing id and removes a present one", () => {
    expect(toggleSelection([], "a")).toEqual(["a"]);
    expect(toggleSelection(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleSelection(["a"], "b")).toEqual(["a", "b"]);
  });

  it("never duplicates an id", () => {
    expect(selectAllOnPage(["a"], ["a", "b"])).toEqual(["a", "b"]);
    expect(selectAllOnPage([], ["a", "a"])).toEqual(["a"]);
  });
});

describe("selectAllOnPage / deselectAllOnPage", () => {
  it("selects only the page ids, keeping off-page selection", () => {
    expect(selectAllOnPage(["x"], ["a", "b"])).toEqual(["x", "a", "b"]);
    expect(deselectAllOnPage(["x", "a", "b"], ["a", "b"])).toEqual(["x"]);
    expect(deselectAllOnPage(["a"], ["a"])).toEqual([]);
  });
});

describe("formatBulkDeleteSummary", () => {
  it("reports deletes and skips with correct plurals", () => {
    expect(formatBulkDeleteSummary(1, 0)).toBe("Deleted 1 transaction.");
    expect(formatBulkDeleteSummary(3, 0)).toBe("Deleted 3 transactions.");
    expect(formatBulkDeleteSummary(2, 1)).toBe(
      "Deleted 2 transactions. 1 transaction was skipped."
    );
    expect(formatBulkDeleteSummary(0, 2)).toBe(
      "Deleted 0 transactions. 2 transactions were skipped."
    );
  });
});

describe("formatBulkRecategoriseSummary", () => {
  it("reports updates and skips with correct plurals", () => {
    expect(formatBulkRecategoriseSummary(1, 0)).toBe("Updated 1 transaction.");
    expect(formatBulkRecategoriseSummary(3, 0)).toBe("Updated 3 transactions.");
    expect(formatBulkRecategoriseSummary(2, 1)).toBe(
      "Updated 2 transactions. 1 transaction was skipped."
    );
    expect(formatBulkRecategoriseSummary(0, 2)).toBe(
      "Updated 0 transactions. 2 transactions were skipped."
    );
  });
});
