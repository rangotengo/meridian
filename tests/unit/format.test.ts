import { describe, expect, it } from "vitest";
import { fmtSignedMoney, formatPct, pluralize } from "@/lib/format";

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

describe("formatPct", () => {
  it("prefixes positive changes with + and keeps one decimal", () => {
    expect(formatPct(0.1234)).toBe("+12.3%");
    expect(formatPct(0)).toBe("+0.0%");
  });

  it("renders negative changes with a plain minus", () => {
    expect(formatPct(-0.045)).toBe("-4.5%");
  });

  it("renders an em dash for a null or non-finite percentage", () => {
    expect(formatPct(null)).toBe("—");
    expect(formatPct(Number.NaN)).toBe("—");
    expect(formatPct(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
