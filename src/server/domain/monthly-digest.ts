import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Executor } from "../db/client";
import type { Family } from "../auth/context";
import { families, users } from "../db/schema";
import { isFlagEnabled } from "../flags";
import { enqueue } from "../queue";
import { monthlyDigestSummary, previousMonthRange } from "./reports";
import { fmtDate, fmtMoney } from "@/lib/format";
import { env } from "@/lib/env";

/**
 * Monthly digest email (flag: `monthly_digest_email`, opt-in per member).
 *
 * Content is totals only — never transaction descriptions, merchants,
 * payees, account names, category names, or any row-level ledger data.
 */

export const MONTHLY_DIGEST_QUEUE = "digest:monthly";

/** A member receives the digest only when their stored preference is exactly true. */
export function isDigestOptedIn(preferences: unknown): boolean {
  if (!preferences) return false;
  let obj: Record<string, unknown> | null = null;
  if (typeof preferences === "string") {
    try {
      const parsed: unknown = JSON.parse(preferences);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      return false;
    }
  } else if (typeof preferences === "object" && !Array.isArray(preferences)) {
    obj = preferences as Record<string, unknown>;
  }
  return obj?.monthly_digest === true;
}

export function digestSubject(monthLabel: string): string {
  return `Meridian — ${monthLabel} summary`;
}

export function composeDigestText(input: {
  familyName: string;
  currency: string;
  monthLabel: string;
  asOf: string;
  netWorthMinor: number;
  incomeMinor: number;
  expenseMinor: number;
  savingsMinor: number;
  incompleteFx: boolean;
  appUrl: string;
}): string {
  const lines = [
    `Meridian monthly summary — ${input.monthLabel}`,
    "",
    `Family: ${input.familyName}`,
    "",
    `Net worth (${input.currency}, as of ${fmtDate(input.asOf)}): ${fmtMoney(input.netWorthMinor, input.currency)}`,
    `Income in ${input.monthLabel}: ${fmtMoney(input.incomeMinor, input.currency)}`,
    `Spending in ${input.monthLabel}: ${fmtMoney(input.expenseMinor, input.currency)}`,
    `Saved in ${input.monthLabel}: ${fmtMoney(input.savingsMinor, input.currency)}`
  ];
  if (input.incompleteFx) {
    lines.push("", "Some amounts were excluded because an exchange rate was missing.");
  }
  lines.push("", `View your dashboard: ${input.appUrl}`);
  return lines.join("\n");
}

export async function runMonthlyDigestForFamily(
  exec: Executor,
  family: Family,
  now: Date = new Date()
): Promise<number> {
  const { monthKey } = previousMonthRange(family.timezone, now);
  const members = await exec
    .select({ id: users.id, email: users.email, preferences: users.preferences })
    .from(users)
    .where(
      and(eq(users.familyId, family.id), isNotNull(users.emailVerifiedAt), isNull(users.removedAt))
    );

  let sent = 0;
  for (const member of members) {
    const email = (member.email ?? "").trim();
    if (!email) continue;
    if (!isDigestOptedIn(member.preferences)) continue;
    const summary = await monthlyDigestSummary(exec, family, member.id, { now });
    if (!summary.hasActivity) continue;
    const id = await enqueue(
      exec,
      "email",
      {
        to: email,
        subject: digestSubject(summary.monthLabel),
        text: composeDigestText({
          familyName: family.name,
          currency: family.currency,
          monthLabel: summary.monthLabel,
          asOf: summary.to,
          netWorthMinor: summary.netWorthMinor,
          incomeMinor: summary.incomeMinor,
          expenseMinor: summary.expenseMinor,
          savingsMinor: summary.savingsMinor,
          incompleteFx: summary.incompleteFx,
          appUrl: env.APP_URL
        })
      },
      { dedupeKey: `digest:${family.id}:${member.id}:${monthKey}` }
    );
    // A re-run hits the per-month dedupeKey and enqueues nothing: the job
    // row already exists, so it must not count (or send) again.
    if (id !== null) sent++;
  }
  return sent;
}

export type MonthlyDigestResult = { families: number; sent: number };

/**
 * Enqueue one digest email per opted-in, verified, non-removed member with
 * reportable activity. Flag-gated: when the flag is off nothing is enqueued.
 * Safe to re-run — every email carries a per-month dedupeKey. One family's
 * failure never aborts the others, but a pass with failures is NOT a
 * success: the error routes the job through retry / dead-letter handling
 * (mirroring runRecurringPost / runBalanceMaintenance).
 */
export async function runMonthlyDigest(
  exec: Executor,
  now: Date = new Date()
): Promise<MonthlyDigestResult> {
  if (!(await isFlagEnabled(exec, "monthly_digest_email"))) {
    return { families: 0, sent: 0 };
  }
  const allFamilies = await exec.select().from(families);
  let sent = 0;
  const failed: string[] = [];
  for (const family of allFamilies) {
    try {
      sent += await runMonthlyDigestForFamily(exec, family, now);
    } catch {
      failed.push(family.id);
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `Monthly digest failed for ${failed.length} ${failed.length === 1 ? "family" : "families"} (${failed.join(", ")}); ${sent} email(s) enqueued before the failure.`
    );
  }
  return { families: allFamilies.length, sent };
}
