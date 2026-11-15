import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { chunkParams } from "../db/params";
import {
  accounts,
  categories,
  entries,
  families,
  recurringSeries,
  transactions
} from "../db/schema";
import type { Actor } from "../auth/context";
import {
  accessibleAccountIds,
  assertAccountAccess,
  assertAccountOpen
} from "../authorization/access";
import { recalculateAccount } from "./balances";
import { enqueue } from "../queue/index";
import { recordAudit } from "../observability/audit";
import { captureDebugLog } from "../observability/debug-log";
import { errors } from "@/lib/errors";
import { addDays, addMonths, endOfMonth, isIsoDate, monthKeyOf } from "@/lib/datetime";

export type Frequency = "monthly" | "weekly" | "yearly";

export type SeriesConfig = {
  dayOfMonth?: number;
  weekday?: number;
  month?: number;
  day?: number;
};

export type RecurringSeriesInput = {
  accountId: string;
  name: string;
  merchant?: string | null;
  amountLedgerMinor: number;
  categoryId?: string | null;
  frequency: Frequency;
  config: SeriesConfig;
  nextDue: string;
};

export type RecurringSeriesRow = typeof recurringSeries.$inferSelect;

const MAX_NAME_LENGTH = 240;

/**
 * Computes the next occurrence after `from` for a series.
 * Monthly series clamp to month length: day 31 in a 30-day month lands on the 30th,
 * and the anchor day is remembered via clamping each month independently.
 */
export function nextOccurrence(frequency: Frequency, config: SeriesConfig, from: string): string {
  if (!isIsoDate(from)) throw errors.validation("Date must be in YYYY-MM-DD format.");
  switch (frequency) {
    case "weekly": {
      const weekday = config.weekday ?? new Date(`${from}T00:00:00Z`).getUTCDay();
      // Defensive bound: an out-of-range weekday (e.g. from a hand-edited
      // database row) must fail fast instead of looping forever — the scan
      // below can never need more than 7 steps for a valid weekday.
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        throw errors.validation("Weekly series require a weekday (0-6).");
      }
      let next = addDays(from, 1);
      while (new Date(`${next}T00:00:00Z`).getUTCDay() !== weekday) {
        next = addDays(next, 1);
      }
      return next;
    }
    case "yearly": {
      const month = config.month ?? Number(from.slice(5, 7));
      const day = config.day ?? Number(from.slice(8, 10));
      const y = Number(from.slice(0, 4));
      const candidate = clampToMonth(`${y}-${pad2(month)}-01`, day);
      return candidate > from ? candidate : clampToMonth(`${y + 1}-${pad2(month)}-01`, day);
    }
    case "monthly":
    default: {
      const anchorDay = config.dayOfMonth ?? Number(from.slice(8, 10));
      const nextMonth = addMonths(monthKeyOf(from), 1);
      const candidate = clampToMonth(`${nextMonth}-01`, anchorDay);
      return candidate > from
        ? candidate
        : clampToMonth(`${addMonths(nextMonth, 1)}-01`, anchorDay);
    }
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function clampToMonth(firstOfMonth: string, day: number): string {
  const last = Number(endOfMonth(firstOfMonth).slice(8, 10));
  return `${firstOfMonth.slice(0, 8)}${pad2(Math.min(Math.max(day, 1), last))}`;
}

/**
 * The schedule-config rules every series must satisfy, shared by series
 * creation and the family-export importer (which restores series verbatim
 * and so must reject configs the service itself would never accept — an
 * out-of-range weekly weekday, for instance, would wedge nextOccurrence).
 */
export function validateSeriesConfig(frequency: Frequency, config: SeriesConfig): void {
  switch (frequency) {
    case "monthly":
      if (
        !Number.isInteger(config.dayOfMonth) ||
        config.dayOfMonth! < 1 ||
        config.dayOfMonth! > 31
      ) {
        throw errors.validation("Monthly series require a day of month (1-31).");
      }
      break;
    case "weekly":
      if (!Number.isInteger(config.weekday) || config.weekday! < 0 || config.weekday! > 6) {
        throw errors.validation("Weekly series require a weekday (0-6).");
      }
      break;
    case "yearly":
      if (
        !Number.isInteger(config.month) ||
        config.month! < 1 ||
        config.month! > 12 ||
        !Number.isInteger(config.day) ||
        config.day! < 1 ||
        config.day! > 31
      ) {
        throw errors.validation("Yearly series require a month (1-12) and day (1-31).");
      }
      break;
    default:
      throw errors.validation("Unsupported frequency.");
  }
}

function validateInput(input: RecurringSeriesInput): void {
  const name = input.name.trim();
  if (!name) throw errors.validation("A name is required.");
  if (name.length > MAX_NAME_LENGTH) throw errors.validation("Name is too long.");
  if (input.amountLedgerMinor === 0) throw errors.validation("Amount cannot be zero.");
  if (!isIsoDate(input.nextDue))
    throw errors.validation("Next due date must be in YYYY-MM-DD format.");
  validateSeriesConfig(input.frequency, input.config);
}

async function assertAccountAndCategory(
  exec: Executor,
  actor: Actor,
  accountId: string,
  categoryId: string | null
): Promise<typeof accounts.$inferSelect> {
  const { account } = await assertAccountOpen(exec, actor, accountId, "manage");
  if (categoryId) {
    const [category] = await exec
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, categoryId), eq(categories.familyId, actor.familyId)))
      .limit(1);
    if (!category) throw errors.validation("Unknown category.");
  }
  return account;
}

async function requireSeriesManage(exec: Executor, actor: Actor, seriesId: string) {
  const [existing] = await exec
    .select()
    .from(recurringSeries)
    .where(and(eq(recurringSeries.id, seriesId), eq(recurringSeries.familyId, actor.familyId)))
    .limit(1);
  if (!existing) throw errors.notFound("Recurring series");
  await assertAccountAccess(exec, actor, existing.accountId, "manage");
  return existing;
}

export async function createSeries(
  exec: Executor,
  actor: Actor,
  input: RecurringSeriesInput
): Promise<string> {
  validateInput(input);
  const account = await assertAccountAndCategory(
    exec,
    actor,
    input.accountId,
    input.categoryId ?? null
  );

  const [row] = await exec
    .insert(recurringSeries)
    .values({
      familyId: actor.familyId,
      accountId: account.id,
      createdBy: actor.userId,
      name: input.name.trim(),
      merchant: input.merchant?.trim() || null,
      amountMinor: input.amountLedgerMinor,
      currency: account.currency,
      categoryId: input.categoryId ?? null,
      frequency: input.frequency,
      config: input.config,
      nextDue: input.nextDue
    })
    .returning({ id: recurringSeries.id });
  const id = row?.id;
  if (!id) throw errors.conflict("Failed to create series.");

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "recurring.created",
    entityType: "recurring_series",
    entityId: id
  });
  return id;
}

export async function updateSeries(
  exec: Executor,
  actor: Actor,
  seriesId: string,
  patch: Partial<RecurringSeriesInput> & { active?: boolean }
): Promise<void> {
  await exec.transaction(async (tx) => {
    const existing = await requireSeriesManage(tx, actor, seriesId);

    let targetAccount: typeof accounts.$inferSelect | null = null;
    if (patch.accountId && patch.accountId !== existing.accountId) {
      targetAccount = await assertAccountAndCategory(
        tx,
        actor,
        patch.accountId,
        patch.categoryId !== undefined ? patch.categoryId : existing.categoryId
      );
      if (targetAccount.currency !== existing.currency) {
        throw errors.validation(
          "Cannot move recurring series across accounts with different currencies."
        );
      }
    } else if (patch.categoryId !== undefined && patch.categoryId !== null) {
      await assertAccountAndCategory(tx, actor, existing.accountId, patch.categoryId);
    }

    const merged: RecurringSeriesInput = {
      accountId: patch.accountId ?? existing.accountId,
      name: patch.name ?? existing.name,
      merchant: patch.merchant !== undefined ? patch.merchant : existing.merchant,
      amountLedgerMinor: patch.amountLedgerMinor ?? existing.amountMinor,
      categoryId: patch.categoryId !== undefined ? patch.categoryId : existing.categoryId,
      frequency: (patch.frequency ?? existing.frequency) as Frequency,
      config: patch.config ?? (existing.config as SeriesConfig),
      nextDue: patch.nextDue ?? existing.nextDue
    };
    validateInput(merged);

    await tx
      .update(recurringSeries)
      .set({
        accountId: merged.accountId,
        name: merged.name.trim(),
        merchant: merged.merchant?.trim() || null,
        amountMinor: merged.amountLedgerMinor,
        currency: targetAccount ? targetAccount.currency : existing.currency,
        categoryId: merged.categoryId ?? null,
        frequency: merged.frequency,
        config: merged.config,
        nextDue: merged.nextDue,
        active: patch.active ?? existing.active,
        updatedAt: new Date()
      })
      .where(eq(recurringSeries.id, seriesId));

    await recordAudit(tx, {
      familyId: actor.familyId,
      actorUserId: actor.userId,
      action: "recurring.updated",
      entityType: "recurring_series",
      entityId: seriesId
    });
  });
}

export async function deleteSeries(exec: Executor, actor: Actor, seriesId: string): Promise<void> {
  await requireSeriesManage(exec, actor, seriesId);
  const deleted = await exec
    .delete(recurringSeries)
    .where(and(eq(recurringSeries.id, seriesId), eq(recurringSeries.familyId, actor.familyId)))
    .returning({ id: recurringSeries.id });
  if (deleted.length === 0) throw errors.notFound("Recurring series");
  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "recurring.deleted",
    entityType: "recurring_series",
    entityId: seriesId
  });
}

export async function setSeriesActive(
  exec: Executor,
  actor: Actor,
  seriesId: string,
  active: boolean
): Promise<void> {
  await requireSeriesManage(exec, actor, seriesId);
  await exec
    .update(recurringSeries)
    .set({ active, updatedAt: new Date() })
    .where(and(eq(recurringSeries.id, seriesId), eq(recurringSeries.familyId, actor.familyId)));
  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "recurring.updated",
    entityType: "recurring_series",
    entityId: seriesId,
    metadata: { active }
  });
}

export async function skipNextOccurrence(
  exec: Executor,
  actor: Actor,
  seriesId: string
): Promise<string> {
  const existing = await requireSeriesManage(exec, actor, seriesId);
  const skipped = nextOccurrence(
    existing.frequency as Frequency,
    existing.config as SeriesConfig,
    existing.nextDue
  );
  await exec
    .update(recurringSeries)
    .set({ nextDue: skipped, updatedAt: new Date() })
    .where(eq(recurringSeries.id, seriesId));
  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "recurring.updated",
    entityType: "recurring_series",
    entityId: seriesId,
    metadata: { skippedTo: skipped }
  });
  return skipped;
}

export async function listSeries(exec: Executor, actor: Actor) {
  const accountIds = await accessibleAccountIds(exec, actor);
  if (accountIds.length === 0) return [];
  // Chunk the IN(...) list: cloud SQLite caps a statement at 100 parameters.
  const series = [];
  for (const chunk of chunkParams(accountIds)) {
    const rows = await exec
      .select({
        id: recurringSeries.id,
        accountId: recurringSeries.accountId,
        accountName: accounts.name,
        name: recurringSeries.name,
        merchant: recurringSeries.merchant,
        amountMinor: recurringSeries.amountMinor,
        currency: recurringSeries.currency,
        categoryId: recurringSeries.categoryId,
        frequency: recurringSeries.frequency,
        config: recurringSeries.config,
        nextDue: recurringSeries.nextDue,
        active: recurringSeries.active,
        accountStatus: accounts.status
      })
      .from(recurringSeries)
      .innerJoin(accounts, eq(accounts.id, recurringSeries.accountId))
      .where(
        and(eq(recurringSeries.familyId, actor.familyId), inArray(recurringSeries.accountId, chunk))
      )
      .orderBy(asc(recurringSeries.nextDue));
    series.push(...rows);
  }
  series.sort((a, b) => (a.nextDue < b.nextDue ? -1 : a.nextDue > b.nextDue ? 1 : 0));
  return series;
}

export type PostResult = { posted: number; paused: number; failed: number };

/**
 * Upper bound on occurrences posted for a single series in one run. A series
 * that fell far behind (worker down for months, daily-equivalent backlog on a
 * weekly series, bad config) catches up over successive runs instead of
 * monopolising one job; next_due is left at the first unposted occurrence, so
 * the next run resumes exactly where this one stopped.
 */
export const MAX_CATCHUP_OCCURRENCES_PER_RUN = 100;

/**
 * Posts every active series whose next_due has arrived (or was missed while the
 * worker was down). Each occurrence is written with externalSource="recurring" and
 * a deterministic externalId, so the entries_external_dedupe unique index makes
 * re-runs idempotent.
 *
 * Occurrence creation, schedule advancement, and balance-repair intent are
 * atomic: the entry insert, its transaction row, the next_due advance to the
 * following occurrence, AND a `maintenance:balances` repair job for the
 * account (deduped per account while pending) commit in ONE transaction per
 * occurrence. A crash between occurrences leaves next_due pointing at the
 * first unposted occurrence, so a retry resumes there (and the dedupe index
 * absorbs any occurrence a previous code path committed without advancing the
 * schedule) — and a repair job is already pending for every committed
 * occurrence, whether the worker dies, the immediate recalculation fails,
 * or a later occurrence fails.
 *
 * A later occurrence failure does not skip the recalculation / repair for
 * occurrences that already committed: the failure is remembered, the
 * committed occurrences are recalculated immediately, and only then is the
 * series counted as failed (so runRecurringPost still propagates the failure
 * and the queue retries the series from the first unposted occurrence).
 * The repair job is retryable even once the series is no longer due: the
 * `maintenance:balances` handler rebuilds every active account
 * independently of series due state.
 *
 * After a series posts, its account balances are recalculated. If that
 * recalculation fails, the repair enqueue is retried as a fallback (the
 * in-transaction job already covers it) and the failure propagates to the
 * caller (see the queue handler) so the recurring job is retried /
 * dead-lettered instead of marked successful.
 *
 * Each series is judged against its own family's timezone, so a series due on
 * "the 1st" posts when it is the 1st for that family, not for the worker.
 */
export async function postDueSeries(exec: Executor, now = new Date()): Promise<PostResult> {
  const result: PostResult = { posted: 0, paused: 0, failed: 0 };

  // UTC date + 1 covers the furthest-ahead timezone (UTC+14) on any given run.
  const utcToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Etc/UTC", ...DATE_FMT }).format(
    now
  );
  const horizon = addDays(utcToday, 1);

  const due = await exec
    .select({
      series: recurringSeries,
      account: accounts,
      familyTimezone: families.timezone
    })
    .from(recurringSeries)
    .innerJoin(accounts, eq(accounts.id, recurringSeries.accountId))
    .innerJoin(families, eq(families.id, recurringSeries.familyId))
    .where(sql`${recurringSeries.active} AND ${recurringSeries.nextDue} <= ${horizon}`)
    .orderBy(asc(recurringSeries.nextDue));

  for (const { series, account, familyTimezone } of due) {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: familyTimezone,
      ...DATE_FMT
    }).format(now);

    if (account.status !== "active") {
      await exec
        .update(recurringSeries)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(recurringSeries.id, series.id));
      await captureDebugLog(exec, {
        category: "recurring",
        level: "warn",
        message: "Recurring series paused because its account is no longer active",
        source: "worker",
        familyId: series.familyId,
        accountId: series.accountId,
        metadata: { seriesId: series.id, seriesName: series.name }
      });
      result.paused++;
      continue;
    }

    if (series.nextDue > today) continue;

    try {
      let occurrence = series.nextDue;
      let processed = 0;
      // A later occurrence can fail after earlier ones committed. Remember
      // the failure instead of aborting: the committed occurrences already
      // carry their repair intent (enqueued in-transaction below), and their
      // balances still need the immediate recalculation.
      let postError: unknown = null;
      try {
        // Catch-up loop: advance until past today, posting each missed
        // occurrence in its own transaction (bounded per run, see
        // MAX_CATCHUP_OCCURRENCES_PER_RUN).
        while (occurrence <= today && processed < MAX_CATCHUP_OCCURRENCES_PER_RUN) {
          const externalId = `${series.id}:${occurrence}`;
          const following = nextOccurrence(
            series.frequency as Frequency,
            series.config as SeriesConfig,
            occurrence
          );
          await exec.transaction(async (tx) => {
            const [entry] = await tx
              .insert(entries)
              .values({
                accountId: series.accountId,
                recurringSeriesId: series.id,
                date: occurrence,
                amountMinor: series.amountMinor,
                currency: series.currency,
                name: series.name,
                externalSource: "recurring",
                externalId,
                entryableType: "transaction"
              })
              .onConflictDoNothing()
              .returning({ id: entries.id });
            const entryId = entry?.id;
            if (entryId) {
              await tx.insert(transactions).values({
                entryId,
                categoryId: series.categoryId,
                merchant: series.merchant
              });
            }
            // Advance the schedule in the SAME transaction as the insert. On a
            // dedupe hit (a legacy / interrupted run already committed this
            // occurrence) entryId is undefined, but the advance still commits
            // atomically, so progress is never lost or replayed.
            await tx
              .update(recurringSeries)
              .set({
                nextDue: following,
                ...(entryId ? { lastPostedEntryId: entryId } : {}),
                updatedAt: new Date()
              })
              .where(eq(recurringSeries.id, series.id));
            // Commit the repair intent WITH the occurrence: a pending
            // maintenance:balances job for this account now exists before
            // anything outside this transaction can fail. The dedupe key
            // collapses repeats while a job is pending, so posting several
            // occurrences leaves a single repair job.
            await enqueue(
              tx,
              "maintenance:balances",
              {},
              {
                dedupeKey: `balance-repair:${series.accountId}`
              }
            );
          });
          processed++;
          occurrence = following;
        }
      } catch (e) {
        postError = e;
      }

      if (processed >= MAX_CATCHUP_OCCURRENCES_PER_RUN && occurrence <= today) {
        await captureDebugLog(exec, {
          category: "recurring",
          level: "warn",
          message:
            "Recurring catch-up hit the per-run occurrence bound; remainder deferred to next run",
          source: "worker",
          familyId: series.familyId,
          accountId: series.accountId,
          metadata: { seriesId: series.id, seriesName: series.name, nextDue: occurrence }
        });
      }

      if (processed > 0) {
        try {
          await recalculateAccount(exec, series.accountId);
        } catch (recalcError) {
          // Repair intent is already durable (enqueued in-transaction with
          // each committed occurrence); retry the enqueue as a fallback in
          // case a future code path posts without it, then surface the
          // failure so the queue retries / dead-letters this job.
          try {
            await enqueue(
              exec,
              "maintenance:balances",
              {},
              {
                dedupeKey: `balance-repair:${series.accountId}`
              }
            );
          } catch {
            // The in-transaction repair job already covers this account.
          }
          throw recalcError;
        }
        if (!postError) result.posted++;
      }
      // A partially posted series still failed: the retry resumes from the
      // first unposted occurrence (next_due was left there by the failed
      // transaction's rollback).
      if (postError) throw postError;
    } catch (e) {
      result.failed++;
      await captureDebugLog(exec, {
        category: "recurring",
        level: "error",
        message: "Failed to post recurring series",
        source: "worker",
        familyId: series.familyId,
        accountId: series.accountId,
        metadata: {
          seriesId: series.id,
          seriesName: series.name,
          error: e instanceof Error ? e.message : String(e)
        }
      });
    }
  }

  return result;
}

const DATE_FMT = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
