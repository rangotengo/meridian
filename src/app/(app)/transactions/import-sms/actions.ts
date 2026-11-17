"use server";

import { revalidatePath } from "next/cache";
import { requireVerifiedActor, currentFamily } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import {
  previewSmsImport,
  confirmSmsImport,
  type SmsImportPreview
} from "@/server/domain/sms-import";
import { runAction, type ActionState } from "@/server/actions/runner";

export async function previewSmsImportAction(
  _prev: ActionState<SmsImportPreview> | undefined,
  formData: FormData
): Promise<ActionState<SmsImportPreview>> {
  return runAction("sms.preview", async () => {
    const actor = await requireVerifiedActor();
    const family = await currentFamily(actor);
    const rawSms = String(formData.get("rawSms") ?? "");
    const sender = String(formData.get("sender") ?? "").trim() || null;
    return previewSmsImport(getDb(), actor, family, rawSms, sender);
  });
}

export async function confirmSmsImportAction(
  _prev: ActionState<{ entryId: string; duplicated: boolean }> | undefined,
  formData: FormData
): Promise<ActionState<{ entryId: string; duplicated: boolean }>> {
  return runAction("sms.confirm", async () => {
    const actor = await requireVerifiedActor();
    const family = await currentFamily(actor);
    const result = await confirmSmsImport(getDb(), actor, family, {
      rawSms: String(formData.get("rawSms") ?? ""),
      sender: String(formData.get("sender") ?? "").trim() || null,
      accountId: String(formData.get("accountId") ?? ""),
      categoryId: String(formData.get("categoryId") ?? "") || null,
      name: String(formData.get("name") ?? "").trim() || null,
      date: String(formData.get("date") ?? "").trim() || null,
      amountText: String(formData.get("amount") ?? "").trim() || null,
      merchant: String(formData.get("merchant") ?? "").trim() || null
    });
    revalidatePath("/transactions");
    revalidatePath("/");
    return result;
  });
}
