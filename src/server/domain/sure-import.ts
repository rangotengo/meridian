import { usesCloudStorage } from "@/server/db/dialect";
import { inflateRawSync } from "node:zlib";
import { eq, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { chunkRows } from "../db/params";
import {
  accounts,
  auditEvents,
  budgets,
  categories,
  chatMessages,
  entries,
  families,
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
import { recalculateAccount } from "./balances";
import { errors } from "@/lib/errors";
import { isIsoDate, todayIn } from "@/lib/datetime";
import { isValidCurrency, parseAmountToMinor } from "@/lib/money";

const SOURCE = "sure_export";
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 100_000;
const SUPPORTED_TYPES = new Set([
  "Account",
  "Category",
  "Tag",
  "Transaction",
  "Transfer",
  "Valuation"
]);

type RecordData = Record<string, unknown>;
export type SureExportRecord = { type: string; data: RecordData };

export type SureImportResult = {
  accounts: number;
  categories: number;
  tags: number;
  transactions: number;
  transfers: number;
  valuations: number;
  skipped: Record<string, number>;
};

export function parseSureExport(
  fileName: string,
  bytes: Uint8Array
): { records: SureExportRecord[]; skipped: Record<string, number> } {
  if (bytes.byteLength === 0)
    throw errors.validation("Choose a Sure export archive or all.ndjson file.");
  if (bytes.byteLength > MAX_ARCHIVE_BYTES)
    throw errors.validation("The Sure export is larger than Meridian's 25 MB import limit.");
  const normalizedName = fileName.toLowerCase();
  const text =
    normalizedName.endsWith(".zip") || isZip(bytes)
      ? readNdjsonFromZip(bytes)
      : decodeNdjson(bytes);
  const records: SureExportRecord[] = [];
  const skipped: Record<string, number> = {};
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    if (records.length >= MAX_ROWS)
      throw errors.validation(`The Sure export exceeds ${MAX_ROWS.toLocaleString()} rows.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw errors.validation(`Sure export line ${index + 1} is not valid JSON.`);
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string" || !isRecord(parsed.data)) {
      throw errors.validation(`Sure export line ${index + 1} is not a recognized export record.`);
    }
    if (SUPPORTED_TYPES.has(parsed.type)) records.push({ type: parsed.type, data: parsed.data });
    else skipped[parsed.type] = (skipped[parsed.type] ?? 0) + 1;
  }
  if (!records.some((record) => record.type === "Account")) {
    throw errors.validation("The Sure export contains no accounts Meridian can migrate.");
  }
  return { records, skipped };
}

export async function importSureExport(
  exec: Executor,
  actor: Actor,
  fileName: string,
  bytes: Uint8Array
): Promise<SureImportResult> {
  const { records, skipped } = parseSureExport(fileName, bytes);
  const result = await exec.transaction(async (tx) => {
    // Serialize imports per family so the empty-family check below cannot race
    // a concurrent double-submit or writer committing mid-import.
    if (!usesCloudStorage)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${actor.familyId}))`);
    await assertFamilyIsEmpty(tx, actor.familyId);
    return importRecords(tx, actor, records, skipped);
  });
  return result;
}

async function importRecords(
  exec: Executor,
  actor: Actor,
  records: SureExportRecord[],
  skipped: Record<string, number>
): Promise<SureImportResult> {
  const byType = groupByType(records);
  const accountRecords = byType.get("Account") ?? [];
  const categoryRecords = byType.get("Category") ?? [];
  const tagRecords = byType.get("Tag") ?? [];
  const transactionRecords = byType.get("Transaction") ?? [];
  const transferRecords = byType.get("Transfer") ?? [];
  const valuationRecords = byType.get("Valuation") ?? [];

  const [family] = await exec
    .select()
    .from(families)
    .where(eq(families.id, actor.familyId))
    .limit(1);
  if (!family) throw errors.notFound("Family");

  const categoryMap = new Map<string, string>();
  const categoryParents = new Map<string, string | null>();
  for (const record of categoryRecords) {
    const sourceId = requiredId(record.data.id, "category");
    const name = requiredText(record.data.name, "category name", 120);
    const [category] = await exec
      .insert(categories)
      .values({
        familyId: actor.familyId,
        name,
        color: optionalText(record.data.color, 32),
        externalSource: SOURCE,
        externalId: sourceId
      })
      .returning({ id: categories.id });
    if (!category) throw errors.conflict("Could not import a Sure category.");
    categoryMap.set(sourceId, category.id);
    categoryParents.set(sourceId, optionalId(record.data.parent_id));
  }
  for (const [sourceId, parentSourceId] of categoryParents) {
    if (!parentSourceId) continue;
    const parentId = categoryMap.get(parentSourceId);
    if (!parentId) throw errors.validation("A Sure category references a missing parent category.");
    await exec
      .update(categories)
      .set({ parentId })
      .where(eq(categories.id, categoryMap.get(sourceId)!));
  }

  const tagMap = new Map<string, string>();
  for (const record of tagRecords) {
    const sourceId = requiredId(record.data.id, "tag");
    const [tag] = await exec
      .insert(tags)
      .values({
        familyId: actor.familyId,
        name: requiredText(record.data.name, "tag name", 60),
        color: optionalText(record.data.color, 32),
        externalSource: SOURCE,
        externalId: sourceId
      })
      .returning({ id: tags.id });
    if (!tag) throw errors.conflict("Could not import a Sure tag.");
    tagMap.set(sourceId, tag.id);
  }

  const accountMap = new Map<
    string,
    { id: string; type: string; currency: string; balanceMinor: number }
  >();
  for (const record of accountRecords) {
    const sourceId = requiredId(record.data.id, "account");
    const currency = currencyCode(record.data.currency, family.currency);
    const type = meridianAccountType(record.data.accountable_type ?? record.data.type);
    const [account] = await exec
      .insert(accounts)
      .values({
        familyId: actor.familyId,
        ownerId: actor.userId,
        type,
        subtype: optionalText(record.data.subtype, 100),
        name: requiredText(record.data.name, "account name", 120),
        institution: optionalText(record.data.institution_name ?? record.data.institution, 120),
        currency,
        status: sourceAccountStatus(record.data.status),
        includedInReports: record.data.exclude_from_reports === true ? false : true,
        openingBalanceMinor: 0,
        openedOn: dateFrom(record.data.created_at, todayIn(family.timezone)),
        externalSource: SOURCE,
        externalId: sourceId
      })
      .returning({ id: accounts.id });
    if (!account) throw errors.conflict("Could not import a Sure account.");
    accountMap.set(sourceId, {
      id: account.id,
      type,
      currency,
      balanceMinor: decimalToMinor(record.data.balance ?? 0, currency, "account balance")
    });
  }

  const transactionMap = new Map<string, string>();
  const transactionAccountSums = new Map<string, number>();
  let transactionCount = 0;
  for (const record of transactionRecords) {
    const transactionId = requiredId(record.data.id, "transaction");
    const account = accountMap.get(requiredId(record.data.account_id, "transaction account"));
    if (!account)
      throw errors.validation(
        "A Sure transaction references an account that is not in this export."
      );
    const parent = await insertTransaction(exec, {
      accountId: account.id,
      sourceId: transactionId,
      date: dateFrom(record.data.date, todayIn(family.timezone)),
      amountMinor: decimalToMinor(record.data.amount, account.currency, "transaction amount"),
      currency: account.currency,
      name: requiredText(record.data.name, "transaction description", 240),
      notes: optionalText(record.data.notes, 5_000),
      categoryId: mappedOptionalId(record.data.category_id, categoryMap, "category"),
      merchant: null,
      tagIds: mappedIds(record.data.tag_ids, tagMap, "tag")
    });
    transactionMap.set(transactionId, parent.entryId);
    transactionCount++;

    const splitLines = record.data.split_lines;
    if (splitLines !== undefined && !Array.isArray(splitLines)) {
      throw errors.validation("A Sure transaction has invalid split lines.");
    }
    if (Array.isArray(splitLines) && splitLines.length > 0) {
      let splitTotal = 0;
      for (const [index, rawLine] of splitLines.entries()) {
        if (!isRecord(rawLine)) throw errors.validation("A Sure split line is invalid.");
        const childAmount = decimalToMinor(rawLine.amount, account.currency, "split amount");
        splitTotal += childAmount;
        await insertTransaction(exec, {
          accountId: account.id,
          parentEntryId: parent.entryId,
          sourceId: `${transactionId}:split:${index + 1}`,
          date: dateFrom(rawLine.date ?? record.data.date, todayIn(family.timezone)),
          amountMinor: childAmount,
          currency: account.currency,
          name: requiredText(rawLine.name ?? record.data.name, "split description", 240),
          notes: optionalText(rawLine.notes, 5_000),
          categoryId: mappedOptionalId(rawLine.category_id, categoryMap, "category"),
          merchant: null,
          tagIds: mappedIds(rawLine.tag_ids, tagMap, "tag")
        });
        transactionCount++;
      }
      if (splitTotal !== parent.amountMinor)
        throw errors.validation("A Sure split does not add up to its parent transaction.");
      addToMap(transactionAccountSums, account.id, splitTotal);
    } else {
      addToMap(transactionAccountSums, account.id, parent.amountMinor);
    }
  }

  let transferCount = 0;
  for (const record of transferRecords) {
    const inflowSourceId =
      typeof record.data.inflow_transaction_id === "string"
        ? record.data.inflow_transaction_id.trim()
        : "";
    const outflowSourceId =
      typeof record.data.outflow_transaction_id === "string"
        ? record.data.outflow_transaction_id.trim()
        : "";
    const inflowEntryId = inflowSourceId ? transactionMap.get(inflowSourceId) : undefined;
    const outflowEntryId = outflowSourceId ? transactionMap.get(outflowSourceId) : undefined;
    const pending = String(record.data.status ?? "confirmed") === "pending";
    if (pending || !inflowEntryId || !outflowEntryId || inflowEntryId === outflowEntryId) {
      skipped.Transfer = (skipped.Transfer ?? 0) + 1;
      continue;
    }
    const [transfer] = await exec
      .insert(transfers)
      .values({
        inflowEntryId,
        outflowEntryId,
        status: "confirmed"
      })
      .returning({ id: transfers.id });
    if (!transfer) throw errors.conflict("Could not import a Sure transfer.");
    await exec
      .update(transactions)
      .set({ transferId: transfer.id })
      .where(sql`${transactions.entryId} IN (${inflowEntryId}, ${outflowEntryId})`);
    transferCount++;
  }

  let valuationCount = 0;
  const valuationAccounts = new Set<string>();
  for (const record of valuationRecords) {
    const account = accountMap.get(requiredId(record.data.account_id, "valuation account"));
    if (!account)
      throw errors.validation("A Sure valuation references an account that is not in this export.");
    const [entry] = await exec
      .insert(entries)
      .values({
        accountId: account.id,
        date: dateFrom(record.data.date, todayIn(family.timezone)),
        amountMinor: decimalToMinor(record.data.amount, account.currency, "valuation amount"),
        currency: account.currency,
        name: optionalText(record.data.name, 240) ?? "Imported valuation",
        externalSource: SOURCE,
        externalId: `valuation:${requiredId(record.data.id, "valuation")}`,
        entryableType: "valuation"
      })
      .returning({ id: entries.id });
    if (!entry) throw errors.conflict("Could not import a Sure valuation.");
    await exec
      .insert(valuations)
      .values({ entryId: entry.id, kind: valuationKind(record.data.kind) });
    valuationAccounts.add(account.id);
    valuationCount++;
  }

  for (const account of accountMap.values()) {
    if (account.type === "other_asset" || account.type === "other_liability") {
      if (!valuationAccounts.has(account.id)) {
        const [entry] = await exec
          .insert(entries)
          .values({
            accountId: account.id,
            date: todayIn(family.timezone),
            amountMinor: account.balanceMinor,
            currency: account.currency,
            name: "Imported account valuation",
            externalSource: SOURCE,
            externalId: "migration-valuation",
            entryableType: "valuation"
          })
          .returning({ id: entries.id });
        if (!entry) throw errors.conflict("Could not preserve a Sure account valuation.");
        await exec.insert(valuations).values({ entryId: entry.id, kind: "opening" });
        valuationCount++;
      }
    } else {
      const openingBalanceMinor =
        account.balanceMinor + (transactionAccountSums.get(account.id) ?? 0);
      if (!Number.isSafeInteger(openingBalanceMinor))
        throw errors.validation(
          "The Sure export contains amounts outside Meridian's supported range."
        );
      await exec
        .update(accounts)
        .set({
          openingBalanceMinor,
          updatedAt: new Date()
        })
        .where(eq(accounts.id, account.id));
    }
  }

  for (const account of accountMap.values()) await recalculateAccount(exec, account.id);
  await exec.insert(auditEvents).values({
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "family.imported_from_sure",
    entityType: "family",
    entityId: actor.familyId,
    metadata: {
      accounts: accountMap.size,
      categories: categoryMap.size,
      tags: tagMap.size,
      transactions: transactionCount,
      transfers: transferCount,
      valuations: valuationCount,
      skipped
    }
  });
  return {
    accounts: accountMap.size,
    categories: categoryMap.size,
    tags: tagMap.size,
    transactions: transactionCount,
    transfers: transferCount,
    valuations: valuationCount,
    skipped
  };
}

async function insertTransaction(
  exec: Executor,
  input: {
    accountId: string;
    parentEntryId?: string;
    sourceId: string;
    date: string;
    amountMinor: number;
    currency: string;
    name: string;
    notes: string | null;
    categoryId: string | null;
    merchant: string | null;
    tagIds: string[];
  }
): Promise<{ entryId: string; amountMinor: number }> {
  if (input.amountMinor === 0)
    throw errors.validation("Sure transactions with a zero amount cannot be migrated.");
  const [entry] = await exec
    .insert(entries)
    .values({
      accountId: input.accountId,
      parentEntryId: input.parentEntryId,
      date: input.date,
      amountMinor: input.amountMinor,
      currency: input.currency,
      name: input.name,
      notes: input.notes,
      externalSource: SOURCE,
      externalId: input.sourceId,
      entryableType: "transaction"
    })
    .returning({ id: entries.id });
  if (!entry) throw errors.conflict("Could not import a Sure transaction.");
  const [transaction] = await exec
    .insert(transactions)
    .values({ entryId: entry.id, categoryId: input.categoryId, merchant: input.merchant })
    .returning({ id: transactions.id });
  if (!transaction) throw errors.conflict("Could not import a Sure transaction.");
  for (const chunk of chunkRows(input.tagIds, 2)) {
    await exec
      .insert(transactionTags)
      .values(chunk.map((tagId) => ({ transactionId: transaction.id, tagId })));
  }
  return { entryId: entry.id, amountMinor: input.amountMinor };
}

async function assertFamilyIsEmpty(exec: Executor, familyId: string): Promise<void> {
  // A transaction is backed by one PostgreSQL client. Keep these reads
  // sequential to avoid overlapping client queries while preserving the
  // empty-family check's all-or-nothing boundary.
  const checks = [
    () =>
      exec
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.familyId, familyId))
        .limit(1),
    () =>
      exec
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.familyId, familyId))
        .limit(1),
    () => exec.select({ id: tags.id }).from(tags).where(eq(tags.familyId, familyId)).limit(1),
    () =>
      exec
        .select({ id: entries.id })
        .from(entries)
        .innerJoin(accounts, eq(accounts.id, entries.accountId))
        .where(eq(accounts.familyId, familyId))
        .limit(1),
    () =>
      exec.select({ id: budgets.id }).from(budgets).where(eq(budgets.familyId, familyId)).limit(1),
    () =>
      exec
        .select({ id: recurringSeries.id })
        .from(recurringSeries)
        .where(eq(recurringSeries.familyId, familyId))
        .limit(1),
    () =>
      exec
        .select({ id: savedFilters.id })
        .from(savedFilters)
        .innerJoin(users, eq(users.id, savedFilters.userId))
        .where(eq(users.familyId, familyId))
        .limit(1),
    () =>
      exec
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(eq(chatMessages.familyId, familyId))
        .limit(1)
  ];
  for (const check of checks) {
    if ((await check()).length > 0) {
      throw errors.conflict(
        "For safety, a Sure migration can only start in a new empty Meridian family."
      );
    }
  }
}

function groupByType(records: SureExportRecord[]): Map<string, SureExportRecord[]> {
  const grouped = new Map<string, SureExportRecord[]>();
  for (const record of records) {
    const values = grouped.get(record.type) ?? [];
    values.push(record);
    grouped.set(record.type, values);
  }
  return grouped;
}

function requiredId(value: unknown, field: string): string {
  const id = optionalId(value);
  if (!id) throw errors.validation(`The Sure export has an invalid ${field} ID.`);
  return id;
}

function optionalId(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim() || null
    : null;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const normalized = optionalText(value, maxLength);
  if (!normalized) throw errors.validation(`The Sure export has an invalid ${field}.`);
  return normalized;
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > maxLength)
    throw errors.validation(`The Sure export includes text longer than ${maxLength} characters.`);
  return normalized;
}

function mappedOptionalId(value: unknown, map: Map<string, string>, type: string): string | null {
  const sourceId = optionalId(value);
  if (!sourceId) return null;
  const mapped = map.get(sourceId);
  if (!mapped) throw errors.validation(`A Sure transaction references a missing ${type}.`);
  return mapped;
}

function mappedIds(value: unknown, map: Map<string, string>, type: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw errors.validation(`A Sure transaction has invalid ${type}s.`);
  return value.map((sourceId) => {
    const mapped = map.get(requiredId(sourceId, type));
    if (!mapped) throw errors.validation(`A Sure transaction references a missing ${type}.`);
    return mapped;
  });
}

function currencyCode(value: unknown, fallback: string): string {
  const currency = String(value ?? fallback).toUpperCase();
  if (!isValidCurrency(currency))
    throw errors.validation(`The Sure export contains unsupported currency "${currency}".`);
  return currency;
}

function dateFrom(value: unknown, fallback: string): string {
  const candidate = String(value ?? "").slice(0, 10);
  return isIsoDate(candidate) ? candidate : fallback;
}

function decimalToMinor(value: unknown, currency: string, field: string): number {
  try {
    return parseAmountToMinor(String(value), currency);
  } catch {
    throw errors.validation(`The Sure export has an invalid ${field}.`);
  }
}

function meridianAccountType(
  value: unknown
): "depository" | "credit_card" | "other_asset" | "other_liability" {
  switch (String(value ?? "").toLowerCase()) {
    case "depository":
    case "cash":
      return "depository";
    case "creditcard":
    case "credit_card":
      return "credit_card";
    case "loan":
    case "otherliability":
    case "other_liability":
      return "other_liability";
    default:
      return "other_asset";
  }
}

function sourceAccountStatus(value: unknown): "active" | "draft" | "disabled" {
  switch (String(value ?? "active")) {
    case "draft":
      return "draft";
    case "disabled":
      return "disabled";
    default:
      return "active";
  }
}

function valuationKind(value: unknown): "opening" | "reconciliation" | "current" {
  return value === "opening" || value === "reconciliation" ? value : "current";
}

function addToMap(map: Map<string, number>, key: string, value: number): void {
  const next = (map.get(key) ?? 0) + value;
  if (!Number.isSafeInteger(next))
    throw errors.validation("The Sure export contains amounts outside Meridian's supported range.");
  map.set(key, next);
}

function isRecord(value: unknown): value is RecordData {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

function decodeNdjson(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_EXTRACTED_BYTES)
    throw errors.validation("The Sure export contains too much extracted data.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw errors.validation("The Sure export is not valid UTF-8 NDJSON.");
  }
}

/** Read only all.ndjson from Sure's standard ZIP without accepting zip-slip paths or zip bombs. */
function readNdjsonFromZip(bytes: Uint8Array): string {
  const end = findEndOfCentralDirectory(bytes);
  if (end < 0) throw errors.validation("The Sure export ZIP is invalid.");
  const centralOffset = readUInt32(bytes, end + 16);
  const entryCount = readUInt16(bytes, end + 10);
  if (entryCount > 100) throw errors.validation("The Sure export ZIP has too many files.");
  let cursor = centralOffset;
  let target: {
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    localOffset: number;
  } | null = null;
  for (let index = 0; index < entryCount; index++) {
    if (readUInt32(bytes, cursor) !== 0x02014b50)
      throw errors.validation("The Sure export ZIP is invalid.");
    const method = readUInt16(bytes, cursor + 10);
    const compressedSize = readUInt32(bytes, cursor + 20);
    const uncompressedSize = readUInt32(bytes, cursor + 24);
    const fileNameLength = readUInt16(bytes, cursor + 28);
    const extraLength = readUInt16(bytes, cursor + 30);
    const commentLength = readUInt16(bytes, cursor + 32);
    const localOffset = readUInt32(bytes, cursor + 42);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.slice(cursor + 46, cursor + 46 + fileNameLength)
    );
    if (name === "all.ndjson") {
      if (target)
        throw errors.validation("The Sure export ZIP includes more than one all.ndjson file.");
      target = { method, compressedSize, uncompressedSize, localOffset };
    }
    cursor += 46 + fileNameLength + extraLength + commentLength;
    if (cursor > bytes.length) throw errors.validation("The Sure export ZIP is invalid.");
  }
  if (!target) throw errors.validation("The Sure export ZIP does not include all.ndjson.");
  if (target.uncompressedSize > MAX_EXTRACTED_BYTES || target.compressedSize > MAX_ARCHIVE_BYTES) {
    throw errors.validation("The Sure export contains too much extracted data.");
  }
  if (readUInt32(bytes, target.localOffset) !== 0x04034b50)
    throw errors.validation("The Sure export ZIP is invalid.");
  const localNameLength = readUInt16(bytes, target.localOffset + 26);
  const localExtraLength = readUInt16(bytes, target.localOffset + 28);
  const dataStart = target.localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + target.compressedSize;
  if (dataEnd > bytes.length) throw errors.validation("The Sure export ZIP is invalid.");
  const compressed = bytes.slice(dataStart, dataEnd);
  let output: Uint8Array;
  try {
    output =
      target.method === 0
        ? compressed
        : target.method === 8
          ? inflateRawSync(compressed, { maxOutputLength: MAX_EXTRACTED_BYTES })
          : (() => {
              throw new Error("unsupported compression");
            })();
  } catch {
    throw errors.validation("The Sure export ZIP could not be safely extracted.");
  }
  if (output.byteLength !== target.uncompressedSize || output.byteLength > MAX_EXTRACTED_BYTES) {
    throw errors.validation("The Sure export ZIP has an invalid all.ndjson file.");
  }
  return decodeNdjson(output);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const lowerBound = Math.max(0, bytes.length - 65_557);
  for (let index = bytes.length - 22; index >= lowerBound; index--) {
    if (readUInt32(bytes, index) === 0x06054b50) return index;
  }
  return -1;
}

function readUInt16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length)
    throw errors.validation("The Sure export ZIP is invalid.");
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length)
    throw errors.validation("The Sure export ZIP is invalid.");
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}
