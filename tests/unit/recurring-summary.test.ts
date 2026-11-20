import { describe, it, expect } from "vitest";
import { nextDueFromActiveSeries } from "@/lib/recurring-summary";

describe("nextDueFromActiveSeries", () => {
  it("prefers the earliest active series even when a paused one is earlier", () => {
    expect(
      nextDueFromActiveSeries([
        { nextDue: "2026-12-05", active: true },
        { nextDue: "2026-11-25", active: false },
        { nextDue: "2026-12-01", active: true }
      ])
    ).toBe("2026-12-01");
  });

  it("returns undefined when every series is paused", () => {
    expect(
      nextDueFromActiveSeries([
        { nextDue: "2026-11-25", active: false },
        { nextDue: "2026-12-05", active: false }
      ])
    ).toBeUndefined();
  });

  it("returns undefined for an empty list", () => {
    expect(nextDueFromActiveSeries([])).toBeUndefined();
  });

  it("returns the only active series next due date", () => {
    expect(nextDueFromActiveSeries([{ nextDue: "2026-12-05", active: true }])).toBe("2026-12-05");
  });
});
