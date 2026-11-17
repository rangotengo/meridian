import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { budgets, categories } from "../db/schema";
import type { Actor, Family } from "../auth/context";
import { recordAudit } from "../observability/audit";
import {
  spendingByCategory,
  currentMonthRange,
  monthRangeOf,
  type FxCompleteness
} from "./reports";
import { errors } from "@/lib/errors";
import { monthKeyIn, addMonths } from "@/lib/datetime";

export type BudgetRow = typeof budgets.$inferSelect;

export type BudgetAlert = "ok" | "warning" | "over";

/** Pure: alert level for a budget at this share of its effective limit. */
export function budgetAlertLevel(pct: number): BudgetAlert {
  if (pct >= 1) return "over";
  if (pct >= 0.8) return "warning";
  return "ok";
}

/**
 * Pure: the unspent amount that rolls into this month from last month.
 *
 * Rollover semantics (documented in the UI and the PR):
 * - Only the immediately previous month's unspent rolls; credit never
 *   compounds across months, and overspending last month rolls nothing.
 * - The credit is measured against last month's end-of-month limit, not
 *   the current limit, so changing this month's limit does not rewrite
 *   what was earned last month.
 * - Switching rollover off removes the credit for the current month
 *   immediately; last month's unspent is not banked anywhere.
 */
export function rolloverCredit(
  lastMonthLimitMinor: number | null,
  lastMonthSpentMinor: number
): number {
  if (lastMonthLimitMinor === null) return 0;
  return Math.max(0, lastMonthLimitMinor - lastMonthSpentMinor);
}

type BudgetHistoryRow = {
  categoryId: string | null;
  amountMinor: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Pure: the budget amount that was active at the end of a month, from the
 * budget's row history. A row was active at `asOf` (a YYYY-MM-DD date)
 * when it was created on or before that date and either still active or
 * deactivated after it. Returns null when no budget existed then — for
 * example the budget was created this month.
 */
export function limitActiveAt(
  rows: BudgetHistoryRow[],
  categoryId: string | null,
  asOf: string
): number | null {
  const candidates = rows.filter(
    (r) =>
      (r.categoryId ?? null) === (categoryId ?? null) &&
      r.createdAt.toISOString().slice(0, 10) <= asOf &&
      (r.active || r.updatedAt.toISOString().slice(0, 10) > asOf)
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return candidates[0]!.amountMinor;
}

function categoryMatch(categoryId: string | null) {
  return categoryId === null
    ? sql`${budgets.categoryId} IS NULL`
    : eq(budgets.categoryId, categoryId);
}

export async function setBudget(
  exec: Executor,
  actor: Actor,
  input: { categoryId: string | null; amountLedgerMinor: number; rollover?: boolean }
): Promise<void> {
  if (input.amountLedgerMinor <= 0) throw errors.validation("Budget amount must be positive.");

  if (input.categoryId) {
    const [category] = await exec
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, input.categoryId), eq(categories.familyId, actor.familyId)))
      .limit(1);
    if (!category) throw errors.validation("Unknown category.");
  }

  // When the caller does not say, keep the current toggle, so editing the
  // limit does not silently switch rollover off.
  const [current] = await exec
    .select({ rollover: budgets.rollover })
    .from(budgets)
    .where(
      and(
        eq(budgets.familyId, actor.familyId),
        categoryMatch(input.categoryId),
        eq(budgets.active, true)
      )
    )
    .limit(1);
  const rollover = input.rollover ?? current?.rollover ?? false;

  await exec.transaction(async (tx) => {
    await tx
      .update(budgets)
      .set({ active: false, updatedAt: new Date() })
      .where(and(eq(budgets.familyId, actor.familyId), categoryMatch(input.categoryId)));
    await tx.insert(budgets).values({
      familyId: actor.familyId,
      categoryId: input.categoryId,
      amountMinor: input.amountLedgerMinor,
      rollover,
      active: true
    });
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "budget.set",
    entityType: input.categoryId ? "category" : "family",
    entityId: input.categoryId ?? actor.familyId,
    metadata: { amountLedgerMinor: input.amountLedgerMinor, rollover }
  });
}

/**
 * Toggles rollover for one budget without changing its limit. Implemented
 * as deactivate + insert with the same amount, like a limit change, so the
 * toggle change is part of the budget's row history (and the end-of-month
 * limit reconstruction in limitActiveAt still sees the old row).
 */
export async function setBudgetRollover(
  exec: Executor,
  actor: Actor,
  categoryId: string | null,
  rollover: boolean
): Promise<void> {
  const [current] = await exec
    .select()
    .from(budgets)
    .where(
      and(eq(budgets.familyId, actor.familyId), categoryMatch(categoryId), eq(budgets.active, true))
    )
    .limit(1);
  if (!current) throw errors.notFound("Budget");
  if (current.rollover === rollover) return;

  await exec.transaction(async (tx) => {
    await tx
      .update(budgets)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(budgets.id, current.id));
    await tx.insert(budgets).values({
      familyId: actor.familyId,
      categoryId,
      amountMinor: current.amountMinor,
      rollover,
      active: true
    });
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "budget.rollover",
    entityType: categoryId ? "category" : "family",
    entityId: categoryId ?? actor.familyId,
    metadata: { rollover }
  });
}

export async function removeBudget(
  exec: Executor,
  actor: Actor,
  categoryId: string | null
): Promise<void> {
  const removed = await exec
    .update(budgets)
    .set({ active: false, updatedAt: new Date() })
    .where(
      and(
        eq(budgets.familyId, actor.familyId),
        categoryId === null
          ? sql`${budgets.categoryId} IS NULL`
          : eq(budgets.categoryId, categoryId)
      )
    )
    .returning({ id: budgets.id });
  if (removed.length === 0) throw errors.notFound("Budget");
  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "budget.removed",
    entityType: categoryId ? "category" : "family",
    entityId: categoryId ?? actor.familyId
  });
}

export type BudgetProgress = {
  categoryId: string | null;
  categoryName: string;
  /** Base monthly limit (before any rolled-over credit). */
  limitMinor: number;
  spentMinor: number;
  /** Remaining against the effective limit (base + rolled-over credit). */
  remainingMinor: number;
  /** Spent / effective limit. */
  pct: number;
  rollover: boolean;
  rolloverCreditMinor: number;
  /** Base limit + rolled-over credit. */
  effectiveLimitMinor: number;
  alert: BudgetAlert;
};

/**
 * Monthly summary across category budgets only. The overall cap is
 * excluded: it double-counts the same spending, so mixing it into these
 * totals would overstate both the budget and the spend.
 */
export type BudgetSummary = {
  totalBaseMinor: number;
  totalEffectiveMinor: number;
  totalSpentMinor: number;
  totalRemainingMinor: number;
  overCount: number;
  warningCount: number;
  onTrackCount: number;
};

export type BudgetOverview = {
  monthKey: string;
  overall: BudgetProgress | null;
  perCategory: BudgetProgress[];
  categoriesWithoutBudget: { id: string; name: string }[];
  summary: BudgetSummary;
  /** FX completeness of the underlying spending totals (see reports.ts). */
  fx: FxCompleteness;
};

export async function budgetOverview(
  exec: Executor,
  family: Family,
  userId: string,
  accountIds?: string[]
): Promise<BudgetOverview> {
  const mk = monthKeyIn(family.timezone);
  const range = currentMonthRange(family.timezone);
  const prevMk = addMonths(mk, -1);
  const prevRange = monthRangeOf(prevMk);

  const [budgetRows, spending, allCategories, historyRows] = await Promise.all([
    exec
      .select({
        categoryId: budgets.categoryId,
        amountMinor: budgets.amountMinor,
        rollover: budgets.rollover,
        categoryName: categories.name
      })
      .from(budgets)
      .leftJoin(categories, eq(categories.id, budgets.categoryId))
      .where(and(eq(budgets.familyId, family.id), eq(budgets.active, true))),
    spendingByCategory(exec, family, userId, range, accountIds),
    exec
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.familyId, family.id)),
    exec
      .select({
        categoryId: budgets.categoryId,
        amountMinor: budgets.amountMinor,
        active: budgets.active,
        createdAt: budgets.createdAt,
        updatedAt: budgets.updatedAt
      })
      .from(budgets)
      .where(eq(budgets.familyId, family.id))
  ]);

  // Last month's spending is only needed when at least one budget rolls over.
  const lastSpending = budgetRows.some((r) => r.rollover)
    ? await spendingByCategory(exec, family, userId, prevRange, accountIds)
    : null;
  const lastSpentByCategory = new Map(
    (lastSpending?.categories ?? []).map((s) => [s.categoryId ?? "uncategorized", s.totalMinor])
  );
  const lastTotalSpent = (lastSpending?.categories ?? []).reduce((acc, s) => acc + s.totalMinor, 0);

  const spentByCategory = new Map(
    spending.categories.map((s) => [s.categoryId ?? "uncategorized", s.totalMinor])
  );
  const totalSpent = spending.categories.reduce((acc, s) => acc + s.totalMinor, 0);

  const perCategory: BudgetProgress[] = [];
  let overall: BudgetProgress | null = null;
  const budgetedCategoryIds = new Set<string>();

  for (const row of budgetRows) {
    const spent = row.categoryId ? (spentByCategory.get(row.categoryId) ?? 0) : totalSpent;
    const lastSpent = row.categoryId
      ? (lastSpentByCategory.get(row.categoryId) ?? 0)
      : lastTotalSpent;
    const lastLimit = row.rollover
      ? limitActiveAt(historyRows, row.categoryId, prevRange.to)
      : null;
    const credit = row.rollover ? rolloverCredit(lastLimit, lastSpent) : 0;
    const progress = toProgress(
      row.categoryId,
      row.categoryName ?? "Overall",
      row.amountMinor,
      spent,
      row.rollover,
      credit
    );
    if (row.categoryId === null) {
      overall = progress;
    } else {
      budgetedCategoryIds.add(row.categoryId);
      perCategory.push(progress);
    }
  }

  perCategory.sort((a, b) => b.pct - a.pct);

  const summary: BudgetSummary = {
    totalBaseMinor: perCategory.reduce((acc, b) => acc + b.limitMinor, 0),
    totalEffectiveMinor: perCategory.reduce((acc, b) => acc + b.effectiveLimitMinor, 0),
    totalSpentMinor: perCategory.reduce((acc, b) => acc + b.spentMinor, 0),
    totalRemainingMinor: perCategory.reduce((acc, b) => acc + b.remainingMinor, 0),
    overCount: perCategory.filter((b) => b.alert === "over").length,
    warningCount: perCategory.filter((b) => b.alert === "warning").length,
    onTrackCount: perCategory.filter((b) => b.alert === "ok").length
  };

  return {
    monthKey: mk,
    overall,
    perCategory,
    categoriesWithoutBudget: allCategories
      .filter((c) => !budgetedCategoryIds.has(c.id))
      .map((c) => ({ id: c.id, name: c.name })),
    summary,
    fx: spending.fx
  };
}

function toProgress(
  categoryId: string | null,
  categoryName: string,
  limitMinor: number,
  spentMinor: number,
  rollover: boolean,
  rolloverCreditMinor: number
): BudgetProgress {
  const effectiveLimitMinor = limitMinor + rolloverCreditMinor;
  const pct = effectiveLimitMinor > 0 ? spentMinor / effectiveLimitMinor : 0;
  return {
    categoryId,
    categoryName,
    limitMinor,
    spentMinor,
    remainingMinor: effectiveLimitMinor - spentMinor,
    pct,
    rollover,
    rolloverCreditMinor,
    effectiveLimitMinor,
    alert: budgetAlertLevel(pct)
  };
}
