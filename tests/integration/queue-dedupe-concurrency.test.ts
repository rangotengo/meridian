import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/server/db/schema";
import type { Executor } from "@/server/db/client";
import { db } from "../helpers";
import { enqueue, claimBatch, failJob, recoverStaleJobs, replayDeadJob } from "@/server/queue";

// Two-connection regressions for the dedupe coalescing race: a guarded
// UPDATE's NOT EXISTS predicate runs on a READ COMMITTED statement snapshot,
// so a pending duplicate inserted by a still-uncommitted transaction on
// another connection is invisible to it — while the partial unique index
// still detects the duplicate once that transaction commits and raises
// 23505 instead of letting the transition take the coalescing branch.
// These tests hold a real enqueue open (uncommitted) on a second connection
// while each transition into 'pending' starts, then commit it mid-flight.

function secondExecutor(): { exec: Executor; close: () => Promise<void> } {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is missing in test environment");
  const pool = new Pool({ connectionString: url, max: 2 });
  const exec: Executor = drizzle(pool, { schema });
  return { exec, close: () => pool.end() };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs the real enqueue() inside an open transaction on the given executor
 * and holds the transaction (and, on Postgres, the per-key advisory lock the
 * enqueue takes) uncommitted until release() is called.
 */
function startUncommittedEnqueue(exec: Executor, queue: string, dedupeKey: string) {
  const inserted = deferred<string | null>();
  const gate = deferred();
  const done = exec.transaction(async (tx) => {
    const id = await enqueue(tx, queue, {}, { dedupeKey });
    inserted.resolve(id);
    await gate.promise;
    return id;
  });
  // Avoid an unhandled rejection if an assertion fails before `done` is
  // awaited; the awaiting test still observes the real outcome.
  done.catch(() => {});
  return { insertedId: inserted.promise, release: () => gate.resolve(), done };
}

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

describe("dedupe coalescing under concurrency", () => {
  beforeEach(async () => {
    await db().execute(sql`DELETE FROM jobs`);
  });

  it("failJob coalesces when the duplicate enqueue is uncommitted on another connection", async () => {
    const queue = "race-retry";
    const key = "race-retry-key";
    const a = await enqueue(db(), queue, {}, { dedupeKey: key });
    expect(a).toBeTruthy();
    const claimedA = await claimOne(a!);

    const second = secondExecutor();
    const pending = startUncommittedEnqueue(second.exec, queue, key);
    try {
      const b = await pending.insertedId;
      expect(b).toBeTruthy();

      // Start the retry transition while B is still uncommitted, then commit
      // B mid-flight. The transition must not surface a 23505.
      const outcomePromise = failJob(db(), claimedA, new Error("kaboom"));
      await sleep(300);
      pending.release();
      const outcome = await outcomePromise;
      await pending.done;

      expect(outcome).toBe("coalesced");
      const rowA = await jobRow(a!);
      expect(rowA.status).toBe("completed");
      expect(rowA.last_error).toContain("Superseded by a pending job");
      expect(rowA.last_error).toContain("kaboom");
      expect((await jobRow(b!)).status).toBe("pending");
      expect(await pendingCount(queue, key)).toBe(1);
    } finally {
      pending.release();
      await second.close();
    }
  });

  it("recoverStaleJobs coalesces when the duplicate enqueue is uncommitted on another connection", async () => {
    const queue = "race-recover";
    const key = "race-recover-key";
    const a = await enqueue(db(), queue, {}, { dedupeKey: key });
    expect(a).toBeTruthy();
    await claimOne(a!);
    await db().execute(sql`
      UPDATE jobs SET locked_at = now() - interval '30 minutes' WHERE id = ${a}::uuid
    `);

    const second = secondExecutor();
    const pending = startUncommittedEnqueue(second.exec, queue, key);
    try {
      const b = await pending.insertedId;
      expect(b).toBeTruthy();

      const recoveredPromise = recoverStaleJobs(db());
      await sleep(300);
      pending.release();
      const recovered = await recoveredPromise;
      await pending.done;

      expect(recovered).toBe(0);
      const rowA = await jobRow(a!);
      expect(rowA.status).toBe("completed");
      expect(rowA.last_error).toContain("Superseded by a pending job");
      expect((await jobRow(b!)).status).toBe("pending");
      expect(await pendingCount(queue, key)).toBe(1);
    } finally {
      pending.release();
      await second.close();
    }
  });

  it("replayDeadJob coalesces when the duplicate enqueue is uncommitted on another connection", async () => {
    const queue = "race-replay";
    const key = "race-replay-key";
    const a = await enqueue(db(), queue, {}, { dedupeKey: key });
    expect(a).toBeTruthy();
    await db().execute(sql`UPDATE jobs SET status = 'dead' WHERE id = ${a}::uuid`);

    const second = secondExecutor();
    const pending = startUncommittedEnqueue(second.exec, queue, key);
    try {
      const b = await pending.insertedId;
      expect(b).toBeTruthy();

      const replayPromise = replayDeadJob(db(), a!);
      await sleep(300);
      pending.release();
      const replayed = await replayPromise;
      await pending.done;

      expect(replayed).toBe(true);
      const rowA = await jobRow(a!);
      expect(rowA.status).toBe("completed");
      expect(rowA.last_error).toContain("Superseded by a pending job");
      expect((await jobRow(b!)).status).toBe("pending");
      expect(await pendingCount(queue, key)).toBe(1);
    } finally {
      pending.release();
      await second.close();
    }
  });

  it("enqueue on a second connection dedupes against an in-flight enqueue once it commits", async () => {
    const queue = "race-enqueue";
    const key = "race-enqueue-key";

    const second = secondExecutor();
    const pending = startUncommittedEnqueue(second.exec, queue, key);
    try {
      const b = await pending.insertedId;
      expect(b).toBeTruthy();

      // A concurrent enqueue of the same key must wait out the uncommitted
      // insert and then dedupe to null instead of inserting a second
      // pending row or throwing.
      const dupPromise = enqueue(db(), queue, {}, { dedupeKey: key });
      await sleep(300);
      pending.release();
      const dup = await dupPromise;
      await pending.done;

      expect(dup).toBeNull();
      expect((await jobRow(b!)).status).toBe("pending");
      expect(await pendingCount(queue, key)).toBe(1);
    } finally {
      pending.release();
      await second.close();
    }
  });
});
