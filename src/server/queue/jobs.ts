import type { Executor } from "../db/client";
import { createMailer } from "../security/mailer";
import { purgeExpiredSessions } from "../security/session";
import { pruneRateLimitCounters } from "../security/rate-limit";
import { pruneDebugLogs } from "../observability/debug-log";
import { pruneFinishedJobs } from "./index";
import { ensureSchedules, type CronDef } from "./worker-loop";
import {
  recalculateAllActiveAccounts,
  recalculateTargetedAccounts
} from "../domain/balances-maintenance";
import { runMonthlyDigest } from "../domain/monthly-digest";
import { postDueSeries } from "../domain/recurring";
import { runScheduledBackup } from "../domain/backups";
import { cleanupOAuthHousekeeping } from "../domain/oauth";
import { env } from "@/lib/env";

export type JobPayloads = {
  email: { to: string; subject: string; text: string };
};

/**
 * Runs one recurring-posting pass and propagates per-series failures to the
 * queue: postDueSeries deliberately isolates failures per series (one bad
 * series must not block the rest), but a pass with failures is NOT a success.
 * Throwing here routes the job through failJob's retry / dead-letter handling.
 * Successful progress is preserved across the retry — posted occurrences
 * commit atomically with their schedule advance and are deduped by
 * externalId — so the retry only reworks series that are still due.
 */
export async function runRecurringPost(exec: Executor) {
  const result = await postDueSeries(exec);
  if (result.failed > 0) {
    throw new Error(
      `Recurring posting failed for ${result.failed} series (${result.posted} posted, ${result.paused} paused).`
    );
  }
  return result;
}

/**
 * Extracts the account target set from a maintenance:balances payload.
 * Returns null for an untargeted (full-rebuild) job: no payload, no
 * accountIds, an empty list, or a malformed value all mean "every active
 * account", matching the nightly job's historical behaviour.
 */
export function balanceMaintenanceTargets(payload?: Record<string, unknown>): string[] | null {
  const raw = payload?.accountIds;
  if (!Array.isArray(raw)) return null;
  const ids = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  return ids.length > 0 ? [...new Set(ids)] : null;
}

/**
 * Runs one balance-maintenance pass and propagates per-account failures to
 * the queue. The recalculation deliberately attempts every account in scope
 * (one failure must not block the others), but a pass with failures is NOT
 * a success: the durable repair jobs enqueued by recurring posting ride on
 * this handler, so resolving here would complete the repair job while the
 * very account needing repair stays stale — and once its series is no
 * longer due, nothing would revisit it until nightly maintenance.
 * Throwing routes the job through failJob's retry / dead-letter handling,
 * which preserves the repair intent until a recalculation succeeds.
 *
 * Scope: a payload of { accountIds: [...] } targets only those accounts
 * (the per-account repair jobs committed by recurring posting); any other
 * payload — including the nightly cron's {} — rebuilds every active
 * account. A failure in any in-scope account fails the job either way.
 */
export async function runBalanceMaintenance(exec: Executor, payload?: Record<string, unknown>) {
  const targets = balanceMaintenanceTargets(payload);
  const result = targets
    ? await recalculateTargetedAccounts(exec, targets)
    : await recalculateAllActiveAccounts(exec);
  if (result.failures.length > 0) {
    const ids = result.failures.map((f) => f.accountId).join(", ");
    throw new Error(
      `Balance recalculation failed for ${result.failures.length} account(s): ${ids} (${result.recalculated} succeeded).`
    );
  }
  return result;
}

export async function createJobRegistry() {
  const mailer = createMailer();
  const registry = new Map<
    string,
    (payload: Record<string, unknown>, exec: Executor) => Promise<void>
  >();

  registry.set("email", async (payload, exec) => {
    await mailer.send({
      to: String(payload.to),
      subject: String(payload.subject),
      text: String(payload.text)
    });
    void exec;
  });

  registry.set("maintenance:balances", async (payload, exec) => {
    await runBalanceMaintenance(exec, payload);
  });

  registry.set("maintenance:cleanup", async (_payload, exec) => {
    await purgeExpiredSessions(exec);
    await cleanupOAuthHousekeeping(exec);
    await pruneRateLimitCounters(exec);
    await pruneDebugLogs(exec, env.DEBUG_LOG_RETENTION_DAYS);
    await pruneFinishedJobs(exec, 14);
  });

  registry.set("recurring:post", async (_payload, exec) => {
    await runRecurringPost(exec);
  });

  registry.set("maintenance:backup", async (_payload, exec) => {
    await runScheduledBackup(exec);
  });

  registry.set("digest:monthly", async (_payload, exec) => {
    await runMonthlyDigest(exec);
  });

  return registry;
}

export const CRON_DEFINITIONS: CronDef[] = [
  { key: "nightly-backup", queue: "maintenance:backup", cron: "47 2 * * *" },
  { key: "nightly-balances", queue: "maintenance:balances", cron: "2 4 * * *" },
  { key: "nightly-cleanup", queue: "maintenance:cleanup", cron: "17 3 * * *" },
  { key: "recurring-post", queue: "recurring:post", cron: "*/30 * * * *" },
  { key: "monthly-digest", queue: "digest:monthly", cron: "17 6 1 * *" }
];

export async function registerWorkerBootstraps(exec: Executor): Promise<void> {
  await ensureSchedules(exec, CRON_DEFINITIONS);
}
