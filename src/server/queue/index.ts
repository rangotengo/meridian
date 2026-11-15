import { rowLock } from "@/server/db/dialect";
import { databaseNow } from "@/server/db/dialect";
import { sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { jobs } from "../db/schema";
import { captureDebugLog } from "../observability/debug-log";

export type JobPayload = Record<string, unknown>;

export type JobHandler = (payload: JobPayload, exec: Executor) => Promise<void>;
export type HandlerRegistry = Map<string, JobHandler>;

export type EnqueueOptions = {
  dedupeKey?: string;
  maxAttempts?: number;
  delaySeconds?: number;
};

export async function enqueue(
  exec: Executor,
  queue: string,
  payload: JobPayload,
  opts: EnqueueOptions = {}
): Promise<string | null> {
  const values = {
    queue,
    payload,
    dedupeKey: opts.dedupeKey ?? null,
    maxAttempts: opts.maxAttempts ?? 5,
    ...(opts.delaySeconds ? { runAfter: new Date(Date.now() + opts.delaySeconds * 1000) } : {})
  };
  const rows = await exec
    .insert(jobs)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows[0]?.id ?? null;
}

export type ClaimedJob = typeof jobs.$inferSelect;

const STALE_LOCK_MINUTES = 10;

/**
 * Coalescing guard for transitions back into 'pending'.
 *
 * The partial unique index jobs_dedupe_active_idx allows only one pending
 * job per (queue, dedupe_key), but a running or dead job does not block
 * enqueue, so a newer pending job with the same key can legitimately appear
 * while an older one is still in flight. When the older job later moves back
 * to 'pending' (retry, stale recovery, dead-letter replay), an unguarded
 * UPDATE violates the index and throws into the worker loop. Guarding the
 * transition with NOT EXISTS over a live pending duplicate keeps it atomic:
 * the pending job already represents the work, so the older job is coalesced
 * instead — marked 'completed' with SUPERSEDED_NOTE as its last_error, which
 * preserves its row for the admin jobs view and the finished-job pruner
 * (deleting it would erase that history). Jobs with a NULL dedupe key never
 * match this predicate (NULL never equals NULL), so they always transition
 * normally.
 */
const pendingDuplicateExists = sql`EXISTS (
  SELECT 1 FROM jobs AS dup
  WHERE dup.queue = jobs.queue
    AND dup.dedupe_key = jobs.dedupe_key
    AND dup.status = 'pending'
    AND dup.id <> jobs.id
)`;

const SUPERSEDED_NOTE = "Superseded by a pending job with the same dedupe key";

export async function recoverStaleJobs(exec: Executor): Promise<number> {
  const staleBefore = new Date(Date.now() - STALE_LOCK_MINUTES * 60000).toISOString();
  // Return stale jobs to 'pending', skipping any whose dedupe key is already
  // covered by a pending duplicate. When several stale jobs share a key, only
  // the longest-stale one is recovered (deterministic tie-break on
  // locked_at/created_at/id); the rest are coalesced by the second UPDATE.
  const res = await exec.execute(sql`
    UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL, updated_at = ${databaseNow}
    WHERE status = 'running' AND locked_at < ${staleBefore}
      AND NOT EXISTS (
        SELECT 1 FROM jobs AS dup
        WHERE dup.queue = jobs.queue
          AND dup.dedupe_key = jobs.dedupe_key
          AND dup.id <> jobs.id
          AND (
            dup.status = 'pending'
            OR (
              dup.status = 'running' AND dup.locked_at < ${staleBefore}
              AND (
                dup.locked_at < jobs.locked_at
                OR (dup.locked_at = jobs.locked_at AND dup.created_at < jobs.created_at)
                OR (dup.locked_at = jobs.locked_at AND dup.created_at = jobs.created_at AND dup.id < jobs.id)
              )
            )
          )
      )
  `);
  // Any stale job still 'running' here was blocked by a pending duplicate —
  // either one that already existed or the tie-break winner recovered above —
  // so coalesce it instead of leaving it stuck behind the dedupe index.
  await exec.execute(sql`
    UPDATE jobs SET status = 'completed', completed_at = ${databaseNow}, locked_at = NULL, locked_by = NULL,
      last_error = ${SUPERSEDED_NOTE}, updated_at = ${databaseNow}
    WHERE status = 'running' AND locked_at < ${staleBefore}
      AND ${pendingDuplicateExists}
  `);
  // Counts only jobs returned to 'pending'; coalesced jobs are resolved as
  // 'completed' and are not included in the count.
  return res.rowCount ?? 0;
}

export async function claimBatch(
  exec: Executor,
  workerName: string,
  limit: number
): Promise<ClaimedJob[]> {
  const res = await exec.execute(sql`
    UPDATE jobs SET status = 'running', locked_by = ${workerName}, locked_at = ${databaseNow},
      attempts = attempts + 1, updated_at = ${databaseNow}
    WHERE id IN (
      SELECT id FROM jobs
      WHERE status = 'pending' AND run_after <= ${databaseNow}
      ORDER BY created_at
      LIMIT ${limit}
      ${rowLock}
    )
    RETURNING id, queue, payload, dedupe_key AS "dedupeKey", status, attempts,
      max_attempts AS "maxAttempts", run_after AS "runAfter", locked_at AS "lockedAt",
      locked_by AS "lockedBy", last_error AS "lastError", completed_at AS "completedAt",
      created_at AS "createdAt", updated_at AS "updatedAt"
  `);
  return (res.rows ?? []).map((row) => ({
    ...row,
    payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload
  })) as ClaimedJob[];
}

function backoffSeconds(attempts: number): number {
  return Math.min(3600, 2 ** Math.max(0, attempts - 1) * 5);
}

export async function completeJob(exec: Executor, jobId: string): Promise<void> {
  await exec.execute(sql`
    UPDATE jobs SET status = 'completed', completed_at = ${databaseNow}, updated_at = ${databaseNow}, last_error = NULL
    WHERE id = ${jobId}
  `);
}

export async function failJob(
  exec: Executor,
  job: ClaimedJob,
  error: unknown
): Promise<"retry" | "dead" | "coalesced"> {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`.slice(0, 500)
      : String(error).slice(0, 500);
  if (job.attempts >= job.maxAttempts) {
    await exec.execute(sql`
      UPDATE jobs SET status = 'dead', last_error = ${message}, updated_at = ${databaseNow} WHERE id = ${job.id}
    `);
    await captureDebugLog(exec, {
      category: "jobs",
      level: "error",
      message: `Job ${job.queue} moved to dead-letter after ${job.attempts} attempts`,
      source: "worker",
      metadata: { jobId: job.id, queue: job.queue, lastError: message }
    });
    return "dead";
  }
  const delay = backoffSeconds(job.attempts + 1);
  const res = await exec.execute(sql`
    UPDATE jobs SET status = 'pending', last_error = ${message},
      run_after = ${new Date(Date.now() + delay * 1000).toISOString()}, updated_at = ${databaseNow}
    WHERE id = ${job.id} AND NOT ${pendingDuplicateExists}
  `);
  if ((res.rowCount ?? 0) > 0) return "retry";
  // A newer pending job with the same dedupe key already covers this work:
  // coalesce instead of violating the dedupe index on the retry transition.
  await exec.execute(sql`
    UPDATE jobs SET status = 'completed', completed_at = ${databaseNow}, locked_at = NULL, locked_by = NULL,
      last_error = ${`${SUPERSEDED_NOTE}; last failure: ${message}`.slice(0, 500)}, updated_at = ${databaseNow}
    WHERE id = ${job.id} AND status = 'running'
  `);
  return "coalesced";
}

export async function replayDeadJob(exec: Executor, jobId: string): Promise<boolean> {
  const res = await exec.execute(sql`
    UPDATE jobs SET status = 'pending', attempts = 0, run_after = ${databaseNow}, updated_at = ${databaseNow}
    WHERE id = ${jobId} AND status = 'dead' AND NOT ${pendingDuplicateExists}
  `);
  if ((res.rowCount ?? 0) > 0) return true;
  // Coalesce: a pending duplicate already covers this job's work, so the
  // replay resolves the dead job as 'completed' instead of violating the
  // dedupe index. Returning true reports that the replay took effect (the
  // job left 'dead' and its work is covered); false means the job was not
  // in 'dead' state to begin with.
  const coalesced = await exec.execute(sql`
    UPDATE jobs SET status = 'completed', completed_at = ${databaseNow},
      last_error = ${SUPERSEDED_NOTE}, updated_at = ${databaseNow}
    WHERE id = ${jobId} AND status = 'dead'
  `);
  return (coalesced.rowCount ?? 0) > 0;
}

export async function pruneFinishedJobs(exec: Executor, olderThanDays: number): Promise<number> {
  const res = await exec.execute(sql`
    DELETE FROM jobs
    WHERE status IN ('completed', 'dead')
      AND updated_at < ${new Date(Date.now() - olderThanDays * 86400000).toISOString()}
  `);
  return res.rowCount ?? 0;
}

export type RecentJobRow = {
  id: string;
  queue: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  run_after: string;
  created_at: string;
};

export async function listRecentJobs(exec: Executor, limit = 100): Promise<RecentJobRow[]> {
  const res = await exec.execute<RecentJobRow>(sql`
    SELECT id, queue, status, attempts, max_attempts, last_error, run_after, created_at
    FROM jobs ORDER BY created_at DESC LIMIT ${limit}
  `);
  return (res.rows ?? []) as RecentJobRow[];
}

export async function runPendingNow(
  exec: Executor,
  registry: HandlerRegistry,
  opts: { maxRounds?: number; batchSize?: number } = {}
): Promise<number> {
  const maxRounds = opts.maxRounds ?? 50;
  const batchSize = opts.batchSize ?? 20;
  let processed = 0;
  for (let round = 0; round < maxRounds; round++) {
    const batch = await claimBatch(exec, "inline-runner", batchSize);
    if (batch.length === 0) break;
    for (const job of batch) {
      const handler = registry.get(job.queue);
      try {
        if (!handler) throw new Error(`No handler registered for queue "${job.queue}"`);
        await handler((job.payload ?? {}) as JobPayload, exec);
        await completeJob(exec, job.id);
      } catch (e) {
        await failJob(exec, job, e);
      }
      processed++;
    }
  }
  return processed;
}

export async function getQueueStats(
  exec: Executor
): Promise<{ pending: number; running: number; completed: number; dead: number }> {
  const res = await exec.execute<{ status: string; count: number }>(sql`
    SELECT status, CAST(count(*) AS INTEGER) AS count FROM jobs GROUP BY status
  `);
  const counts: Record<string, number> = { pending: 0, running: 0, completed: 0, dead: 0 };
  for (const row of res.rows ?? []) {
    counts[row.status] = Number(row.count);
  }
  return {
    pending: counts.pending ?? 0,
    running: counts.running ?? 0,
    completed: counts.completed ?? 0,
    dead: counts.dead ?? 0
  };
}
