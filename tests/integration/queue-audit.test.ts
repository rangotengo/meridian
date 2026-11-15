import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { db, makeUser, makeAccount, addTxn, truncateAll, actorOf } from "../helpers";
import {
  enqueue,
  runPendingNow,
  claimBatch,
  failJob,
  completeJob,
  recoverStaleJobs,
  replayDeadJob,
  pruneFinishedJobs
} from "@/server/queue";
import { createJobRegistry, registerWorkerBootstraps } from "@/server/queue/jobs";
import { ensureSchedules, runDueCrons } from "@/server/queue/worker-loop";

beforeAll(async () => {
  await truncateAll();
});

describe("durable queue", () => {
  it("delivers email through the registry handler", async () => {
    await enqueue(db(), "email", { to: "x@test.local", subject: "Hi", text: "Body" });
    const processed = await runPendingNow(db(), await createJobRegistry());
    expect(processed).toBeGreaterThanOrEqual(1);
  });

  it("collapses duplicate dedupe keys while pending", async () => {
    const a = await enqueue(db(), "email", {}, { dedupeKey: "same-key" });
    const b = await enqueue(db(), "email", {}, { dedupeKey: "same-key" });
    expect(a).toBeTruthy();
    expect(b).toBeNull();
  });

  it("retries with backoff then dead-letters and records diagnostics", async () => {
    const failing = new Map<string, () => Promise<void>>();
    failing.set("boom", async () => {
      throw new Error("kaboom");
    });
    const registry = new Map<string, (p: Record<string, unknown>, e: never) => Promise<void>>();
    void registry;

    const jobId = await enqueue(db(), "boom", {}, { maxAttempts: 2 });
    expect(jobId).toBeTruthy();

    for (let round = 0; round < 10; round++) {
      const batch = await claimBatch(db(), "test", 5);
      for (const job of batch) {
        if (job.queue === "boom") {
          await failJob(db(), job, new Error("kaboom"));
        }
      }
      await db().execute(
        sql`UPDATE jobs SET run_after = now() - interval '1 minute' WHERE id = ${jobId}::uuid AND status = 'pending'`
      );
      const status = await db().execute<{ status: string }>(
        sql`SELECT status FROM jobs WHERE id = ${jobId}::uuid`
      );
      if (status.rows![0]!.status === "dead") break;
    }

    const finalStatus = await db().execute<{ status: string }>(
      sql`SELECT status FROM jobs WHERE id = ${jobId}::uuid`
    );
    expect(finalStatus.rows![0]!.status).toBe("dead");

    const diag = await db().execute<{ message: string }>(sql`
      SELECT message FROM debug_log_entries WHERE category='jobs' ORDER BY created_at DESC LIMIT 1
    `);
    expect((diag.rows ?? [])[0]?.message).toContain("dead-letter");
  });

  it("cron schedules enqueue work exactly once per scheduled slot", async () => {
    await ensureSchedules(db(), [
      { key: "test-nightly", queue: "maintenance:cleanup", cron: "* * * * *", payload: {} }
    ]);

    await db().execute(sql`
      UPDATE cron_schedules SET next_run_at = now() - interval '1 minute' WHERE key='test-nightly'
    `);
    const fired1 = await runDueCrons(db());
    expect(fired1).toBe(1);

    const fired2 = await runDueCrons(db());
    expect(fired2).toBe(0);

    const jobs = await db().execute<{ c: string }>(sql`
      SELECT count(*)::text AS c FROM jobs WHERE queue='maintenance:cleanup'
    `);
    expect(Number(jobs.rows![0]!.c)).toBe(1);
  });

  it("prunes old completed and dead jobs but keeps recent dead letters", async () => {
    const oldCompleted = await enqueue(db(), "email", {
      to: "old@test.local",
      subject: "x",
      text: "y"
    });
    const oldDead = await enqueue(db(), "email", {
      to: "dead@test.local",
      subject: "x",
      text: "y"
    });
    const recentDead = await enqueue(db(), "email", {
      to: "new@test.local",
      subject: "x",
      text: "y"
    });
    await db().execute(sql`
      UPDATE jobs SET status = 'completed', updated_at = now() - interval '20 days' WHERE id = ${oldCompleted}::uuid
    `);
    await db().execute(sql`
      UPDATE jobs SET status = 'dead', updated_at = now() - interval '20 days' WHERE id = ${oldDead}::uuid
    `);
    await db().execute(sql`
      UPDATE jobs SET status = 'dead', updated_at = now() WHERE id = ${recentDead}::uuid
    `);
    const removed = await pruneFinishedJobs(db(), 14);
    expect(removed).toBeGreaterThanOrEqual(2);
    const leftover = await db().execute<{ id: string }>(sql`
      SELECT id::text AS id FROM jobs WHERE id IN (${oldCompleted}::uuid, ${oldDead}::uuid, ${recentDead}::uuid)
    `);
    expect(leftover.rows?.map((r) => r.id)).toEqual([recentDead]);
  });

  it("worker bootstrap registers maintenance crons", async () => {
    await registerWorkerBootstraps(db());
    const rows = await db().execute<{ c: string }>(
      sql`SELECT count(*)::text AS c FROM cron_schedules`
    );
    expect(Number(rows.rows![0]!.c)).toBeGreaterThanOrEqual(2);
  });
});

describe("dedupe coalescing", () => {
  beforeAll(async () => {
    await db().execute(sql`DELETE FROM jobs`);
  });

  async function jobRow(id: string) {
    const res = await db().execute<{ status: string; last_error: string | null }>(
      sql`SELECT status, last_error FROM jobs WHERE id = ${id}::uuid`
    );
    return res.rows![0]!;
  }

  async function pendingCount(queue: string, key: string) {
    const res = await db().execute<{ c: string }>(sql`
      SELECT count(*)::text AS c FROM jobs
      WHERE queue = ${queue} AND dedupe_key = ${key} AND status = 'pending'
    `);
    return Number(res.rows![0]!.c);
  }

  async function claimOne(id: string) {
    const batch = await claimBatch(db(), "test", 50);
    const job = batch.find((j) => j.id === id);
    expect(job).toBeTruthy();
    return job!;
  }

  it("coalesces a retry when a newer pending job shares the dedupe key", async () => {
    const a = await enqueue(db(), "coalesce-retry", {}, { dedupeKey: "retry-key" });
    expect(a).toBeTruthy();
    const claimedA = await claimOne(a!);

    // A running job does not block enqueue: B lands as the pending duplicate.
    const b = await enqueue(db(), "coalesce-retry", {}, { dedupeKey: "retry-key" });
    expect(b).toBeTruthy();

    const outcome = await failJob(db(), claimedA, new Error("kaboom"));
    expect(outcome).toBe("coalesced");

    const rowA = await jobRow(a!);
    expect(rowA.status).toBe("completed");
    expect(rowA.last_error).toContain("Superseded by a pending job");
    expect(rowA.last_error).toContain("kaboom");

    expect((await jobRow(b!)).status).toBe("pending");
    expect(await pendingCount("coalesce-retry", "retry-key")).toBe(1);

    // The surviving pending job is still claimable and completable.
    await claimOne(b!);
    await completeJob(db(), b!);
    expect((await jobRow(b!)).status).toBe("completed");
  });

  it("coalesces stale-job recovery when a pending duplicate exists", async () => {
    const a = await enqueue(db(), "coalesce-recover", {}, { dedupeKey: "recover-key" });
    await claimOne(a!);
    const b = await enqueue(db(), "coalesce-recover", {}, { dedupeKey: "recover-key" });
    expect(b).toBeTruthy();

    await db().execute(sql`
      UPDATE jobs SET locked_at = now() - interval '30 minutes' WHERE id = ${a}::uuid
    `);
    const recovered = await recoverStaleJobs(db());
    expect(recovered).toBe(0);

    const rowA = await jobRow(a!);
    expect(rowA.status).toBe("completed");
    expect(rowA.last_error).toContain("Superseded by a pending job");
    expect((await jobRow(b!)).status).toBe("pending");
    expect(await pendingCount("coalesce-recover", "recover-key")).toBe(1);
  });

  it("coalesces a dead-letter replay when a pending duplicate exists", async () => {
    const a = await enqueue(db(), "coalesce-replay", {}, { dedupeKey: "replay-key" });
    await db().execute(sql`UPDATE jobs SET status = 'dead' WHERE id = ${a}::uuid`);
    const b = await enqueue(db(), "coalesce-replay", {}, { dedupeKey: "replay-key" });
    expect(b).toBeTruthy();

    const replayed = await replayDeadJob(db(), a!);
    expect(replayed).toBe(true);

    const rowA = await jobRow(a!);
    expect(rowA.status).toBe("completed");
    expect(rowA.last_error).toContain("Superseded by a pending job");
    expect((await jobRow(b!)).status).toBe("pending");
    expect(await pendingCount("coalesce-replay", "replay-key")).toBe(1);
  });

  it("keeps the non-collision retry, recovery, and replay paths unchanged", async () => {
    // Retry without a conflict reschedules with backoff.
    const c = await enqueue(db(), "plain-retry", {}, { dedupeKey: "plain-key", maxAttempts: 3 });
    const claimedC = await claimOne(c!);
    const outcome = await failJob(db(), claimedC, new Error("transient"));
    expect(outcome).toBe("retry");
    const resC = await db().execute<{ status: string; delayed: boolean }>(sql`
      SELECT status, (run_after > now()) AS delayed FROM jobs WHERE id = ${c}::uuid
    `);
    expect(resC.rows![0]!.status).toBe("pending");
    expect(resC.rows![0]!.delayed).toBe(true);

    // A NULL dedupe key never coalesces, even with another pending job.
    const f = await enqueue(db(), "plain-retry", {});
    const claimedF = await claimOne(f!);
    const g = await enqueue(db(), "plain-retry", {});
    expect(g).toBeTruthy();
    expect(await failJob(db(), claimedF, new Error("transient"))).toBe("retry");
    expect((await jobRow(f!)).status).toBe("pending");

    // Stale recovery without a conflict returns the job to pending.
    const d = await enqueue(db(), "plain-recover", {}, { dedupeKey: "plain-recover-key" });
    await claimOne(d!);
    await db().execute(sql`
      UPDATE jobs SET locked_at = now() - interval '30 minutes' WHERE id = ${d}::uuid
    `);
    const recovered = await recoverStaleJobs(db());
    expect(recovered).toBeGreaterThanOrEqual(1);
    const resD = await db().execute<{ status: string; locked_at: string | null }>(sql`
      SELECT status, locked_at FROM jobs WHERE id = ${d}::uuid
    `);
    expect(resD.rows![0]!.status).toBe("pending");
    expect(resD.rows![0]!.locked_at).toBeNull();

    // Replay without a conflict requeues the dead job with attempts reset.
    const e = await enqueue(db(), "plain-replay", {}, { dedupeKey: "plain-replay-key" });
    await db().execute(sql`UPDATE jobs SET status = 'dead', attempts = 4 WHERE id = ${e}::uuid`);
    expect(await replayDeadJob(db(), e!)).toBe(true);
    const resE = await db().execute<{ status: string; attempts: number }>(sql`
      SELECT status, attempts FROM jobs WHERE id = ${e}::uuid
    `);
    expect(resE.rows![0]!.status).toBe("pending");
    expect(Number(resE.rows![0]!.attempts)).toBe(0);
  });
});

describe("audit trail", () => {
  it("records entries and transfers on sensitive mutations", async () => {
    const user = await makeUser();
    const account = await makeAccount(user);
    await addTxn(user, account, { amountLedgerMinor: 500 });

    const events = await db().execute<{ action: string }>(sql`
      SELECT action FROM audit_events WHERE family_id = ${user.familyId}::uuid ORDER BY created_at
    `);
    const actions = (events.rows ?? []).map((r) => r.action);
    expect(actions).toContain("user.registered");
    expect(actions).toContain("account.created");
    expect(actions).toContain("entry.created");
  });
});

void actorOf;
