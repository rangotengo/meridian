"use server";

import { revalidatePath } from "next/cache";
import { requireVerifiedActor } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { formValues, runAction, type ActionState } from "@/server/actions/runner";
import {
  confirmStatementImport,
  parseStatementHeaders,
  previewStatementImport,
  type StatementMapping,
  type StatementParseResult,
  type StatementPreview,
  type StatementImportResult
} from "@/server/domain/statement-csv";
import { errors } from "@/lib/errors";

function mappingFromValues(values: Record<string, string>): StatementMapping {
  const num = (key: string): number | null => {
    const raw = (values[key] ?? "").trim();
    if (raw === "") return null;
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
  };
  return {
    date: num("map_date"),
    description: num("map_description"),
    amount: num("map_amount"),
    debit: num("map_debit"),
    credit: num("map_credit")
  };
}

export async function parseStatementCsvAction(
  _prev: ActionState<StatementParseResult> | undefined,
  formData: FormData
): Promise<ActionState<StatementParseResult>> {
  const values = formValues(formData);
  return runAction("transactions.import_csv.parse", async () => {
    await requireVerifiedActor();
    const text = values.csvText ?? "";
    if (!text.trim()) throw errors.validation("Paste a statement or choose a CSV file first.");
    return parseStatementHeaders(text);
  });
}

export async function previewStatementCsvAction(
  _prev: ActionState<StatementPreview> | undefined,
  formData: FormData
): Promise<ActionState<StatementPreview>> {
  const values = formValues(formData);
  return runAction("transactions.import_csv.preview", async () => {
    const actor = await requireVerifiedActor();
    const accountId = values.accountId ?? "";
    if (!accountId) throw errors.validation("Choose an account first.");
    return previewStatementImport(getDb(), actor, {
      accountId,
      text: values.csvText ?? "",
      mapping: mappingFromValues(values)
    });
  });
}

export async function confirmStatementCsvAction(
  _prev: ActionState<StatementImportResult> | undefined,
  formData: FormData
): Promise<ActionState<StatementImportResult>> {
  const values = formValues(formData);
  return runAction("transactions.import_csv.confirm", async () => {
    const actor = await requireVerifiedActor();
    const accountId = values.accountId ?? "";
    if (!accountId) throw errors.validation("Choose an account first.");
    const result = await confirmStatementImport(getDb(), actor, {
      accountId,
      text: values.csvText ?? "",
      mapping: mappingFromValues(values)
    });
    revalidatePath("/transactions");
    return result;
  });
}
