import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { budgets, categories } from "../db/schema";
import type { Actor, Family } from "../auth/context";
import { recordAudit } from "../observability/audit";
import { spendingByCategory, currentMonthRange, type FxCompleteness } from "./reports";
import { errors } from "@/lib/errors";
import { monthKeyIn } from "@/lib/datetime";

export type BudgetRow = typeof budgets.$inferSelect;

export async function setBudget(
  exec: Executor,
  actor: Actor,
  input: { categoryId: string | null; amountLedgerMinor: number }
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

  await exec.transaction(async (tx) => {
    await tx
      .update(budgets)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          eq(budgets.familyId, actor.familyId),
          input.categoryId === null
            ? sql`${budgets.categoryId} IS NULL`
            : eq(budgets.categoryId, input.categoryId)
        )
      );
    await tx.insert(budgets).values({
      familyId: actor.familyId,
      categoryId: input.categoryId,
      amountMinor: input.amountLedgerMinor,
      active: true
    });
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "budget.set",
    entityType: input.categoryId ? "category" : "family",
    entityId: input.categoryId ?? actor.familyId,
    metadata: { amountLedgerMinor: input.amountLedgerMinor }
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
  limitMinor: number;
  spentMinor: number;
  remainingMinor: number;
  pct: number;
};

export type BudgetOverview = {
  monthKey: string;
  overall: BudgetProgress | null;
  perCategory: BudgetProgress[];
  categoriesWithoutBudget: { id: string; name: string }[];
  /** FX completeness of the underlying spending totals (see reports.ts). */
  fx: FxCompleteness;
};

export async function budgetOverview(
  exec: Executor,
  family: Family,
  userId: string
): Promise<BudgetOverview> {
  const mk = monthKeyIn(family.timezone);
  const range = currentMonthRange(family.timezone);

  const [budgetRows, spending, allCategories] = await Promise.all([
    exec
      .select({
        categoryId: budgets.categoryId,
        amountMinor: budgets.amountMinor,
        categoryName: categories.name
      })
      .from(budgets)
      .leftJoin(categories, eq(categories.id, budgets.categoryId))
      .where(and(eq(budgets.familyId, family.id), eq(budgets.active, true))),
    spendingByCategory(exec, family, userId, range),
    exec
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.familyId, family.id))
  ]);

  const spentByCategory = new Map(
    spending.categories.map((s) => [s.categoryId ?? "uncategorized", s.totalMinor])
  );
  const totalSpent = spending.categories.reduce((acc, s) => acc + s.totalMinor, 0);

  const perCategory: BudgetProgress[] = [];
  let overall: BudgetProgress | null = null;
  const budgetedCategoryIds = new Set<string>();

  for (const row of budgetRows) {
    const progress = toProgress(
      row.categoryId,
      row.categoryName ?? "Overall",
      row.amountMinor,
      row.categoryId ? (spentByCategory.get(row.categoryId) ?? 0) : totalSpent
    );
    if (row.categoryId === null) {
      overall = progress;
    } else {
      budgetedCategoryIds.add(row.categoryId);
      perCategory.push(progress);
    }
  }

  perCategory.sort((a, b) => b.pct - a.pct);

  return {
    monthKey: mk,
    overall,
    perCategory,
    categoriesWithoutBudget: allCategories
      .filter((c) => !budgetedCategoryIds.has(c.id))
      .map((c) => ({ id: c.id, name: c.name })),
    fx: spending.fx
  };
}

function toProgress(
  categoryId: string | null,
  categoryName: string,
  limitMinor: number,
  spentMinor: number
): BudgetProgress {
  return {
    categoryId,
    categoryName,
    limitMinor,
    spentMinor,
    remainingMinor: limitMinor - spentMinor,
    pct: limitMinor > 0 ? spentMinor / limitMinor : 0
  };
}
