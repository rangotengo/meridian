import { usesCloudStorage } from "@/server/db/dialect";
import { eq, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { chunkRows } from "../db/params";
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
import { recalculateAccount } from "./balances";
import { normalizeTicker, parseQuantity } from "./holdings";
import { validateSeriesConfig, type Frequency, type SeriesConfig } from "./recurring";
import { assertFamilyIsEmpty } from "./sure-import";
import { TRANSFER_DATE_WINDOW_DAYS } from "./transfers";
import {
  ACCOUNT_TYPES,
  defaultBalanceTracking,
  isValuationTracked,
  type BalanceTracking
} from "../authorization/access";
import { errors } from "@/lib/errors";
import { diffDays, isIsoDate } from "@/lib/datetime";
import { isValidCurrency } from "@/lib/money";

/**
 * Restore a household from a Meridian family export (see exports.ts).
 *
 * Semantics (deliberately mirroring the Sure migration):
 * - The export is restored into the importing family admin's CURRENT family,
 *   and only when that family is still empty, so a restore can never merge
 *   into or overwrite existing data. Everything applies in one transaction:
 *   any validation or referential failure rolls the whole import back.
 * - Every entity is recreated with a fresh id; references are remapped
 *   through the maps built during the import (Sure-import conventions).
 * - People are never recreated: the export carries no credentials. Members,
 *   account owners, series creators, share grantees, and saved-filter owners
 *   are matched to users already in the target family by email. Unmatched
 *   shares and saved filters are skipped and counted in the result; account
 *   ownership falls back to the importing admin — except joint accounts
 *   (owner null), which stay joint.
 * - Family settings (name, currency, locale, timezone) are NOT overwritten;
 *   the target family keeps its own. Because budgets are denominated in the
 *   reporting currency, an export whose budgets were recorded in a different
 *   reporting currency than the target family's is rejected outright rather
 *   than silently reinterpreted.
 * - Exchange rates are instance-global reference data whose normal writes
 *   are restricted to platform super-admins, so a household restore applies
 *   uploaded rates only when the importing admin is also a super-admin;
 *   otherwise they are skipped and counted. Uploaded JSON must never mutate
 *   global data as a side effect of a household restore.
 * - Transfers and splits are validated against the same invariants the
 *   transfer/split services enforce (balanced legs in one currency inside
 *   the date window; split parts inheriting and summing to the parent),
 *   every entry and recurring definition against its account's currency
 *   (creation derives currency from the account, so a mismatch can only
 *   come from a tampered export), and recurring configs against the
 *   recurring service's rules, before any row is written.
 * - Format v1 exports (no budgets/recurring/savedFilters/transfers arrays)
 *   still import: transfers are rebuilt from the transferId carried on each
 *   entry, using the ledger sign convention (outflow positive, inflow
 *   negative, legs summing to zero).
 * - Same-day valuation precedence survives a restore when the export
 *   carries the per-account `writeOrder` key (see exports.ts): entries are
 *   inserted in that order and stamped with monotonically increasing
 *   destination-local created_at values, so the destination balance engine
 *   picks the same winning valuation as the source. Exports without the
 *   key restore through the previous backwards walk instead, whose
 *   same-date winner is the first entry in the array — order-dependent,
 *   not source-correct, and kept only as the legacy fallback.
 */

const SOURCE = "meridian_export";
const MAX_EXPORT_BYTES = 25 * 1024 * 1024;
const MAX_ROWS = 100_000;
const SUPPORTED_VERSIONS = new Set([1, 2, 3]);
const FREQUENCIES = new Set(["monthly", "weekly", "yearly"]);
const VALUATION_KINDS = new Set(["opening", "reconciliation", "current"]);
const ACCOUNT_STATUSES = new Set(["active", "draft", "disabled"]);
const SHARE_PERMISSIONS = new Set(["full_control", "read_write", "read_only"]);

type RecordData = Record<string, unknown>;

export type FamilyImportResult = {
  accounts: number;
  categories: number;
  tags: number;
  entries: number;
  transfers: number;
  valuations: number;
  holdings: number;
  budgets: number;
  recurring: number;
  savedFilters: number;
  exchangeRates: number;
  skipped: { shares: number; savedFilters: number; exchangeRates: number };
};

type ParsedMember = { id: string; email: string };
type ParsedAccount = {
  id: string;
  name: string;
  type: string;
  balanceTracking: BalanceTracking;
  subtype: string | null;
  institution: string | null;
  currency: string;
  status: string;
  includedInReports: boolean;
  openingBalanceMinor: number;
  openedOn: string;
  ownerId: string | null;
};
type ParsedCategory = { id: string; name: string; color: string | null; parentId: string | null };
type ParsedTag = { id: string; name: string; color: string | null };
type ParsedEntry = {
  id: string;
  accountId: string;
  parentEntryId: string | null;
  date: string;
  amountMinor: number;
  currency: string;
  name: string;
  notes: string | null;
  externalSource: string | null;
  externalId: string | null;
  kind: string;
  recurringSeriesId: string | null;
  categoryId: string | null;
  merchant: string | null;
  transferId: string | null;
  valuationKind: string | null;
  tagIds: string[];
  /**
   * Per-account rank in source write order (exports.ts), or null for
   * exports written before the key existed. It is an ordering key only:
   * the destination never copies the source's created_at — the importer
   * re-derives destination-local stamps in this order instead.
   */
  writeOrder: number | null;
};
type ParsedTransfer = {
  id: string;
  outflowEntryId: string;
  inflowEntryId: string;
  status: string;
};
type ParsedBudget = {
  id: string;
  categoryId: string | null;
  amountMinor: number;
  active: boolean;
};
type ParsedRecurring = {
  id: string;
  accountId: string;
  createdBy: string | null;
  name: string;
  merchant: string | null;
  amountMinor: number;
  currency: string;
  categoryId: string | null;
  frequency: string;
  config: RecordData;
  nextDue: string;
  active: boolean;
  lastPostedEntryId: string | null;
};
type ParsedHolding = {
  id: string;
  accountId: string;
  ticker: string;
  companyName: string | null;
  quantity: string;
  averageCostMinor: number | null;
  averageCostQuantity: string;
  currentPriceMinor: number | null;
};
type ParsedSavedFilter = { id: string; userId: string; name: string; params: RecordData };
type ParsedShare = { accountId: string; userId: string; permission: string };
type ParsedRate = { base: string; quote: string; rate: string; quotedOn: string };

export type ParsedFamilyExport = {
  version: number;
  /** The source family's reporting currency, when the export records it. */
  familyCurrency: string | null;
  members: ParsedMember[];
  accounts: ParsedAccount[];
  categories: ParsedCategory[];
  tags: ParsedTag[];
  entries: ParsedEntry[];
  transfers: ParsedTransfer[];
  holdings: ParsedHolding[];
  budgets: ParsedBudget[];
  recurring: ParsedRecurring[];
  savedFilters: ParsedSavedFilter[];
  shares: ParsedShare[];
  exchangeRates: ParsedRate[];
};

export function parseFamilyExport(bytes: Uint8Array): ParsedFamilyExport {
  if (bytes.byteLength === 0) throw errors.validation("Choose a Meridian export file.");
  if (bytes.byteLength > MAX_EXPORT_BYTES)
    throw errors.validation("The export is larger than Meridian's 25 MB import limit.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw errors.validation("The export is not valid UTF-8 JSON.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw errors.validation("The export is not valid JSON.");
  }
  if (!isRecord(raw)) throw errors.validation("The export is not a recognized Meridian export.");
  const version = raw.version;
  if (typeof version !== "number" || !SUPPORTED_VERSIONS.has(version)) {
    throw errors.validation(
      `This export format version (${String(version)}) is not supported by this Meridian version.`
    );
  }
  const family = isRecord(raw.family) ? raw.family : null;
  if (!family) throw errors.validation("The export is missing its family record.");
  const familyCurrency =
    typeof family.currency === "string" && isValidCurrency(family.currency.toUpperCase())
      ? family.currency.toUpperCase()
      : null;
  const members = reqArray(family.members, "family members").map((m) => {
    if (!isRecord(m)) throw errors.validation("The export has an invalid family member.");
    return {
      id: reqId(m.id, "member"),
      email: reqText(m.email, "member email", 320).toLowerCase()
    };
  });

  const accounts = reqArray(raw.accounts, "accounts").map(parseAccount);
  const categories = reqArray(raw.categories, "categories").map(parseCategory);
  const tags = reqArray(raw.tags, "tags").map(parseTag);
  const entries = reqArray(raw.entries, "entries").map(parseEntry);
  const holdings = optArray(raw.holdings, "holdings").map(parseHolding);
  const total =
    accounts.length + categories.length + tags.length + entries.length + holdings.length;
  if (total > MAX_ROWS)
    throw errors.validation(`The export exceeds ${MAX_ROWS.toLocaleString()} records.`);

  return {
    version,
    familyCurrency,
    members,
    accounts,
    categories,
    tags,
    entries,
    transfers: optArray(raw.transfers, "transfers").map(parseTransfer),
    holdings,
    budgets: optArray(raw.budgets, "budgets").map(parseBudget),
    recurring: optArray(raw.recurring, "recurring series").map(parseRecurring),
    savedFilters: optArray(raw.savedFilters, "saved filters").map(parseSavedFilter),
    shares: optArray(raw.shares, "shares").map(parseShare),
    exchangeRates: optArray(raw.exchangeRates, "exchange rates").map(parseRate)
  };
}

export async function importFamilyExport(
  exec: Executor,
  actor: Actor,
  data: ParsedFamilyExport
): Promise<FamilyImportResult> {
  if (actor.familyRole !== "admin") {
    throw errors.forbidden("Only a family admin can restore an export into this family.");
  }
  return exec.transaction(async (tx) => {
    // Serialize restores per family so the empty-family check cannot race a
    // concurrent double-submit (same pattern as the Sure migration).
    if (!usesCloudStorage)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${actor.familyId}))`);
    await assertFamilyIsEmpty(tx, actor.familyId, "a Meridian export restore");
    return importRecords(tx, actor, data);
  });
}

async function importRecords(
  exec: Executor,
  actor: Actor,
  data: ParsedFamilyExport
): Promise<FamilyImportResult> {
  const [family] = await exec
    .select()
    .from(families)
    .where(eq(families.id, actor.familyId))
    .limit(1);
  if (!family) throw errors.notFound("Family");

  // Budgets are denominated in the family's reporting currency and minor
  // units do not translate across currencies (a $100 budget is not ¥100), so
  // a budget-bearing export recorded under a different reporting currency is
  // rejected rather than silently reinterpreted.
  if (data.budgets.length > 0) {
    if (!data.familyCurrency) {
      throw errors.validation(
        "This export does not record its household reporting currency, so its budgets cannot be restored safely. Re-export the household with a current Meridian version and try again."
      );
    }
    if (data.familyCurrency !== family.currency) {
      throw errors.validation(
        `This export's budgets are in ${data.familyCurrency}, but this family reports in ${family.currency}. Budget amounts cannot be converted between currencies — restore the export into a family that reports in ${data.familyCurrency}, or remove the budgets from the export file.`
      );
    }
  }

  // Transfers: v2 exports carry an explicit list; v1 exports only carry the
  // transferId on each entry, so rebuild pairs from the ledger sign rule.
  const transferPairs: ParsedTransfer[] =
    data.transfers.length > 0
      ? data.transfers.map((t) => ({
          id: t.id,
          outflowEntryId: t.outflowEntryId,
          inflowEntryId: t.inflowEntryId,
          status: t.status
        }))
      : rebuildTransferPairs(data.entries);
  // Validate splits and transfers against the domain invariants before any
  // row is written, so a tampered export fails as one atomic no-op.
  validateRestoredData(data, transferPairs);

  // Resolve exported people to users already present in the target family.
  const targetMembers = await exec
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.familyId, actor.familyId));
  const targetByEmail = new Map(targetMembers.map((u) => [u.email.toLowerCase(), u.id]));
  const memberMap = new Map<string, string>();
  for (const member of data.members) {
    const targetId = targetByEmail.get(member.email);
    if (targetId) memberMap.set(member.id, targetId);
  }
  const resolveUser = (sourceUserId: string | null): string | null =>
    sourceUserId ? (memberMap.get(sourceUserId) ?? null) : null;

  const categoryMap = new Map<string, string>();
  const categoryParents: [string, string | null][] = [];
  for (const record of data.categories) {
    const [category] = await exec
      .insert(categories)
      .values({
        familyId: actor.familyId,
        name: record.name,
        color: record.color,
        externalSource: SOURCE,
        externalId: record.id
      })
      .returning({ id: categories.id });
    if (!category) throw errors.conflict("Could not restore a category.");
    categoryMap.set(record.id, category.id);
    categoryParents.push([record.id, record.parentId]);
  }
  for (const [sourceId, parentSourceId] of categoryParents) {
    if (!parentSourceId) continue;
    const parentId = categoryMap.get(parentSourceId);
    if (!parentId)
      throw errors.validation("A category in the export references a missing parent category.");
    await exec
      .update(categories)
      .set({ parentId })
      .where(eq(categories.id, categoryMap.get(sourceId)!));
  }

  const tagMap = new Map<string, string>();
  for (const record of data.tags) {
    const [tag] = await exec
      .insert(tags)
      .values({
        familyId: actor.familyId,
        name: record.name,
        color: record.color,
        externalSource: SOURCE,
        externalId: record.id
      })
      .returning({ id: tags.id });
    if (!tag) throw errors.conflict("Could not restore a tag.");
    tagMap.set(record.id, tag.id);
  }

  const accountMap = new Map<string, string>();
  for (const record of data.accounts) {
    const [account] = await exec
      .insert(accounts)
      .values({
        familyId: actor.familyId,
        // Joint accounts (owner null) stay joint; only a non-null owner who
        // cannot be matched to a target member falls back to the admin.
        ownerId: record.ownerId === null ? null : (resolveUser(record.ownerId) ?? actor.userId),
        type: record.type,
        balanceTracking: record.balanceTracking,
        subtype: record.subtype,
        name: record.name,
        institution: record.institution,
        currency: record.currency,
        status: record.status,
        includedInReports: record.includedInReports,
        openingBalanceMinor: record.openingBalanceMinor,
        openedOn: record.openedOn,
        externalSource: SOURCE,
        externalId: record.id
      })
      .returning({ id: accounts.id });
    if (!account) throw errors.conflict("Could not restore an account.");
    accountMap.set(record.id, account.id);
  }

  // Series come before entries: entries reference their series, while a
  // series' lastPostedEntryId is a plain column fixed up after entries land.
  const seriesMap = new Map<string, string>();
  for (const record of data.recurring) {
    const accountId = mappedId(record.accountId, accountMap, "account");
    const [series] = await exec
      .insert(recurringSeries)
      .values({
        familyId: actor.familyId,
        accountId,
        createdBy: resolveUser(record.createdBy) ?? actor.userId,
        name: record.name,
        merchant: record.merchant,
        amountMinor: record.amountMinor,
        currency: record.currency,
        categoryId: mappedOptionalId(record.categoryId, categoryMap, "category"),
        frequency: record.frequency,
        config: record.config,
        nextDue: record.nextDue,
        active: record.active,
        lastPostedEntryId: null
      })
      .returning({ id: recurringSeries.id });
    if (!series) throw errors.conflict("Could not restore a recurring series.");
    seriesMap.set(record.id, series.id);
  }

  const entryMap = new Map<string, string>();
  const transactionIdByEntry = new Map<string, string>();
  let valuationCount = 0;
  const deferredTagLinks: { entryId: string; tagIds: string[] }[] = [];

  // Insert one entry (and its transaction/valuation row). `stamp` is a
  // destination-local write-order stamp; without it the column defaults
  // apply (one shared transaction timestamp on PostgreSQL).
  const insertEntry = async (record: ParsedEntry, stamp?: Date): Promise<void> => {
    const accountId = mappedId(record.accountId, accountMap, "account");
    const [entry] = await exec
      .insert(entries)
      .values({
        accountId,
        parentEntryId: record.parentEntryId
          ? mappedId(record.parentEntryId, entryMap, "parent entry")
          : null,
        recurringSeriesId: record.recurringSeriesId
          ? mappedId(record.recurringSeriesId, seriesMap, "recurring series")
          : null,
        date: record.date,
        amountMinor: record.amountMinor,
        currency: record.currency,
        name: record.name,
        notes: record.notes,
        externalSource: record.externalSource,
        externalId: record.externalId,
        entryableType: record.kind,
        ...(stamp ? { createdAt: stamp, updatedAt: stamp } : {})
      })
      .returning({ id: entries.id });
    if (!entry) throw errors.conflict("Could not restore an entry.");
    entryMap.set(record.id, entry.id);
    if (record.kind === "transaction") {
      const [transaction] = await exec
        .insert(transactions)
        .values({
          entryId: entry.id,
          categoryId: mappedOptionalId(record.categoryId, categoryMap, "category"),
          merchant: record.merchant
        })
        .returning({ id: transactions.id });
      if (!transaction) throw errors.conflict("Could not restore a transaction.");
      transactionIdByEntry.set(record.id, transaction.id);
      if (record.tagIds.length > 0)
        deferredTagLinks.push({ entryId: record.id, tagIds: record.tagIds });
    } else {
      await exec.insert(valuations).values({
        entryId: entry.id,
        kind: record.valuationKind ?? "current"
      });
      valuationCount++;
    }
  };

  // Same-day valuation precedence must survive the restore: the balance
  // engine picks the last valuation for a date by (date, created_at,
  // write_seq/rowid), so the destination must reproduce the source's write
  // order. Exports carrying the per-account `writeOrder` key are inserted
  // in that order — entries without a rank (a partially keyed export)
  // sort after the ranked ones within their account, array order kept —
  // and stamped with monotonically increasing destination-local timestamps
  // (one millisecond apart, ending before the import's start), so the created_at
  // tiebreak resolves identically to the source. Insertion order carries
  // the same sequence into write_seq (PostgreSQL) and rowid (cloud).
  // A split child is still deferred until its parent lands; valuations
  // never have parents, so their order is never disturbed by that.
  //
  // Exports WITHOUT the key (v1, v2, early v3) take the previous path
  // unchanged: the backwards walk and column defaults, which resolve
  // same-date ties by reverse array order (the first entry for a date
  // wins). That behavior is preserved as the legacy fallback — it is
  // order-dependent, not source-correct, and is documented as such rather
  // than silently changed.
  if (data.entries.some((e) => e.writeOrder !== null)) {
    const orderedEntries = [...data.entries].sort((a, b) => {
      if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1;
      const ao = a.writeOrder ?? Number.MAX_SAFE_INTEGER;
      const bo = b.writeOrder ?? Number.MAX_SAFE_INTEGER;
      return ao - bo;
    });
    // Keep the entire imported history before the first possible live
    // write. Starting at now and adding a millisecond per entry can put
    // fast restores ahead of wall time, letting stale imported values
    // override subsequent holdings changes until the clock catches up.
    const stampBase = Date.now() - data.entries.length;
    let stampSeq = 0;
    let pendingEntries = orderedEntries;
    while (pendingEntries.length > 0) {
      const next: ParsedEntry[] = [];
      let inserted = 0;
      for (const record of pendingEntries) {
        if (record.parentEntryId && !entryMap.has(record.parentEntryId)) {
          next.push(record);
          continue;
        }
        await insertEntry(record, new Date(stampBase + stampSeq++));
        inserted++;
      }
      if (inserted === 0) {
        throw errors.validation("The export contains entries with a missing parent entry.");
      }
      pendingEntries = next;
    }
  } else {
    const pendingEntries = [...data.entries];
    while (pendingEntries.length > 0) {
      const before = pendingEntries.length;
      for (let i = pendingEntries.length - 1; i >= 0; i--) {
        const record = pendingEntries[i]!;
        if (record.parentEntryId && !entryMap.has(record.parentEntryId)) continue;
        await insertEntry(record);
        pendingEntries.splice(i, 1);
      }
      if (pendingEntries.length === before) {
        throw errors.validation("The export contains entries with a missing parent entry.");
      }
    }
  }

  for (const link of deferredTagLinks) {
    const transactionId = transactionIdByEntry.get(link.entryId)!;
    const tagIds = link.tagIds.map((id) => mappedId(id, tagMap, "tag"));
    for (const chunk of chunkRows(tagIds, 2)) {
      await exec.insert(transactionTags).values(chunk.map((tagId) => ({ transactionId, tagId })));
    }
  }

  for (const record of data.recurring) {
    if (!record.lastPostedEntryId) continue;
    const postedEntryId = entryMap.get(record.lastPostedEntryId);
    if (!postedEntryId) continue;
    await exec
      .update(recurringSeries)
      .set({ lastPostedEntryId: postedEntryId })
      .where(eq(recurringSeries.id, seriesMap.get(record.id)!));
  }

  let transferCount = 0;
  for (const pair of transferPairs) {
    const outflowEntryId = mappedId(pair.outflowEntryId, entryMap, "transfer outflow entry");
    const inflowEntryId = mappedId(pair.inflowEntryId, entryMap, "transfer inflow entry");
    const [transfer] = await exec
      .insert(transfers)
      .values({ outflowEntryId, inflowEntryId, status: pair.status })
      .returning({ id: transfers.id });
    if (!transfer) throw errors.conflict("Could not restore a transfer.");
    await exec
      .update(transactions)
      .set({ transferId: transfer.id })
      .where(sql`${transactions.entryId} IN (${outflowEntryId}, ${inflowEntryId})`);
    transferCount++;
  }

  let holdingCount = 0;
  for (const record of data.holdings) {
    await exec.insert(portfolioHoldings).values({
      accountId: mappedId(record.accountId, accountMap, "account"),
      ticker: record.ticker,
      companyName: record.companyName,
      quantity: record.quantity,
      averageCostMinor: record.averageCostMinor,
      averageCostQuantity: record.averageCostQuantity,
      currentPriceMinor: record.currentPriceMinor
    });
    holdingCount++;
  }

  let budgetCount = 0;
  for (const record of data.budgets) {
    await exec.insert(budgets).values({
      familyId: actor.familyId,
      categoryId: mappedOptionalId(record.categoryId, categoryMap, "category"),
      amountMinor: record.amountMinor,
      active: record.active
    });
    budgetCount++;
  }

  let savedFilterCount = 0;
  let skippedFilters = 0;
  for (const record of data.savedFilters) {
    const userId = resolveUser(record.userId);
    if (!userId) {
      skippedFilters++;
      continue;
    }
    await exec.insert(savedFilters).values({
      userId,
      name: record.name,
      params: remapFilterParams(record.params, { accountMap, categoryMap, tagMap })
    });
    savedFilterCount++;
  }

  let skippedShares = 0;
  for (const share of data.shares) {
    const accountId = accountMap.get(share.accountId);
    const userId = resolveUser(share.userId);
    if (!accountId || !userId) {
      skippedShares++;
      continue;
    }
    await exec
      .insert(accountShares)
      .values({ accountId, userId, permission: share.permission })
      .onConflictDoNothing();
  }

  // Exchange rates are instance-global and their normal writes are
  // super-admin-only; a household restore must not let uploaded JSON mutate
  // them. Only a super-admin import applies uploaded rates — everyone else's
  // are skipped and counted.
  let rateCount = 0;
  let skippedRates = 0;
  const mayWriteRates = actor.platformRole === "super_admin";
  for (const rate of data.exchangeRates) {
    if (!mayWriteRates) {
      skippedRates++;
      continue;
    }
    const inserted = await exec
      .insert(exchangeRates)
      .values({
        baseCurrency: rate.base,
        quoteCurrency: rate.quote,
        rate: rate.rate,
        quotedOn: rate.quotedOn
      })
      .onConflictDoNothing()
      .returning({ id: exchangeRates.id });
    rateCount += inserted.length;
  }

  for (const accountId of accountMap.values()) await recalculateAccount(exec, accountId);

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "family.imported_from_export",
    entityType: "family",
    entityId: actor.familyId,
    metadata: {
      version: data.version,
      accounts: accountMap.size,
      categories: categoryMap.size,
      tags: tagMap.size,
      entries: entryMap.size,
      transfers: transferCount,
      valuations: valuationCount,
      holdings: holdingCount,
      budgets: budgetCount,
      recurring: seriesMap.size,
      savedFilters: savedFilterCount,
      exchangeRates: rateCount,
      skipped: { shares: skippedShares, savedFilters: skippedFilters, exchangeRates: skippedRates }
    }
  });

  return {
    accounts: accountMap.size,
    categories: categoryMap.size,
    tags: tagMap.size,
    entries: entryMap.size,
    transfers: transferCount,
    valuations: valuationCount,
    holdings: holdingCount,
    budgets: budgetCount,
    recurring: seriesMap.size,
    savedFilters: savedFilterCount,
    exchangeRates: rateCount,
    skipped: { shares: skippedShares, savedFilters: skippedFilters, exchangeRates: skippedRates }
  };
}

/**
 * Saved-filter params reference accounts, categories, and tags by id; those
 * ids change on restore, so remap them through the import's id maps.
 * References that cannot be remapped (the entity is not part of the export)
 * are dropped, consistent with how unmatched people are skipped.
 */
function remapFilterParams(
  params: RecordData,
  maps: {
    accountMap: Map<string, string>;
    categoryMap: Map<string, string>;
    tagMap: Map<string, string>;
  }
): RecordData {
  const idMaps: Record<string, Map<string, string>> = {
    account: maps.accountMap,
    category: maps.categoryMap,
    tag: maps.tagMap
  };
  const out: RecordData = {};
  for (const [key, value] of Object.entries(params)) {
    const map = idMaps[key];
    if (map && typeof value === "string") {
      const mapped = map.get(value);
      if (mapped) out[key] = mapped;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Pre-write validation of the relationships the normal services enforce at
 * creation time. The importer recreates rows verbatim, so without this a
 * tampered export could persist states the domain forbids: entries or
 * recurring definitions denominated in a currency other than their
 * account's, unbalanced or cross-currency transfer legs, split parts that
 * do not sum to (or do not inherit) their parent, and entries claiming
 * transfers they are not part of. Throws a validation error; the caller
 * runs inside the import transaction, so the whole restore rolls back.
 */
function validateRestoredData(data: ParsedFamilyExport, pairs: ParsedTransfer[]): void {
  const entryById = new Map(data.entries.map((e) => [e.id, e]));
  const accountById = new Map(data.accounts.map((a) => [a.id, a]));

  // Entry and recurring creation derive the currency from the account, so
  // a stored record can never disagree with its account. An export whose
  // records do disagree would have its amounts silently reinterpreted in
  // the account's currency when balances are rebuilt (while currency-aware
  // reports read the row's own currency), so reject the mismatch outright
  // instead of relabeling amounts. This covers every entry kind —
  // transactions, valuations, split parents and parts, and both transfer
  // legs — because comparing records only with each other (as the split
  // and transfer checks below do) cannot catch all of them flipped at once.
  for (const entry of data.entries) {
    const account = accountById.get(entry.accountId);
    if (!account)
      throw errors.validation(
        "An entry in the export references an account that is not part of the export."
      );
    if (entry.currency !== account.currency) {
      throw errors.validation(
        `An entry in the export ("${entry.name}") uses currency ${entry.currency}, which does not match its account's currency ${account.currency}. Entry amounts are denominated in their account's currency — correct the export file or re-export the household.`
      );
    }
  }
  for (const series of data.recurring) {
    const account = accountById.get(series.accountId);
    if (!account)
      throw errors.validation(
        "A recurring series in the export references an account that is not part of the export."
      );
    if (series.currency !== account.currency) {
      throw errors.validation(
        `A recurring series in the export ("${series.name}") uses currency ${series.currency}, which does not match its account's currency ${account.currency}. Recurring amounts are denominated in their account's currency — correct the export file or re-export the household.`
      );
    }
  }

  const childrenByParent = new Map<string, ParsedEntry[]>();
  for (const entry of data.entries) {
    if (!entry.parentEntryId) continue;
    const list = childrenByParent.get(entry.parentEntryId) ?? [];
    list.push(entry);
    childrenByParent.set(entry.parentEntryId, list);
  }

  for (const [parentId, children] of childrenByParent) {
    const parent = entryById.get(parentId);
    if (!parent)
      throw errors.validation("The export contains a split part whose parent entry is missing.");
    if (parent.kind !== "transaction")
      throw errors.validation("A split parent in the export is not a transaction.");
    let total = 0;
    for (const child of children) {
      if (child.kind !== "transaction")
        throw errors.validation("A split part in the export is not a transaction.");
      if (childrenByParent.has(child.id))
        throw errors.validation(
          "A split part in the export is itself split; nested splits are not supported."
        );
      if (
        child.accountId !== parent.accountId ||
        child.date !== parent.date ||
        child.currency !== parent.currency
      ) {
        throw errors.validation(
          "A split part in the export does not inherit its parent's account, date, and currency."
        );
      }
      if (child.amountMinor === 0)
        throw errors.validation("A split part in the export has a zero amount.");
      total += child.amountMinor;
    }
    if (total !== parent.amountMinor) {
      throw errors.validation(
        "The split parts in the export do not add up to the original transaction amount."
      );
    }
  }

  const pairById = new Map(pairs.map((p) => [p.id, p]));
  const usedLegs = new Set<string>();
  for (const pair of pairs) {
    if (pair.outflowEntryId === pair.inflowEntryId)
      throw errors.validation("A transfer in the export uses the same entry for both legs.");
    const outflow = entryById.get(pair.outflowEntryId);
    const inflow = entryById.get(pair.inflowEntryId);
    if (!outflow || !inflow)
      throw errors.validation(
        "A transfer in the export references an entry that is not part of the export."
      );
    for (const leg of [outflow, inflow]) {
      if (leg.kind !== "transaction")
        throw errors.validation("Only transactions can be linked as a transfer in the export.");
      if (leg.parentEntryId)
        throw errors.validation("A split part in the export cannot be a transfer leg.");
      if (childrenByParent.has(leg.id))
        throw errors.validation("A split transaction in the export cannot be a transfer leg.");
      if (usedLegs.has(leg.id))
        throw errors.validation("An entry in the export is used by more than one transfer.");
      usedLegs.add(leg.id);
    }
    if (outflow.accountId === inflow.accountId)
      throw errors.validation("A transfer in the export must move between two different accounts.");
    const outflowAccount = accountById.get(outflow.accountId);
    const inflowAccount = accountById.get(inflow.accountId);
    if (!outflowAccount || !inflowAccount)
      throw errors.validation(
        "A transfer in the export references an account that is not part of the export."
      );
    if (outflow.currency !== inflow.currency || outflowAccount.currency !== inflowAccount.currency)
      throw errors.validation("A cross-currency transfer in the export is not supported.");
    if (outflow.amountMinor <= 0 || inflow.amountMinor >= 0)
      throw errors.validation(
        "A transfer in the export does not follow the outflow/inflow sign convention."
      );
    if (outflow.amountMinor + inflow.amountMinor !== 0)
      throw errors.validation("The legs of a transfer in the export do not have equal amounts.");
    if (Math.abs(diffDays(outflow.date, inflow.date)) > TRANSFER_DATE_WINDOW_DAYS) {
      throw errors.validation(
        `The legs of a transfer in the export are more than ${TRANSFER_DATE_WINDOW_DAYS} days apart.`
      );
    }
  }

  for (const entry of data.entries) {
    if (!entry.transferId) continue;
    const pair = pairById.get(entry.transferId);
    if (!pair || (pair.outflowEntryId !== entry.id && pair.inflowEntryId !== entry.id)) {
      throw errors.validation("An entry in the export claims a transfer it is not a leg of.");
    }
  }

  // Holdings are user-entered positions the holdings domain only allows on
  // other-asset accounts, unique per ticker; a tampered export must not
  // restore states the domain forbids. Tickers were normalized at parse
  // time, so this uniqueness check compares the canonical form.
  const holdingKeys = new Set<string>();
  for (const holding of data.holdings) {
    const account = accountById.get(holding.accountId);
    if (!account)
      throw errors.validation(
        "A holding in the export references an account that is not part of the export."
      );
    if (account.type !== "other_asset") {
      throw errors.validation(
        "A holding in the export belongs to an account that is not an other-asset account."
      );
    }
    // Holdings publish the account's balance as a valuation, so they can
    // only exist while the account is valuation-tracked — the same
    // one-controller invariant switchBalanceTracking and the holdings
    // domain enforce. A recognized balanceTracking enum value is not
    // enough: an export pairing holdings with transaction tracking
    // would restore an account whose balance ignores its holdings and
    // whose holdings can no longer be edited.
    if (!isValuationTracked(account)) {
      throw errors.validation(
        "A holding in the export belongs to an account that tracks its balance from its transactions. Holdings require valuation tracking — correct the export file or re-export the household."
      );
    }
    const key = `${holding.accountId}:${holding.ticker}`;
    if (holdingKeys.has(key)) {
      throw errors.validation(
        "The export contains two holdings for the same ticker on one account."
      );
    }
    holdingKeys.add(key);
  }
}

function rebuildTransferPairs(entries: ParsedEntry[]): ParsedTransfer[] {
  const byTransferId = new Map<string, ParsedEntry[]>();
  for (const entry of entries) {
    if (!entry.transferId) continue;
    const legs = byTransferId.get(entry.transferId) ?? [];
    legs.push(entry);
    byTransferId.set(entry.transferId, legs);
  }
  const pairs: ParsedTransfer[] = [];
  for (const [transferId, legs] of byTransferId) {
    if (legs.length !== 2) {
      throw errors.validation("A transfer in the export does not have exactly two entries.");
    }
    const outflow = legs.find((e) => e.amountMinor > 0);
    const inflow = legs.find((e) => e.amountMinor < 0);
    if (!outflow || !inflow || outflow.amountMinor + inflow.amountMinor !== 0) {
      throw errors.validation(
        "A transfer in the export does not follow the outflow/inflow sign convention."
      );
    }
    pairs.push({
      id: transferId,
      outflowEntryId: outflow.id,
      inflowEntryId: inflow.id,
      status: "confirmed"
    });
  }
  return pairs;
}

function parseAccount(raw: unknown): ParsedAccount {
  const r = reqRecord(raw, "account");
  const type = reqText(r.type, "account type", 40);
  if (!(ACCOUNT_TYPES as readonly string[]).includes(type))
    throw errors.validation(`The export contains an unsupported account type "${type}".`);
  const status = reqText(r.status ?? "active", "account status", 20);
  if (!ACCOUNT_STATUSES.has(status))
    throw errors.validation(`The export contains an unsupported account status "${status}".`);
  // balanceTracking is an additive field: exports written before it existed
  // (or with an unrecognized value) fall back to the type's default mode.
  const balanceTracking: BalanceTracking =
    r.balanceTracking === "transactions" || r.balanceTracking === "valuation"
      ? r.balanceTracking
      : defaultBalanceTracking(type);
  return {
    id: reqId(r.id, "account"),
    name: reqText(r.name, "account name", 120),
    type,
    balanceTracking,
    subtype: optText(r.subtype, 100),
    institution: optText(r.institution, 120),
    currency: reqCurrency(r.currency),
    status,
    includedInReports: optBool(r.includedInReports, true),
    openingBalanceMinor: reqMinor(r.openingBalanceMinor, "account opening balance"),
    openedOn: reqDate(r.openedOn, "account opening date"),
    ownerId: optId(r.ownerId)
  };
}

function parseCategory(raw: unknown): ParsedCategory {
  const r = reqRecord(raw, "category");
  return {
    id: reqId(r.id, "category"),
    name: reqText(r.name, "category name", 120),
    color: optText(r.color, 32),
    parentId: optId(r.parentId)
  };
}

function parseTag(raw: unknown): ParsedTag {
  const r = reqRecord(raw, "tag");
  return {
    id: reqId(r.id, "tag"),
    name: reqText(r.name, "tag name", 60),
    color: optText(r.color, 32)
  };
}

function parseEntry(raw: unknown): ParsedEntry {
  const r = reqRecord(raw, "entry");
  const kind = reqText(r.kind, "entry kind", 40);
  if (kind !== "transaction" && kind !== "valuation")
    throw errors.validation(`The export contains an unsupported entry kind "${kind}".`);
  const valuationKind = optText(r.valuationKind, 20);
  if (valuationKind !== null && !VALUATION_KINDS.has(valuationKind))
    throw errors.validation(
      `The export contains an unsupported valuation kind "${valuationKind}".`
    );
  const writeOrder = optWriteOrder(r.writeOrder);
  const tagIdsRaw = r.tagIds ?? [];
  if (!Array.isArray(tagIdsRaw))
    throw errors.validation("An entry in the export has invalid tag references.");
  return {
    id: reqId(r.id, "entry"),
    accountId: reqId(r.accountId, "entry account"),
    parentEntryId: optId(r.parentEntryId),
    date: reqDate(r.date, "entry date"),
    amountMinor: reqMinor(r.amountMinor, "entry amount"),
    currency: reqCurrency(r.currency),
    name: reqText(r.name, "entry name", 240),
    notes: optText(r.notes, 5_000),
    externalSource: optText(r.externalSource, 120),
    externalId: optText(r.externalId, 240),
    kind,
    recurringSeriesId: optId(r.recurringSeriesId),
    categoryId: optId(r.categoryId),
    merchant: optText(r.merchant, 240),
    transferId: optId(r.transferId),
    valuationKind,
    tagIds: tagIdsRaw.map((t) => reqId(t, "tag")),
    writeOrder
  };
}

function parseTransfer(raw: unknown): ParsedTransfer {
  const r = reqRecord(raw, "transfer");
  const status = reqText(r.status ?? "confirmed", "transfer status", 20);
  return {
    id: reqId(r.id, "transfer"),
    outflowEntryId: reqId(r.outflowEntryId, "transfer outflow entry"),
    inflowEntryId: reqId(r.inflowEntryId, "transfer inflow entry"),
    status
  };
}

function parseHolding(raw: unknown): ParsedHolding {
  const r = reqRecord(raw, "holding");
  // Restore applies the holdings domain's canonical invariants, not just
  // its storage shape: tickers are normalized (trim + uppercase) exactly
  // as the domain writes them — so per-account uniqueness is checked on
  // the normalized form and ABC + abc cannot both land — the ticker
  // policy is enforced, and the quantity must be a strictly positive
  // decimal the domain's parser accepts, stored in its canonical form.
  const ticker = normalizeTicker(reqText(r.ticker, "holding ticker", 200));
  if (!ticker) throw errors.validation("A holding in the export has an empty ticker.");
  if (ticker.length > 32) {
    throw errors.validation("A holding in the export has a ticker longer than 32 characters.");
  }
  if (/\s/.test(ticker)) {
    throw errors.validation("A holding in the export has a ticker containing spaces.");
  }
  let quantity: string;
  let quantityScaled: bigint;
  try {
    const parsed = parseQuantity(reqText(r.quantity, "holding quantity", 32));
    quantity = parsed.normalized;
    quantityScaled = parsed.scaled;
  } catch {
    throw errors.validation("A holding in the export has an invalid quantity.");
  }
  if (quantityScaled === 0n) {
    throw errors.validation("A holding in the export has a zero quantity.");
  }
  const averageCostMinor = optMinor(r.averageCostMinor, "holding average cost");
  const currentPriceMinor = optMinor(r.currentPriceMinor, "holding current price");
  // Cost provenance: exports written before the field existed recorded an
  // average that covered the whole position (the domain's backfill rule),
  // so an absent field derives the known quantity from the average.
  let averageCostQuantity: string;
  if (r.averageCostQuantity === null || r.averageCostQuantity === undefined) {
    averageCostQuantity = averageCostMinor !== null ? quantity : "0";
  } else {
    let knownScaled: bigint;
    try {
      const parsed = parseQuantity(
        reqText(r.averageCostQuantity, "holding average cost quantity", 32)
      );
      averageCostQuantity = parsed.normalized;
      knownScaled = parsed.scaled;
    } catch {
      throw errors.validation("A holding in the export has an invalid average cost quantity.");
    }
    if (averageCostMinor === null && knownScaled !== 0n) {
      throw errors.validation(
        "A holding in the export claims a cost quantity without an average cost."
      );
    }
    if (knownScaled > quantityScaled) {
      throw errors.validation(
        "A holding in the export has a cost quantity larger than its quantity."
      );
    }
  }
  return {
    id: reqId(r.id, "holding"),
    accountId: reqId(r.accountId, "holding account"),
    ticker,
    companyName: optText(r.companyName, 200),
    quantity,
    averageCostMinor,
    averageCostQuantity,
    currentPriceMinor
  };
}

function parseBudget(raw: unknown): ParsedBudget {
  const r = reqRecord(raw, "budget");
  const amountMinor = reqMinor(r.amountMinor, "budget amount");
  if (amountMinor <= 0)
    throw errors.validation("A budget in the export has a non-positive amount.");
  return {
    id: reqId(r.id, "budget"),
    categoryId: optId(r.categoryId),
    amountMinor,
    active: optBool(r.active, true)
  };
}

function parseRecurring(raw: unknown): ParsedRecurring {
  const r = reqRecord(raw, "recurring series");
  const frequency = reqText(r.frequency, "recurring frequency", 20);
  if (!FREQUENCIES.has(frequency))
    throw errors.validation(`The export contains an unsupported frequency "${frequency}".`);
  if (!isRecord(r.config))
    throw errors.validation("A recurring series in the export has an invalid schedule config.");
  // The importer restores series verbatim, so the config must satisfy the
  // same rules the recurring service enforces at creation time — an
  // out-of-range weekly weekday, for example, would wedge the worker's
  // next-occurrence scan.
  validateSeriesConfig(frequency as Frequency, r.config as SeriesConfig);
  const amountMinor = reqMinor(r.amountMinor, "recurring amount");
  if (amountMinor === 0)
    throw errors.validation("A recurring series in the export has a zero amount.");
  return {
    id: reqId(r.id, "recurring series"),
    accountId: reqId(r.accountId, "recurring account"),
    createdBy: optId(r.createdBy),
    name: reqText(r.name, "recurring series name", 240),
    merchant: optText(r.merchant, 240),
    amountMinor,
    currency: reqCurrency(r.currency),
    categoryId: optId(r.categoryId),
    frequency,
    config: r.config,
    nextDue: reqDate(r.nextDue, "recurring next due date"),
    active: optBool(r.active, true),
    lastPostedEntryId: optId(r.lastPostedEntryId)
  };
}

function parseSavedFilter(raw: unknown): ParsedSavedFilter {
  const r = reqRecord(raw, "saved filter");
  if (!isRecord(r.params))
    throw errors.validation("A saved filter in the export has invalid parameters.");
  return {
    id: reqId(r.id, "saved filter"),
    userId: reqId(r.userId, "saved filter owner"),
    name: reqText(r.name, "saved filter name", 120),
    params: r.params
  };
}

function parseShare(raw: unknown): ParsedShare {
  const r = reqRecord(raw, "share");
  const permission = reqText(r.permission, "share permission", 20);
  if (!SHARE_PERMISSIONS.has(permission))
    throw errors.validation(`The export contains an unsupported share permission "${permission}".`);
  return {
    accountId: reqId(r.accountId, "share account"),
    userId: reqId(r.userId, "share user"),
    permission
  };
}

function parseRate(raw: unknown): ParsedRate {
  const r = reqRecord(raw, "exchange rate");
  const rate = r.rate;
  if (typeof rate !== "string" && typeof rate !== "number")
    throw errors.validation("An exchange rate in the export is invalid.");
  return {
    base: reqCurrency(r.base),
    quote: reqCurrency(r.quote),
    rate: String(rate),
    quotedOn: reqDate(r.quotedOn, "exchange rate date")
  };
}

function mappedId(sourceId: string, map: Map<string, string>, what: string): string {
  const mapped = map.get(sourceId);
  if (!mapped)
    throw errors.validation(`The export references a ${what} that is not part of the export.`);
  return mapped;
}

function mappedOptionalId(
  sourceId: string | null,
  map: Map<string, string>,
  what: string
): string | null {
  if (!sourceId) return null;
  return mappedId(sourceId, map, what);
}

function isRecord(value: unknown): value is RecordData {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reqRecord(value: unknown, what: string): RecordData {
  if (!isRecord(value)) throw errors.validation(`The export has an invalid ${what}.`);
  return value;
}

function reqArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw errors.validation(`The export is missing its ${what}.`);
  return value;
}

function optArray(value: unknown, what: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw errors.validation(`The export has invalid ${what}.`);
  return value;
}

function reqId(value: unknown, what: string): string {
  const id = optId(value);
  if (!id) throw errors.validation(`The export has an invalid ${what} ID.`);
  return id;
}

function optId(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim() || null
    : null;
}

function reqText(value: unknown, what: string, maxLength: number): string {
  const text = optText(value, maxLength);
  if (!text) throw errors.validation(`The export has an invalid ${what}.`);
  return text;
}

function optText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > maxLength)
    throw errors.validation(`The export includes text longer than ${maxLength} characters.`);
  return normalized;
}

function reqMinor(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw errors.validation(`The export has an invalid ${what}.`);
  return value;
}

function optMinor(value: unknown, what: string): number | null {
  if (value === null || value === undefined) return null;
  const minor = reqMinor(value, what);
  if (minor < 0) throw errors.validation(`The export has a negative ${what}.`);
  return minor;
}

/**
 * The per-account write-order rank (exports.ts). Absent on exports written
 * before the key existed — those restore through the legacy path instead.
 * A present value must be a non-negative integer; anything else is a
 * tampered export. Duplicate ranks within an account are tolerated
 * deterministically (stable array order breaks the tie), never rejected.
 */
function optWriteOrder(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw errors.validation("An entry in the export has an invalid write order.");
  return value;
}

function reqDate(value: unknown, what: string): string {
  const candidate = typeof value === "string" ? value.slice(0, 10) : "";
  if (!isIsoDate(candidate)) throw errors.validation(`The export has an invalid ${what}.`);
  return candidate;
}

function reqCurrency(value: unknown): string {
  const currency = typeof value === "string" ? value.toUpperCase() : "";
  if (!isValidCurrency(currency))
    throw errors.validation(`The export contains an unsupported currency "${String(value)}".`);
  return currency;
}

function optBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
