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

function validateInput(input: RecurringSeriesInput): void {
  const name = input.name.trim();
  if (!name) throw errors.validation("A name is required.");
  if (name.length > MAX_NAME_LENGTH) throw errors.validation("Name is too long.");
  if (input.amountLedgerMinor === 0) throw errors.validation("Amount cannot be zero.");
  if (!isIsoDate(input.nextDue))
    throw errors.validation("Next due date must be in YYYY-MM-DD format.");

  switch (input.frequency) {
    case "monthly":
      if (!input.config.dayOfMonth || input.config.dayOfMonth < 1 || input.config.dayOfMonth > 31) {
        throw errors.validation("Monthly series require a day of month (1-31).");
      }
      break;
    case "weekly":
      if (
        input.config.weekday === undefined ||
        input.config.weekday < 0 ||
        input.config.weekday > 6
      ) {
        throw errors.validation("Weekly series require a weekday (0-6).");
      }
      break;
    case "yearly":
      if (
        !input.config.month ||
        input.config.month < 1 ||
        input.config.month > 12 ||
        !input.config.day ||
        input.config.day < 1 ||
        input.config.day > 31
      ) {
        throw errors.validation("Yearly series require a month (1-12) and day (1-31).");
      }
      break;
    default:
      throw errors.validation("Unsupported frequency.");
  }
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
 * Posts every active series whose next_due has arrived (or was missed while the
 * worker was down). Each occurrence is written with externalSource="recurring" and
 * a deterministic externalId, so the entries_external_dedupe unique index makes
 * re-runs idempotent. next_due is advanced in the same transaction as the insert,
 * so a crash mid-run cannot double-post.
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
      let posted = false;
      let occurrence = series.nextDue;
      // Catch-up loop: advance until past today, posting each missed occurrence.
      while (occurrence <= today) {
        const externalId = `${series.id}:${occurrence}`;
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
            await tx
              .update(recurringSeries)
              .set({ lastPostedEntryId: entryId, updatedAt: new Date() })
              .where(eq(recurringSeries.id, series.id));
          }
        });
        posted = true;
        occurrence = nextOccurrence(
          series.frequency as Frequency,
          series.config as SeriesConfig,
          occurrence
        );
      }

      await exec
        .update(recurringSeries)
        .set({ nextDue: occurrence, updatedAt: new Date() })
        .where(eq(recurringSeries.id, series.id));

      if (posted) {
        await recalculateAccount(exec, series.accountId);
        result.posted++;
      }
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
