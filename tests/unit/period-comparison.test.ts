import { describe, it, expect } from "vitest";
import {
  deltaWithPct,
  netWorthChange,
  sumFlows,
  compareFlowWindows,
  monthVsLastMonth
} from "@/lib/period-comparison";

describe("deltaWithPct", () => {
  it("computes delta and percentage from integer minors", () => {
    expect(deltaWithPct(120000, 100000)).toEqual({ deltaMinor: 20000, pct: 0.2 });
    expect(deltaWithPct(80000, 100000)).toEqual({ deltaMinor: -20000, pct: -0.2 });
  });

  it("never returns Infinity or NaN for a zero previous value", () => {
    const result = deltaWithPct(50000, 0);
    expect(result.deltaMinor).toBe(50000);
    expect(result.pct).toBeNull();
    expect(Number.isFinite(result.deltaMinor)).toBe(true);
  });

  it("handles negative previous values with the absolute base", () => {
    // Net worth -100,000 -> -50,000 is a +50% move, not -50%.
    expect(deltaWithPct(-50000, -100000)).toEqual({ deltaMinor: 50000, pct: 0.5 });
    expect(deltaWithPct(-150000, -100000)).toEqual({ deltaMinor: -50000, pct: -0.5 });
  });

  it("keeps integer minor units exact (no float rounding in totals)", () => {
    // 0.1 + 0.2 style float trap: minors stay exact integers.
    expect(deltaWithPct(199999, 100001).deltaMinor).toBe(99998);
  });
});

describe("netWorthChange", () => {
  it("returns null for an empty series", () => {
    expect(netWorthChange([])).toBeNull();
  });

  it("reports zero change with no percentage for a single point", () => {
    expect(netWorthChange([{ date: "2026-11-01", valueMinor: 100000 }])).toEqual({
      currentMinor: 100000,
      startMinor: 100000,
      startDate: "2026-11-01",
      deltaMinor: 0,
      pct: null
    });
  });

  it("compares the last point against the first point", () => {
    expect(
      netWorthChange([
        { date: "2026-08-01", valueMinor: 100000 },
        { date: "2026-09-01", valueMinor: 90000 },
        { date: "2026-10-01", valueMinor: 150000 }
      ])
    ).toEqual({
      currentMinor: 150000,
      startMinor: 100000,
      startDate: "2026-08-01",
      deltaMinor: 50000,
      pct: 0.5
    });
  });

  it("returns null pct when the series starts at zero", () => {
    const result = netWorthChange([
      { date: "2026-08-01", valueMinor: 0 },
      { date: "2026-09-01", valueMinor: 25000 }
    ]);
    expect(result?.deltaMinor).toBe(25000);
    expect(result?.pct).toBeNull();
  });

  it("handles negative net worth", () => {
    const result = netWorthChange([
      { date: "2026-08-01", valueMinor: -200000 },
      { date: "2026-09-01", valueMinor: -100000 }
    ]);
    expect(result?.deltaMinor).toBe(100000);
    expect(result?.pct).toBe(0.5);
  });
});

describe("sumFlows / compareFlowWindows", () => {
  const flows = [
    { incomeMinor: 100000, expenseMinor: 60000 },
    { incomeMinor: 120000, expenseMinor: 80000 }
  ];

  it("sums integer minors exactly", () => {
    expect(sumFlows(flows)).toEqual({ inMinor: 220000, outMinor: 140000, netMinor: 80000 });
    expect(sumFlows([])).toEqual({ inMinor: 0, outMinor: 0, netMinor: 0 });
  });

  it("compares a window against the previous window", () => {
    const result = compareFlowWindows(flows, [
      { incomeMinor: 100000, expenseMinor: 50000 }
    ]);
    expect(result.current).toEqual({ inMinor: 220000, outMinor: 140000, netMinor: 80000 });
    expect(result.previousMonths).toBe(1);
    expect(result.in).toEqual({ deltaMinor: 120000, pct: 1.2 });
    expect(result.out).toEqual({ deltaMinor: 90000, pct: 1.8 });
    expect(result.net.pct).toBeCloseTo(0.6);
  });

  it("reports a short previous window instead of pretending it is full", () => {
    const result = compareFlowWindows(flows, []);
    expect(result.previousMonths).toBe(0);
    expect(result.in.pct).toBeNull();
    expect(result.net.pct).toBeNull();
  });
});

describe("monthVsLastMonth", () => {
  it("returns null with fewer than two months", () => {
    expect(monthVsLastMonth([])).toBeNull();
    expect(
      monthVsLastMonth([{ monthKey: "2026-11", incomeMinor: 1, expenseMinor: 1 }])
    ).toBeNull();
  });

  it("compares the last two months", () => {
    const result = monthVsLastMonth([
      { monthKey: "2026-09", incomeMinor: 100000, expenseMinor: 40000 },
      { monthKey: "2026-10", incomeMinor: 120000, expenseMinor: 90000 },
      { monthKey: "2026-11", incomeMinor: 110000, expenseMinor: 50000 }
    ]);
    expect(result?.current.monthKey).toBe("2026-11");
    expect(result?.previous.monthKey).toBe("2026-10");
    expect(result?.in).toEqual({ deltaMinor: -10000, pct: -10000 / 120000 });
    expect(result?.net).toEqual({ deltaMinor: 30000, pct: 1 });
  });
});
