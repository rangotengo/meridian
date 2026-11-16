import { and, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/client";
import { chunkParams } from "../db/params";
import {
  accountShares,
  accounts,
  budgets,
  categories,
  entries,
  exchangeRates,
  families,
  portfolioHoldings,
  recurringSeries,
  savedFilters,
  tags,
  transactionTags,
  transactions,
  transfers,
  users,
  valuations
} from "../db/schema";
import type { Actor } from "../auth/context";
import { recordAudit } from "../observability/audit";
import { listAccountsForActor } from "./accounts";

/**
 * Household export format version.
 *
 * v1: family, shares, accounts, categories, tags, entries, exchange rates.
 * v2: adds budgets, recurring series, saved filters, an explicit transfers
 *     list, and `recurringSeriesId` on entries. The importer accepts both.
 * v3: adds manual portfolio holdings. Holdings are user-entered data, so
 *     they migrate with the household — unlike MeroShare sync state
 *     (connections, synced accounts/holdings/transactions), which is
 *     deliberately NOT exported: it is recreated by re-syncing.
 *
 * Also deliberately NOT exported: MCP OAuth state (oauth_clients,
 * oauth_grants, oauth_authorization_requests, oauth_authorization_codes,
 * oauth_tokens, oauth_assertion_claims). AI-agent connections never migrate
 * with a household export — after a household restore, agents reconnect and
 * re-consent from scratch. (Operator instance backups are the opposite
 * contract; see backups.ts.)
 */
export const EXPORT_VERSION = 3;

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

  const budgetRows = await exec.select().from(budgets).where(eq(budgets.familyId, familyId));

  const recurringRows = [];
  for (const chunk of chunkParams(visibleAccountIds)) {
    const rows = await exec
      .select()
      .from(recurringSeries)
      .where(
        and(eq(recurringSeries.familyId, familyId), inArray(recurringSeries.accountId, chunk))
      );
    recurringRows.push(...rows);
  }

  const transferRows = [];
  for (const chunk of chunkParams(visibleAccountIds)) {
    const rows = await exec
      .select({
        id: transfers.id,
        outflowEntryId: transfers.outflowEntryId,
        inflowEntryId: transfers.inflowEntryId,
        status: transfers.status
      })
      .from(transfers)
      .innerJoin(entries, eq(entries.id, transfers.outflowEntryId))
      .innerJoin(accounts, eq(accounts.id, entries.accountId))
      .where(and(eq(accounts.familyId, familyId), inArray(accounts.id, chunk)));
    transferRows.push(...rows);
  }

  const memberRows = await exec
    .select({ id: users.id, email: users.email, name: users.name, role: users.familyRole })
    .from(users)
    .where(eq(users.familyId, familyId));

  // Saved filters are private to their owner: an export carries only the
  // exporting actor's own filters, never other members' saved searches.
  const savedFilterRows = await exec
    .select({
      id: savedFilters.id,
      userId: savedFilters.userId,
      name: savedFilters.name,
      params: savedFilters.params
    })
    .from(savedFilters)
    .where(eq(savedFilters.userId, actor.userId));

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

  const holdingRows = [];
  for (const chunk of chunkParams(visibleAccountIds)) {
    const rows = await exec
      .select({
        id: portfolioHoldings.id,
        accountId: portfolioHoldings.accountId,
        ticker: portfolioHoldings.ticker,
        companyName: portfolioHoldings.companyName,
        quantity: portfolioHoldings.quantity,
        averageCostMinor: portfolioHoldings.averageCostMinor,
        currentPriceMinor: portfolioHoldings.currentPriceMinor
      })
      .from(portfolioHoldings)
      .innerJoin(accounts, eq(accounts.id, portfolioHoldings.accountId))
      .where(and(eq(accounts.familyId, familyId), inArray(accounts.id, chunk)));
    holdingRows.push(...rows);
  }

  const rateRows = await exec.select().from(exchangeRates);

  const tagsByEntry = new Map<string, string[]>();
  for (const link of tagLinks) {
    const list = tagsByEntry.get(link.entryId) ?? [];
    list.push(link.tagId);
    tagsByEntry.set(link.entryId, list);
  }

  // A transfer is exported only when BOTH legs are in accounts the actor can
  // see; a half-visible transfer would dangle (its other leg is not in the
  // export) and leak the existence of an account the actor cannot access.
  // Legs of an excluded transfer are exported as ordinary transactions with
  // no transfer link.
  const exportedEntryIds = new Set(entryRows.map((r) => r.entry.id));
  const completeTransfers = transferRows.filter(
    (t) => exportedEntryIds.has(t.outflowEntryId) && exportedEntryIds.has(t.inflowEntryId)
  );
  const completeTransferIds = new Set(completeTransfers.map((t) => t.id));

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
        recurringSeriesId: entry.recurringSeriesId,
        categoryId: txnCategoryId ?? null,
        merchant: txnMerchant ?? null,
        transferId: txnTransferId && completeTransferIds.has(txnTransferId) ? txnTransferId : null,
        valuationKind: valuationKind ?? null,
        tagIds: tagsByEntry.get(entry.id) ?? []
      })
    ),
    transfers: completeTransfers,
    holdings: holdingRows,
    budgets: budgetRows.map((b) => ({
      id: b.id,
      categoryId: b.categoryId,
      amountMinor: b.amountMinor,
      active: b.active
    })),
    recurring: recurringRows.map((s) => ({
      id: s.id,
      accountId: s.accountId,
      createdBy: s.createdBy,
      name: s.name,
      merchant: s.merchant,
      amountMinor: s.amountMinor,
      currency: s.currency,
      categoryId: s.categoryId,
      frequency: s.frequency,
      config: s.config,
      nextDue: s.nextDue,
      active: s.active,
      lastPostedEntryId: s.lastPostedEntryId
    })),
    savedFilters: savedFilterRows.map((f) => ({
      id: f.id,
      userId: f.userId,
      name: f.name,
      params: f.params
    })),
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

export type ExportedTransfer = {
  id: string;
  outflowEntryId: string;
  inflowEntryId: string;
  status: string;
};

export type ExportedHolding = {
  id: string;
  accountId: string;
  ticker: string;
  companyName: string | null;
  quantity: string;
  averageCostMinor: number | null;
  currentPriceMinor: number | null;
};

export type ExportedBudget = {
  id: string;
  categoryId: string | null;
  amountMinor: number;
  active: boolean;
};

export type ExportedRecurringSeries = {
  id: string;
  accountId: string;
  createdBy: string;
  name: string;
  merchant: string | null;
  amountMinor: number;
  currency: string;
  categoryId: string | null;
  frequency: string;
  config: unknown;
  nextDue: string;
  active: boolean;
  lastPostedEntryId: string | null;
};

export type ExportedSavedFilter = {
  id: string;
  userId: string;
  name: string;
  params: unknown;
};

export type FamilyExport = {
  version: number;
  exportedAt: string;
  family: ReturnType<typeof serializeFamily>;
  shares: unknown[];
  accounts: unknown[];
  categories: unknown[];
  tags: unknown[];
  entries: unknown[];
  transfers: ExportedTransfer[];
  holdings: ExportedHolding[];
  budgets: ExportedBudget[];
  recurring: ExportedRecurringSeries[];
  savedFilters: ExportedSavedFilter[];
  exchangeRates: unknown[];
};
