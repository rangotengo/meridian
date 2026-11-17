import { describe, expect, it } from "vitest";
import { fmtSignedMoney, pluralize } from "@/lib/format";

describe("pluralize", () => {
  it("uses the singular for one and plural otherwise", () => {
    expect(pluralize(1, "account")).toBe("1 account");
    expect(pluralize(3, "account")).toBe("3 accounts");
    expect(pluralize(0, "transfer")).toBe("0 transfers");
  });

  it("accepts an irregular plural", () => {
    expect(pluralize(1, "series", "series")).toBe("1 series");
    expect(pluralize(2, "series", "series")).toBe("2 series");
  });
});

describe("fmtSignedMoney", () => {
  it("renders exactly one leading + for positive deltas, never ++", () => {
    const rendered = fmtSignedMoney(50000, "NPR");
    expect(rendered).toContain("+");
    expect(rendered).not.toContain("++");
    expect((rendered.match(/\+/g) ?? []).length).toBe(1);
    expect(rendered).toContain("500");
  });

  it("renders a single leading minus for negative deltas", () => {
    const rendered = fmtSignedMoney(-50000, "NPR");
    expect(rendered).toMatch(/[\u2212-]/);
    expect(rendered).not.toContain("++");
    expect(rendered).not.toContain("+");
  });

  it("renders no sign for a zero delta", () => {
    const rendered = fmtSignedMoney(0, "NPR");
    expect(rendered).not.toContain("+");
    expect(rendered).not.toContain("++");
    expect(rendered).toContain("0.00");
  });

  it("keeps integer minor units exact (no float rounding)", () => {
    expect(fmtSignedMoney(199999, "NPR")).toContain("1,999.99");
    expect(fmtSignedMoney(-199999, "NPR")).toContain("1,999.99");
  });
});
