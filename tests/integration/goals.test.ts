import { describe, it, expect, beforeAll } from "vitest";
import { db, makeUser, makeAccount, addTxn, truncateAll, daysAgo, actorOf } from "../helpers";
import { currentFamily } from "@/server/auth/context";
import * as goalsSvc from "@/server/domain/goals";
import * as categoriesSvc from "@/server/domain/categories";
import * as accountsSvc from "@/server/domain/accounts";

beforeAll(async () => {
  await truncateAll();
});

function daysFromNow(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

describe("goals — account-linked progress", () => {
  it("tracks balance growth since creation and floors at zero", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const accountId = await makeAccount(user, { openingBalanceDisplayMinor: 100_000 });

    await goalsSvc.createGoal(db(), actor, family, {
      name: "Emergency fund",
      targetMinor: 50_000,
      accountId
    });

    // Income grows the balance; progress is the growth only.
    await addTxn(user, accountId, { amountLedgerMinor: -30_000, date: daysAgo(0) });
    let [goal] = await goalsSvc.listGoalsWithProgress(db(), actor, family);
    expect(goal).toMatchObject({
      name: "Emergency fund",
      targetMinor: 50_000,
      currency: "USD",
      linkType: "account",
      linkRemoved: false,
      progressMinor: 30_000,
      remainingMinor: 20_000,
      reached: false
    });
    expect(goal!.pct).toBeCloseTo(0.6);

    // Spending the balance back below the starting balance floors at zero.
    await addTxn(user, accountId, { amountLedgerMinor: 40_000, date: daysAgo(0) });
    [goal] = await goalsSvc.listGoalsWithProgress(db(), actor, family);
    expect(goal!.progressMinor).toBe(0);
    expect(goal!.pct).toBe(0);
    expect(goal!.remainingMinor).toBe(50_000);
  });

  it("reports link removed when the linked account is deleted", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const accountId = await makeAccount(user, { openingBalanceDisplayMinor: 10_000 });
    await goalsSvc.createGoal(db(), actor, family, {
      name: "New bike",
      targetMinor: 20_000,
      accountId
    });

    await accountsSvc.deleteAccount(db(), actor, accountId);
    const [goal] = await goalsSvc.listGoalsWithProgress(db(), actor, family);
    expect(goal).toMatchObject({ linkRemoved: true, progressMinor: null, pct: null });
  });
});

describe("goals — category-linked progress", () => {
  it("counts only income in the category since creation, not earlier income or spending", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const accountId = await makeAccount(user);
    const { categoryId } = await categoriesSvc.createCategory(db(), actor, { name: "Salary" });

    // Income earned BEFORE the goal exists must not count.
    await addTxn(user, accountId, {
      amountLedgerMinor: -20_000,
      date: daysAgo(1),
      categoryId,
      name: "Old pay"
    });
    await goalsSvc.createGoal(db(), actor, family, {
      name: "Save the bonus",
      targetMinor: 50_000,
      categoryId
    });

    await addTxn(user, accountId, {
      amountLedgerMinor: -15_000,
      date: daysAgo(0),
      categoryId,
      name: "Pay"
    });
    // Spending in the same category must not reduce income progress.
    await addTxn(user, accountId, {
      amountLedgerMinor: 5_000,
      date: daysAgo(0),
      categoryId,
      name: "Salary advance fee"
    });

    const [goal] = await goalsSvc.listGoalsWithProgress(db(), actor, family);
    expect(goal).toMatchObject({
      linkType: "category",
      linkName: "Salary",
      linkRemoved: false,
      progressMinor: 15_000,
      remainingMinor: 35_000,
      reached: false,
      fxIncomplete: false
    });
    expect(goal!.pct).toBeCloseTo(0.3);
  });

  it("reports link removed when the linked category is deleted", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const { categoryId } = await categoriesSvc.createCategory(db(), actor, { name: "Bonus" });
    await goalsSvc.createGoal(db(), actor, family, {
      name: "Bonus pot",
      targetMinor: 10_000,
      categoryId
    });

    await categoriesSvc.deleteCategory(db(), actor, categoryId);
    const [goal] = await goalsSvc.listGoalsWithProgress(db(), actor, family);
    expect(goal).toMatchObject({ linkRemoved: true, progressMinor: null, pct: null });
  });
});

describe("goals — deadlines, status and validation", () => {
  it("flags a past-due goal but keeps counting progress; a future deadline is not past due", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const accountId = await makeAccount(user, { openingBalanceDisplayMinor: 0 });
    await goalsSvc.createGoal(db(), actor, family, {
      name: "Overdue",
      targetMinor: 10_000,
      deadline: daysAgo(1),
      accountId
    });
    await goalsSvc.createGoal(db(), actor, family, {
      name: "On track",
      targetMinor: 10_000,
      deadline: daysFromNow(30),
      accountId
    });
    await addTxn(user, accountId, { amountLedgerMinor: -4_000, date: daysAgo(0) });

    const goals = await goalsSvc.listGoalsWithProgress(db(), actor, family);
    const overdue = goals.find((g) => g.name === "Overdue")!;
    const onTrack = goals.find((g) => g.name === "On track")!;
    expect(overdue.pastDue).toBe(true);
    expect(overdue.progressMinor).toBe(4_000);
    expect(onTrack.pastDue).toBe(false);
    expect(onTrack.progressMinor).toBe(4_000);
  });

  it("updates the target, marks achieved, hides it by default, and deletes", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const accountId = await makeAccount(user);
    const { goalId } = await goalsSvc.createGoal(db(), actor, family, {
      name: "Holiday",
      targetMinor: 10_000,
      accountId
    });

    await goalsSvc.updateGoal(db(), actor, goalId, { targetMinor: 20_000 });
    let [goal] = await goalsSvc.listGoalsWithProgress(db(), actor, family, {
      includeArchived: true
    });
    expect(goal!.targetMinor).toBe(20_000);

    await goalsSvc.setGoalStatus(db(), actor, goalId, "achieved");
    expect(await goalsSvc.listGoalsWithProgress(db(), actor, family)).toHaveLength(0);
    [goal] = await goalsSvc.listGoalsWithProgress(db(), actor, family, {
      includeArchived: true
    });
    expect(goal!.status).toBe("achieved");

    await goalsSvc.deleteGoal(db(), actor, goalId);
    expect(
      await goalsSvc.listGoalsWithProgress(db(), actor, family, { includeArchived: true })
    ).toHaveLength(0);
  });

  it("rejects goals with no link, both links, a non-positive target, or an unknown category", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const accountId = await makeAccount(user);
    const { categoryId } = await categoriesSvc.createCategory(db(), actor, { name: "Misc" });

    await expect(
      goalsSvc.createGoal(db(), actor, family, { name: "No link", targetMinor: 1000 })
    ).rejects.toThrow("exactly one");
    await expect(
      goalsSvc.createGoal(db(), actor, family, {
        name: "Both links",
        targetMinor: 1000,
        accountId,
        categoryId
      })
    ).rejects.toThrow("exactly one");
    await expect(
      goalsSvc.createGoal(db(), actor, family, {
        name: "Zero target",
        targetMinor: 0,
        accountId
      })
    ).rejects.toThrow("positive amount");
    await expect(
      goalsSvc.createGoal(db(), actor, family, {
        name: "Bad category",
        targetMinor: 1000,
        categoryId: "00000000-0000-0000-0000-000000000000"
      })
    ).rejects.toThrow("Unknown category");
  });
});
