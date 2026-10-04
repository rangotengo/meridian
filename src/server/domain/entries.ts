import { caseInsensitiveLike } from "@/server/db/dialect";
import { and, asc, desc, eq, exists, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { chunkParams, chunkRows } from "../db/params";
import { accounts, categories, entries, tags, transactionTags, transactions } from "../db/schema";
import type { Actor } from "../auth/context";
import {
  assertAccountAccess,
  assertAccountAccessLevel,
  assertAccountOpen,
  canEditCore,
  type AccountRow
} from "../authorization/access";
import { errors } from "@/lib/errors";
import { addMinor } from "@/lib/money";
import { isIsoDate } from "@/lib/datetime";
import { recordAudit } from "../observability/audit";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidUuid(id: unknown): id is string {
  return typeof id === "string" && UUID_REGEX.test(id);
}

export const MAX_NAME_LENGTH = 240;
export const MAX_NOTES_LENGTH = 5000;
export const MAX_MERCHANT_LENGTH = 120;

export type TransactionEntryInput = {
  accountId: string;
  date: string;
  amountLedgerMinor: number;
  name: string;
  notes?: string | null;
  merchant?: string | null;
  categoryId?: string | null;
  tagIds?: string[];
  externalSource?: string | null;
  externalId?: string | null;
};

function validateEntryBasics(input: { date: string; name: string; amountLedgerMinor: number }) {
  if (!isIsoDate(input.date)) throw errors.validation("Date must be in YYYY-MM-DD format.");
  const name = input.name.trim();
  if (!name) throw errors.validation("A description is required.");
  if (name.length > MAX_NAME_LENGTH) throw errors.validation("Description is too long.");
  if (input.amountLedgerMinor === 0) throw errors.validation("Amount cannot be zero.");
  try {
    addMinor(0, input.amountLedgerMinor);
  } catch {
    throw errors.validation("Amount is outside the supported range.");
  }
}

async function assertCategoryInFamily(exec: Executor, familyId: string, categoryId: string | null) {
  if (!categoryId) return null;
  const [row] = await exec.select().from(categories).where(eq(categories.id, categoryId)).limit(1);
  if (!row || row.familyId !== familyId) throw errors.validation("Unknown category.");
  return row.id;
}

async function assertTagsInFamily(exec: Executor, familyId: string, tagIds: string[]) {
  if (tagIds.length === 0) return [];
  const rows: { id: string }[] = [];
  for (const chunk of chunkParams(tagIds)) {
    const matched = await exec
      .select({ id: tags.id })
      .from(tags)
      .where(and(inArray(tags.id, chunk), eq(tags.familyId, familyId)));
    rows.push(...matched);
  }
  if (rows.length !== new Set(tagIds).size) throw errors.validation("Unknown tag.");
  return rows.map((r) => r.id);
}

export async function createTransactionEntry(
  exec: Executor,
  actor: Actor,
  input: TransactionEntryInput
): Promise<{ entryId: string; duplicated: boolean }> {
  const { account } = await assertAccountOpen(exec, actor, input.accountId, "manage");
  validateEntryBasics(input);
  if (account.status !== "active") throw errors.conflict("Account is closed.");

  const existing = await findByExternalId(exec, input);
  if (existing) return { entryId: existing, duplicated: true };

  const categoryId = await assertCategoryInFamily(exec, actor.familyId, input.categoryId ?? null);
  const tagIds = await assertTagsInFamily(exec, actor.familyId, input.tagIds ?? []);

  const entryId = await exec.transaction(async (tx) => {
    const [entry] = await tx
      .insert(entries)
      .values({
        accountId: account.id,
        date: input.date,
        amountMinor: input.amountLedgerMinor,
        currency: account.currency,
        name: input.name.trim(),
        notes: sanitizeOptionalText(input.notes, MAX_NOTES_LENGTH),
        externalSource: input.externalSource ?? null,
        externalId: input.externalId ?? null,
        entryableType: "transaction"
      })
      .returning({ id: entries.id });
    const eid = entry?.id;
    if (!eid) throw errors.conflict("Failed to create entry.");
    await tx.insert(transactions).values({
      entryId: eid,
      categoryId,
      merchant: sanitizeOptionalText(input.merchant, MAX_MERCHANT_LENGTH)
    });
    if (tagIds.length > 0) {
      const [txn] = await tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.entryId, eid))
        .limit(1);
      if (!txn) throw errors.conflict("Failed to create transaction for tags.");
      for (const chunk of chunkRows(tagIds, 2)) {
        await tx
          .insert(transactionTags)
          .values(chunk.map((tagId) => ({ transactionId: txn.id, tagId })));
      }
    }
    return eid;
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "entry.created",
    entityType: "entry",
    entityId: entryId
  });

  return { entryId, duplicated: false };
}

async function findByExternalId(
  exec: Executor,
  input: Pick<TransactionEntryInput, "accountId" | "externalSource" | "externalId">
): Promise<string | null> {
  if (!input.externalId) return null;
  const [row] = await exec
    .select({ id: entries.id })
    .from(entries)
    .where(
      and(
        eq(entries.accountId, input.accountId),
        eq(entries.externalId, input.externalId),
        input.externalSource
          ? eq(entries.externalSource, input.externalSource)
          : sql`external_source IS NULL`
      )
    )
    .limit(1);
  return row?.id ?? null;
}

function sanitizeOptionalText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw errors.validation(`Text exceeds ${max} characters.`);
  return trimmed;
}

export type EntryUpdatePatch = {
  date?: string;
  name?: string;
  amountLedgerMinor?: number;
  notes?: string | null;
  merchant?: string | null;
  categoryId?: string | null;
  replaceTagIds?: string[] | null;
};

export async function updateTransactionEntry(
  exec: Executor,
  actor: Actor,
  entryId: string,
  patch: EntryUpdatePatch
): Promise<{ oldDate: string; newDate: string }> {
  const loaded = await loadTransactionEntry(exec, actor, entryId);
  const { entry, account, level } = loaded;

  if (account.status !== "active") {
    throw errors.conflict("This account is closed and can no longer be modified.");
  }

  const touchesCore =
    patch.date !== undefined || patch.name !== undefined || patch.amountLedgerMinor !== undefined;
  if (touchesCore && !canEditCore(level)) {
    throw errors.forbidden("Your access level does not allow editing amounts or dates.");
  }

  const touchesAnnotations =
    patch.notes !== undefined ||
    patch.merchant !== undefined ||
    patch.categoryId !== undefined ||
    patch.replaceTagIds != null;
  if (touchesAnnotations && level === "read_only") {
    throw errors.forbidden("Your access level does not allow annotating transactions.");
  }

  const [txn] = await exec
    .select({ transferId: transactions.transferId })
    .from(transactions)
    .where(eq(transactions.entryId, entryId))
    .limit(1);
  if (txn?.transferId && (patch.amountLedgerMinor !== undefined || patch.date !== undefined)) {
    throw errors.conflict(
      "Cannot edit amount or date of a linked transfer leg. Unlink the transfer first."
    );
  }

  const [splitCount] = await exec
    .select({ count: sql<number>`CAST(count(*) AS INTEGER)` })
    .from(entries)
    .where(eq(entries.parentEntryId, entryId));
  const isSplitParent = (splitCount?.count ?? 0) > 0;

  if (
    isSplitParent &&
    patch.amountLedgerMinor !== undefined &&
    patch.amountLedgerMinor !== entry.amountMinor
  ) {
    throw errors.conflict(
      "Cannot edit amount of a split parent directly. Unsplit the transaction first."
    );
  }

  if (entry.parentEntryId) {
    const [parent] = await exec
      .select()
      .from(entries)
      .where(eq(entries.id, entry.parentEntryId))
      .limit(1);
    if (parent) {
      if (patch.date !== undefined && patch.date !== parent.date) {
        throw errors.validation("Split child date must match parent transaction date.");
      }
      if (patch.amountLedgerMinor !== undefined && patch.amountLedgerMinor !== entry.amountMinor) {
        const otherChildren = await exec
          .select({ amountMinor: entries.amountMinor })
          .from(entries)
          .where(
            and(eq(entries.parentEntryId, entry.parentEntryId), sql`${entries.id} != ${entryId}`)
          );
        const otherSum = otherChildren.reduce((acc, c) => acc + c.amountMinor, 0);
        if (otherSum + patch.amountLedgerMinor !== parent.amountMinor) {
          throw errors.validation("Split parts must sum exactly to the parent transaction amount.");
        }
      }
    }
  }

  if (patch.amountLedgerMinor !== undefined) {
    if (patch.amountLedgerMinor === 0) throw errors.validation("Amount cannot be zero.");
    addMinor(0, patch.amountLedgerMinor);
  }
  if (patch.date !== undefined && !isIsoDate(patch.date)) {
    throw errors.validation("Date must be in YYYY-MM-DD format.");
  }
  if (patch.name !== undefined && !patch.name.trim()) {
    throw errors.validation("A description is required.");
  }
  if (patch.categoryId !== undefined) {
    await assertCategoryInFamily(exec, actor.familyId, patch.categoryId);
  }
  let tagIds: string[] | undefined;
  if (patch.replaceTagIds != null) {
    tagIds = await assertTagsInFamily(exec, actor.familyId, patch.replaceTagIds);
  }

  const oldDate = entry.date;
  const newDate = patch.date ?? entry.date;

  await exec.transaction(async (tx) => {
    await tx
      .update(entries)
      .set({
        ...(patch.date !== undefined ? { date: patch.date } : {}),
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.amountLedgerMinor !== undefined ? { amountMinor: patch.amountLedgerMinor } : {}),
        ...(patch.notes !== undefined
          ? { notes: sanitizeOptionalText(patch.notes, MAX_NOTES_LENGTH) }
          : {}),
        updatedAt: new Date()
      })
      .where(eq(entries.id, entryId));

    if (isSplitParent && patch.date !== undefined) {
      await tx.update(entries).set({ date: patch.date }).where(eq(entries.parentEntryId, entryId));
    }

    const txnSet: Partial<typeof transactions.$inferInsert> = {};
    if (patch.categoryId !== undefined) txnSet.categoryId = patch.categoryId;
    if (patch.merchant !== undefined) {
      txnSet.merchant = sanitizeOptionalText(patch.merchant, MAX_MERCHANT_LENGTH);
    }
    if (Object.keys(txnSet).length > 0) {
      await tx.update(transactions).set(txnSet).where(eq(transactions.entryId, entryId));
    }

    if (tagIds) {
      await tx
        .delete(transactionTags)
        .where(sql`transaction_id IN (SELECT id FROM transactions WHERE entry_id = ${entryId})`);
      if (tagIds.length > 0) {
        const [txn] = await tx
          .select({ id: transactions.id })
          .from(transactions)
          .where(eq(transactions.entryId, entryId))
          .limit(1);
        if (txn) {
          for (const chunk of chunkRows(tagIds, 2)) {
            await tx
              .insert(transactionTags)
              .values(chunk.map((tagId) => ({ transactionId: txn.id, tagId })));
          }
        }
      }
    }
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "entry.updated",
    entityType: "entry",
    entityId: entryId
  });

  void account;
  return { oldDate, newDate };
}

type LoadedEntry = {
  entry: typeof entries.$inferSelect;
  account: AccountRow;
  level: "full_control" | "read_write" | "read_only";
};

export async function loadTransactionEntry(
  exec: Executor,
  actor: Actor,
  entryId: string
): Promise<LoadedEntry> {
  const [row] = await exec
    .select({ entry: entries, account: accounts })
    .from(entries)
    .innerJoin(accounts, eq(accounts.id, entries.accountId))
    .where(and(eq(entries.id, entryId), eq(entries.entryableType, "transaction")))
    .limit(1);
  if (!row || row.account.familyId !== actor.familyId) throw errors.notFound("Transaction");
  const level = await assertAccountAccessLevel(exec, actor, row.account.id);
  return { entry: row.entry, account: row.account, level };
}

export async function deleteEntry(exec: Executor, actor: Actor, entryId: string): Promise<void> {
  const [row] = await exec
    .select({ entry: entries, account: accounts })
    .from(entries)
    .innerJoin(accounts, eq(accounts.id, entries.accountId))
    .where(eq(entries.id, entryId))
    .limit(1);
  if (!row || row.account.familyId !== actor.familyId) throw errors.notFound("Transaction");

  if (row.account.status !== "active") {
    throw errors.conflict("This account is closed and its transactions cannot be deleted.");
  }

  await assertAccountAccess(exec, actor, row.account.id, "manage");

  if (row.entry.parentEntryId) {
    throw errors.conflict(
      "Cannot delete an individual split part directly. Unsplit the transaction instead."
    );
  }

  const [txn] = await exec
    .select({ transferId: transactions.transferId })
    .from(transactions)
    .where(eq(transactions.entryId, entryId))
    .limit(1);
  const linkedTransfer = txn?.transferId ?? null;

  const [childCount] = await exec
    .select({ count: sql<number>`CAST(count(*) AS INTEGER)` })
    .from(entries)
    .where(eq(entries.parentEntryId, entryId));

  await exec.transaction(async (tx) => {
    if (linkedTransfer) {
      await tx.execute(sql`DELETE FROM transfers WHERE id = ${linkedTransfer}`);
    }
    await tx.delete(entries).where(eq(entries.parentEntryId, entryId));
    await tx.delete(entries).where(eq(entries.id, entryId));
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "entry.deleted",
    entityType: "entry",
    entityId: entryId,
    metadata: { hadChildren: (childCount?.count ?? 0) > 0, wasTransferLeg: !!linkedTransfer }
  });
}

export type EntryListFilters = {
  accountId?: string;
  categoryId?: string;
  tagId?: string;
  search?: string;
  kind?: "expense" | "income" | "transfer";
  from?: string;
  to?: string;
  cursor?: { date: string; id: string } | null;
  direction?: "next" | "prev";
  limit?: number;
};

export type EntryListItem = {
  id: string;
  date: string;
  name: string;
  amountMinor: number;
  currency: string;
  accountId: string;
  accountName: string;
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  merchant: string | null;
  notes: string | null;
  transferId: string | null;
  parentId: string | null;
  hasChildren: boolean;
  tagIds: string[];
};

const LEAF = sql`NOT EXISTS (SELECT 1 FROM entries child WHERE child.parent_entry_id = entries.id)`;

export async function listEntriesPage(
  exec: Executor,
  actor: Actor,
  filters: EntryListFilters
): Promise<{
  items: EntryListItem[];
  nextCursor: { date: string; id: string } | null;
  hasPrevious: boolean;
}> {
  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
  const goingPrev = filters.direction === "prev" && Boolean(filters.cursor);
  const conditions = [
    eq(entries.entryableType, "transaction"),
    eq(accounts.familyId, actor.familyId),
    sql`(
      accounts.owner_id IS NULL
      OR accounts.owner_id = ${actor.userId}
      OR EXISTS (
        SELECT 1 FROM account_shares s
        WHERE s.account_id = accounts.id AND s.user_id = ${actor.userId}
      )
    )`
  ];

  if (filters.accountId && isValidUuid(filters.accountId))
    conditions.push(eq(entries.accountId, filters.accountId));
  if (filters.categoryId && isValidUuid(filters.categoryId))
    conditions.push(eq(transactions.categoryId, filters.categoryId));
  if (filters.tagId && isValidUuid(filters.tagId)) {
    conditions.push(
      exists(
        sql`SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id = ${transactions.id} AND tt.tag_id = ${filters.tagId}`
      )
    );
  }
  if (filters.search) {
    const pattern = `%${filters.search}%`;
    conditions.push(
      or(
        caseInsensitiveLike(entries.name, pattern),
        caseInsensitiveLike(entries.notes, pattern),
        caseInsensitiveLike(transactions.merchant, pattern)
      )!
    );
  }
  if (filters.kind === "expense") {
    conditions.push(sql`${transactions.transferId} IS NULL`, sql`${entries.amountMinor} > 0`, LEAF);
  } else if (filters.kind === "income") {
    conditions.push(sql`${transactions.transferId} IS NULL`, sql`${entries.amountMinor} < 0`, LEAF);
  } else if (filters.kind === "transfer") {
    conditions.push(sql`${transactions.transferId} IS NOT NULL`);
  } else {
    conditions.push(LEAF);
  }
  if (filters.from && isIsoDate(filters.from)) conditions.push(gte(entries.date, filters.from));
  if (filters.to && isIsoDate(filters.to)) conditions.push(lte(entries.date, filters.to));
  if (filters.cursor && isIsoDate(filters.cursor.date) && isValidUuid(filters.cursor.id)) {
    if (goingPrev) {
      conditions.push(
        sql`(${entries.date}, ${entries.id}) > (${filters.cursor.date}, ${filters.cursor.id})`
      );
    } else {
      conditions.push(
        sql`(${entries.date}, ${entries.id}) < (${filters.cursor.date}, ${filters.cursor.id})`
      );
    }
  }

  const orderBy = goingPrev
    ? [asc(entries.date), asc(entries.id)]
    : [desc(entries.date), desc(entries.id)];

  const rows = await exec
    .select({
      id: entries.id,
      date: entries.date,
      name: entries.name,
      amountMinor: entries.amountMinor,
      currency: entries.currency,
      accountId: entries.accountId,
      accountName: accounts.name,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      categoryColor: categories.color,
      merchant: transactions.merchant,
      notes: entries.notes,
      transferId: transactions.transferId,
      parentId: entries.parentEntryId
    })
    .from(entries)
    .innerJoin(accounts, eq(accounts.id, entries.accountId))
    .innerJoin(transactions, eq(transactions.entryId, entries.id))
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(...conditions))
    .orderBy(...orderBy)
    .limit(limit + 1);

  const extra = rows.length > limit;
  const slice = rows.slice(0, limit);
  const page = goingPrev ? [...slice].reverse() : slice;
  const hasNext = goingPrev ? Boolean(filters.cursor) : extra;
  const hasPrevious = goingPrev ? extra : Boolean(filters.cursor);
  const nextCursor =
    hasNext && page.length > 0
      ? { date: page[page.length - 1]!.date, id: page[page.length - 1]!.id }
      : null;

  // Chunk the IN(...) list: cloud SQLite caps a statement at 100 parameters.
  const tagRows: { rows: { entry_id: string; tag_id: string | null }[] } = { rows: [] };
  for (const idChunk of chunkParams(page.map((p) => p.id))) {
    const res = await exec.execute<{ entry_id: string; tag_id: string | null }>(sql`
      SELECT e.id AS entry_id, tt.tag_id AS tag_id
      FROM entries e
      JOIN transactions t ON t.entry_id = e.id
      LEFT JOIN transaction_tags tt ON tt.transaction_id = t.id
      WHERE e.id IN (${sql.join(
        idChunk.map((id) => sql`${id}`),
        sql`, `
      )})
    `);
    tagRows.rows.push(...(res.rows ?? []));
  }

  const tagsByEntry = new Map<string, string[]>();
  for (const r of tagRows.rows ?? []) {
    if (r.tag_id) tagsByEntry.set(r.entry_id, [...(tagsByEntry.get(r.entry_id) ?? []), r.tag_id]);
  }

  return {
    items: page.map((r) => ({
      ...r,
      hasChildren: false,
      tagIds: tagsByEntry.get(r.id) ?? []
    })),
    nextCursor,
    hasPrevious
  };
}

export { listEntriesPage as listEntries };

export type EntryDetail = Awaited<ReturnType<typeof getEntryDetail>>;

export async function getEntryDetail(exec: Executor, actor: Actor, entryId: string) {
  const loaded = await loadTransactionEntry(exec, actor, entryId);
  const { entry, account, level } = loaded;

  const [txn] = await exec
    .select({
      id: transactions.id,
      categoryId: transactions.categoryId,
      merchant: transactions.merchant,
      transferId: transactions.transferId
    })
    .from(transactions)
    .where(eq(transactions.entryId, entryId))
    .limit(1);

  const tagRows = await exec
    .select({ tagId: transactionTags.tagId })
    .from(transactionTags)
    .innerJoin(transactions, eq(transactions.id, transactionTags.transactionId))
    .where(eq(transactions.entryId, entryId));

  const children = await exec
    .select({
      id: entries.id,
      name: entries.name,
      amountMinor: entries.amountMinor,
      date: entries.date
    })
    .from(entries)
    .where(eq(entries.parentEntryId, entryId))
    .orderBy(asc(entries.createdAt));

  let transferPartner: {
    direction: "outflow" | "inflow";
    accountName: string;
    amountMinor: number;
  } | null = null;
  if (txn?.transferId) {
    const isOutflow = entry.amountMinor > 0;
    const partnerCol = isOutflow ? "inflow_entry_id" : "outflow_entry_id";
    const res = await exec.execute<{ account_name: string; amount_minor: string }>(sql`
      SELECT a.name AS account_name, CAST(e.amount_minor AS TEXT) AS amount_minor
      FROM transfers tr
      JOIN entries e ON e.id = tr.${sql.raw(partnerCol)}
      JOIN accounts a ON a.id = e.account_id
      WHERE tr.id = ${txn.transferId}
    `);
    const partner = res.rows?.[0];
    if (partner) {
      transferPartner = {
        direction: isOutflow ? "outflow" : "inflow",
        accountName: partner.account_name,
        amountMinor: Number(partner.amount_minor)
      };
    }
  }

  return {
    entry: {
      id: entry.id,
      date: entry.date,
      name: entry.name,
      notes: entry.notes,
      amountMinor: entry.amountMinor,
      currency: entry.currency,
      externalSource: entry.externalSource,
      externalId: entry.externalId,
      accountId: entry.accountId,
      accountName: account.name,
      merchant: txn?.merchant ?? null,
      categoryId: txn?.categoryId ?? null,
      tagIds: tagRows.map((t) => t.tagId),
      transferId: txn?.transferId ?? null,
      transferPartner,
      parentId: entry.parentEntryId
    },
    account: { id: account.id, name: account.name, type: account.type, status: account.status },
    level,
    categoryId: txn?.categoryId ?? null,
    merchant: txn?.merchant ?? null,
    tagIds: tagRows.map((t) => t.tagId),
    transferId: txn?.transferId ?? null,
    transferPartner,
    parentId: entry.parentEntryId,
    children
  };
}

export async function entryExists(exec: Executor, entryId: string): Promise<boolean> {
  const [row] = await exec
    .select({ id: entries.id })
    .from(entries)
    .where(eq(entries.id, entryId))
    .limit(1);
  return !!row;
}
