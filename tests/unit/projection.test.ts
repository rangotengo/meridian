import { describe, expect, it } from "vitest";
import {
  applyOccurrencesToPoints,
  projectionOccurrenceDates,
  projectionPointDates
} from "@/server/domain/reports";

describe("projectionOccurrenceDates", () => {
  it("lists monthly occurrences strictly after today through the horizon", () => {
    expect(
      projectionOccurrenceDates(
        "monthly",
        { dayOfMonth: 27 },
        "2026-11-27",
        "2026-11-17",
        "2027-02-15"
      )
    ).toEqual(["2026-11-27", "2026-12-27", "2027-01-27"]);
  });

  it("clamps a day-31 monthly series to the short month, then resumes the anchor", () => {
    expect(
      projectionOccurrenceDates(
        "monthly",
        { dayOfMonth: 31 },
        "2026-01-31",
        "2026-01-15",
        "2026-04-30"
      )
    ).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("lists weekly occurrences on the configured weekday", () => {
    expect(
      projectionOccurrenceDates("weekly", { weekday: 3 }, "2026-11-18", "2026-11-17", "2026-12-02")
    ).toEqual(["2026-11-18", "2026-11-25", "2026-12-02"]);
  });

  it("skips overdue occurrences and resumes at the next future one", () => {
    expect(
      projectionOccurrenceDates(
        "monthly",
        { dayOfMonth: 17 },
        "2026-10-17",
        "2026-11-17",
        "2027-01-17"
      )
    ).toEqual(["2026-12-17", "2027-01-17"]);
  });

  it("rejects an invalid schedule instead of inventing dates", () => {
    expect(() =>
      projectionOccurrenceDates("monthly", {}, "2026-11-27", "2026-11-17", "2027-02-15")
    ).toThrow();
  });
});

describe("projectionPointDates", () => {
  it("steps weekly from the start and always ends exactly on the horizon", () => {
    const dates = projectionPointDates("2026-11-17", "2027-02-15");
    expect(dates[0]).toBe("2026-11-17");
    expect(dates[dates.length - 1]).toBe("2027-02-15");
    expect(dates).toHaveLength(14);
    expect(dates[1]).toBe("2026-11-24");
    expect(dates[12]).toBe("2027-02-09");
  });
});

describe("applyOccurrencesToPoints", () => {
  it("applies outflows at the first point on or after their date", () => {
    const points = applyOccurrencesToPoints(
      150_000,
      [
        { date: "2026-11-27", deltaMinor: -5_000 },
        { date: "2026-12-27", deltaMinor: -5_000 }
      ],
      ["2026-11-17", "2026-11-24", "2026-12-01", "2026-12-27", "2027-01-05"]
    );
    // The 27 Nov outflow lands at the 1 Dec point; the 27 Dec outflow at
    // the 27 Dec point.
    expect(points).toEqual([
      { date: "2026-11-17", valueMinor: 150_000 },
      { date: "2026-11-24", valueMinor: 150_000 },
      { date: "2026-12-01", valueMinor: 145_000 },
      { date: "2026-12-27", valueMinor: 140_000 },
      { date: "2027-01-05", valueMinor: 140_000 }
    ]);
  });

  it("income raises the projected value", () => {
    const points = applyOccurrencesToPoints(
      100_000,
      [{ date: "2026-11-20", deltaMinor: 20_000 }],
      ["2026-11-17", "2026-11-24"]
    );
    expect(points[1]?.valueMinor).toBe(120_000);
  });
});
