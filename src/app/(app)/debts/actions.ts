"use server";

import { revalidatePath } from "next/cache";
import { requireVerifiedActor } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { updateAccount } from "@/server/domain/accounts";
import { formValues, runAction, type ActionState } from "@/server/actions/runner";
import { parsePercentToBps } from "@/lib/payoff";
import { errors } from "@/lib/errors";

export async function setLoanRateAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const values = formValues(formData);
  return runAction("debts.setLoanRate", async () => {
    const actor = await requireVerifiedActor();
    const accountId = values.accountId ?? "";
    const rawRate = (values.rate ?? "").trim();
    // Empty clears the rate; a non-empty value that does not parse is an error.
    const bps = rawRate === "" ? null : parsePercentToBps(rawRate);
    if (rawRate !== "" && bps === null) {
      throw errors.validation("Interest rate must be a number between 0% and 1000%.");
    }
    await updateAccount(getDb(), actor, accountId, { interestRateBps: bps });
    revalidatePath("/debts");
    return undefined;
  });
}
