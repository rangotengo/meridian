import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  db,
  makeUser,
  makeAccount,
  truncateAll,
  actorOf,
  daysAgo,
  latestBalance
} from "../helpers";
import {
  createSeries,
  postDueSeries,
  MAX_CATCHUP_OCCURRENCES_PER_RUN
} from "@/server/domain/recurring";
import { addDays } from "@/lib/datetime";
import { recalculateAccount } from "@/server/domain/balances";
import { createJobRegistry } from "@/server/queue/jobs";

// Fault injection for the repair-durability tests below. Both mocks delegate
// to the real implementation unless a test arms them; no fault-injection
// probe exists in source.
const mockCtl = vi.hoisted(() => ({ failPostHocEnqueue: false }));

vi.mock("@/server/domain/balances", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/domain/balances")>();
  return {
    ...actual,
    recalculateAccount: vi.fn((...args: Parameters<typeof actual.recalculateAccount>) =>
      actual.recalculateAccount(...args)
    )
  };
});

vi.mock("@/server/queue/index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/queue/index")>();
  const { getDb } = await import("@/server/db/client");
  return {
    ...actual,
    enqueue: async (...args: Parameters<typeof actual.enqueue>) => {
      const [exec] = args;
      // The post-hoc repair enqueue passes the shared db executor; the
      // in-transaction enqueue passes a transaction executor. Failing only
      // the former simulates a repair enqueue that cannot rescue a failed
      // recalculation — the in-transaction job must already be pending.
      if (mockCtl.failPostHocEnqueue && exec === getDb()) {
        throw new Error("simulated post-hoc repair-enqueue failure");
      }
      return actual.enqueue(...args);
    }
  };
});

afterEach(() => {
  mockCtl.failPostHocEnqueue = false;
  vi.mocked(recalculateAccount).mockClear();
});

beforeAll(async () => {
  await truncateAll();
});

function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

async function entryCountFor(seriesId: string): Promise<number> {
  const res = await db().execute<{ c: number }>(
    sql`SELECT CAST(count(*) AS INTEGER) AS c FROM entries WHERE recurring_series_id = ${seriesId}::uuid`
  );
  return Number(res.rows?.[0]?.c ?? 0);
}

async function nextDueOf(seriesId: string): Promise<string> {
  const res = await db().execute<{ next_due: string }>(
    sql`SELECT CAST(next_due AS TEXT) AS next_due FROM recurring_series WHERE id = ${seriesId}::uuid`
  );
  return (res.rows?.[0]?.next_due ?? "").slice(0, 10);
}

async function pendingRepairJobs(accountId: string): Promise<number> {
  const res = await db().execute<{ c: number }>(sql`
    SELECT CAST(count(*) AS INTEGER) AS c FROM jobs
    WHERE queue = 'maintenance:balances'
      AND dedupe_key = ${`balance-repair:${accountId}`}
      AND status = 'pending'
  `);
  return Number(res.rows?.[0]?.c ?? 0);
}

async function runMaintenanceBalancesHandler(): Promise<void> {
  const registry = await createJobRegistry();
  const handler = registry.get("maintenance:balances");
  expect(handler).toBeDefined();
  await handler!({}, db());
}

describe("postDueSeries", () => {
  it("posts catch-up occurrences, advances the schedule, recalculates balances, and is idempotent", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, { openingBalanceDisplayMinor: 0 });
    const start = daysAgo(21);
    const seriesId = await createSeries(db(), actorOf(user), {
      accountId,
      name: "Weekly bill",
      amountLedgerMinor: 1000,
      frequency: "weekly",
      config: { weekday: weekdayOf(start) },
      nextDue: start
    });

    const result = await postDueSeries(db(), new Date());
    expect(result.failed).toBe(0);
    expect(result.posted).toBe(1);

    // Occurrences on daysAgo(21), (14), (7) and (0) are all due.
    expect(await entryCountFor(seriesId)).toBe(4);
    // Schedule advanced past today, to the next weekly occurrence.
    expect(await nextDueOf(seriesId)).toBe(addDays(daysAgo(0), 7));
    // Balances were recalculated for the committed entries:
    // display balance = opening (0) − Σ amounts (4 × 1000).
    const balance = await latestBalance(accountId);
    expect(balance?.balanceMinor).toBe(-4000);

    // A retry / second run posts nothing new and keeps the same balance.
    const again = await postDueSeries(db(), new Date());
    expect(again.posted).toBe(0);
    expect(again.failed).toBe(0);
    expect(await entryCountFor(seriesId)).toBe(4);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(-4000);
  });

  it("bounds catch-up per run and resumes from the first unposted occurrence", async () => {
    const user = await makeUser();
    // openedOn must precede the backlog: balance recalculation starts at the
    // account's opening date, so an account opened 30 days ago (the helper
    // default) would legitimately ignore older entries.
    const accountId = await makeAccount(user, {
      openingBalanceDisplayMinor: 0,
      openedOn: daysAgo(900)
    });
    // 116 weekly occurrences are due (805 days back through today).
    const start = daysAgo(7 * 115);
    const seriesId = await createSeries(db(), actorOf(user), {
      accountId,
      name: "Ancient weekly",
      amountLedgerMinor: 100,
      frequency: "weekly",
      config: { weekday: weekdayOf(start) },
      nextDue: start
    });

    const first = await postDueSeries(db(), new Date());
    expect(first.failed).toBe(0);
    expect(await entryCountFor(seriesId)).toBe(MAX_CATCHUP_OCCURRENCES_PER_RUN);
    // Still behind: next_due points at the first unposted occurrence.
    expect((await nextDueOf(seriesId)) <= daysAgo(0)).toBe(true);

    const second = await postDueSeries(db(), new Date());
    expect(second.failed).toBe(0);
    expect(await entryCountFor(seriesId)).toBe(116);
    expect((await nextDueOf(seriesId)) > daysAgo(0)).toBe(true);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(-11600);
  });

  it("keeps a pending repair job when a later catch-up occurrence fails, and the maintenance handler repairs balances", async () => {
    // UTC family so the due occurrences are exactly the 7-day steps below.
    const user = await makeUser({ timezone: "UTC" });
    const accountId = await makeAccount(user, { openingBalanceDisplayMinor: 0 });
    // Occurrences on daysAgo(14), (7) and (0) are due.
    const start = daysAgo(14);
    const seriesId = await createSeries(db(), actorOf(user), {
      accountId,
      name: "Weekly bill",
      amountLedgerMinor: 1000,
      frequency: "weekly",
      config: { weekday: weekdayOf(start) },
      nextDue: start
    });

    // Fault injection (test database only): fail the SECOND entries insert
    // for this series, so occurrence 1 commits and occurrence 2 rolls back.
    // The series id is inlined as a literal: a bind parameter inside the
    // dollar-quoted function body is not a placeholder to the server, so
    // the prepared statement would receive a parameter it cannot bind.
    const fnName = "fail_second_recurring_entry";
    const trgName = "fail_second_recurring_entry_trg";
    try {
      await db().execute(sql`
        CREATE OR REPLACE FUNCTION ${sql.raw(fnName)}() RETURNS trigger AS $$
        BEGIN
          IF (SELECT count(*) FROM entries WHERE recurring_series_id = ${sql.raw(`'${seriesId}'`)}::uuid) >= 1 THEN
            RAISE EXCEPTION 'simulated occurrence insert failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await db().execute(sql`
        CREATE TRIGGER ${sql.raw(trgName)} BEFORE INSERT ON entries
        FOR EACH ROW EXECUTE FUNCTION ${sql.raw(fnName)}()
      `);

      const result = await postDueSeries(db(), new Date());
      expect(result.failed).toBe(1);
      expect(result.posted).toBe(0);

      // Occurrence 1 committed; occurrence 2 rolled back, so the schedule
      // still points at it.
      expect(await entryCountFor(seriesId)).toBe(1);
      expect(await nextDueOf(seriesId)).toBe(daysAgo(7));
      // The committed occurrence was recalculated immediately despite the
      // later failure, and its repair intent is durable.
      expect((await latestBalance(accountId))?.balanceMinor).toBe(-1000);
      expect(await pendingRepairJobs(accountId)).toBe(1);
    } finally {
      await db().execute(sql`
        DROP TRIGGER IF EXISTS ${sql.raw(trgName)} ON entries
      `);
      await db().execute(sql`
        DROP FUNCTION IF EXISTS ${sql.raw(fnName)}()
      `);
    }

    // The maintenance handler rebuilds the account even though the series
    // failure is unrelated to its due state.
    await runMaintenanceBalancesHandler();
    expect((await latestBalance(accountId))?.balanceMinor).toBe(-1000);

    // The failure under test leaves nextDue on a still-due date by design.
    // postDueSeries is global, so move this series far into the future —
    // otherwise the next test's postDueSeries call would pick it up again.
    await db().execute(sql`
      UPDATE recurring_series SET next_due = '2999-01-01' WHERE id = ${seriesId}::uuid
    `);
  });

  it("keeps repair intent when recalculation and the post-hoc enqueue both fail", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const accountId = await makeAccount(user, { openingBalanceDisplayMinor: 0 });
    // Occurrences on daysAgo(7) and (0) are due; both commit, then the
    // immediate recalculation fails.
    const start = daysAgo(7);
    const seriesId = await createSeries(db(), actorOf(user), {
      accountId,
      name: "Weekly bill",
      amountLedgerMinor: 2500,
      frequency: "weekly",
      config: { weekday: weekdayOf(start) },
      nextDue: start
    });

    // Fault injection: the immediate recalculation fails, and the post-hoc
    // repair enqueue fails too — the repair job must already be pending
    // from the in-transaction enqueue that committed with the occurrences.
    vi.mocked(recalculateAccount).mockRejectedValueOnce(
      new Error("simulated recalculation failure")
    );
    mockCtl.failPostHocEnqueue = true;
    let result;
    try {
      result = await postDueSeries(db(), new Date());
    } finally {
      mockCtl.failPostHocEnqueue = false;
    }
    expect(result.failed).toBe(1);
    expect(result.posted).toBe(0);
    expect(await entryCountFor(seriesId)).toBe(2);
    // The schedule advanced past today, but no recalculation ran: the
    // balance is still the stale opening snapshot.
    expect((await latestBalance(accountId))?.balanceMinor).toBe(0);
    // Both in-transaction enqueues collapsed to one pending job (dedupe).
    expect(await pendingRepairJobs(accountId)).toBe(1);

    // A later recurring pass has nothing to post: the series is no longer due.
    const again = await postDueSeries(db(), new Date());
    expect(again).toEqual({ posted: 0, paused: 0, failed: 0 });

    // The maintenance handler repairs balances independently of series due
    // state: 2 × 2500 of committed entries.
    await runMaintenanceBalancesHandler();
    expect((await latestBalance(accountId))?.balanceMinor).toBe(-5000);
  });
});
