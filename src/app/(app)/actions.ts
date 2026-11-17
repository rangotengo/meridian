"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, withTransaction } from "@/server/db/client";
import { assertActor } from "@/server/auth/context";
import { parseAmountToMinor } from "@/lib/money";
import { errors, DomainError } from "@/lib/errors";
import { runAction, formValues, optionalString, type ActionState } from "@/server/actions/runner";
import * as valuationsSvc from "@/server/domain/valuations";
import * as holdingsSvc from "@/server/domain/holdings";
import { importHoldingsCsv, type HoldingsImportResult } from "@/server/domain/holdings-import";
import * as orchestrate from "@/server/domain/orchestrate";
import { parseTagIds } from "@/components/ds/tag-picker";

async function currencyFor(accountId: string): Promise<string> {
  const res = await getDb().execute<{ currency: string }>(
    sql`SELECT currency FROM accounts WHERE id = ${accountId}`
  );
  const row = (res.rows ?? [])[0];
  if (!row) throw errors.notFound("Account");
  return row.currency;
}

function toLedgerAmount(
  displayAmount: string,
  currency: string,
  kind: "expense" | "income"
): number {
  const display = parseAmountToMinor(displayAmount, currency);
  return kind === "expense" ? Math.abs(display) : -Math.abs(display);
}

const createTxnSchema = z.object({
  accountId: z.string().uuid(),
  kind: z.enum(["expense", "income"]),
  date: z.string().min(8),
  amount: z.string().min(1),
  name: z.string().min(1).max(240),
  categoryId: z.string().optional(),
  merchant: z.string().optional(),
  notes: z.string().optional()
});

/**
 * Shared create-transaction mutation behind both action wrappers. Runs the
 * domain write and revalidates every surface the new entry affects (the
 * transaction list, the dashboard, the account list/sidebar data, and the
 * account page) but never redirects — each wrapper decides what happens
 * next. Returns the typed ActionState so dialog callers can surface errors
 * without losing the form.
 */
async function createTransactionInternal(formData: FormData): Promise<ActionState> {
  const parsed = createTxnSchema.safeParse(formValues(formData));
  if (!parsed.success)
    return { ok: false, error: "Check the highlighted fields.", code: "validation.failed" };
  const input = parsed.data;
  return runAction("txn.create", async () => {
    const actor = await assertActor();
    const currency = await currencyFor(input.accountId);
    await withTransaction(async (tx) => {
      await orchestrate.addTransaction(tx, actor, {
        accountId: input.accountId,
        date: input.date,
        amountLedgerMinor: toLedgerAmount(input.amount, currency, input.kind),
        name: input.name,
        categoryId: input.categoryId ? input.categoryId : null,
        merchant: optionalString(input.merchant),
        notes: optionalString(input.notes),
        tagIds: parseTagIds(formData)
      });
    });
    revalidatePath("/transactions");
    revalidatePath("/");
    revalidatePath("/accounts");
    revalidatePath(`/accounts/${input.accountId}`);
  });
}

export async function createTransactionAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const state = await createTransactionInternal(formData);
  if (state.ok) redirect("/transactions");
  return state;
}

/** Dialog variant: same mutation, typed result, no redirect. */
export async function createTransactionDialogAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return createTransactionInternal(formData);
}

const updateTxnSchema = z.object({
  entryId: z.string().uuid(),
  date: z.string().optional(),
  name: z.string().optional(),
  amount: z.string().optional(),
  ledgerSign: z.enum(["1", "-1"]).optional(),
  notes: z.string().optional(),
  merchant: z.string().optional(),
  categoryId: z.string().optional()
});

export async function updateTransactionAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const parsed = updateTxnSchema.safeParse(formValues(formData));
  if (!parsed.success)
    return { ok: false, error: "Check the highlighted fields.", code: "validation.failed" };
  const input = parsed.data;
  return runAction("txn.update", async () => {
    const actor = await assertActor();
    const res = await getDb().execute<{ account_id: string; currency: string }>(
      sql`SELECT e.account_id, a.currency FROM entries e JOIN accounts a ON a.id = e.account_id WHERE e.id = ${input.entryId}`
    );
    const row = (res.rows ?? [])[0];
    if (!row) throw errors.notFound("Transaction");

    let amountLedgerMinor: number | undefined;
    if (input.amount !== undefined && input.amount.trim() !== "") {
      const parsedAmount = Math.abs(parseAmountToMinor(input.amount, row.currency));
      const sign = input.ledgerSign === "-1" ? -1 : 1;
      amountLedgerMinor = parsedAmount * sign;
    }

    await withTransaction((tx) =>
      orchestrate.editTransaction(tx, actor, input.entryId, {
        date: input.date,
        name: input.name,
        amountLedgerMinor,
        notes: input.notes,
        merchant: input.merchant,
        categoryId: input.categoryId === "" ? null : input.categoryId,
        replaceTagIds: formData.has("tagIds") ? parseTagIds(formData) : null
      })
    );
    revalidatePath("/transactions");
    revalidatePath(`/transactions/${input.entryId}`);
    revalidatePath(`/accounts/${row.account_id}`);
    revalidatePath("/");
    return undefined;
  });
}

export async function deleteEntryAction(formData: FormData): Promise<ActionState> {
  const entryId = String(formData.get("entryId") ?? "");
  return runAction("txn.delete", async () => {
    const actor = await assertActor();
    await withTransaction((tx) => orchestrate.removeEntry(tx, actor, entryId));
    revalidatePath("/transactions");
    revalidatePath("/");
    redirect("/transactions");
  });
}

export type BulkDeleteResult = {
  deleted: string[];
  skipped: { id: string; reason: string }[];
};

const bulkDeleteSchema = z.object({
  entryIds: z.array(z.string().uuid()).min(1).max(25)
});

/**
 * Delete several transactions from the list in one go. Each entry is
 * removed in its own transaction via the same removeEntry path as a single
 * delete (so balances are recalculated per account), and a failure for one
 * entry — e.g. a split part, which cannot be deleted directly — only skips
 * that entry instead of rolling back the rest. The result names every
 * deleted id and every skipped id with its reason.
 */
export async function bulkDeleteEntriesAction(
  _prev: ActionState<BulkDeleteResult> | undefined,
  formData: FormData
): Promise<ActionState<BulkDeleteResult>> {
  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("entryIds") ?? "[]"));
  } catch {
    return { ok: false, error: "Invalid selection.", code: "validation.failed" };
  }
  const parsed = bulkDeleteSchema.safeParse({ entryIds: raw });
  if (!parsed.success) {
    return { ok: false, error: "Check the highlighted fields.", code: "validation.failed" };
  }
  return runAction("txn.bulk-delete", async () => {
    const actor = await assertActor();
    const deleted: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const entryId of parsed.data.entryIds) {
      try {
        await withTransaction((tx) => orchestrate.removeEntry(tx, actor, entryId));
        deleted.push(entryId);
      } catch (e) {
        skipped.push({
          id: entryId,
          reason: e instanceof DomainError ? e.userMessage : "Could not delete."
        });
      }
    }
    revalidatePath("/transactions");
    revalidatePath("/");
    return { deleted, skipped };
  });
}

const splitPayloadSchema = z.object({
  parentEntryId: z.string().uuid(),
  parts: z
    .array(
      z.object({
        name: z.string().max(240).optional(),
        amountLedgerMinor: z.number().int(),
        categoryId: z.string().uuid().nullable().optional()
      })
    )
    .min(2)
});

export async function splitEntryAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("txn.split", async () => {
    const json = String(formData.get("payload") ?? "");
    const input = splitPayloadSchema.parse(JSON.parse(json));
    const actor = await assertActor();
    await withTransaction((tx) =>
      orchestrate.splitTransaction(tx, actor, input.parentEntryId, input.parts)
    );
    revalidatePath("/transactions");
    revalidatePath(`/transactions/${input.parentEntryId}`);
    return undefined;
  });
}

export async function unsplitEntryAction(formData: FormData): Promise<ActionState> {
  const parentEntryId = String(formData.get("parentEntryId") ?? "");
  return runAction("txn.unsplit", async () => {
    const actor = await assertActor();
    await withTransaction((tx) => orchestrate.unsplitTransaction(tx, actor, parentEntryId));
    revalidatePath("/transactions");
    revalidatePath(`/transactions/${parentEntryId}`);
  });
}

const linkTransferSchema = z.object({
  outflowEntryId: z.string().uuid(),
  inflowEntryId: z.string().uuid()
});

export async function linkTransferAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return runAction("transfer.link", async () => {
    const input = linkTransferSchema.parse(formValues(formData));
    const actor = await assertActor();
    await withTransaction((tx) =>
      orchestrate.linkTransfer(tx, actor, input.outflowEntryId, input.inflowEntryId)
    );
    revalidatePath("/transactions");
    revalidatePath(`/transactions/${input.outflowEntryId}`);
    revalidatePath(`/transactions/${input.inflowEntryId}`);
    return undefined;
  });
}

export async function unlinkTransferAction(formData: FormData): Promise<ActionState> {
  const transferId = String(formData.get("transferId") ?? "");
  const entryId = String(formData.get("entryId") ?? "");
  return runAction("transfer.unlink", async () => {
    const actor = await assertActor();
    await withTransaction((tx) => orchestrate.unlinkTransfer(tx, actor, transferId));
    revalidatePath("/transactions");
    if (entryId) revalidatePath(`/transactions/${entryId}`);
  });
}

const transferFormSchema = z.object({
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
  date: z.string().min(8),
  amount: z.string().min(1),
  name: z.string().optional()
});

/**
 * Shared create-transfer mutation behind both action wrappers (see
 * createTransactionInternal). The domain creates both legs atomically; this
 * layer only maps the form, converts the amount, and revalidates the list,
 * the dashboard, the account list/sidebar data, and BOTH account pages.
 */
async function createTransferInternal(formData: FormData): Promise<ActionState> {
  const parsed = transferFormSchema.safeParse(formValues(formData));
  if (!parsed.success)
    return { ok: false, error: "Check the highlighted fields.", code: "validation.failed" };
  const input = parsed.data;
  return runAction("transfer.create", async () => {
    const actor = await assertActor();
    const currency = await currencyFor(input.fromAccountId);
    await withTransaction((tx) =>
      orchestrate.makeTransferWithEntries(tx, actor, {
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        date: input.date,
        amountDisplayMinor: Math.abs(parseAmountToMinor(input.amount, currency)),
        name: input.name?.trim() ? input.name.trim() : undefined
      })
    );
    revalidatePath("/transactions");
    revalidatePath("/");
    revalidatePath("/accounts");
    revalidatePath(`/accounts/${input.fromAccountId}`);
    revalidatePath(`/accounts/${input.toAccountId}`);
  });
}

export async function createTransferAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const state = await createTransferInternal(formData);
  if (state.ok) redirect("/transactions");
  return state;
}

/** Dialog variant: same mutation, typed result, no redirect. */
export async function createTransferDialogAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  return createTransferInternal(formData);
}

const valuationSchema = z.object({
  accountId: z.string().uuid(),
  date: z.string().min(8),
  amount: z.string().min(1),
  kind: z.enum(["current", "reconciliation", "opening"])
});

export async function recordValuationAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const parsed = valuationSchema.safeParse(formValues(formData));
  if (!parsed.success)
    return { ok: false, error: "Check the highlighted fields.", code: "validation.failed" };
  const input = parsed.data;
  return runAction("valuation.record", async () => {
    const actor = await assertActor();
    const currency = await currencyFor(input.accountId);
    const { recalculateAccount } = await import("@/server/domain/balances");
    await withTransaction(async (tx) => {
      await valuationsSvc.recordValuation(tx, actor, {
        accountId: input.accountId,
        date: input.date,
        amountDisplayMinor: parseAmountToMinor(input.amount, currency),
        kind: input.kind
      });
      await recalculateAccount(tx, input.accountId, input.date);
    });
    revalidatePath(`/accounts/${input.accountId}`);
    revalidatePath("/");
    return undefined;
  });
}

const updateValuationSchema = z.object({
  entryId: z.string().uuid(),
  date: z.string().min(8),
  amount: z.string().min(1),
  kind: z.enum(["current", "reconciliation", "opening"])
});

async function valuationAccount(entryId: string): Promise<{ accountId: string; currency: string }> {
  const res = await getDb().execute<{ account_id: string; currency: string }>(
    sql`SELECT e.account_id, a.currency FROM entries e JOIN accounts a ON a.id = e.account_id WHERE e.id = ${entryId} AND e.entryable_type = 'valuation'`
  );
  const row = (res.rows ?? [])[0];
  if (!row) throw errors.notFound("Valuation");
  return { accountId: row.account_id, currency: row.currency };
}

export async function updateValuationAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const parsed = updateValuationSchema.safeParse(formValues(formData));
  if (!parsed.success)
    return { ok: false, error: "Check the highlighted fields.", code: "validation.failed" };
  const input = parsed.data;
  return runAction("valuation.update", async () => {
    const actor = await assertActor();
    const { accountId, currency } = await valuationAccount(input.entryId);
    const { recalculateAccount } = await import("@/server/domain/balances");
    await withTransaction(async (tx) => {
      const result = await valuationsSvc.updateValuation(tx, actor, {
        entryId: input.entryId,
        date: input.date,
        amountDisplayMinor: parseAmountToMinor(input.amount, currency),
        kind: input.kind
      });
      const from = result.previousDate < result.date ? result.previousDate : result.date;
      await recalculateAccount(tx, result.accountId, from);
    });
    revalidatePath(`/accounts/${accountId}`);
    revalidatePath("/");
    return undefined;
  });
}

export async function deleteValuationAction(formData: FormData): Promise<void> {
  const entryId = String(formData.get("entryId") ?? "");
  if (!entryId) return;
  const actor = await assertActor();
  const { recalculateAccount } = await import("@/server/domain/balances");
  let accountId = "";
  await withTransaction(async (tx) => {
    const result = await valuationsSvc.deleteValuation(tx, actor, entryId);
    accountId = result.accountId;
    await recalculateAccount(tx, result.accountId, result.date);
  });
  if (accountId) {
    revalidatePath(`/accounts/${accountId}`);
    revalidatePath("/");
  }
}

// --- Manual portfolio holdings -------------------------------------------------
// The holdings domain keeps the account balance in sync itself (it upserts
// today's portfolio valuation and recalculates), so these actions only map
// form fields — prices arrive in major units and convert with the account
// currency, exactly like the valuation actions above.

function optionalPriceMinor(value: string | undefined, currency: string): number | null {
  if (value === undefined || value.trim() === "") return null;
  return parseAmountToMinor(value, currency);
}

const addHoldingSchema = z.object({
  accountId: z.string().uuid(),
  ticker: z.string().min(1).max(64),
  companyName: z.string().optional(),
  quantity: z.string().min(1),
  averageCost: z.string().optional(),
  currentPrice: z.string().optional()
});

export async function addHoldingAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const parsed = addHoldingSchema.safeParse(formValues(formData));
  if (!parsed.success)
    return { ok: false, error: "Check the highlighted fields.", code: "validation.failed" };
  const input = parsed.data;
  return runAction("holding.add", async () => {
    const actor = await assertActor();
    const currency = await currencyFor(input.accountId);
    await withTransaction((tx) =>
      holdingsSvc.addHolding(tx, actor, {
        accountId: input.accountId,
        ticker: input.ticker,
        companyName: optionalString(input.companyName),
        quantity: input.quantity,
        averageCostMinor: optionalPriceMinor(input.averageCost, currency),
        currentPriceMinor: optionalPriceMinor(input.currentPrice, currency)
      })
    );
    revalidatePath(`/accounts/${input.accountId}`);
    revalidatePath("/");
    return undefined;
  });
}

const updateHoldingSchema = z.object({
  accountId: z.string().uuid(),
  holdingId: z.string().uuid(),
  companyName: z.string().optional(),
  quantity: z.string().min(1),
  averageCost: z.string().optional(),
  currentPrice: z.string().optional(),
  // Present (value "true") only when the user checks "Apply this average
  // cost to all shares" on a partial-cost position.
  costCoversAllShares: z.string().optional()
});

export async function updateHoldingAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const parsed = updateHoldingSchema.safeParse(formValues(formData));
  if (!parsed.success)
    return { ok: false, error: "Check the highlighted fields.", code: "validation.failed" };
  const input = parsed.data;
  return runAction("holding.update", async () => {
    const actor = await assertActor();
    const currency = await currencyFor(input.accountId);
    await withTransaction((tx) =>
      holdingsSvc.updateHolding(tx, actor, {
        accountId: input.accountId,
        holdingId: input.holdingId,
        companyName: optionalString(input.companyName),
        quantity: input.quantity,
        averageCostMinor: optionalPriceMinor(input.averageCost, currency),
        currentPriceMinor: optionalPriceMinor(input.currentPrice, currency),
        costCoversAllShares: input.costCoversAllShares === "true"
      })
    );
    revalidatePath(`/accounts/${input.accountId}`);
    revalidatePath("/");
    return undefined;
  });
}

export async function deleteHoldingAction(formData: FormData): Promise<void> {
  const accountId = String(formData.get("accountId") ?? "");
  const holdingId = String(formData.get("holdingId") ?? "");
  if (!accountId || !holdingId) return;
  const actor = await assertActor();
  await withTransaction((tx) => holdingsSvc.deleteHolding(tx, actor, { accountId, holdingId }));
  revalidatePath(`/accounts/${accountId}`);
  revalidatePath("/");
}

const adjustHoldingSchema = z.object({
  accountId: z.string().uuid(),
  ticker: z.string().min(1).max(64),
  side: z.enum(["buy", "sell"]),
  quantity: z.string().min(1),
  price: z.string().min(1)
});

export async function adjustHoldingAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const parsed = adjustHoldingSchema.safeParse(formValues(formData));
  if (!parsed.success)
    return { ok: false, error: "Check the highlighted fields.", code: "validation.failed" };
  const input = parsed.data;
  return runAction("holding.adjust", async () => {
    const actor = await assertActor();
    const currency = await currencyFor(input.accountId);
    await withTransaction((tx) =>
      holdingsSvc.adjustHolding(tx, actor, {
        accountId: input.accountId,
        ticker: input.ticker,
        side: input.side,
        quantity: input.quantity,
        priceMinor: parseAmountToMinor(input.price, currency)
      })
    );
    revalidatePath(`/accounts/${input.accountId}`);
    revalidatePath("/");
    return undefined;
  });
}

export async function importHoldingsCsvAction(
  _prev: ActionState<HoldingsImportResult> | undefined,
  formData: FormData
): Promise<ActionState<HoldingsImportResult>> {
  const accountId = String(formData.get("accountId") ?? "");
  const file = formData.get("csv");
  return runAction<HoldingsImportResult>("holding.import_csv", async () => {
    const actor = await assertActor();
    if (!accountId) throw errors.validation("Choose an account.");
    if (!(file instanceof File) || file.size === 0) {
      throw errors.validation("Choose a CSV file to import.");
    }
    const text = await file.text();
    const result = await withTransaction((tx) => importHoldingsCsv(tx, actor, accountId, text));
    revalidatePath(`/accounts/${accountId}`);
    revalidatePath("/");
    return result;
  });
}
