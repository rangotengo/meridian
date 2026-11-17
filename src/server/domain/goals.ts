import { and, desc, eq } from "drizzle-orm";
import type { Executor } from "../db/client";
import { categories, goals } from "../db/schema";
import type { Actor, Family } from "../auth/context";
import { assertAccountAccess } from "../authorization/access";
import { listAccountsForActor } from "./accounts";
import { incomeByCategory } from "./reports";
import { recordAudit } from "../observability/audit";
import { errors } from "@/lib/errors";
import { isIsoDate, todayIn } from "@/lib/datetime";

export type GoalRow = typeof goals.$inferSelect;
export type GoalStatus = "active" | "achieved" | "archived";
export type GoalLinkType = "account" | "category";

export type GoalProgress = {
  id: string;
  name: string;
  targetMinor: number;
  currency: string;
  deadline: string | null;
  status: GoalStatus;
  linkType: GoalLinkType;
  linkId: string | null;
  linkName: string | null;
  /** True when the linked account/category was removed (or the account is
   * closed / no longer visible to the viewer). Progress is then unknown. */
  linkRemoved: boolean;
  /** Null when the link is gone. Otherwise integer minor units, floored at 0. */
  progressMinor: number | null;
  /** progress / target, or null when progress is unknown. */
  pct: number | null;
  remainingMinor: number | null;
  reached: boolean;
  /** Deadline has passed while the goal is still active. The goal keeps
   * counting progress; it is never auto-archived. */
  pastDue: boolean;
  /** True when some income could not be converted (missing FX rate), so a
   * category-linked progress understates the real total. */
  fxIncomplete: boolean;
  createdAt: string;
};

/**
 * Pure account-linked progress: balance growth since the goal was created,
 * floored at zero — withdrawals below the starting balance count as no
 * progress, never as negative progress.
 */
export function accountGoalProgress(
  currentBalanceMinor: number,
  startingBalanceMinor: number
): number {
  return Math.max(0, currentBalanceMinor - startingBalanceMinor);
}

export function goalPct(progressMinor: number | null, targetMinor: number): number | null {
  if (progressMinor === null || targetMinor <= 0) return null;
  return progressMinor / targetMinor;
}

function dateInTimezone(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);
}

export type CreateGoalInput = {
  name: string;
  targetMinor: number;
  deadline?: string | null;
  accountId?: string | null;
  categoryId?: string | null;
};

/**
 * Creates a goal linked to exactly one account or one category.
 *
 * - Account-linked: currency is the account's currency; progress is the
 *   account's balance growth since creation (starting balance is captured
 *   here, from the account's current display balance).
 * - Category-linked: currency is the family currency; progress is income
 *   earned in that category since creation (see incomeByCategory).
 */
export async function createGoal(
  exec: Executor,
  actor: Actor,
  family: Family,
  input: CreateGoalInput
): Promise<{ goalId: string }> {
  const name = input.name.trim();
  if (!name) throw errors.validation("A goal name is required.");
  if (name.length > 240) throw errors.validation("Goal name is too long.");
  if (!Number.isSafeInteger(input.targetMinor) || input.targetMinor <= 0) {
    throw errors.validation("Target must be a positive amount.");
  }
  if (input.deadline && !isIsoDate(input.deadline)) {
    throw errors.validation("Deadline must be a valid calendar date.");
  }
  const hasAccount = Boolean(input.accountId);
  const hasCategory = Boolean(input.categoryId);
  if (hasAccount === hasCategory) {
    throw errors.validation("Link a goal to exactly one account or one category.");
  }

  let currency: string;
  let startingBalanceMinor = 0;
  if (hasAccount) {
    const { account } = await assertAccountAccess(exec, actor, input.accountId!, "view");
    if (account.status !== "active") throw errors.validation("Linked account is closed.");
    currency = account.currency;
    const visible = await listAccountsForActor(exec, actor);
    startingBalanceMinor = visible.find((a) => a.id === account.id)?.displayBalanceMinor ?? 0;
  } else {
    const [category] = await exec
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, input.categoryId!), eq(categories.familyId, actor.familyId)))
      .limit(1);
    if (!category) throw errors.validation("Unknown category.");
    currency = family.currency;
  }

  const [goal] = await exec
    .insert(goals)
    .values({
      familyId: actor.familyId,
      createdBy: actor.userId,
      name,
      targetMinor: input.targetMinor,
      currency,
      deadline: input.deadline ?? null,
      accountId: input.accountId ?? null,
      categoryId: input.categoryId ?? null,
      startingBalanceMinor,
      status: "active"
    })
    .returning({ id: goals.id });
  if (!goal) throw errors.conflict("Failed to create goal.");

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "goal.created",
    entityType: "goal",
    entityId: goal.id,
    metadata: { name, targetMinor: input.targetMinor, currency }
  });
  return { goalId: goal.id };
}

async function requireGoal(exec: Executor, actor: Actor, goalId: string): Promise<GoalRow> {
  const [goal] = await exec
    .select()
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.familyId, actor.familyId)))
    .limit(1);
  if (!goal) throw errors.notFound("Goal");
  return goal;
}

export async function listGoalsWithProgress(
  exec: Executor,
  actor: Actor,
  family: Family,
  opts: { includeArchived?: boolean } = {}
): Promise<GoalProgress[]> {
  const rows = await exec
    .select()
    .from(goals)
    .where(
      opts.includeArchived
        ? eq(goals.familyId, family.id)
        : and(eq(goals.familyId, family.id), eq(goals.status, "active"))
    )
    .orderBy(desc(goals.createdAt));

  if (rows.length === 0) return [];

  const visibleAccounts = await listAccountsForActor(exec, actor);
  const accountById = new Map(visibleAccounts.map((a) => [a.id, a]));
  const categoryNames = new Map<string, string>();
  const categoryRows = await exec
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(eq(categories.familyId, family.id));
  for (const c of categoryRows) categoryNames.set(c.id, c.name);

  const today = todayIn(family.timezone);
  const out: GoalProgress[] = [];

  // Category goals all read income since their creation date. Goals created
  // on the same day share one incomeByCategory call (and one FX-issue
  // report) instead of one query per goal.
  const createdDates = new Map(
    rows.map((g) => [g.id, dateInTimezone(new Date(g.createdAt), family.timezone)])
  );
  const incomeCache = new Map<string, Awaited<ReturnType<typeof incomeByCategory>>>();

  for (const goal of rows) {
    const status = goal.status as GoalStatus;
    const pastDue = status === "active" && goal.deadline !== null && goal.deadline < today;
    const createdDate = createdDates.get(goal.id)!;
    const base = {
      id: goal.id,
      name: goal.name,
      targetMinor: goal.targetMinor,
      currency: goal.currency,
      deadline: goal.deadline,
      status,
      createdAt: goal.createdAt.toISOString(),
      pastDue
    };

    if (goal.accountId) {
      const account = accountById.get(goal.accountId);
      if (!account || account.status !== "active") {
        out.push({
          ...base,
          linkType: "account",
          linkId: null,
          linkName: null,
          linkRemoved: true,
          progressMinor: null,
          pct: null,
          remainingMinor: null,
          reached: false,
          fxIncomplete: false
        });
        continue;
      }
      const progress = accountGoalProgress(account.displayBalanceMinor, goal.startingBalanceMinor);
      out.push({
        ...base,
        linkType: "account",
        linkId: account.id,
        linkName: account.name,
        linkRemoved: false,
        progressMinor: progress,
        pct: goalPct(progress, goal.targetMinor),
        remainingMinor: Math.max(0, goal.targetMinor - progress),
        reached: progress >= goal.targetMinor,
        fxIncomplete: false
      });
    } else if (goal.categoryId) {
      const name = categoryNames.get(goal.categoryId);
      if (!name) {
        out.push({
          ...base,
          linkType: "category",
          linkId: null,
          linkName: null,
          linkRemoved: true,
          progressMinor: null,
          pct: null,
          remainingMinor: null,
          reached: false,
          fxIncomplete: false
        });
        continue;
      }
      let income = incomeCache.get(createdDate);
      if (!income) {
        income = await incomeByCategory(exec, family, actor.userId, {
          from: createdDate,
          to: today
        });
        incomeCache.set(createdDate, income);
      }
      const row = income.categories.find((c) => c.categoryId === goal.categoryId);
      const progress = row?.totalMinor ?? 0;
      out.push({
        ...base,
        linkType: "category",
        linkId: goal.categoryId,
        linkName: name,
        linkRemoved: false,
        progressMinor: progress,
        pct: goalPct(progress, goal.targetMinor),
        remainingMinor: Math.max(0, goal.targetMinor - progress),
        reached: progress >= goal.targetMinor,
        fxIncomplete: income.fx.incompleteFx
      });
    } else {
      // No link: the linked account/category was deleted (ON DELETE SET
      // NULL) and the CHECK allows both NULL for exactly this state.
      out.push({
        ...base,
        linkType: "account",
        linkId: null,
        linkName: null,
        linkRemoved: true,
        progressMinor: null,
        pct: null,
        remainingMinor: null,
        reached: false,
        fxIncomplete: false
      });
    }
  }
  return out;
}

export async function updateGoal(
  exec: Executor,
  actor: Actor,
  goalId: string,
  patch: { name?: string; targetMinor?: number; deadline?: string | null }
): Promise<void> {
  const goal = await requireGoal(exec, actor, goalId);
  const updates: Partial<typeof goal> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw errors.validation("A goal name is required.");
    if (name.length > 240) throw errors.validation("Goal name is too long.");
    updates.name = name;
  }
  if (patch.targetMinor !== undefined) {
    if (!Number.isSafeInteger(patch.targetMinor) || patch.targetMinor <= 0) {
      throw errors.validation("Target must be a positive amount.");
    }
    updates.targetMinor = patch.targetMinor;
  }
  if (patch.deadline !== undefined) {
    if (patch.deadline && !isIsoDate(patch.deadline)) {
      throw errors.validation("Deadline must be a valid calendar date.");
    }
    updates.deadline = patch.deadline;
  }
  if (Object.keys(updates).length === 0) return;
  await exec
    .update(goals)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(goals.id, goal.id));
  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "goal.updated",
    entityType: "goal",
    entityId: goal.id,
    metadata: { name: updates.name ?? goal.name }
  });
}

/** The link (account/category) never changes: it defines what progress
 * means, so changing it would silently redefine the goal. Delete and
 * recreate to link a different account or category. */
export async function setGoalStatus(
  exec: Executor,
  actor: Actor,
  goalId: string,
  status: GoalStatus
): Promise<void> {
  const goal = await requireGoal(exec, actor, goalId);
  await exec.update(goals).set({ status, updatedAt: new Date() }).where(eq(goals.id, goal.id));
  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "goal.status",
    entityType: "goal",
    entityId: goal.id,
    metadata: { status }
  });
}

export async function deleteGoal(exec: Executor, actor: Actor, goalId: string): Promise<void> {
  const goal = await requireGoal(exec, actor, goalId);
  await exec.delete(goals).where(eq(goals.id, goal.id));
  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "goal.deleted",
    entityType: "goal",
    entityId: goal.id,
    metadata: { name: goal.name }
  });
}
