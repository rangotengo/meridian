import { describe, expect, it } from "vitest";
import {
  SCHEDULE_EXPECTATIONS,
  evaluateScheduleCheck,
  type ScheduleExpectation
} from "@/server/observability/schedule-health";

const recurring = SCHEDULE_EXPECTATIONS.find((e) => e.key === "recurring-post")!;
const nightly = SCHEDULE_EXPECTATIONS.find((e) => e.key === "nightly-balances")!;
const backup = SCHEDULE_EXPECTATIONS.find((e) => e.key === "nightly-backup")!;

const NOW = new Date("2026-11-15T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60000);
const minutesFromNow = (m: number) => new Date(NOW.getTime() + m * 60000);

function check(expectation: ScheduleExpectation, row: Parameters<typeof evaluateScheduleCheck>[1]) {
  return evaluateScheduleCheck(expectation, row, NOW);
}

describe("evaluateScheduleCheck", () => {
  it("reports ok when the next run is still in the future", () => {
    const c = check(recurring, { lastRunAt: minutesAgo(10), nextRunAt: minutesFromNow(20) });
    expect(c.status).toBe("ok");
    expect(c.overdueSeconds).toBe(0);
    expect(c.lastRunAgeSeconds).toBe(600);
    expect(c.lastRunAt).toBe(minutesAgo(10).toISOString());
    expect(c.nextRunAt).toBe(minutesFromNow(20).toISOString());
  });

  it("reports ok while a schedule is due but inside its freshness budget", () => {
    // Recurring posting fires every 30 minutes; 45 minutes overdue is late
    // but within the 1-hour budget (one missed cycle plus jitter).
    const c = check(recurring, { lastRunAt: minutesAgo(75), nextRunAt: minutesAgo(45) });
    expect(c.status).toBe("ok");
    expect(c.overdueSeconds).toBe(2700);
  });

  it("reports stale when recurring posting is overdue beyond its budget", () => {
    const c = check(recurring, { lastRunAt: minutesAgo(150), nextRunAt: minutesAgo(120) });
    expect(c.status).toBe("stale");
    expect(c.overdueSeconds).toBe(7200);
    expect(c.staleAfterSeconds).toBe(3600);
  });

  it("applies the larger nightly budget to the maintenance schedules", () => {
    const within = check(nightly, { lastRunAt: minutesAgo(26 * 60), nextRunAt: minutesAgo(120) });
    expect(within.status).toBe("ok");
    const beyond = check(nightly, {
      lastRunAt: minutesAgo(31 * 60),
      nextRunAt: minutesAgo(7 * 60)
    });
    expect(beyond.status).toBe("stale");
    expect(beyond.staleAfterSeconds).toBe(6 * 3600);
  });

  it("reports missing when the worker never registered the schedule", () => {
    const c = check(recurring, null);
    expect(c.status).toBe("missing");
    expect(c.lastRunAt).toBeNull();
    expect(c.nextRunAt).toBeNull();
    expect(c.lastRunAgeSeconds).toBeNull();
  });

  it("reports disabled schedules separately and never ran age as null", () => {
    const c = check(recurring, {
      lastRunAt: null,
      nextRunAt: minutesAgo(600),
      enabled: false
    });
    expect(c.status).toBe("disabled");
    expect(c.lastRunAgeSeconds).toBeNull();
  });

  it("covers nightly-backup with the nightly budget, marked optional", () => {
    // Optional = only checked when a cron_schedules row exists (backups
    // are registered only where configured); the required schedules are
    // always checked, so a missing row for them still degrades.
    expect(backup.queue).toBe("maintenance:backup");
    expect(backup.staleAfterSeconds).toBe(6 * 3600);
    expect(backup.optional).toBe(true);
    expect(recurring.optional).toBe(false);
    expect(nightly.optional).toBe(false);
    const c = check(backup, {
      lastRunAt: minutesAgo(31 * 60),
      nextRunAt: minutesAgo(7 * 60)
    });
    expect(c.status).toBe("stale");
  });

  it("accepts ISO strings as well as Date objects (SQLite backend)", () => {
    const c = check(recurring, {
      lastRunAt: minutesAgo(10).toISOString(),
      nextRunAt: minutesFromNow(20).toISOString()
    });
    expect(c.status).toBe("ok");
    expect(c.lastRunAgeSeconds).toBe(600);
  });
});
