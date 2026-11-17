"use server";

import { revalidatePath } from "next/cache";
import { requireVerifiedActor, currentFamily } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { listAccountsForActor } from "@/server/domain/accounts";
import {
  createGoal,
  deleteGoal,
  setGoalStatus,
  updateGoal,
  type GoalStatus
} from "@/server/domain/goals";
import { runAction, type ActionState } from "@/server/actions/runner";
import { parseAmountToMinor } from "@/lib/money";
import { errors } from "@/lib/errors";

const VALID_STATUSES: GoalStatus[] = ["active", "achieved", "archived"];

export async function createGoalAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("goal.create", async () => {
    const actor = await requireVerifiedActor();
    const family = await currentFamily(actor);
    const name = String(formData.get("name") ?? "").trim();
    const amountRaw = String(formData.get("amount") ?? "").trim();
    const linkType = String(formData.get("linkType") ?? "");
    const accountId = String(formData.get("accountId") ?? "");
    const categoryId = String(formData.get("categoryId") ?? "");
    const deadline = String(formData.get("deadline") ?? "").trim();
    if (!amountRaw) throw errors.validation("Enter a target amount.");
    if (linkType !== "account" && linkType !== "category") {
      throw errors.validation("Choose whether the goal tracks an account or a category.");
    }
    // Parse the target in the goal's own currency: the linked account's
    // currency for account goals, the family currency for category goals.
    let currency = family.currency;
    if (linkType === "account") {
      const account = (await listAccountsForActor(getDb(), actor)).find((a) => a.id === accountId);
      if (!account) throw errors.validation("Unknown account.");
      currency = account.currency;
    }
    await createGoal(getDb(), actor, family, {
      name,
      targetMinor: parseAmountToMinor(amountRaw, currency),
      deadline: deadline || null,
      accountId: linkType === "account" ? accountId || null : null,
      categoryId: linkType === "category" ? categoryId || null : null
    });
    revalidatePath("/goals");
    revalidatePath("/");
    return undefined;
  });
}

export async function updateGoalAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("goal.update", async () => {
    const actor = await requireVerifiedActor();
    const goalId = String(formData.get("goalId") ?? "");
    const name = String(formData.get("name") ?? "").trim();
    const amountRaw = String(formData.get("amount") ?? "").trim();
    const deadline = String(formData.get("deadline") ?? "").trim();
    // The target is stored in the goal's own currency, which the edit form
    // submits alongside the amount.
    const currency = String(formData.get("currency") ?? "").trim();
    await updateGoal(getDb(), actor, goalId, {
      ...(name ? { name } : {}),
      ...(amountRaw && currency ? { targetMinor: parseAmountToMinor(amountRaw, currency) } : {}),
      deadline: deadline || null
    });
    revalidatePath("/goals");
    revalidatePath("/");
    return undefined;
  });
}

export async function setGoalStatusAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("goal.status", async () => {
    const actor = await requireVerifiedActor();
    const goalId = String(formData.get("goalId") ?? "");
    const status = String(formData.get("status") ?? "") as GoalStatus;
    if (!VALID_STATUSES.includes(status)) throw errors.validation("Unknown goal status.");
    await setGoalStatus(getDb(), actor, goalId, status);
    revalidatePath("/goals");
    revalidatePath("/");
    return undefined;
  });
}

export async function deleteGoalAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("goal.delete", async () => {
    const actor = await requireVerifiedActor();
    const goalId = String(formData.get("goalId") ?? "");
    await deleteGoal(getDb(), actor, goalId);
    revalidatePath("/goals");
    revalidatePath("/");
    return undefined;
  });
}
