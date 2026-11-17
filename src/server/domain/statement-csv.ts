import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { entries } from "../db/schema";
import type { Actor } from "../auth/context";
import { assertAccountOpen } from "../authorization/access";
import { usesCloudStorage } from "../db/dialect";
import { chunkParams, chunkRows } from "../db/params";
import { errors } from "@/lib/errors";
import { isIsoDate } from "@/lib/datetime";
import { parseAmountToMinor } from "@/lib/money";
import { createTransactionEntry } from "./entries";
import { recalculateAccount } from "./balances";
import { recordAudit } from "../observability/audit";

export const STATEMENT_CSV_SOURCE = "statement_csv";
const MAX_CSV_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10_000;
export const STATEMENT_PREVIEW_ROWS = 50;

/** Minimal RFC 4180 parser: quoted fields, embedded commas/newlines, CRLF, BOM. */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else if (ch === '"') {
      // A quote opens a quoted field only at the field start; mid-field
      // quotes are literal, so sloppy exports still parse.
      if (field === "") {
        inQuotes = true;
        i++;
      } else {
        field += ch;
        i++;
      }
    } else if (ch === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i++;
    } else if (ch === "\r") {
      if (input[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  while (rows.length > 0 && rows[rows.length - 1]!.every((c) => c.trim() === "")) rows.pop();
  return rows;
}

export type StatementMapping = {
  date: number | null;
  description: number | null;
  /** Signed single amount column (negative = money out). */
  amount: number | null;
  debit: number | null;
  credit: number | null;
};

function findHeader(headers: string[], patterns: RegExp[]): number | null {
  const norm = headers.map((h) => h.trim().toLowerCase());
  for (let i = 0; i < norm.length; i++) {
    if (patterns.some((p) => p.test(norm[i]!))) return i;
  }
  return null;
}

/** Best-guess mapping from header names. Nepali bank statements usually use Date / Particulars / Debit / Credit / Balance. */
export function detectStatementMapping(headers: string[]): StatementMapping {
  const debit = findHeader(headers, [/debit/, /withdrawal/, /^dr$/]);
  const credit = findHeader(headers, [/credit/, /deposit/, /^cr$/]);
  const amount = findHeader(headers, [/amount/]);
  return {
    date: findHeader(headers, [/date/]),
    description: findHeader(headers, [
      /description/,
      /particulars/,
      /narration/,
      /details/,
      /payee/,
      /merchant/,
      /remarks?/
    ]),
    // "Debit amount" / "Credit amount" belong to the split columns, not amount.
    amount: amount !== null && amount !== debit && amount !== credit ? amount : null,
    debit,
    credit
  };
}

export function validateStatementMapping(mapping: StatementMapping, columnCount: number): void {
  const roles: [string, number | null][] = [
    ["date", mapping.date],
    ["description", mapping.description],
    ["amount", mapping.amount],
    ["debit", mapping.debit],
    ["credit", mapping.credit]
  ];
  const seen = new Set<number>();
  for (const [role, index] of roles) {
    if (index === null) continue;
    if (!Number.isInteger(index) || index < 0 || index >= columnCount) {
      throw errors.validation(`The ${role} column is outside the file.`);
    }
    if (seen.has(index)) throw errors.validation(`Two columns map to the same ${role} column.`);
    seen.add(index);
  }
  if (mapping.date === null) throw errors.validation("Map a date column.");
  if (mapping.description === null) throw errors.validation("Map a description column.");
  const hasAmount = mapping.amount !== null;
  const hasSplit = mapping.debit !== null || mapping.credit !== null;
  if (hasAmount && hasSplit) {
    throw errors.validation("Use either one amount column or debit + credit columns, not both.");
  }
  if (!hasAmount && !hasSplit) {
    throw errors.validation("Map an amount column, or debit and credit columns.");
  }
  if (hasSplit && (mapping.debit === null || mapping.credit === null)) {
    throw errors.validation("Map both a debit and a credit column.");
  }
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
};

function isoDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** ISO, DD/MM/YYYY or DD-MM-YYYY (day first, the Nepal convention), or "9 Sep 2026". */
export function parseStatementDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (isIsoDate(s)) return s;
  const numeric = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (numeric) return isoDate(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]));
  const named = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(s);
  if (named) {
    const month = MONTHS[named[2]!.toLowerCase().slice(0, 3)];
    if (month) return isoDate(Number(named[3]), month, Number(named[1]));
  }
  return null;
}

/**
 * Parse a statement amount to integer minor units in the account currency.
 * Understands thousands separators, currency tokens, "(1,234.00)" and
 * trailing Dr/Cr markers. Returns null when the text is not a number.
 * The sign follows the statement: negative means money out.
 */
export function parseStatementAmount(raw: string, currency: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  const drCr = /\s*(dr|cr)\.?$/i.exec(s);
  if (drCr) {
    if (drCr[1]!.toLowerCase() === "dr") negative = true;
    s = s.slice(0, drCr.index).trim();
  }
  s = s.replace(/[,\s]/g, "");
  s = s.replace(/^(npr|rs\.?|रू\.?)/i, "").replace(/(npr|rs\.?)$/i, "");
  if (s.endsWith("-")) {
    negative = true;
    s = s.slice(0, -1);
  }
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  let minor: number;
  try {
    minor = parseAmountToMinor(s, currency);
  } catch {
    return null;
  }
  return negative ? -Math.abs(minor) : minor;
}

export type ParsedStatementRow = {
  /** 1-based data row number, excluding the header. */
  rowNumber: number;
  date: string | null;
  name: string | null;
  /** Ledger minor units (outflow positive). Null when the row has an error. */
  amountLedgerMinor: number | null;
  error: string | null;
};

function cell(row: string[], index: number | null): string {
  if (index === null) return "";
  return row[index] ?? "";
}

export function parseStatementRows(
  rows: string[][],
  mapping: StatementMapping,
  currency: string
): ParsedStatementRow[] {
  return rows.map((row, i) => {
    const rowNumber = i + 1;
    const base: ParsedStatementRow = {
      rowNumber,
      date: null,
      name: null,
      amountLedgerMinor: null,
      error: null
    };
    const name = cell(row, mapping.description).trim();
    if (!name) return { ...base, error: "Missing description." };
    if (name.length > 240) return { ...base, error: "Description is longer than 240 characters." };
    const date = parseStatementDate(cell(row, mapping.date));
    if (!date) {
      return { ...base, name, error: `Unrecognized date "${cell(row, mapping.date).trim()}".` };
    }
    let ledger: number | null = null;
    if (mapping.amount !== null) {
      const raw = cell(row, mapping.amount);
      const signed = parseStatementAmount(raw, currency);
      if (signed === null)
        return { ...base, name, date, error: `Unrecognized amount "${raw.trim()}".` };
      if (signed === 0) return { ...base, name, date, error: "Amount is zero." };
      ledger = -signed;
    } else {
      const debitRaw = cell(row, mapping.debit);
      const creditRaw = cell(row, mapping.credit);
      // An explicit 0 counts as absent for the both/neither decision, so a
      // statement that writes 0 in the empty column still imports; a row
      // whose only values are zero is rejected instead of recording zero.
      const debit = debitRaw.trim() === "" ? 0 : parseStatementAmount(debitRaw, currency);
      const credit = creditRaw.trim() === "" ? 0 : parseStatementAmount(creditRaw, currency);
      if (debit === null) {
        return { ...base, name, date, error: `Unrecognized debit "${debitRaw.trim()}".` };
      }
      if (credit === null) {
        return { ...base, name, date, error: `Unrecognized credit "${creditRaw.trim()}".` };
      }
      if (debit !== 0 && credit !== 0) {
        return { ...base, name, date, error: "Row has both a debit and a credit." };
      }
      if (debit === 0 && credit === 0) {
        if (debitRaw.trim() === "" && creditRaw.trim() === "") {
          return { ...base, name, date, error: "Row has neither a debit nor a credit." };
        }
        return { ...base, name, date, error: "Amount is zero." };
      }
      ledger = debit !== 0 ? Math.abs(debit) : -Math.abs(credit);
    }
    return { ...base, name, date, amountLedgerMinor: ledger };
  });
}

export function normalizeStatementName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Stable dedupe id for a statement row, shared by preview and confirm. */
export function statementExternalId(
  accountId: string,
  date: string,
  amountLedgerMinor: number,
  name: string
): string {
  const hash = createHash("sha256")
    .update(`${accountId}|${date}|${amountLedgerMinor}|${normalizeStatementName(name)}`)
    .digest("hex")
    .slice(0, 32);
  return `csv_${hash}`;
}

function parseStatementFile(text: string): { headers: string[]; rows: string[][] } {
  if (new TextEncoder().encode(text).length > MAX_CSV_BYTES) {
    throw errors.validation("The statement file is larger than Meridian's 5 MB import limit.");
  }
  const all = parseCsv(text);
  if (all.length === 0) throw errors.validation("The statement file is empty.");
  const headers = all[0]!;
  if (headers.every((h) => h.trim() === "")) {
    throw errors.validation("The statement file has no header row.");
  }
  const rows = all.slice(1);
  if (rows.length > MAX_ROWS) {
    throw errors.validation(`The statement exceeds ${MAX_ROWS.toLocaleString()} rows.`);
  }
  return { headers, rows };
}

export type StatementParseResult = {
  headers: string[];
  mapping: StatementMapping;
  rowCount: number;
};

/** Parse only: headers + detected mapping, so the UI can offer corrections. */
export function parseStatementHeaders(text: string): StatementParseResult {
  const { headers, rows } = parseStatementFile(text);
  return { headers, mapping: detectStatementMapping(headers), rowCount: rows.length };
}

export type StatementPreviewRow = ParsedStatementRow & {
  duplicate: boolean;
  duplicateEntryId: string | null;
  externalId: string | null;
};

export type StatementPreview = {
  headers: string[];
  mapping: StatementMapping;
  totalRows: number;
  importableCount: number;
  duplicateCount: number;
  errorCount: number;
  /** First STATEMENT_PREVIEW_ROWS rows; the rest are counted, not listed. */
  rows: StatementPreviewRow[];
};

async function findDuplicates(
  exec: Executor,
  accountId: string,
  clean: { date: string; amountLedgerMinor: number; name: string; externalId: string }[]
): Promise<Map<string, string>> {
  const byExternalId = new Map<string, string>();
  if (clean.length === 0) return byExternalId;
  // 1) Re-imports: the external id recorded on the first import.
  for (const chunk of chunkParams(clean.map((c) => c.externalId))) {
    const rows = await exec
      .select({ id: entries.id, externalId: entries.externalId })
      .from(entries)
      .where(
        and(
          eq(entries.accountId, accountId),
          eq(entries.externalSource, STATEMENT_CSV_SOURCE),
          inArray(entries.externalId, chunk)
        )
      );
    for (const r of rows) if (r.externalId) byExternalId.set(r.externalId, r.id);
  }
  // 2) Transactions entered by hand before the import: same account, date,
  // amount, and normalized description. Batched per distinct (date, amount).
  const pairs = [...new Map(clean.map((c) => [`${c.date}|${c.amountLedgerMinor}`, c])).values()];
  const candidates: { id: string; date: string; amountMinor: number; name: string }[] = [];
  for (const chunk of chunkRows(pairs, 2, 10)) {
    const conditions = chunk.map(
      (c) => sql`(date = ${c.date} AND amount_minor = ${c.amountLedgerMinor})`
    );
    const rows = await exec
      .select({
        id: entries.id,
        date: entries.date,
        amountMinor: entries.amountMinor,
        name: entries.name
      })
      .from(entries)
      .where(and(eq(entries.accountId, accountId), or(...conditions)));
    candidates.push(...rows.map((r) => ({ ...r, date: r.date.slice(0, 10) })));
  }
  const byContent = new Map<string, string>();
  for (const c of candidates) {
    byContent.set(`${c.date}|${c.amountMinor}|${normalizeStatementName(c.name)}`, c.id);
  }
  const out = new Map<string, string>();
  for (const c of clean) {
    const fromExternal = byExternalId.get(c.externalId);
    if (fromExternal) {
      out.set(c.externalId, fromExternal);
      continue;
    }
    const fromContent = byContent.get(
      `${c.date}|${c.amountLedgerMinor}|${normalizeStatementName(c.name)}`
    );
    if (fromContent) out.set(c.externalId, fromContent);
  }
  return out;
}

export async function previewStatementImport(
  exec: Executor,
  actor: Actor,
  input: { accountId: string; text: string; mapping: StatementMapping }
): Promise<StatementPreview> {
  const { account } = await assertAccountOpen(exec, actor, input.accountId, "manage");
  const { headers, rows } = parseStatementFile(input.text);
  validateStatementMapping(input.mapping, headers.length);
  const parsed = parseStatementRows(rows, input.mapping, account.currency);
  const clean = parsed
    .filter((r) => r.error === null && r.date !== null && r.amountLedgerMinor !== null)
    .map((r) => ({
      date: r.date!,
      amountLedgerMinor: r.amountLedgerMinor!,
      name: r.name!,
      externalId: statementExternalId(input.accountId, r.date!, r.amountLedgerMinor!, r.name!)
    }));
  const duplicates = await findDuplicates(exec, input.accountId, clean);
  const seen = new Set<string>();
  let importableCount = 0;
  let duplicateCount = 0;
  let errorCount = 0;
  const previewRows: StatementPreviewRow[] = parsed.map((r) => {
    if (r.error !== null) {
      errorCount++;
      return { ...r, duplicate: false, duplicateEntryId: null, externalId: null };
    }
    const externalId = statementExternalId(input.accountId, r.date!, r.amountLedgerMinor!, r.name!);
    if (seen.has(externalId)) {
      duplicateCount++;
      return { ...r, duplicate: true, duplicateEntryId: null, externalId };
    }
    seen.add(externalId);
    const duplicateEntryId = duplicates.get(externalId) ?? null;
    if (duplicateEntryId) {
      duplicateCount++;
      return { ...r, duplicate: true, duplicateEntryId, externalId };
    }
    importableCount++;
    return { ...r, duplicate: false, duplicateEntryId: null, externalId };
  });
  return {
    headers,
    mapping: input.mapping,
    totalRows: parsed.length,
    importableCount,
    duplicateCount,
    errorCount,
    rows: previewRows.slice(0, STATEMENT_PREVIEW_ROWS)
  };
}

export type StatementImportResult = {
  imported: number;
  skippedDuplicates: number;
  skippedErrors: number;
  totalRows: number;
};

/**
 * Import the clean, non-duplicate rows. The preview is display-only: the
 * file is re-parsed and duplicates re-checked here, so a row that changed
 * between preview and confirm cannot slip through. One transaction for the
 * whole import (plus the per-family advisory lock, like the Sure import):
 * duplicate discovery, entries, audit, AND the balance recalculation all
 * run inside it, so a recalculation failure rolls the import back instead
 * of leaving committed entries with stale balances that no retry can heal.
 */
export async function confirmStatementImport(
  exec: Executor,
  actor: Actor,
  input: { accountId: string; text: string; mapping: StatementMapping }
): Promise<StatementImportResult> {
  // Re-parse from scratch: the preview lists only the first 50 rows, and
  // duplicates are re-checked here so a row that changed between preview
  // and confirm cannot slip through.
  const { account } = await assertAccountOpen(exec, actor, input.accountId, "manage");
  const { headers, rows } = parseStatementFile(input.text);
  validateStatementMapping(input.mapping, headers.length);
  const parsed = parseStatementRows(rows, input.mapping, account.currency);
  const clean = parsed
    .filter((r) => r.error === null && r.date !== null && r.amountLedgerMinor !== null)
    .map((r) => ({
      row: r,
      externalId: statementExternalId(input.accountId, r.date!, r.amountLedgerMinor!, r.name!)
    }));
  return exec.transaction(async (tx) => {
    if (!usesCloudStorage) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${actor.familyId}))`);
    }
    // Duplicate discovery runs inside the lock/transaction, so its snapshot
    // is serialized with the writes: a concurrent import cannot slip in
    // between the check and the insert.
    const duplicates = await findDuplicates(
      tx,
      input.accountId,
      clean.map((c) => ({
        date: c.row.date!,
        amountLedgerMinor: c.row.amountLedgerMinor!,
        name: c.row.name!,
        externalId: c.externalId
      }))
    );
    const seen = new Set<string>();
    const importable = clean.filter((c) => {
      if (seen.has(c.externalId)) return false;
      seen.add(c.externalId);
      return !duplicates.has(c.externalId);
    });
    const skippedDuplicates = clean.length - importable.length;
    const skippedErrors = parsed.length - clean.length;

    let imported = 0;
    let earliest: string | null = null;
    for (const c of importable) {
      const res = await createTransactionEntry(tx, actor, {
        accountId: input.accountId,
        date: c.row.date!,
        amountLedgerMinor: c.row.amountLedgerMinor!,
        name: c.row.name!,
        externalSource: STATEMENT_CSV_SOURCE,
        externalId: c.externalId
      });
      if (res.duplicated) continue;
      imported++;
      if (earliest === null || c.row.date! < earliest) earliest = c.row.date!;
    }
    await recordAudit(tx, {
      familyId: actor.familyId,
      actorUserId: actor.userId,
      action: "statement_csv.imported",
      entityType: "account",
      entityId: input.accountId,
      metadata: { imported, skippedDuplicates, skippedErrors, totalRows: parsed.length }
    });
    // Balances are derived state of the entries just written, so they are
    // rebuilt in the same transaction: if this throws, the entries roll
    // back with it and a retry imports cleanly instead of finding every
    // row already duplicated with balances still stale.
    if (imported > 0 && earliest) {
      await recalculateAccount(tx, input.accountId, earliest);
    }
    return { imported, skippedDuplicates, skippedErrors, totalRows: parsed.length };
  });
}
