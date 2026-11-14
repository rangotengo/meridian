import type { Executor } from "../db/client";
import { createMailer } from "../security/mailer";
import { purgeExpiredSessions } from "../security/session";
import { pruneRateLimitCounters } from "../security/rate-limit";
import { pruneDebugLogs } from "../observability/debug-log";
import { pruneFinishedJobs } from "./index";
import { ensureSchedules, type CronDef } from "./worker-loop";
import { recalculateAllActiveAccounts } from "../domain/balances-maintenance";
import { postDueSeries } from "../domain/recurring";
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

  registry.set("maintenance:balances", async (_payload, exec) => {
    await recalculateAllActiveAccounts(exec);
  });

  registry.set("maintenance:cleanup", async (_payload, exec) => {
    await purgeExpiredSessions(exec);
    await pruneRateLimitCounters(exec);
    await pruneDebugLogs(exec, env.DEBUG_LOG_RETENTION_DAYS);
    await pruneFinishedJobs(exec, 14);
  });

  registry.set("recurring:post", async (_payload, exec) => {
    await runRecurringPost(exec);
  });

  return registry;
}

export const CRON_DEFINITIONS: CronDef[] = [
  { key: "nightly-balances", queue: "maintenance:balances", cron: "2 4 * * *" },
  { key: "nightly-cleanup", queue: "maintenance:cleanup", cron: "17 3 * * *" },
  { key: "recurring-post", queue: "recurring:post", cron: "*/30 * * * *" }
];

export async function registerWorkerBootstraps(exec: Executor): Promise<void> {
  await ensureSchedules(exec, CRON_DEFINITIONS);
}
