"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertActor } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { consumeRateLimit } from "@/server/security/rate-limit";
import { formValues, runAction, type ActionState } from "@/server/actions/runner";
import {
  importSsisSnapshot,
  refreshSsis,
  setSsisBoAccountNo,
  type SsisBoConfigResult,
  type SsisImportCounts
} from "@/server/domain/ssis";
import { errors } from "@/lib/errors";

export type SsisImportResult = SsisImportCounts & { warnings: string[] };

const MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024;

export async function importSsisAction(
  _previous: ActionState<SsisImportResult> | undefined,
  formData: FormData
): Promise<ActionState<SsisImportResult>> {
  return runAction("ssis.import", async () => {
    const actor = await assertActor();
    await consumeRateLimit(getDb(), `ssis.import:${actor.userId}`, 10, 3600);
    const file = formData.get("snapshot");
    if (!(file instanceof File) || file.size === 0) {
      throw errors.validation("Choose the SSIS snapshot JSON file to import.");
    }
    if (file.size > MAX_SNAPSHOT_BYTES) {
      throw errors.validation("That snapshot file is too large (25 MB limit).");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      throw errors.validation("That file is not valid JSON.");
    }
    const counts = await importSsisSnapshot(getDb(), actor, payload, "import");
    revalidatePath("/insights/ssis");
    return { ...counts, warnings: [] };
  });
}

export async function refreshSsisAction(
  _previous: ActionState<SsisImportResult> | undefined,
  formData: FormData
): Promise<ActionState<SsisImportResult>> {
  void formData;
  return runAction("ssis.refresh", async () => {
    const actor = await assertActor();
    await consumeRateLimit(getDb(), `ssis.refresh:${actor.userId}`, 20, 3600);
    const result = await refreshSsis(getDb(), actor);
    revalidatePath("/insights/ssis");
    return result;
  });
}

const boAccountSchema = z.object({
  boAccountNo: z
    .string()
    .trim()
    .regex(/^[0-9]{8,24}$/, "Enter the BO account number (digits only, 8–24 characters).")
});

export async function setSsisBoAccountAction(
  _previous: ActionState<SsisBoConfigResult> | undefined,
  formData: FormData
): Promise<ActionState<SsisBoConfigResult>> {
  return runAction("ssis.configure_bo", async () => {
    const actor = await assertActor();
    const values = formValues(formData);
    const input = boAccountSchema.parse(values);
    // Changing the BO number while another holder's data is stored is a
    // destructive switch: the domain rejects it unless the admin ticked
    // the explicit confirmation in the form.
    const resetExistingData =
      values.resetExistingData === "on" || values.resetExistingData === "true";
    const result = await setSsisBoAccountNo(getDb(), actor, input.boAccountNo, {
      resetExistingData
    });
    revalidatePath("/insights/ssis");
    return result;
  });
}
