import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, makeUser, makeAccount, addTxn, truncateAll, actorOf, daysAgo } from "../helpers";
import {
  buildInstanceExport,
  decryptBackupArchive,
  parseInstanceExport,
  restoreInstanceExport,
  runScheduledBackup,
  type InstanceExport
} from "@/server/domain/backups";
import * as orchestrate from "@/server/domain/orchestrate";
import * as recurringSvc from "@/server/domain/recurring";
import {
  accounts,
  entries,
  families,
  recurringSeries,
  transactions,
  transfers
} from "@/server/db/schema";

const TEST_KEY = randomBytes(32).toString("base64");
const ENV_KEYS = ["BACKUP_ENCRYPTION_KEY", "BACKUP_DIR", "BACKUP_RETENTION"] as const;
const savedEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  await truncateAll();
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("operator instance backups", () => {
  it("writes an encrypted archive that decrypts back to the instance export", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meridian-backup-"));
    try {
      const user = await makeUser();
      const accountId = await makeAccount(user, { name: "Backup Checking" });
      await addTxn(user, accountId, { amountLedgerMinor: 12_345, name: "Backup txn" });

      process.env.BACKUP_ENCRYPTION_KEY = TEST_KEY;
      process.env.BACKUP_DIR = dir;
      process.env.BACKUP_RETENTION = "7";

      const result = await runScheduledBackup(db());
      expect(result.skipped).toBe(false);
      if (result.skipped) throw new Error("unreachable");

      const files = await readdir(dir);
      expect(files).toEqual([result.file]);
      const ciphertext = await readFile(path.join(dir, result.file), "utf8");
      expect(ciphertext.startsWith("v1.")).toBe(true);
      expect(ciphertext).not.toContain("Backup Checking");

      const archive = decryptBackupArchive(ciphertext);
      expect(archive.kind).toBe("meridian-instance-export");
      expect(archive.version).toBe(1);
      const accountRows = archive.tables.accounts ?? [];
      expect(accountRows.some((r) => r.name === "Backup Checking")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prunes archives beyond the retention limit, keeping the newest", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meridian-backup-"));
    try {
      await makeUser();
      process.env.BACKUP_ENCRYPTION_KEY = TEST_KEY;
      process.env.BACKUP_DIR = dir;
      process.env.BACKUP_RETENTION = "2";

      // Pre-seed three older archives (names sort before today's timestamp).
      for (const stamp of ["2020-01-01", "2020-01-02", "2020-01-03"]) {
        await writeFile(path.join(dir, `meridian-backup-${stamp}.json.enc`), "v1.old", "utf8");
      }
      const result = await runScheduledBackup(db());
      expect(result.skipped).toBe(false);
      if (result.skipped) throw new Error("unreachable");
      expect(result.pruned).toBe(2);

      const files = (await readdir(dir)).sort();
      expect(files).toHaveLength(2);
      expect(files[1]).toBe(result.file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips quietly when backups are not configured", async () => {
    delete process.env.BACKUP_ENCRYPTION_KEY;
    delete process.env.BACKUP_DIR;
    const result = await runScheduledBackup(db());
    expect(result.skipped).toBe(true);
  });

  it("restores an instance export into an empty database and refuses a second restore", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, { name: "Restore Checking" });
    await addTxn(user, accountId, { amountLedgerMinor: 7_777, name: "Restore txn" });

    const snapshot = await buildInstanceExport(db());
    const familyCount = snapshot.tables.families?.length ?? 0;
    expect(familyCount).toBeGreaterThan(0);

    await truncateAll();
    expect(await db().select().from(families)).toHaveLength(0);

    const parsed = parseInstanceExport(JSON.stringify(snapshot));
    const result = await restoreInstanceExport(db(), parsed);
    expect(result.tables.families).toBe(familyCount);
    expect(result.totalRows).toBeGreaterThan(0);

    const restoredAccounts = await db()
      .select()
      .from(accounts)
      .where(eq(accounts.familyId, user.familyId));
    expect(restoredAccounts.map((a) => a.id)).toEqual([accountId]);

    await expect(restoreInstanceExport(db(), parsed)).rejects.toThrow(/already contains families/);
  });

  it("rejects archives with the wrong key", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meridian-backup-"));
    try {
      await makeUser();
      process.env.BACKUP_ENCRYPTION_KEY = TEST_KEY;
      process.env.BACKUP_DIR = dir;
      const result = await runScheduledBackup(db());
      if (result.skipped) throw new Error("backup should be configured");
      const ciphertext = await readFile(path.join(dir, result.file), "utf8");

      process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
      expect(() => decryptBackupArchive(ciphertext)).toThrow(/could not be decrypted/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("restores transfers, splits, and recurring series with links re-attached", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const a = await makeAccount(user, {
      name: "BK Checking",
      openingBalanceDisplayMinor: 100_000
    });
    const b = await makeAccount(user, { name: "BK Savings" });
    await orchestrate.makeTransferWithEntries(db(), actor, {
      fromAccountId: a,
      toAccountId: b,
      date: daysAgo(0),
      amountDisplayMinor: 20_000
    });
    const parent = await addTxn(user, a, { amountLedgerMinor: 10_000, name: "BK Split" });
    await orchestrate.splitTransaction(db(), actor, parent, [
      { amountLedgerMinor: 6_000 },
      { amountLedgerMinor: 4_000 }
    ]);
    const seriesId = await recurringSvc.createSeries(db(), actor, {
      accountId: a,
      name: "BK Rent",
      amountLedgerMinor: 120_000,
      frequency: "monthly",
      config: { dayOfMonth: 1 },
      nextDue: daysAgo(-15)
    });

    const snapshot = await buildInstanceExport(db());
    // Reverse the entries so split children precede their parent in the
    // archive: restore must still insert parents before children.
    snapshot.tables.entries = [...(snapshot.tables.entries ?? [])].reverse();

    await truncateAll();
    const result = await restoreInstanceExport(db(), parseInstanceExport(JSON.stringify(snapshot)));
    expect(result.tables.transfers).toBe(1);

    const restoredTransfers = await db().select().from(transfers);
    expect(restoredTransfers).toHaveLength(1);
    // The transactions were inserted before transfers existed; their
    // transfer links must have been re-attached afterwards.
    const allTransactions = await db().select().from(transactions);
    const linked = allTransactions.filter((t) => t.transferId !== null);
    expect(linked).toHaveLength(2);
    expect(linked.every((t) => t.transferId === restoredTransfers[0]!.id)).toBe(true);
    const legEntries = await db()
      .select()
      .from(entries)
      .where(
        sql`${entries.id} IN (${restoredTransfers[0]!.outflowEntryId}, ${restoredTransfers[0]!.inflowEntryId})`
      );
    expect(legEntries).toHaveLength(2);
    expect(legEntries.reduce((sum, e) => sum + e.amountMinor, 0)).toBe(0);

    const restoredEntries = await db().select().from(entries);
    const children = restoredEntries.filter((e) => e.parentEntryId !== null);
    expect(children).toHaveLength(2);
    expect(children.reduce((sum, e) => sum + e.amountMinor, 0)).toBe(10_000);
    expect(children.every((c) => restoredEntries.some((e) => e.id === c.parentEntryId))).toBe(true);

    const restoredSeries = await db().select().from(recurringSeries);
    expect(restoredSeries.map((s) => s.id)).toContain(seriesId);
  });

  it("rolls back the whole restore when the archive is corrupt", async () => {
    const user = await makeUser();
    await makeAccount(user, { name: "Atomic Checking" });
    const snapshot = await buildInstanceExport(db());
    snapshot.tables.transactions = [
      ...(snapshot.tables.transactions ?? []),
      {
        id: randomUUID(),
        entryId: randomUUID(), // no such entry: FK violation mid-restore
        categoryId: null,
        merchant: null,
        transferId: null
      }
    ];

    await truncateAll();
    await expect(
      restoreInstanceExport(db(), parseInstanceExport(JSON.stringify(snapshot)))
    ).rejects.toThrow();
    // Nothing from the archive survived the failed restore.
    expect(await db().select().from(families)).toHaveLength(0);
    expect(await db().select().from(accounts)).toHaveLength(0);
  });

  it("captures one coherent snapshot while a writer commits mid-capture", async () => {
    const user = await makeUser();
    const base = await makeAccount(user, { name: "Coherence Base" });
    await addTxn(user, base, { amountLedgerMinor: 100, name: "base txn" });

    let exportPromise: Promise<InstanceExport> | null = null;
    let injectedAccountId = "";
    let injectedEntryId = "";
    // The writer holds an ACCESS EXCLUSIVE lock on entries, so the capture
    // reads the early tables, blocks on entries, and only proceeds after
    // the writer commits a brand-new account + entry pair. Under the old
    // per-statement reads the archive would contain the entry but not its
    // account; a snapshot read must contain both or neither.
    await db().transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE entries IN ACCESS EXCLUSIVE MODE`);
      exportPromise = buildInstanceExport(db());
      await new Promise((resolve) => setTimeout(resolve, 750));
      const [account] = await tx
        .insert(accounts)
        .values({
          familyId: user.familyId,
          ownerId: user.userId,
          type: "depository",
          name: "Injected Mid-Capture",
          currency: "USD",
          openedOn: daysAgo(1)
        })
        .returning({ id: accounts.id });
      injectedAccountId = account!.id;
      const [entry] = await tx
        .insert(entries)
        .values({
          accountId: injectedAccountId,
          date: daysAgo(0),
          amountMinor: 42_000,
          currency: "USD",
          name: "Injected entry",
          entryableType: "transaction"
        })
        .returning({ id: entries.id });
      injectedEntryId = entry!.id;
    });
    const archive = await exportPromise!;
    const hasEntry = (archive.tables.entries ?? []).some((r) => r.id === injectedEntryId);
    const hasAccount = (archive.tables.accounts ?? []).some((r) => r.id === injectedAccountId);
    expect(hasEntry && !hasAccount).toBe(false);
  });

  it("writes the archive via a temp file and leaves no residue", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meridian-backup-"));
    try {
      await makeUser();
      process.env.BACKUP_ENCRYPTION_KEY = TEST_KEY;
      process.env.BACKUP_DIR = dir;
      const result = await runScheduledBackup(db());
      expect(result.skipped).toBe(false);
      if (result.skipped) throw new Error("unreachable");
      const files = await readdir(dir);
      expect(files).toEqual([result.file]);
      expect(files.some((f) => f.includes(".tmp"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the family export restore path independent of operator backups", () => {
    // A household export is a different document kind: the instance parser
    // must refuse it rather than treating it as a database backup.
    expect(() =>
      parseInstanceExport(JSON.stringify({ version: 2, family: {}, accounts: [] }))
    ).toThrow(/not a Meridian instance export/);
  });
});
