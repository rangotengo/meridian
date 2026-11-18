import { describe, it, expect, beforeAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db, makeUser, makeAccount, addTxn, truncateAll, daysAgo, actorOf } from "../helpers";
import { currentFamily } from "@/server/auth/context";
import { budgets } from "@/server/db/schema";
import * as budgetsSvc from "@/server/domain/budgets";
import * as categoriesSvc from "@/server/domain/categories";
import { monthKeyIn, addMonths } from "@/lib/datetime";

beforeAll(async () => {
  await truncateAll();
});

function prevMonthKey(): string {
  return addMonths(monthKeyIn("Etc/UTC"), -1);
}

/**
 * Inserts a budget row as if it had existed since last month: the
 * rollover credit is measured against last month's end-of-month limit,
 * so the row's createdAt must predate last month's end.
 */
async function insertBackdatedBudget(
  familyId: string,
  categoryId: string | null,
  amountMinor: number,
  rollover: boolean
): Promise<void> {
  const prevMk = prevMonthKey();
  const at = new Date(`${prevMk}-15T00:00:00Z`);
  await db().insert(budgets).values({
    familyId,
    categoryId,
    amountMinor,
    rollover,
    active: true,
    createdAt: at,
    updatedAt: at
  });
}

describe("budgets — rollover", () => {
  it("carries last month's unspent into this month's effective limit", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const accountId = await makeAccount(user);
    const { categoryId } = await categoriesSvc.createCategory(db(), actor, { name: "Food" });
    const prevMk = prevMonthKey();

    await addTxn(user, accountId, {
      amountLedgerMinor: 60_000,
      date: `${prevMk}-15`,
      categoryId,
      name: "Last month groceries"
    });
    await insertBackdatedBudget(family.id, categoryId, 100_000, true);

    const overview = await budgetsSvc.budgetOverview(db(), family, user.userId);
    const food = overview.perCategory.find((b) => b.categoryId === categoryId)!;
    expect(food).toMatchObject({
      limitMinor: 100_000,
      rollover: true,
      rolloverCreditMinor: 40_000,
      effectiveLimitMinor: 140_000,
      spentMinor: 0,
      pct: 0,
      alert: "ok"
    });
  });

  it("rolls nothing when last month was overspent", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const accountId = await makeAccount(user);
    const { categoryId } = await categoriesSvc.createCategory(db(), actor, { name: "Food" });
    const prevMk = prevMonthKey();

    await addTxn(user, accountId, {
      amountLedgerMinor: 120_000,
      date: `${prevMk}-15`,
      categoryId,
      name: "Last month blowout"
    });
    await insertBackdatedBudget(family.id, categoryId, 100_000, true);

    const overview = await budgetsSvc.budgetOverview(db(), family, user.userId);
    const food = overview.perCategory.find((b) => b.categoryId === categoryId)!;
    expect(food.rolloverCreditMinor).toBe(0);
    expect(food.effectiveLimitMinor).toBe(100_000);
  });

  it("rolls nothing when rollover is off, even with unspent last month", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const accountId = await makeAccount(user);
    const { categoryId } = await categoriesSvc.createCategory(db(), actor, { name: "Food" });
    const prevMk = prevMonthKey();

    await addTxn(user, accountId, {
      amountLedgerMinor: 60_000,
      date: `${prevMk}-15`,
      categoryId,
      name: "Last month groceries"
    });
    await insertBackdatedBudget(family.id, categoryId, 100_000, false);

    const overview = await budgetsSvc.budgetOverview(db(), family, user.userId);
    const food = overview.perCategory.find((b) => b.categoryId === categoryId)!;
    expect(food.rollover).toBe(false);
    expect(food.rolloverCreditMinor).toBe(0);
  });

  it("switching rollover off removes the credit for the current month", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const accountId = await makeAccount(user);
    const { categoryId } = await categoriesSvc.createCategory(db(), actor, { name: "Food" });
    const prevMk = prevMonthKey();

    await addTxn(user, accountId, {
      amountLedgerMinor: 60_000,
      date: `${prevMk}-15`,
      categoryId,
      name: "Last month groceries"
    });
    await insertBackdatedBudget(family.id, categoryId, 100_000, true);

    let overview = await budgetsSvc.budgetOverview(db(), family, user.userId);
    expect(overview.perCategory.find((b) => b.categoryId === categoryId)!.rolloverCreditMinor).toBe(
      40_000
    );

    await budgetsSvc.setBudgetRollover(db(), actor, categoryId, false);
    overview = await budgetsSvc.budgetOverview(db(), family, user.userId);
    const food = overview.perCategory.find((b) => b.categoryId === categoryId)!;
    expect(food.rollover).toBe(false);
    expect(food.rolloverCreditMinor).toBe(0);
    expect(food.effectiveLimitMinor).toBe(100_000);
  });

  it("editing the limit keeps the rollover toggle", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const { categoryId } = await categoriesSvc.createCategory(db(), actor, { name: "Food" });

    await budgetsSvc.setBudget(db(), actor, {
      categoryId,
      amountLedgerMinor: 100_000,
      rollover: true
    });
    await budgetsSvc.setBudget(db(), actor, { categoryId, amountLedgerMinor: 80_000 });

    const overview = await budgetsSvc.budgetOverview(db(), family, user.userId);
    const food = overview.perCategory.find((b) => b.categoryId === categoryId)!;
    expect(food.limitMinor).toBe(80_000);
    expect(food.rollover).toBe(true);
  });

  it("toggling rollover on a missing budget is a not-found error", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const { categoryId } = await categoriesSvc.createCategory(db(), actor, { name: "Food" });
    await expect(budgetsSvc.setBudgetRollover(db(), actor, categoryId, true)).rejects.toThrow(
      "Budget"
    );
  });
});

describe("budgets — alerts and monthly summary", () => {
  it("warns at 80%, flags over at 100%, and summarises the month", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const accountId = await makeAccount(user);
    const a = await categoriesSvc.createCategory(db(), actor, { name: "A" });
    const b = await categoriesSvc.createCategory(db(), actor, { name: "B" });
    const c = await categoriesSvc.createCategory(db(), actor, { name: "C" });

    await budgetsSvc.setBudget(db(), actor, {
      categoryId: a.categoryId,
      amountLedgerMinor: 10_000
    });
    await budgetsSvc.setBudget(db(), actor, {
      categoryId: b.categoryId,
      amountLedgerMinor: 10_000
    });
    await budgetsSvc.setBudget(db(), actor, {
      categoryId: c.categoryId,
      amountLedgerMinor: 10_000
    });

    await addTxn(user, accountId, {
      amountLedgerMinor: 8_500,
      date: daysAgo(0),
      categoryId: a.categoryId
    });
    await addTxn(user, accountId, {
      amountLedgerMinor: 12_000,
      date: daysAgo(0),
      categoryId: b.categoryId
    });
    await addTxn(user, accountId, {
      amountLedgerMinor: 1_000,
      date: daysAgo(0),
      categoryId: c.categoryId
    });

    const overview = await budgetsSvc.budgetOverview(db(), family, user.userId);
    const byId = new Map(overview.perCategory.map((p) => [p.categoryId, p]));
    expect(byId.get(a.categoryId)).toMatchObject({ pct: 0.85, alert: "warning" });
    expect(byId.get(b.categoryId)).toMatchObject({ pct: 1.2, alert: "over" });
    expect(byId.get(c.categoryId)).toMatchObject({ pct: 0.1, alert: "ok" });
    expect(overview.summary).toMatchObject({
      totalBaseMinor: 30_000,
      totalEffectiveMinor: 30_000,
      totalSpentMinor: 21_500,
      totalRemainingMinor: 8_500,
      overCount: 1,
      warningCount: 1,
      onTrackCount: 1
    });
  });
});

describe("budgets — removed budgets stay removed", () => {
  /**
   * Regression: setBudget used to deactivate ALL rows for the category and
   * rewrite every row's updatedAt, so recreating a budget in December moved
   * the removed October budget's end date to December and limitActiveAt
   * suddenly counted it as active at Nov 30 — phantom rollover. The
   * sequence runs through the real service (setBudget / removeBudget);
   * only row timestamps are staged with SQL, because createdAt comes from
   * the database default and the service stamps updatedAt from `new
   * Date()` (faked here with vitest).
   */
  it("recreating a removed budget earns no rollover from the removed months", async () => {
    const user = await makeUser({ currency: "NPR", timezone: "UTC" });
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const { categoryId } = await categoriesSvc.createCategory(db(), actor, { name: "Food" });

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Oct 1: create the budget.
      vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
      await budgetsSvc.setBudget(db(), actor, {
        categoryId,
        amountLedgerMinor: 100_000,
        rollover: true
      });
      await db().execute(sql`
        UPDATE budgets SET created_at = '2026-10-01', updated_at = '2026-10-01'
        WHERE family_id = ${family.id}::uuid AND category_id = ${categoryId}::uuid
      `);

      // Nov 15: remove it.
      vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
      await budgetsSvc.removeBudget(db(), actor, categoryId);

      // Dec 5: recreate it.
      vi.setSystemTime(new Date("2026-12-05T12:00:00Z"));
      await budgetsSvc.setBudget(db(), actor, {
        categoryId,
        amountLedgerMinor: 100_000,
        rollover: true
      });
      await db().execute(sql`
        UPDATE budgets SET created_at = '2026-12-05', updated_at = '2026-12-05'
        WHERE family_id = ${family.id}::uuid AND category_id = ${categoryId}::uuid AND active = true
      `);

      const res = await db().execute<{
        category_id: string | null;
        amount_minor: string;
        active: boolean;
        created_at: Date;
        updated_at: Date;
      }>(sql`
        SELECT category_id, amount_minor::text AS amount_minor, active, created_at, updated_at
        FROM budgets WHERE family_id = ${family.id}::uuid
      `);
      const history = (res.rows ?? []).map((r) => ({
        categoryId: r.category_id,
        amountMinor: Number(r.amount_minor),
        active: r.active,
        createdAt: new Date(r.created_at),
        updatedAt: new Date(r.updated_at)
      }));
      // At Nov 30 the budget was removed (Nov 15) and not yet recreated
      // (Dec 5): no limit existed then.
      expect(budgetsSvc.limitActiveAt(history, categoryId, "2026-11-30")).toBeNull();

      // End to end: the December overview earns no rollover credit from
      // the removed November budget.
      const overview = await budgetsSvc.budgetOverview(db(), family, user.userId);
      const food = overview.perCategory.find((b) => b.categoryId === categoryId)!;
      expect(food.rolloverCreditMinor).toBe(0);
      expect(food.effectiveLimitMinor).toBe(100_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("merges last month's FX gaps into the overview completeness", async () => {
    const user = await makeUser({ currency: "NPR", timezone: "UTC" });
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const { categoryId } = await categoriesSvc.createCategory(db(), actor, { name: "Food" });
    const prevMk = prevMonthKey();

    // Last month's only spending is in CAD, which has no NPR rate; this
    // month has no foreign spending at all, so the current month's own
    // completeness is clean and only the merged last-month gaps can flag.
    const cad = await makeAccount(user, { currency: "CAD" });
    await addTxn(user, cad, {
      amountLedgerMinor: 4000,
      date: `${prevMk}-15`,
      categoryId,
      name: "Last month CAD groceries"
    });
    await insertBackdatedBudget(family.id, categoryId, 100_000, true);

    const overview = await budgetsSvc.budgetOverview(db(), family, user.userId);
    expect(overview.fx.incompleteFx).toBe(true);
    expect(overview.fx.fxIssues).toContainEqual(
      expect.objectContaining({ base: "CAD", quote: "NPR" })
    );
  });
});
