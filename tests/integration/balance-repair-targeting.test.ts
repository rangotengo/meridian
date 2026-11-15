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

// Same fault injection as balance-repair-retry.test.ts: recalculateAccount
// throws for accounts in failFor while armed, otherwise delegates to the
// real implementation.
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

async function corruptBalance(accountId: string): Promise<void> {
  await db().execute(
    sql`UPDATE balances SET balance_minor = 0 WHERE account_id = ${accountId}::uuid`
  );
}

type JobRow = {
  id: string;
  status: string;
  attempts: number;
  last_error: string | null;
  payload: unknown;
};

async function jobById(jobId: string): Promise<JobRow | undefined> {
  const res = await db().execute<JobRow>(sql`
    SELECT CAST(id AS TEXT) AS id, status, attempts, last_error, payload FROM jobs
    WHERE id = ${jobId}::uuid
  `);
  return res.rows?.[0];
}

async function forceJobDue(jobId: string): Promise<void> {
  await db().execute(
    sql`UPDATE jobs SET run_after = now() - interval '1 minute' WHERE id = ${jobId}::uuid`
  );
}

describe("account-targeted balance repair jobs", () => {
  it("repairs only the targeted account; a full run later repairs the rest", async () => {
    const user = await makeUser();
    const targetId = await makeAccount(user, { openingBalanceDisplayMinor: 0 });
    const otherId = await makeAccount(user, { openingBalanceDisplayMinor: 0 });
    await addTxn(user, targetId, { amountLedgerMinor: 400 });
    await addTxn(user, otherId, { amountLedgerMinor: 900 });
    expect((await latestBalance(targetId))?.balanceMinor).toBe(-400);
    expect((await latestBalance(otherId))?.balanceMinor).toBe(-900);
    await corruptBalance(targetId);
    await corruptBalance(otherId);

    const jobId = await enqueue(db(), "maintenance:balances", { accountIds: [targetId] });
    expect(jobId).toBeTruthy();
    const registry = await createJobRegistry();
    await runPendingNow(db(), registry);

    // Targeted run: named account repaired, untargeted account untouched,
    // job completed (its whole scope succeeded).
    expect((await jobById(jobId!))?.status).toBe("completed");
    expect((await latestBalance(targetId))?.balanceMinor).toBe(-400);
    expect((await latestBalance(otherId))?.balanceMinor).toBe(0);

    // A later untargeted (nightly-style) run repairs everything else.
    const fullJobId = await enqueue(db(), "maintenance:balances", {});
    expect(fullJobId).toBeTruthy();
    await runPendingNow(db(), registry);
    expect((await jobById(fullJobId!))?.status).toBe("completed");
    expect((await latestBalance(otherId))?.balanceMinor).toBe(-900);
  });

  it("fails a targeted job when a targeted account fails, then completes on retry", async () => {
    const user = await makeUser();
    const targetId = await makeAccount(user, { openingBalanceDisplayMinor: 0 });
    const otherId = await makeAccount(user, { openingBalanceDisplayMinor: 0 });
    await addTxn(user, targetId, { amountLedgerMinor: 250 });
    await addTxn(user, otherId, { amountLedgerMinor: 250 });
    await corruptBalance(targetId);
    await corruptBalance(otherId);

    const jobId = await enqueue(db(), "maintenance:balances", { accountIds: [targetId] });
    expect(jobId).toBeTruthy();
    mockCtl.failFor.add(targetId);
    const registry = await createJobRegistry();
    await runPendingNow(db(), registry);

    const afterFail = await jobById(jobId!);
    expect(afterFail?.status).toBe("pending");
    expect(afterFail?.attempts).toBe(1);
    expect(afterFail?.last_error).toMatch(/Balance recalculation failed for 1 account/);
    expect((await latestBalance(targetId))?.balanceMinor).toBe(0);
    // The untargeted account was never in scope and stays stale throughout.
    expect((await latestBalance(otherId))?.balanceMinor).toBe(0);

    mockCtl.failFor.delete(targetId);
    await forceJobDue(jobId!);
    await runPendingNow(db(), registry);
    expect((await jobById(jobId!))?.status).toBe("completed");
    expect((await latestBalance(targetId))?.balanceMinor).toBe(-250);
    expect((await latestBalance(otherId))?.balanceMinor).toBe(0);
  });

  it("commits the account target in the repair job enqueued by recurring posting", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, { openingBalanceDisplayMinor: 0 });
    const start = daysAgo(7);
    await createSeries(db(), actorOf(user), {
      accountId,
      name: "Weekly bill",
      amountLedgerMinor: 100,
      frequency: "weekly",
      config: { weekday: new Date(`${start}T00:00:00Z`).getUTCDay() },
      nextDue: start
    });

    const posted = await postDueSeries(db(), new Date());
    expect(posted.failed).toBe(0);

    const res = await db().execute<JobRow>(sql`
      SELECT CAST(id AS TEXT) AS id, status, attempts, last_error, payload FROM jobs
      WHERE dedupe_key = ${`balance-repair:${accountId}`} ORDER BY created_at DESC LIMIT 1
    `);
    const job = res.rows?.[0];
    expect(job?.status).toBe("pending");
    const payload =
      typeof job?.payload === "string" ? JSON.parse(job.payload) : (job?.payload ?? {});
    expect(payload).toMatchObject({ accountIds: [accountId] });
  });
});
