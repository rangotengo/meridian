import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  db,
  makeUser,
  makeAccount,
  addTxn,
  truncateAll,
  actorOf,
  daysAgo,
  latestBalance
} from "../helpers";
import { createSeries, postDueSeries } from "@/server/domain/recurring";
import { enqueue, runPendingNow } from "@/server/queue";
import { createJobRegistry } from "@/server/queue/jobs";
import { recalculateAccount } from "@/server/domain/balances";

// Fault injection: recalculateAccount throws a transient error for accounts
// in failFor while armed; otherwise it delegates to the real implementation.
// This mirrors the reviewer's probe (handler must not resolve on failure),
// but drives the full queue path: claim -> handler -> failJob / completeJob.
const mockCtl = vi.hoisted(() => ({ failFor: new Set<string>() }));

vi.mock("@/server/domain/balances", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/domain/balances")>();
  return {
    ...actual,
    recalculateAccount: async (
      ...args: Parameters<typeof actual.recalculateAccount>
    ): Promise<void> => {
      if (mockCtl.failFor.has(args[1])) {
        throw new Error("simulated transient recalculation failure");
      }
      return actual.recalculateAccount(...args);
    }
  };
});

beforeAll(async () => {
  await truncateAll();
});

afterEach(() => {
  mockCtl.failFor.clear();
});

function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

async function corruptBalance(accountId: string): Promise<void> {
  await db().execute(
    sql`UPDATE balances SET balance_minor = 0 WHERE account_id = ${accountId}::uuid`
  );
}

type JobRow = { id: string; status: string; attempts: number; last_error: string | null };

async function repairJob(dedupeKey: string): Promise<JobRow | undefined> {
  const res = await db().execute<JobRow>(sql`
    SELECT CAST(id AS TEXT) AS id, status, attempts, last_error FROM jobs
    WHERE dedupe_key = ${dedupeKey} ORDER BY created_at DESC LIMIT 1
  `);
  return res.rows?.[0];
}

async function forceJobDue(jobId: string): Promise<void> {
  await db().execute(
    sql`UPDATE jobs SET run_after = now() - interval '1 minute' WHERE id = ${jobId}::uuid`
  );
}

describe("queued balance repair retries on recalculation failure", () => {
  it("fails the repair job back to pending on a transient failure, then completes and repairs balances on retry", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, { openingBalanceDisplayMinor: 0 });
    const start = daysAgo(7);
    await createSeries(db(), actorOf(user), {
      accountId,
      name: "Weekly bill",
      amountLedgerMinor: 100,
      frequency: "weekly",
      config: { weekday: weekdayOf(start) },
      nextDue: start
    });

    // Posting commits the occurrences AND the durable repair job.
    const posted = await postDueSeries(db(), new Date());
    expect(posted.failed).toBe(0);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(-200);
    const dedupeKey = `balance-repair:${accountId}`;
    const before = await repairJob(dedupeKey);
    expect(before?.status).toBe("pending");

    // Simulate the materialized balance going stale after the commit.
    await corruptBalance(accountId);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(0);

    // First attempt: recalculation fails transiently. The queue must NOT
    // complete the repair job — it goes back to pending for a retry, and
    // the stale balance is still there (repair genuinely did not happen).
    mockCtl.failFor.add(accountId);
    const registry = await createJobRegistry();
    await runPendingNow(db(), registry);
    const afterFail = await repairJob(dedupeKey);
    expect(afterFail?.id).toBe(before?.id);
    expect(afterFail?.status).toBe("pending");
    expect(afterFail?.attempts).toBe(1);
    expect(afterFail?.last_error).toMatch(/Balance recalculation failed for 1 account/);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(0);

    // Retry once the transient failure clears: the SAME job completes and
    // the balance is actually repaired.
    mockCtl.failFor.delete(accountId);
    await forceJobDue(before!.id);
    await runPendingNow(db(), registry);
    const afterRetry = await repairJob(dedupeKey);
    expect(afterRetry?.status).toBe("completed");
    expect((await latestBalance(accountId))?.balanceMinor).toBe(-200);
  });

  it("still repairs healthy accounts in the same pass while the failing account's job retries", async () => {
    const user = await makeUser();
    const badId = await makeAccount(user, { openingBalanceDisplayMinor: 0 });
    const goodId = await makeAccount(user, { openingBalanceDisplayMinor: 0 });
    await addTxn(user, badId, { amountLedgerMinor: 500 });
    await addTxn(user, goodId, { amountLedgerMinor: 700 });
    expect((await latestBalance(badId))?.balanceMinor).toBe(-500);
    expect((await latestBalance(goodId))?.balanceMinor).toBe(-700);
    await corruptBalance(badId);
    await corruptBalance(goodId);

    // Nightly-style maintenance job (no dedupe key): one pass must attempt
    // both accounts, repair the healthy one, and still fail the job so the
    // failing account is retried rather than dropped.
    const jobId = await enqueue(db(), "maintenance:balances", {});
    expect(jobId).toBeTruthy();
    mockCtl.failFor.add(badId);
    const registry = await createJobRegistry();
    await runPendingNow(db(), registry);

    expect((await latestBalance(goodId))?.balanceMinor).toBe(-700);
    expect((await latestBalance(badId))?.balanceMinor).toBe(0);
    const res = await db().execute<JobRow>(
      sql`SELECT CAST(id AS TEXT) AS id, status, attempts, last_error FROM jobs WHERE id = ${jobId}::uuid`
    );
    expect(res.rows?.[0]?.status).toBe("pending");
    expect(res.rows?.[0]?.attempts).toBe(1);

    mockCtl.failFor.delete(badId);
    await forceJobDue(jobId!);
    await runPendingNow(db(), registry);
    expect((await latestBalance(badId))?.balanceMinor).toBe(-500);
    const done = await db().execute<JobRow>(
      sql`SELECT CAST(id AS TEXT) AS id, status, attempts, last_error FROM jobs WHERE id = ${jobId}::uuid`
    );
    expect(done.rows?.[0]?.status).toBe("completed");
  });

  it("keeps the mocked recalculateAccount wired to the real implementation when not armed", async () => {
    // Guards against the fault-injection mock silently neutering repairs in
    // the tests above: unarmed, a direct call recalculates for real.
    const user = await makeUser();
    const accountId = await makeAccount(user, { openingBalanceDisplayMinor: 0 });
    await addTxn(user, accountId, { amountLedgerMinor: 250 });
    await corruptBalance(accountId);
    await recalculateAccount(db(), accountId);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(-250);
  });
});
