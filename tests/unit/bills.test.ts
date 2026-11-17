import { describe, expect, it } from "vitest";
import { classifyBill, daysBetween, DUE_SOON_DAYS, UPCOMING_DAYS } from "@/server/domain/bills";

describe("classifyBill", () => {
  const today = "2026-11-17";

  it("marks past due dates missed with negative days", () => {
    expect(classifyBill("2026-11-16", today)).toEqual({ status: "missed", daysUntilDue: -1 });
    expect(classifyBill("2026-11-10", today)).toEqual({ status: "missed", daysUntilDue: -7 });
  });

  it("marks today through day 7 due-soon", () => {
    expect(classifyBill("2026-11-17", today).status).toBe("due-soon");
    expect(classifyBill("2026-11-24", today)).toEqual({ status: "due-soon", daysUntilDue: 7 });
  });

  it("marks day 8 through day 30 upcoming", () => {
    expect(classifyBill("2026-11-25", today)).toEqual({ status: "upcoming", daysUntilDue: 8 });
    expect(classifyBill("2026-12-17", today)).toEqual({ status: "upcoming", daysUntilDue: 30 });
  });

  it("excludes anything beyond 30 days", () => {
    expect(classifyBill("2026-12-18", today)).toEqual({ status: null, daysUntilDue: 31 });
  });

  it("exposes the window constants the UI states", () => {
    expect(DUE_SOON_DAYS).toBe(7);
    expect(UPCOMING_DAYS).toBe(30);
  });
});

describe("daysBetween", () => {
  it("counts calendar days across month boundaries", () => {
    expect(daysBetween("2026-11-17", "2026-12-01")).toBe(14);
    expect(daysBetween("2026-12-01", "2026-11-17")).toBe(-14);
    expect(daysBetween("2026-11-17", "2026-11-17")).toBe(0);
  });
});
