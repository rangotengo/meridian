"use server";

import { revalidatePath } from "next/cache";
import { requireVerifiedActor, currentFamily } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { setBudget, setBudgetRollover, removeBudget } from "@/server/domain/budgets";
import { runAction, type ActionState } from "@/server/actions/runner";
import { parseAmountToMinor } from "@/lib/money";
import { errors } from "@/lib/errors";

export async function setBudgetAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("budget.set", async () => {
    const actor = await requireVerifiedActor();
    const family = await currentFamily(actor);
    const categoryId = String(formData.get("categoryId") ?? "");
    const amountRaw = String(formData.get("amount") ?? "").trim();
    if (!amountRaw) throw errors.validation("Enter a monthly amount.");

    await setBudget(getDb(), actor, {
      categoryId: categoryId || null,
      amountLedgerMinor: parseAmountToMinor(amountRaw, family.currency),
      // The edit form has no rollover field; setBudget then keeps the
      // current toggle instead of resetting it.
      ...(formData.has("rollover") ? { rollover: formData.get("rollover") === "on" } : {})
    });
    revalidatePath("/budgets");
    revalidatePath("/");
    return undefined;
  });
}

export async function setBudgetRolloverAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("budget.rollover", async () => {
    const actor = await requireVerifiedActor();
    const categoryId = String(formData.get("categoryId") ?? "");
    const rollover = String(formData.get("rollover") ?? "") === "on";
    await setBudgetRollover(getDb(), actor, categoryId || null, rollover);
    revalidatePath("/budgets");
    revalidatePath("/");
    return undefined;
  });
}

export async function removeBudgetAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("budget.remove", async () => {
    const actor = await requireVerifiedActor();
    const categoryId = String(formData.get("categoryId") ?? "");
    await removeBudget(getDb(), actor, categoryId || null);
    revalidatePath("/budgets");
    revalidatePath("/");
    return undefined;
  });
}
