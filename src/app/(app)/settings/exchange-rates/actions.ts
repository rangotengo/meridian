"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSuperAdmin } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { upsertRateForActor } from "@/server/domain/exchange-rates";
import { runAction, type ActionState } from "@/server/actions/runner";

const rateSchema = z.object({
  base: z.string().length(3),
  quote: z.string().length(3),
  rate: z.string().min(1),
  quotedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
});

/**
 * Exchange rates are instance-level reference data (the exchange_rates table
 * has no family scope), so writes are restricted to platform super-admins:
 * any verified user who could write here could replace the rates other
 * households' reports rely on. Validation of the pair, positivity, and date
 * happens in upsertRate; the actor and the changed rate are recorded in the
 * audit trail by upsertRateForActor.
 */
export async function upsertExchangeRateAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("fx.upsert_rate", async () => {
    const actor = await requireSuperAdmin();
    const input = rateSchema.parse(Object.fromEntries(formData));
    await upsertRateForActor(getDb(), actor, {
      base: input.base.toUpperCase(),
      quote: input.quote.toUpperCase(),
      rate: input.rate,
      quotedOn: input.quotedOn
    });
    revalidatePath("/settings/exchange-rates");
    revalidatePath("/");
    revalidatePath("/reports");
    return undefined;
  });
}
