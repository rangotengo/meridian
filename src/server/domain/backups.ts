import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getTableColumns, type Table } from "drizzle-orm";
import type { Executor } from "../db/client";
import { usesCloudStorage } from "../db/dialect";
import { chunkRows } from "../db/params";
import {
  accountShares,
  accounts,
  apiKeys,
  auditEvents,
  balances,
  budgets,
  categories,
  chatMessages,
  chatProposals,
  debugLogEntries,
  entries,
  exchangeRates,
  families,
  featureFlags,
  instanceInvitations,
  invitations,
  meroShareAccounts,
  meroShareConnections,
  meroShareHoldings,
  meroShareTransactions,
  recurringSeries,
  savedFilters,
  tags,
  transactionTags,
  transactions,
  transfers,
  users,
  valuations
} from "../db/schema";
import { recordAudit } from "../observability/audit";
import { decryptWithKey, encryptWithKey } from "../security/secrets";
import { backupConfig } from "@/lib/env";
import { errors } from "@/lib/errors";

/**
 * Operator-level instance backup and restore.
 *
 * An instance export is a versioned JSON document holding every data-bearing
 * table (credentials included — the archive is always encrypted at rest).
 * Ephemeral runtime state is deliberately excluded: sessions and auth tokens
 * (users sign in again after a restore), rate-limit counters, the job queue,
 * and cron schedules (the worker recreates its schedules on boot).
 *
 * Tables are listed in foreign-key order (parents before children) so a
 * restore can insert them verbatim, preserving ids, into an empty database.
 */

export const INSTANCE_EXPORT_VERSION = 1;
const INSTANCE_EXPORT_KIND = "meridian-instance-export";
const BACKUP_FILE_PREFIX = "meridian-backup-";
const BACKUP_FILE_SUFFIX = ".json.enc";
const KEY_ENV_NAME = "BACKUP_ENCRYPTION_KEY";

type TableRows = Record<string, unknown>[];

const INSTANCE_TABLES: { name: string; table: Table }[] = [
  { name: "families", table: families },
  { name: "users", table: users },
  { name: "exchangeRates", table: exchangeRates },
  { name: "featureFlags", table: featureFlags },
  { name: "invitations", table: invitations },
  { name: "instanceInvitations", table: instanceInvitations },
  { name: "apiKeys", table: apiKeys },
  { name: "categories", table: categories },
  { name: "tags", table: tags },
  { name: "accounts", table: accounts },
  { name: "accountShares", table: accountShares },
  { name: "recurringSeries", table: recurringSeries },
  { name: "entries", table: entries },
  { name: "transactions", table: transactions },
  { name: "valuations", table: valuations },
  { name: "transfers", table: transfers },
  { name: "transactionTags", table: transactionTags },
  { name: "budgets", table: budgets },
  { name: "savedFilters", table: savedFilters },
  { name: "balances", table: balances },
  { name: "auditEvents", table: auditEvents },
  { name: "debugLogEntries", table: debugLogEntries },
  { name: "meroShareConnections", table: meroShareConnections },
  { name: "meroShareAccounts", table: meroShareAccounts },
  { name: "meroShareHoldings", table: meroShareHoldings },
  { name: "meroShareTransactions", table: meroShareTransactions },
  { name: "chatMessages", table: chatMessages },
  { name: "chatProposals", table: chatProposals }
];

export type InstanceExport = {
  kind: typeof INSTANCE_EXPORT_KIND;
  version: number;
  exportedAt: string;
  tables: Record<string, TableRows>;
};

export async function buildInstanceExport(exec: Executor): Promise<InstanceExport> {
  const tables: Record<string, TableRows> = {};
  for (const { name, table } of INSTANCE_TABLES) {
    const rows = await exec.select().from(table);
    tables[name] = rows as TableRows;
  }
  return {
    kind: INSTANCE_EXPORT_KIND,
    version: INSTANCE_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    tables
  };
}

export function parseInstanceExport(text: string): InstanceExport {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw errors.validation("The backup archive does not contain valid JSON.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw errors.validation("The backup archive is not a Meridian instance export.");
  const data = raw as Record<string, unknown>;
  if (data.kind !== INSTANCE_EXPORT_KIND)
    throw errors.validation("The backup archive is not a Meridian instance export.");
  if (data.version !== INSTANCE_EXPORT_VERSION)
    throw errors.validation(
      `This backup format version (${String(data.version)}) is not supported by this Meridian version.`
    );
  if (typeof data.tables !== "object" || data.tables === null || Array.isArray(data.tables))
    throw errors.validation("The backup archive is missing its table data.");
  for (const { name } of INSTANCE_TABLES) {
    const rows = (data.tables as Record<string, unknown>)[name];
    if (rows !== undefined && !Array.isArray(rows))
      throw errors.validation(`The backup archive has invalid rows for table "${name}".`);
  }
  return data as unknown as InstanceExport;
}

export type InstanceRestoreResult = { tables: Record<string, number>; totalRows: number };

/**
 * Restore an instance export into an EMPTY database, preserving ids.
 * Runs in one transaction: any failure leaves the database untouched.
 */
export async function restoreInstanceExport(
  exec: Executor,
  data: InstanceExport
): Promise<InstanceRestoreResult> {
  return exec.transaction(async (tx) => {
    const existing = await tx.select({ id: families.id }).from(families).limit(1);
    if (existing.length > 0) {
      throw errors.conflict(
        "Refusing to restore into a database that already contains families. Restore into a fresh, empty instance instead."
      );
    }
    const counts: Record<string, number> = {};
    let totalRows = 0;
    for (const { name, table } of INSTANCE_TABLES) {
      let rows = (data.tables[name] ?? []) as TableRows;
      // Categories reference their parent category: insert parents first.
      if (name === "categories") rows = sortCategoriesParentsFirst(rows);
      rows = rows.map((row) => reviveTimestamps(table, row));
      if (rows.length === 0) {
        counts[name] = 0;
        continue;
      }
      const columnsPerRow = Math.max(1, Object.keys(rows[0]!).length);
      for (const chunk of chunkRows(rows, columnsPerRow)) {
        await tx.insert(table).values(chunk as (typeof table)["$inferInsert"][]);
      }
      counts[name] = rows.length;
      totalRows += rows.length;
    }
    return { tables: counts, totalRows };
  });
}

/**
 * JSON archives carry timestamps as ISO strings, but the PostgreSQL driver
 * maps timestamp columns from Date objects. Revive them per column type.
 * The cloud SQLite backend stores ISO text natively, so it is left as-is.
 */
function reviveTimestamps(table: Table, row: Record<string, unknown>): Record<string, unknown> {
  if (usesCloudStorage) return row;
  const columns = getTableColumns(table);
  let revived: Record<string, unknown> | null = null;
  for (const [key, column] of Object.entries(columns)) {
    const value = row[key];
    if (column.dataType === "date" && typeof value === "string") {
      revived ??= { ...row };
      revived[key] = new Date(value);
    }
  }
  return revived ?? row;
}

function sortCategoriesParentsFirst(rows: TableRows): TableRows {
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const sorted: TableRows = [];
  const placed = new Set<string>();
  const pending = [...rows];
  while (pending.length > 0) {
    const before = pending.length;
    for (let i = pending.length - 1; i >= 0; i--) {
      const row = pending[i]!;
      const parentId = row.parentId;
      if (
        parentId === null ||
        parentId === undefined ||
        !byId.has(String(parentId)) ||
        placed.has(String(parentId))
      ) {
        sorted.push(row);
        placed.add(String(row.id));
        pending.splice(i, 1);
      }
    }
    if (pending.length === before) {
      // A cycle or dangling parent chain: fall back to the original order and
      // let the database constraint report the problem inside the transaction.
      sorted.push(...pending);
      break;
    }
  }
  return sorted;
}

export type ScheduledBackupResult =
  | { skipped: true; reason: string }
  | { skipped: false; file: string; bytes: number; pruned: number };

/**
 * Nightly worker job: write an encrypted instance backup to BACKUP_DIR and
 * prune all but the newest BACKUP_RETENTION archives. When backups are not
 * configured (no key or no directory) the job completes as a no-op so an
 * unconfigured instance does not dead-letter every night.
 */
export async function runScheduledBackup(exec: Executor): Promise<ScheduledBackupResult> {
  const config = backupConfig();
  if (!config.encryptionKey || !config.dir) {
    return {
      skipped: true,
      reason: "BACKUP_ENCRYPTION_KEY or BACKUP_DIR is not configured."
    };
  }
  const data = await buildInstanceExport(exec);
  const ciphertext = encryptWithKey(JSON.stringify(data), config.encryptionKey, KEY_ENV_NAME);
  await mkdir(config.dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${BACKUP_FILE_PREFIX}${stamp}${BACKUP_FILE_SUFFIX}`;
  const filePath = path.join(config.dir, fileName);
  await writeFile(filePath, ciphertext, "utf8");

  const archives = (await readdir(config.dir))
    .filter((f) => f.startsWith(BACKUP_FILE_PREFIX) && f.endsWith(BACKUP_FILE_SUFFIX))
    .sort();
  let pruned = 0;
  const excess = archives.length - config.retention;
  if (excess > 0) {
    for (const stale of archives.slice(0, excess)) {
      await unlink(path.join(config.dir, stale));
      pruned++;
    }
  }

  await recordAudit(exec, {
    familyId: null,
    actorUserId: null,
    action: "instance.backup_created",
    entityType: "instance",
    entityId: null,
    metadata: { file: fileName, bytes: ciphertext.length, pruned }
  });

  return { skipped: false, file: fileName, bytes: ciphertext.length, pruned };
}

/** Decrypt a backup archive's contents (used by the restore CLI and tests). */
export function decryptBackupArchive(ciphertext: string): InstanceExport {
  const config = backupConfig();
  const plaintext = decryptWithKey(ciphertext.trim(), config.encryptionKey, KEY_ENV_NAME);
  return parseInstanceExport(plaintext);
}
