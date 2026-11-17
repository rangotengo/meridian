import { describe, it, expect } from "vitest";
import { resolveReportRange } from "@/lib/report-range";

const base = { currentMonth: "2026-11" };

describe("resolveReportRange presets", () => {
  it("resolves monthly to the current month", () => {
    const r = resolveReportRange({ ...base, period: "monthly" });
    expect(r.key).toBe("monthly");
    expect(r.from).toBe("2026-11-01");
    expect(r.to).toBe("2026-11-30");
    expect(r.months).toBe(1);
    expect(r.monthsBack).toBe(1);
    expect(r.previousFrom).toBe("2026-10-01");
    expect(r.previousTo).toBe("2026-10-31");
  });

  it("resolves quarterly and year-to-date", () => {
    const q = resolveReportRange({ ...base, period: "quarterly" });
    expect([q.from, q.to, q.months]).toEqual(["2026-09-01", "2026-11-30", 3]);
    expect([q.previousFrom, q.previousTo]).toEqual(["2026-06-01", "2026-08-31"]);
    const ytd = resolveReportRange({ ...base, period: "ytd" });
    expect([ytd.from, ytd.to, ytd.months]).toEqual(["2026-01-01", "2026-11-30", 11]);
  });

  it("falls back to monthly for an unknown period", () => {
    expect(resolveReportRange({ ...base, period: "nope" }).key).toBe("monthly");
  });

  it("extends monthsBack to cover the previous window when comparing", () => {
    const r = resolveReportRange({ ...base, period: "quarterly", compare: true });
    expect(r.monthsBack).toBe(6);
    const m = resolveReportRange({ ...base, period: "monthly", compare: true });
    expect(m.monthsBack).toBe(2);
  });
});

describe("resolveReportRange custom", () => {
  it("snaps a date range to whole months", () => {
    const r = resolveReportRange({ ...base, from: "2026-09-15", to: "2026-10-10" });
    expect(r.key).toBe("custom");
    expect([r.from, r.to]).toEqual(["2026-09-01", "2026-10-31"]);
    expect(r.months).toBe(2);
    expect([r.previousFrom, r.previousTo]).toEqual(["2026-07-01", "2026-08-31"]);
  });

  it("clamps a range ending in the future to the current month", () => {
    const r = resolveReportRange({ ...base, from: "2026-11-01", to: "2027-03-01" });
    expect([r.from, r.to, r.months]).toEqual(["2026-11-01", "2026-11-30", 1]);
  });

  it("clamps a range starting more than a year ago", () => {
    const r = resolveReportRange({ ...base, from: "2024-01-01", to: "2026-11-01" });
    expect(r.from).toBe("2025-12-01");
    expect(r.months).toBe(12);
  });

  it("falls back to monthly for reversed or unparseable dates", () => {
    expect(resolveReportRange({ ...base, from: "2026-10-01", to: "2026-09-01" }).key).toBe(
      "monthly"
    );
    expect(resolveReportRange({ ...base, from: "banana", to: "2026-09-01" }).key).toBe(
      "monthly"
    );
    expect(resolveReportRange({ ...base, from: "2026-09-01" }).key).toBe("monthly");
  });

  it("covers the previous window when comparing a custom range", () => {
    const r = resolveReportRange({
      ...base,
      from: "2026-09-01",
      to: "2026-10-31",
      compare: true
    });
    // Previous months Jul–Aug 2026; query must reach back to Jul from Nov.
    expect(r.monthsBack).toBe(5);
    expect(r.previousFromMonth).toBe("2026-07");
    expect(r.previousToMonth).toBe("2026-08");
  });
});
