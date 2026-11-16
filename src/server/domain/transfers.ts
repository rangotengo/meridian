import { dateDistance } from "@/server/db/dialect";
import { eq, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { accounts, entries, transactions, transfers } from "../db/schema";
import type { Actor } from "../auth/context";
import { assertAccountOpen, getAccountAccess } from "../authorization/access";
import { errors } from "@/lib/errors";
import { addMinor, negateMinor } from "@/lib/money";
import { diffDays, isIsoDate } from "@/lib/datetime";
import { recordAudit } from "../observability/audit";
import { lockHoldingsAccount } from "./holdings";

export const TRANSFER_DATE_WINDOW_DAYS = 4;

export async function createTransferFromTransactions(
  exec: Executor,
  actor: Actor,
  outflowEntryId: string,
  inflowEntryId: string
): Promise<{ transferId: string; existing: boolean }> {
  // Account ids only discover the locks; all entry/permission/amount
  // checks run after acquiring them. A mode switch can restate an
  // opening adjustment, so a link must not commit using amounts read
  // before that switch. Lock both accounts in a consistent order.
  const rows = await exec
    .select({ accountId: entries.accountId })
    .from(entries)
    .where(sql`${entries.id} IN (${outflowEntryId}, ${inflowEntryId})`);
  return exec.transaction(async (tx) => {
    for (const accountId of [...new Set(rows.map((row) => row.accountId))].sort()) {
      await lockHoldingsAccount(tx, accountId);
    }
    return linkTransferUnderAccountLocks(tx, actor, outflowEntryId, inflowEntryId);
  });
}

async function linkTransferUnderAccountLocks(
  exec: Executor,
  actor: Actor,
  outflowEntryId: string,
  inflowEntryId: string
): Promise<{ transferId: string; existing: boolean }> {
  if (outflowEntryId === inflowEntryId) {
    throw errors.validation("A transfer needs two different transactions.");
  }

  const rows = await exec
    .select({ entry: entries, account: accounts })
    .from(entries)
    .innerJoin(accounts, eq(accounts.id, entries.accountId))
    .where(sql`${entries.id} IN (${outflowEntryId}, ${inflowEntryId})`);

  const outRow = rows.find((r) => r.entry.id === outflowEntryId);
  const inRow = rows.find((r) => r.entry.id === inflowEntryId);
  if (!outRow || !inRow) throw errors.notFound("Transaction");

  for (const row of [outRow, inRow]) {
    if (row.account.familyId !== actor.familyId) throw errors.notFound("Transaction");
    await assertAccountOpen(exec, actor, row.account.id, "manage");
  }
  if (outRow.account.familyId !== inRow.account.familyId) {
    throw errors.validation("Transfer legs must belong to the same family.");
  }
  if (outRow.entry.entryableType !== "transaction" || inRow.entry.entryableType !== "transaction") {
    throw errors.validation("Only transactions can be linked as a transfer.");
  }
  if (outRow.entry.parentEntryId || inRow.entry.parentEntryId) {
    throw errors.validation(
      "Split parts cannot be linked as transfers. Split the whole transaction instead."
    );
  }

  const [splitChildren] = await exec
    .select({ count: sql<number>`CAST(count(*) AS INTEGER)` })
    .from(entries)
    .where(sql`${entries.parentEntryId} IN (${outflowEntryId}, ${inflowEntryId})`);
  if ((splitChildren?.count ?? 0) > 0) {
    throw errors.validation("Split transactions cannot be linked as transfers.");
  }

  if (outRow.account.id === inRow.account.id) {
    throw errors.validation("A transfer must move between two different accounts.");
  }
  if (outRow.account.currency !== inRow.account.currency) {
    throw errors.validation("Cross-currency transfers are not supported yet.");
  }

  const out = outRow.entry;
  const inn = inRow.entry;
  if (out.amountMinor <= 0 || inn.amountMinor >= 0) {
    throw errors.validation(
      "A transfer must link one outflow (positive amount) and one inflow (negative amount)."
    );
  }

  const [existingTransfer] = await exec
    .select({ id: transfers.id })
    .from(transfers)
    .where(
      sql`${transfers.outflowEntryId} = ${outflowEntryId} AND ${transfers.inflowEntryId} = ${inflowEntryId}`
    )
    .limit(1);
  if (existingTransfer) {
    return { transferId: existingTransfer.id, existing: true };
  }

  if (addMinor(out.amountMinor, inn.amountMinor) !== 0) {
    throw errors.validation("Transfer amounts must match exactly.");
  }
  const dateGap = Math.abs(diffDays(out.date, inn.date));
  if (dateGap > TRANSFER_DATE_WINDOW_DAYS) {
    throw errors.validation(
      `Transactions are ${dateGap} days apart; transfers must fall within ${TRANSFER_DATE_WINDOW_DAYS} days.`
    );
  }

  const [txOut] = await exec
    .select()
    .from(transactions)
    .where(eq(transactions.entryId, outflowEntryId))
    .limit(1);
  const [txIn] = await exec
    .select()
    .from(transactions)
    .where(eq(transactions.entryId, inflowEntryId))
    .limit(1);
  if (!txOut || !txIn) throw errors.notFound("Transaction");

  const transferId = await exec.transaction(async (tx) => {
    const [transfer] = await tx
      .insert(transfers)
      .values({ outflowEntryId, inflowEntryId, status: "confirmed" })
      .returning({ id: transfers.id });
    const id = transfer!.id;
    await tx.update(transactions).set({ transferId: id }).where(eq(transactions.id, txOut.id));
    await tx.update(transactions).set({ transferId: id }).where(eq(transactions.id, txIn.id));
    return id;
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "transfer.linked",
    entityType: "transfer",
    entityId: transferId,
    metadata: { outflowEntryId, inflowEntryId }
  });

  return { transferId, existing: false };
}

export type CreateTransferInput = {
  fromAccountId: string;
  toAccountId: string;
  amountDisplayMinor: number;
  date: string;
  name?: string;
};

export async function createTransferWithNewEntries(
  exec: Executor,
  actor: Actor,
  input: CreateTransferInput
): Promise<{ transferId: string; outflowEntryId: string; inflowEntryId: string }> {
  if (input.fromAccountId === input.toAccountId) {
    throw errors.validation("Transfers require two different accounts.");
  }
  if (input.amountDisplayMinor <= 0) {
    throw errors.validation("Transfer amount must be greater than zero.");
  }
  if (!isIsoDate(input.date)) throw errors.validation("Date must be in YYYY-MM-DD format.");

  const from = await assertAccountOpen(exec, actor, input.fromAccountId, "manage");
  const to = await assertAccountOpen(exec, actor, input.toAccountId, "manage");
  if (from.account.familyId !== to.account.familyId || from.account.familyId !== actor.familyId) {
    throw errors.validation("Both accounts must belong to your family.");
  }
  if (from.account.currency !== to.account.currency) {
    throw errors.validation("Cross-currency transfers are not supported yet.");
  }

  const currency = from.account.currency;
  const amount = input.amountDisplayMinor;
  const defaultDesc = `Transfer to ${to.account.name}`;
  const defaultInDesc = `Transfer from ${from.account.name}`;
  const outDesc = input.name?.trim() || defaultDesc;
  const inDesc = input.name?.trim() || defaultInDesc;

  const { transferId, outflowEntryId, inflowEntryId } = await exec.transaction(async (tx) => {
    const [outEntry] = await tx
      .insert(entries)
      .values({
        accountId: from.account.id,
        date: input.date,
        amountMinor: amount,
        currency,
        name: outDesc,
        entryableType: "transaction"
      })
      .returning({ id: entries.id });

    const [inEntry] = await tx
      .insert(entries)
      .values({
        accountId: to.account.id,
        date: input.date,
        amountMinor: negateMinor(amount),
        currency,
        name: inDesc,
        entryableType: "transaction"
      })
      .returning({ id: entries.id });

    const [txnOut] = await tx
      .insert(transactions)
      .values({ entryId: outEntry!.id })
      .returning({ id: transactions.id });
    const [txnIn] = await tx
      .insert(transactions)
      .values({ entryId: inEntry!.id })
      .returning({ id: transactions.id });

    const [transfer] = await tx
      .insert(transfers)
      .values({ outflowEntryId: outEntry!.id, inflowEntryId: inEntry!.id, status: "confirmed" })
      .returning({ id: transfers.id });

    await tx
      .update(transactions)
      .set({ transferId: transfer!.id })
      .where(eq(transactions.id, txnOut!.id));
    await tx
      .update(transactions)
      .set({ transferId: transfer!.id })
      .where(eq(transactions.id, txnIn!.id));
    return { transferId: transfer!.id, outflowEntryId: outEntry!.id, inflowEntryId: inEntry!.id };
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "transfer.created",
    entityType: "transfer",
    entityId: transferId,
    metadata: { from: from.account.id, to: to.account.id, amountDisplayMinor: amount }
  });

  return { transferId, outflowEntryId, inflowEntryId };
}

export async function removeTransfer(
  exec: Executor,
  actor: Actor,
  transferId: string
): Promise<void> {
  const [row] = await exec.select().from(transfers).where(eq(transfers.id, transferId)).limit(1);
  if (!row) throw errors.notFound("Transfer");

  const legs = await exec
    .select({ accountId: entries.accountId })
    .from(entries)
    .where(sql`${entries.id} IN (${row.outflowEntryId}, ${row.inflowEntryId})`);

  let familyId: string | null = null;
  for (const leg of legs) {
    const [acc] = await exec.select().from(accounts).where(eq(accounts.id, leg.accountId)).limit(1);
    if (!acc || acc.familyId !== actor.familyId) throw errors.forbidden();
    await assertAccountOpen(exec, actor, acc.id, "manage");
    familyId = actor.familyId;
  }

  await exec.transaction(async (tx) => {
    await tx
      .update(transactions)
      .set({ transferId: null })
      .where(sql`${transactions.entryId} IN (${row.outflowEntryId}, ${row.inflowEntryId})`);
    await tx.delete(transfers).where(eq(transfers.id, transferId));
  });

  if (familyId) {
    await recordAudit(exec, {
      familyId,
      actorUserId: actor.userId,
      action: "transfer.deleted",
      entityType: "transfer",
      entityId: transferId
    });
  }
}

export type TransferCandidate = {
  entryId: string;
  date: string;
  name: string;
  amountMinor: number;
  currency: string;
  accountName: string;
  daysApart: number;
};

export async function findTransferCandidates(
  exec: Executor,
  actor: Actor,
  sourceEntryId: string
): Promise<TransferCandidate[]> {
  const [source] = await exec
    .select({ entry: entries, account: accounts })
    .from(entries)
    .innerJoin(accounts, eq(accounts.id, entries.accountId))
    .where(eq(entries.id, sourceEntryId))
    .limit(1);
  if (!source || source.account.familyId !== actor.familyId) throw errors.notFound("Transaction");
  // Suggestions only exist to offer a link action. An actor who cannot
  // annotate the account (a read_only share) gets no suggestions instead of
  // a forbidden error, so read-only viewers can still open the transaction
  // detail page, which fetches suggestions for every viewer.
  const access = await getAccountAccess(exec, actor, source.account.id);
  if (!access.granted) throw errors.notFound("Account");
  if (access.level === "read_only") return [];

  const targetAmount = negateMinor(source.entry.amountMinor);

  const res = await exec.execute<{
    id: string;
    date: string;
    name: string;
    amount_minor: string;
    currency: string;
    account_name: string;
    days_apart: number;
  }>(sql`
    SELECT CAST(e.id AS TEXT) AS id, CAST(e.date AS TEXT) AS date, e.name, CAST(e.amount_minor AS TEXT) AS amount_minor,
           e.currency, a.name AS account_name,
           CAST(${dateDistance(sql`e.date`, source.entry.date)} AS INTEGER) AS days_apart
    FROM entries e
    JOIN accounts a ON a.id = e.account_id
    JOIN transactions t ON t.entry_id = e.id
    WHERE a.family_id = ${actor.familyId}
      AND e.account_id != ${source.entry.accountId}
      AND e.entryable_type = 'transaction'
      AND e.currency = ${source.entry.currency}
      AND e.amount_minor = ${targetAmount}
      AND t.transfer_id IS NULL
      AND e.parent_entry_id IS NULL
      AND ${dateDistance(sql`e.date`, source.entry.date)} <= ${TRANSFER_DATE_WINDOW_DAYS}
    ORDER BY days_apart ASC, e.date DESC
    LIMIT 6
  `);

  return (res.rows ?? []).map((r) => ({
    entryId: r.id,
    date: r.date.slice(0, 10),
    name: r.name,
    amountMinor: Number(r.amount_minor),
    currency: r.currency,
    accountName: r.account_name,
    daysApart: Number(r.days_apart)
  }));
}

export { findTransferCandidates as suggestTransferMatches };
