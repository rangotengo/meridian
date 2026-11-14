"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireVerifiedActor } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { upsertRate } from "@/server/domain/exchange-rates";
import { runAction, type ActionState } from "@/server/actions/runner";

const rateSchema = z.object({
  base: z.string().length(3),
  quote: z.string().length(3),
  rate: z.string().min(1),
  quotedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
});

/**
 * Exchange rates are instance-level reference data (the exchange_rates table
 * has no family scope, mirroring exports), so any verified user who can see
 * a missing-rate warning can also fix it by entering the rate. Validation of
 * the pair, positivity, and date happens in upsertRate.
 */
export async function upsertExchangeRateAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("fx.upsert_rate", async () => {
    const input = rateSchema.parse(Object.fromEntries(formData));
    await requireVerifiedActor();
    await upsertRate(getDb(), {
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
