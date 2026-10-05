import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { chunkParams, chunkRows } from "../db/params";
import { categories, entries, tags, transactionTags, transactions } from "../db/schema";
import type { Actor } from "../auth/context";
import {
  assertAccountOpen,
  canEditCore,
  assertAccountAccessLevel,
  getAccountAccess
} from "../authorization/access";
import { errors } from "@/lib/errors";
import { addMinor } from "@/lib/money";
import { recordAudit } from "../observability/audit";

export type SplitChildInput = {
  name?: string;
  amountLedgerMinor: number;
  categoryId?: string | null;
  tagIds?: string[];
};

export async function splitEntry(
  exec: Executor,
  actor: Actor,
  parentEntryId: string,
  children: SplitChildInput[]
): Promise<{ createdCount: number }> {
  if (!children || children.length < 2) {
    throw errors.validation("A split needs at least two parts.");
  }
  const [parent] = await exec.select().from(entries).where(eq(entries.id, parentEntryId)).limit(1);
  if (!parent || parent.entryableType !== "transaction") throw errors.notFound("Transaction");

  if (parent.parentEntryId) {
    throw errors.validation("Cannot split a transaction that is already a split part.");
  }

  const access = await getAccountAccess(exec, actor, parent.accountId);
  if (!access.granted) throw errors.notFound("Transaction");
  if (!canEditCore(access.level)) {
    throw errors.forbidden("Your access level does not allow splitting transactions.");
  }
  await assertAccountOpen(exec, actor, parent.accountId, "manage");

  const [txn] = await exec
    .select({
      transferId: transactions.transferId,
      merchant: transactions.merchant
    })
    .from(transactions)
    .where(eq(transactions.entryId, parentEntryId))
    .limit(1);
  if (!txn) throw errors.notFound("Transaction");
  if (txn.transferId) {
    throw errors.conflict("Unlink the transfer before splitting this transaction.");
  }

  const [childCount] = await exec
    .select({ count: sql<number>`CAST(count(*) AS INTEGER)` })
    .from(entries)
    .where(eq(entries.parentEntryId, parentEntryId));
  if ((childCount?.count ?? 0) > 0) {
    throw errors.conflict("This transaction is already split.");
  }

  let sum = 0;
  for (const c of children) {
    if (c.amountLedgerMinor === 0) throw errors.validation("Split parts cannot be zero.");
    try {
      addMinor(0, c.amountLedgerMinor);
    } catch {
      throw errors.validation("A split part is outside the supported range.");
    }
    sum = addMinor(sum, c.amountLedgerMinor);
  }
  if (sum !== parent.amountMinor) {
    throw errors.validation(
      `Split parts must add up to the original amount (difference ${sum - parent.amountMinor} minor units).`
    );
  }

  const categoryIds = children.map((c) => c.categoryId).filter((id): id is string => !!id);
  if (categoryIds.length > 0) {
    const matching: { id: string }[] = [];
    for (const chunk of chunkParams(categoryIds)) {
      const rows = await exec
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.familyId, actor.familyId), inArray(categories.id, chunk)));
      matching.push(...rows);
    }
    if (matching.length !== new Set(categoryIds).size) {
      throw errors.validation("One or more chosen categories do not belong to this family.");
    }
  }

  const allTagIds = Array.from(new Set(children.flatMap((c) => c.tagIds ?? [])));
  if (allTagIds.length > 0) {
    const validTags: { id: string }[] = [];
    for (const chunk of chunkParams(allTagIds)) {
      const rows = await exec
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.familyId, actor.familyId), inArray(tags.id, chunk)));
      validTags.push(...rows);
    }
    if (validTags.length !== allTagIds.length) {
      throw errors.validation("One or more chosen tags do not belong to this family.");
    }
  }

  await exec.transaction(async (tx) => {
    for (const child of children) {
      const [childEntry] = await tx
        .insert(entries)
        .values({
          accountId: parent.accountId,
          parentEntryId: parent.id,
          date: parent.date,
          amountMinor: child.amountLedgerMinor,
          currency: parent.currency,
          name: child.name?.trim() || parent.name,
          notes: parent.notes,
          entryableType: "transaction"
        })
        .returning({ id: entries.id });

      const [childTxn] = await tx
        .insert(transactions)
        .values({
          entryId: childEntry!.id,
          categoryId: child.categoryId ?? null,
          merchant: txn.merchant
        })
        .returning({ id: transactions.id });

      if (child.tagIds && child.tagIds.length > 0) {
        for (const chunk of chunkRows(child.tagIds, 2)) {
          await tx.insert(transactionTags).values(
            chunk.map((tagId) => ({
              transactionId: childTxn!.id,
              tagId
            }))
          );
        }
      }
    }
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "entry.split",
    entityType: "entry",
    entityId: parentEntryId,
    metadata: { parts: children.length }
  });

  return { createdCount: children.length };
}

export async function unsplitEntry(
  exec: Executor,
  actor: Actor,
  parentEntryId: string
): Promise<void> {
  const [parent] = await exec.select().from(entries).where(eq(entries.id, parentEntryId)).limit(1);
  if (!parent || parent.entryableType !== "transaction") throw errors.notFound("Transaction");
  await assertAccountOpen(exec, actor, parent.accountId, "manage");
  const level = await assertAccountAccessLevel(exec, actor, parent.accountId);
  if (!canEditCore(level)) throw errors.forbidden();

  const removed = await exec.transaction(async (tx) => {
    const removedRows = await tx
      .delete(entries)
      .where(eq(entries.parentEntryId, parentEntryId))
      .returning({ id: entries.id });
    if (removedRows.length === 0) {
      throw errors.conflict("This transaction has no split parts.");
    }
    return removedRows.length;
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "entry.unsplit",
    entityType: "entry",
    entityId: parentEntryId,
    metadata: { removedParts: removed }
  });
}

export async function listSplits(exec: Executor, actor: Actor, parentEntryId: string) {
  const loaded = await exec
    .select({ accountId: entries.accountId })
    .from(entries)
    .where(eq(entries.id, parentEntryId))
    .limit(1);
  if (!loaded[0]) throw errors.notFound("Transaction");
  const level = await assertAccountAccessLevel(exec, actor, loaded[0].accountId);
  if (!level) throw errors.forbidden();
  return exec
    .select({
      id: entries.id,
      name: entries.name,
      amountMinor: entries.amountMinor,
      date: entries.date,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      categoryColor: categories.color
    })
    .from(entries)
    .innerJoin(transactions, eq(transactions.entryId, entries.id))
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(eq(entries.parentEntryId, parentEntryId))
    .orderBy(asc(entries.createdAt));
}
