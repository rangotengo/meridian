"use server";

import { revalidatePath } from "next/cache";
import { assertActor } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { runAction, type ActionState } from "@/server/actions/runner";
import { importSureExport, type SureImportResult } from "@/server/domain/sure-import";
import {
  importFamilyExport,
  parseFamilyExport,
  type FamilyImportResult
} from "@/server/domain/family-import";

export async function importSureExportAction(
  _previous: ActionState<SureImportResult> | undefined,
  formData: FormData
): Promise<ActionState<SureImportResult>> {
  return runAction("family.import_sure", async () => {
    const actor = await assertActor();
    const upload = formData.get("sureExport");
    if (!(upload instanceof File) || upload.size === 0) {
      throw (await import("@/lib/errors")).errors.validation(
        "Choose the Sure export ZIP or all.ndjson file."
      );
    }
    const result = await importSureExport(
      getDb(),
      actor,
      upload.name,
      new Uint8Array(await upload.arrayBuffer())
    );
    revalidatePath("/", "layout");
    revalidatePath("/accounts");
    revalidatePath("/transactions");
    revalidatePath("/reports");
    revalidatePath("/settings/data");
    return result;
  });
}

export async function importFamilyExportAction(
  _previous: ActionState<FamilyImportResult> | undefined,
  formData: FormData
): Promise<ActionState<FamilyImportResult>> {
  return runAction("family.import_export", async () => {
    const actor = await assertActor();
    const upload = formData.get("familyExport");
    if (!(upload instanceof File) || upload.size === 0) {
      throw (await import("@/lib/errors")).errors.validation(
        "Choose the Meridian export JSON file."
      );
    }
    const data = parseFamilyExport(new Uint8Array(await upload.arrayBuffer()));
    const result = await importFamilyExport(getDb(), actor, data);
    revalidatePath("/", "layout");
    revalidatePath("/accounts");
    revalidatePath("/transactions");
    revalidatePath("/reports");
    revalidatePath("/settings/data");
    return result;
  });
}
