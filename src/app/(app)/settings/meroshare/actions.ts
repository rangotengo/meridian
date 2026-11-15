"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertActor } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { consumeRateLimit } from "@/server/security/rate-limit";
import { formValues, runAction, type ActionState } from "@/server/actions/runner";
import {
  connectMeroShare,
  disconnectMeroShareConnection,
  MeroShareClient,
  syncMeroShareConnection,
  type MeroShareCapital
} from "@/server/domain/meroshare";

const connectSchema = z.object({
  clientId: z.coerce.number().int().positive(),
  dpCode: z.string().trim().min(1).max(32),
  dpName: z.string().trim().min(1).max(160),
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(255)
});

export async function meroShareCapitalsAction(): Promise<ActionState<MeroShareCapital[]>> {
  return runAction("meroshare.capitals", async () => {
    await assertActor();
    return MeroShareClient.capitals();
  });
}

/** Outcome of a connect/sync, including any partial-success warnings. */
export type MeroShareSyncResult = {
  accounts: number;
  costBasisAvailable: boolean;
  warnings: string[];
};

export async function connectMeroShareAction(
  _previous: ActionState<MeroShareSyncResult> | undefined,
  formData: FormData
): Promise<ActionState<MeroShareSyncResult>> {
  return runAction("meroshare.connect", async () => {
    const actor = await assertActor();
    await consumeRateLimit(getDb(), `meroshare.connect:${actor.userId}`, 10, 3600);
    const input = connectSchema.parse(formValues(formData));
    const result = await connectMeroShare(getDb(), actor, {
      clientId: input.clientId,
      username: input.username,
      password: input.password,
      capital: { id: input.clientId, code: input.dpCode, name: input.dpName }
    });
    revalidatePath("/settings/meroshare");
    revalidatePath("/accounts");
    revalidatePath("/");
    return {
      accounts: result.accounts,
      costBasisAvailable: result.costBasisAvailable,
      warnings: result.warnings
    };
  });
}

export async function syncMeroShareAction(
  _previous: ActionState<MeroShareSyncResult> | undefined,
  formData: FormData
): Promise<ActionState<MeroShareSyncResult>> {
  return runAction("meroshare.sync", async () => {
    const actor = await assertActor();
    await consumeRateLimit(getDb(), `meroshare.sync:${actor.userId}`, 30, 3600);
    const connectionId = z.string().uuid().parse(formData.get("connectionId"));
    const result = await syncMeroShareConnection(getDb(), actor, connectionId);
    revalidatePath("/settings/meroshare");
    revalidatePath("/accounts");
    revalidatePath("/");
    return {
      accounts: result.accounts,
      costBasisAvailable: result.costBasisAvailable,
      warnings: result.warnings
    };
  });
}

export async function disconnectMeroShareAction(
  _previous: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("meroshare.disconnect", async () => {
    const actor = await assertActor();
    const connectionId = z.string().uuid().parse(formData.get("connectionId"));
    await disconnectMeroShareConnection(getDb(), actor, connectionId);
    revalidatePath("/settings/meroshare");
    revalidatePath("/accounts");
    revalidatePath("/");
    return undefined;
  });
}
