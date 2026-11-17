import { describe, it, expect } from "vitest";
import { addAmountToDraft, QUICK_AMOUNT_CHIPS } from "@/lib/quick-amounts";

describe("addAmountToDraft", () => {
  it("adds a chip amount to an empty draft", () => {
    expect(addAmountToDraft("", 50000, "USD")).toBe("500.00");
    expect(addAmountToDraft("  ", 10000, "NPR")).toBe("100.00");
  });

  it("adds to the existing draft without float rounding", () => {
    // 100.10 + 0.20 must be exactly 100.30, not 100.30000000000001.
    expect(addAmountToDraft("100.10", 20, "USD")).toBe("100.30");
    expect(addAmountToDraft("100.50", 5000, "USD")).toBe("150.50");
  });

  it("treats an unparseable draft as empty", () => {
    expect(addAmountToDraft("abc", 10000, "USD")).toBe("100.00");
  });

  it("respects zero-exponent currencies", () => {
    expect(addAmountToDraft("1000", 500, "JPY")).toBe("1500");
  });

  it("exposes the expected chips", () => {
    expect([...QUICK_AMOUNT_CHIPS]).toEqual([100, 500, 1000, 5000]);
  });
});
