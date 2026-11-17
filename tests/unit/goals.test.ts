import { describe, it, expect } from "vitest";
import { accountGoalProgress, goalPct } from "@/server/domain/goals";

describe("accountGoalProgress", () => {
  it("measures balance growth since creation", () => {
    expect(accountGoalProgress(150_000, 100_000)).toBe(50_000);
  });

  it("floors withdrawals below the starting balance at zero, never negative", () => {
    expect(accountGoalProgress(80_000, 100_000)).toBe(0);
    expect(accountGoalProgress(100_000, 100_000)).toBe(0);
  });

  it("keeps exact integer minor units", () => {
    expect(accountGoalProgress(100_001, 100_000)).toBe(1);
  });
});

describe("goalPct", () => {
  it("returns progress / target, including over-target", () => {
    expect(goalPct(50_000, 100_000)).toBe(0.5);
    expect(goalPct(150_000, 100_000)).toBe(1.5);
  });

  it("returns null for unknown progress or a non-positive target", () => {
    expect(goalPct(null, 100_000)).toBeNull();
    expect(goalPct(50_000, 0)).toBeNull();
    expect(goalPct(50_000, -1)).toBeNull();
  });
});
