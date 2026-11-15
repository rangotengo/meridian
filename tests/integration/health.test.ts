import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { GET } from "@/app/api/health/route";
import { listDebugLogs } from "@/server/observability/debug-log";
import { db, truncateAll } from "../helpers";

type HealthBody = {
  status: string;
  db: boolean;
  migrations: string;
  schedules: {
    key: string;
    queue: string;
    status: string;
    lastRunAt: string | null;
    nextRunAt: string | null;
    overdueSeconds: number;
  }[];
};

const minutesFromNow = (m: number) => new Date(Date.now() + m * 60000).toISOString();

async function seedSchedule(input: {
  key: string;
  queue: string;
  cron: string;
  lastRunAt: string | null;
  nextRunAt: string;
}): Promise<void> {
  await db().execute(sql`
    INSERT INTO cron_schedules (key, queue, payload, cron, next_run_at, last_run_at, enabled)
    VALUES (${input.key}, ${input.queue}, '{}', ${input.cron}, ${input.nextRunAt}, ${input.lastRunAt}, true)
  `);
}

/** All three worker schedules in their normal, freshly-ticked state. */
async function seedFreshSchedules(): Promise<void> {
  await seedSchedule({
    key: "recurring-post",
    queue: "recurring:post",
    cron: "*/30 * * * *",
    lastRunAt: minutesFromNow(-10),
    nextRunAt: minutesFromNow(20)
  });
  await seedSchedule({
    key: "nightly-balances",
    queue: "maintenance:balances",
    cron: "2 4 * * *",
    lastRunAt: minutesFromNow(-120),
    nextRunAt: minutesFromNow(600)
  });
  await seedSchedule({
    key: "nightly-cleanup",
    queue: "maintenance:cleanup",
    cron: "17 3 * * *",
    lastRunAt: minutesFromNow(-180),
    nextRunAt: minutesFromNow(540)
  });
}

beforeEach(async () => {
  await truncateAll();
});

describe("health endpoint", () => {
  it("returns 200 ok when the database, migrations and schedules are current", async () => {
    await seedFreshSchedules();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body).toMatchObject({ status: "ok", db: true, migrations: "current" });
    expect(body.schedules).toHaveLength(3);
    expect(body.schedules.every((s) => s.status === "ok")).toBe(true);
    const recurring = body.schedules.find((s) => s.key === "recurring-post");
    expect(recurring?.queue).toBe("recurring:post");
    expect(recurring?.lastRunAt).not.toBeNull();
  });

  it("reports degraded (still 200) and names the check when recurring posting is stale", async () => {
    await seedFreshSchedules();
    // Worker stopped ticking: the */30 schedule has been due for 2 hours,
    // far beyond its 1-hour freshness budget.
    await db().execute(sql`
      UPDATE cron_schedules
      SET last_run_at = ${minutesFromNow(-150)}, next_run_at = ${minutesFromNow(-120)}
      WHERE key = 'recurring-post'
    `);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("degraded");
    const recurring = body.schedules.find((s) => s.key === "recurring-post");
    expect(recurring?.status).toBe("stale");
    expect(recurring?.overdueSeconds).toBeGreaterThan(3600);
    expect(body.schedules.find((s) => s.key === "nightly-balances")?.status).toBe("ok");

    // The flip into degraded is recorded once in the debug log; a second
    // poll with the same stale set must not spam another entry.
    const logsAfterFirst = await listDebugLogs(db(), { category: "health" });
    expect(logsAfterFirst).toHaveLength(1);
    expect(logsAfterFirst[0]?.level).toBe("warn");
    expect((logsAfterFirst[0]?.metadata as { staleKeys?: string[] })?.staleKeys).toEqual([
      "recurring-post"
    ]);
    await GET();
    const logsAfterSecond = await listDebugLogs(db(), { category: "health" });
    expect(logsAfterSecond).toHaveLength(1);
  });

  it("records recovery and alerts again when the same schedule goes stale again", async () => {
    await seedFreshSchedules();
    const makeRecurringStale = () =>
      db().execute(sql`
        UPDATE cron_schedules
        SET last_run_at = ${minutesFromNow(-150)}, next_run_at = ${minutesFromNow(-120)}
        WHERE key = 'recurring-post'
      `);
    const makeRecurringFresh = () =>
      db().execute(sql`
        UPDATE cron_schedules
        SET last_run_at = ${minutesFromNow(-10)}, next_run_at = ${minutesFromNow(20)}
        WHERE key = 'recurring-post'
      `);

    // First outage: one warn entry; a repeat poll during the same outage
    // stays deduped.
    await makeRecurringStale();
    await GET();
    await GET();
    let logs = await listDebugLogs(db(), { category: "health" });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe("warn");

    // Recovery: the healthy read records an info entry resetting the
    // incident state; further healthy polls add nothing.
    await makeRecurringFresh();
    const recovered = await GET();
    expect(((await recovered.json()) as HealthBody).status).toBe("ok");
    await GET();
    logs = await listDebugLogs(db(), { category: "health" });
    expect(logs).toHaveLength(2);
    expect(logs[0]?.level).toBe("info");
    expect((logs[0]?.metadata as { staleKeys?: string[] })?.staleKeys).toEqual([]);
    expect((logs[0]?.metadata as { recoveredFrom?: string[] })?.recoveredFrom).toEqual([
      "recurring-post"
    ]);

    // Recurrence of the SAME stale set: a new alertable warn entry, not
    // suppressed by the first incident's log.
    await makeRecurringStale();
    const recurred = await GET();
    expect(((await recurred.json()) as HealthBody).status).toBe("degraded");
    logs = await listDebugLogs(db(), { category: "health" });
    expect(logs).toHaveLength(3);
    expect(logs[0]?.level).toBe("warn");
    expect((logs[0]?.metadata as { staleKeys?: string[] })?.staleKeys).toEqual(["recurring-post"]);
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(2);
  });

  it("does not require the optional nightly-backup schedule to be registered", async () => {
    await seedFreshSchedules();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    // Backups are only registered where configured: no row, no check, no
    // degradation.
    expect(body.status).toBe("ok");
    expect(body.schedules).toHaveLength(3);
    expect(body.schedules.find((s) => s.key === "nightly-backup")).toBeUndefined();
  });

  it("checks nightly-backup when it is registered, and degrades when it is stale", async () => {
    await seedFreshSchedules();
    await seedSchedule({
      key: "nightly-backup",
      queue: "maintenance:backup",
      cron: "47 2 * * *",
      lastRunAt: minutesFromNow(-60),
      nextRunAt: minutesFromNow(600)
    });
    const fresh = await GET();
    const freshBody = (await fresh.json()) as HealthBody;
    expect(freshBody.status).toBe("ok");
    expect(freshBody.schedules).toHaveLength(4);
    expect(freshBody.schedules.find((s) => s.key === "nightly-backup")?.status).toBe("ok");

    // 12 hours overdue is beyond the 6-hour nightly budget.
    await db().execute(sql`
      UPDATE cron_schedules
      SET last_run_at = ${minutesFromNow(-36 * 60)}, next_run_at = ${minutesFromNow(-12 * 60)}
      WHERE key = 'nightly-backup'
    `);
    const stale = await GET();
    expect(stale.status).toBe(200);
    const staleBody = (await stale.json()) as HealthBody;
    expect(staleBody.status).toBe("degraded");
    expect(staleBody.schedules.find((s) => s.key === "nightly-backup")?.status).toBe("stale");
    expect(staleBody.schedules.find((s) => s.key === "recurring-post")?.status).toBe("ok");
  });

  it("reports degraded when a nightly maintenance schedule is stale", async () => {
    await seedFreshSchedules();
    await db().execute(sql`
      UPDATE cron_schedules
      SET last_run_at = ${minutesFromNow(-31 * 60)}, next_run_at = ${minutesFromNow(-12 * 60)}
      WHERE key = 'nightly-balances'
    `);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("degraded");
    expect(body.schedules.find((s) => s.key === "nightly-balances")?.status).toBe("stale");
    expect(body.schedules.find((s) => s.key === "recurring-post")?.status).toBe("ok");
    expect(body.schedules.find((s) => s.key === "nightly-cleanup")?.status).toBe("ok");
  });

  it("reports degraded when the worker never registered any schedule", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("degraded");
    expect(body.schedules).toHaveLength(3);
    expect(body.schedules.every((s) => s.status === "missing")).toBe(true);
  });
});
