import type { Executor } from "../db/client";
import { cronSchedules } from "../db/schema";
import { captureDebugLog, listDebugLogs } from "./debug-log";

/**
 * Freshness expectations for the worker's cron schedules, mirroring
 * CRON_DEFINITIONS in src/server/queue/jobs.ts (keep the keys in sync).
 *
 * A schedule is stale when its next_run_at has been in the past for longer
 * than staleAfterSeconds: the worker fires due schedules on every poll, so
 * a next_run_at that stays due means the worker is not ticking. Thresholds
 * are a small multiple of each schedule's cadence — recurring posting runs
 * every 30 minutes, so 1 hour overdue means two whole cycles were missed;
 * the nightly jobs run every 24 hours, so 6 hours overdue is already far
 * beyond any normal scheduling jitter (and still flags a dead worker the
 * same morning, not a day later).
 *
 * This measures enqueue freshness only — that the worker ticked and queued
 * the job on schedule — NOT that the job's handler then succeeded. A job
 * can be enqueued on time and still fail; the complementary signal for
 * handler success is the queue's dead-letter state (the queue stats in
 * /api/health and the admin page).
 *
 * An expectation marked `optional` is only checked when a cron_schedules
 * row exists for it. nightly-backup is registered only on deployments
 * where operator backups are configured, so a missing row there means
 * "feature off", not "worker never booted", and must not degrade health.
 */
export const SCHEDULE_EXPECTATIONS = [
  { key: "recurring-post", queue: "recurring:post", staleAfterSeconds: 3600, optional: false },
  {
    key: "nightly-balances",
    queue: "maintenance:balances",
    staleAfterSeconds: 6 * 3600,
    optional: false
  },
  {
    key: "nightly-cleanup",
    queue: "maintenance:cleanup",
    staleAfterSeconds: 6 * 3600,
    optional: false
  },
  {
    key: "nightly-backup",
    queue: "maintenance:backup",
    staleAfterSeconds: 6 * 3600,
    optional: true
  }
] as const;

export type ScheduleExpectation = (typeof SCHEDULE_EXPECTATIONS)[number];

export type ScheduleCheckStatus = "ok" | "stale" | "missing" | "disabled";

export type ScheduleCheck = {
  key: string;
  queue: string;
  status: ScheduleCheckStatus;
  lastRunAt: string | null;
  nextRunAt: string | null;
  /** Seconds since the schedule last fired; null if it never has. */
  lastRunAgeSeconds: number | null;
  /** Seconds next_run_at has been in the past; 0 while it is in the future. */
  overdueSeconds: number;
  /** Overdue budget before the check counts as stale. */
  staleAfterSeconds: number;
};

export type ScheduleRow = {
  lastRunAt: Date | string | null;
  nextRunAt: Date | string | null;
  enabled?: boolean | null;
};

function toIso(value: Date | string | null): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function secondsBetween(fromIso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(fromIso).getTime()) / 1000));
}

/**
 * Pure status mapping for one schedule: given its cron_schedules row (or
 * null when the worker never registered it) and the current time, decide
 * whether scheduled work is fresh. A missing row means no worker has ever
 * booted against this database, so nothing is scheduled at all — reported
 * as "missing" and treated as not-ok by callers.
 */
export function evaluateScheduleCheck(
  expectation: ScheduleExpectation,
  row: ScheduleRow | null,
  now: Date
): ScheduleCheck {
  const base = {
    key: expectation.key,
    queue: expectation.queue,
    staleAfterSeconds: expectation.staleAfterSeconds
  };
  if (!row) {
    return {
      ...base,
      status: "missing",
      lastRunAt: null,
      nextRunAt: null,
      lastRunAgeSeconds: null,
      overdueSeconds: 0
    };
  }
  const lastRunAt = toIso(row.lastRunAt);
  const nextRunAt = toIso(row.nextRunAt);
  const overdueSeconds = nextRunAt ? secondsBetween(nextRunAt, now) : 0;
  const status: ScheduleCheckStatus =
    row.enabled === false
      ? "disabled"
      : overdueSeconds > expectation.staleAfterSeconds
        ? "stale"
        : "ok";
  return {
    ...base,
    status,
    lastRunAt,
    nextRunAt,
    lastRunAgeSeconds: lastRunAt ? secondsBetween(lastRunAt, now) : null,
    overdueSeconds
  };
}

export type ScheduleFreshness = {
  checks: ScheduleCheck[];
  /** Checks that make the instance degraded: stale or never registered. */
  staleChecks: ScheduleCheck[];
};

export async function getScheduleFreshness(
  exec: Executor,
  now: Date = new Date()
): Promise<ScheduleFreshness> {
  const rows = await exec
    .select({
      key: cronSchedules.key,
      queue: cronSchedules.queue,
      lastRunAt: cronSchedules.lastRunAt,
      nextRunAt: cronSchedules.nextRunAt,
      enabled: cronSchedules.enabled
    })
    .from(cronSchedules);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const checks = SCHEDULE_EXPECTATIONS.flatMap((expectation) => {
    const row = byKey.get(expectation.key);
    // Optional schedules (nightly-backup) are only checked when registered:
    // no row means the feature is not configured on this deployment, which
    // is neither "missing" nor a reason to degrade health.
    if (!row && expectation.optional) return [];
    return [
      evaluateScheduleCheck(
        expectation,
        row ? { lastRunAt: row.lastRunAt, nextRunAt: row.nextRunAt, enabled: row.enabled } : null,
        now
      )
    ];
  });
  return {
    checks,
    staleChecks: checks.filter((c) => c.status === "stale" || c.status === "missing")
  };
}

/**
 * Records schedule-health transitions in the debug log — both the flip
 * into a degraded state and the recovery back to healthy. Health is
 * polled frequently (Coolify, uptime checks), so logging every read would
 * flood the log; instead, the latest "health" entry's recorded stale-key
 * set is the incident state, and an entry is written only when the
 * current set differs from it:
 *
 * - degraded set changed (including a first incident) → one "warn" entry
 *   naming the stale schedules — the alertable record for that incident;
 * - degraded set became empty after an incident → one "info" recovery
 *   entry whose staleKeys is [], resetting the incident state. Without
 *   this, the latest entry would keep the old stale set forever and a
 *   later recurrence of the same outage would compare equal to it and be
 *   suppressed — the next outage would get no alert;
 * - same set as last recorded (repeated polls during one outage, or
 *   repeated healthy polls) → nothing written.
 *
 * That keeps exactly one alertable record per incident while the live
 * state stays visible in /api/health and the admin page. Returns true
 * when an entry was written. Callers must invoke this on every health
 * read — healthy ones included — so recoveries are observed; the caller
 * also wraps it so a failed write never breaks the health response.
 */
export async function recordScheduleDegradation(
  exec: Executor,
  freshness: ScheduleFreshness
): Promise<boolean> {
  const staleKeys = freshness.staleChecks.map((c) => c.key).sort();
  const [latest] = await listDebugLogs(exec, { category: "health", limit: 1 });
  const previous = (latest?.metadata as { staleKeys?: unknown } | null)?.staleKeys;
  const previousKeys = Array.isArray(previous)
    ? previous.filter((k): k is string => typeof k === "string").sort()
    : [];
  if (JSON.stringify(previousKeys) === JSON.stringify(staleKeys)) return false;
  if (staleKeys.length === 0) {
    await captureDebugLog(exec, {
      category: "health",
      level: "info",
      message: `Health recovered: scheduled work is fresh again (was stale: ${previousKeys.join(", ")})`,
      source: "api",
      metadata: { staleKeys: [], recoveredFrom: previousKeys }
    });
    return true;
  }
  await captureDebugLog(exec, {
    category: "health",
    level: "warn",
    message: `Health degraded: scheduled work is stale (${staleKeys.join(", ")})`,
    source: "api",
    metadata: {
      staleKeys,
      checks: freshness.staleChecks.map((c) => ({
        key: c.key,
        queue: c.queue,
        status: c.status,
        lastRunAt: c.lastRunAt,
        nextRunAt: c.nextRunAt,
        overdueSeconds: c.overdueSeconds,
        staleAfterSeconds: c.staleAfterSeconds
      }))
    }
  });
  return true;
}
