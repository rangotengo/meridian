import { NextResponse } from "next/server";
import { sql, type SQLWrapper } from "drizzle-orm";
import { checkDb, getDb } from "@/server/db/client";
import { migrateStatusReport } from "@/server/db/migrate";
import { getQueueStats } from "@/server/queue";
import {
  getScheduleFreshness,
  recordScheduleDegradation
} from "@/server/observability/schedule-health";
import { mailConfigurationIssue } from "@/server/security/mailer";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Readiness vs. degradation:
 * - Readiness failures — database unreachable or migrations pending —
 *   return 503: the app cannot serve correctly, and Coolify's health
 *   check should treat the container as unhealthy.
 * - Degraded conditions — stale scheduled work, dead-letter jobs, mail
 *   misconfiguration — return 200 with status "degraded" and the failing
 *   checks named in the body. In particular a stale WORKER must not mark
 *   the WEB container unhealthy: the web app is serving fine, and
 *   restarting it would not fix the worker. The degraded state is still
 *   explicit here, on the admin operations page, and (on the flip into
 *   degraded) as a "health" debug-log entry an operator can alert on.
 */
export async function GET() {
  const dbOk = await checkDb();
  if (!dbOk) {
    return NextResponse.json(
      { status: "error", db: false, migrations: "unknown" },
      { status: 503 }
    );
  }

  try {
    const report = await migrateStatusReport();
    const db = getDb();
    const queueStats = await getQueueStats(db);
    const mailIssue = mailConfigurationIssue();
    const freshness = await getScheduleFreshness(db);

    // Cloud only: the Durable Object records each successful cron tick.
    let lastTickAt: string | null = null;
    if (env.DATABASE_BACKEND === "cloud-sqlite") {
      try {
        const ticked = await (
          db as unknown as {
            execute<T extends Record<string, unknown>>(query: SQLWrapper): Promise<{ rows: T[] }>;
          }
        ).execute<{ value: string }>(sql`SELECT value FROM ops_state WHERE key = 'last_tick_at'`);
        lastTickAt = ticked.rows[0]?.value ?? null;
      } catch {
        lastTickAt = null;
      }
    }

    if (freshness.staleChecks.length > 0) {
      // Record the flip into the degraded state (once per distinct stale
      // set) so it is alertable later; never let logging break health.
      try {
        await recordScheduleDegradation(db, freshness);
      } catch {
        // Health reporting must not fail because the audit write did.
      }
    }

    const isDegraded =
      report.pending.length > 0 ||
      !!mailIssue ||
      queueStats.dead > 0 ||
      freshness.staleChecks.length > 0;
    const httpStatus = report.pending.length > 0 ? 503 : 200;

    return NextResponse.json(
      {
        status: isDegraded ? "degraded" : "ok",
        db: true,
        migrations: report.pending.length > 0 ? `pending:${report.pending.length}` : "current",
        queue: queueStats,
        schedules: freshness.checks,
        ...(env.DATABASE_BACKEND === "cloud-sqlite" ? { cron: { lastTickAt } } : {}),
        mail: {
          transport: env.MAIL_TRANSPORT,
          ready: env.MAIL_TRANSPORT !== "manual" && !mailIssue,
          ...(env.MAIL_TRANSPORT === "manual" ? { invitations: "share-link" } : {}),
          ...(mailIssue ? { issue: mailIssue } : {})
        }
      },
      { status: httpStatus }
    );
  } catch {
    return NextResponse.json({ status: "error", db: true, migrations: "error" }, { status: 503 });
  }
}
