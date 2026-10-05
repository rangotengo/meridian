import { and, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/client";
import { chunkParams } from "../db/params";
import {
  accountShares,
  accounts,
  categories,
  entries,
  exchangeRates,
  families,
  tags,
  transactionTags,
  transactions,
  users,
  valuations
} from "../db/schema";
import type { Actor } from "../auth/context";
import { recordAudit } from "../observability/audit";
import { listAccountsForActor } from "./accounts";

export const EXPORT_VERSION = 1;

type FamilyRow = typeof families.$inferSelect;

export async function buildFamilyExport(exec: Executor, actor: Actor): Promise<FamilyExport> {
  const familyId = actor.familyId;

  const [family] = await exec.select().from(families).where(eq(families.id, familyId)).limit(1);
  if (!family) throw new Error("Family not found");

  const visibleAccounts = await listAccountsForActor(exec, actor);
  const visibleAccountIds = visibleAccounts.map((a) => a.id);

  const categoryRows = await exec
    .select()
    .from(categories)
    .where(eq(categories.familyId, familyId));
  const tagRows = await exec.select().from(tags).where(eq(tags.familyId, familyId));

  // Chunk the IN(...) lists: cloud SQLite caps a statement at 100 parameters.
  const entryRows = [];
  for (const chunk of chunkParams(visibleAccountIds)) {
    const rows = await exec
      .select({
        entry: entries,
        txnCategoryId: transactions.categoryId,
        txnMerchant: transactions.merchant,
        txnTransferId: transactions.transferId,
        valuationKind: valuations.kind
      })
      .from(entries)
      .innerJoin(accounts, eq(accounts.id, entries.accountId))
      .leftJoin(transactions, eq(transactions.entryId, entries.id))
      .leftJoin(valuations, eq(valuations.entryId, entries.id))
      .where(and(eq(accounts.familyId, familyId), inArray(accounts.id, chunk)));
    entryRows.push(...rows);
  }

  const tagLinks = [];
  if (entryRows.length > 0) {
    for (const chunk of chunkParams(visibleAccountIds)) {
      const rows = await exec
        .select({ entryId: entries.id, tagId: transactionTags.tagId })
        .from(transactionTags)
        .innerJoin(transactions, eq(transactions.id, transactionTags.transactionId))
        .innerJoin(entries, eq(entries.id, transactions.entryId))
        .innerJoin(accounts, eq(accounts.id, entries.accountId))
        .where(and(eq(accounts.familyId, familyId), inArray(accounts.id, chunk)));
      tagLinks.push(...rows);
    }
  }

  const memberRows = await exec
    .select({ id: users.id, email: users.email, name: users.name, role: users.familyRole })
    .from(users)
    .where(eq(users.familyId, familyId));

  const shareRows = [];
  for (const chunk of chunkParams(visibleAccountIds)) {
    const rows = await exec
      .select({
        accountId: accountShares.accountId,
        userId: accountShares.userId,
        permission: accountShares.permission
      })
      .from(accountShares)
      .innerJoin(accounts, eq(accounts.id, accountShares.accountId))
      .where(and(eq(accounts.familyId, familyId), inArray(accounts.id, chunk)));
    shareRows.push(...rows);
  }

  const rateRows = await exec.select().from(exchangeRates);

  const tagsByEntry = new Map<string, string[]>();
  for (const link of tagLinks) {
    const list = tagsByEntry.get(link.entryId) ?? [];
    list.push(link.tagId);
    tagsByEntry.set(link.entryId, list);
  }

  await recordAudit(exec, {
    familyId,
    actorUserId: actor.userId,
    action: "family.exported",
    entityType: "family",
    entityId: familyId,
    metadata: { accounts: visibleAccounts.length, entries: entryRows.length }
  });

  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    family: serializeFamily(family, memberRows),
    shares: shareRows,
    accounts: visibleAccounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      subtype: a.subtype,
      institution: a.institution,
      currency: a.currency,
      status: a.status,
      includedInReports: a.includedInReports,
      openingBalanceMinor: a.openingBalanceMinor,
      openedOn: a.openedOn,
      ownerId: a.ownerId
    })),
    categories: categoryRows.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      parentId: c.parentId
    })),
    tags: tagRows.map((t) => ({ id: t.id, name: t.name, color: t.color })),
    entries: entryRows.map(
      ({ entry, txnCategoryId, txnMerchant, txnTransferId, valuationKind }) => ({
        id: entry.id,
        accountId: entry.accountId,
        parentEntryId: entry.parentEntryId,
        date: entry.date,
        amountMinor: entry.amountMinor,
        currency: entry.currency,
        name: entry.name,
        notes: entry.notes,
        externalSource: entry.externalSource,
        externalId: entry.externalId,
        kind: entry.entryableType,
        categoryId: txnCategoryId ?? null,
        merchant: txnMerchant ?? null,
        transferId: txnTransferId ?? null,
        valuationKind: valuationKind ?? null,
        tagIds: tagsByEntry.get(entry.id) ?? []
      })
    ),
    exchangeRates: rateRows.map((r) => ({
      base: r.baseCurrency,
      quote: r.quoteCurrency,
      rate: r.rate,
      quotedOn: r.quotedOn
    }))
  };
}

function serializeFamily(
  family: FamilyRow,
  members: { id: string; email: string; name: string; role: string }[]
) {
  return {
    id: family.id,
    name: family.name,
    currency: family.currency,
    locale: family.locale,
    timezone: family.timezone,
    createdAt: family.createdAt.toISOString(),
    members
  };
}

export type FamilyExport = {
  version: number;
  exportedAt: string;
  family: ReturnType<typeof serializeFamily>;
  shares: unknown[];
  accounts: unknown[];
  categories: unknown[];
  tags: unknown[];
  entries: unknown[];
  exchangeRates: unknown[];
};
