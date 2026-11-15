import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, makeUser, makeAccount, addTxn, truncateAll } from "../helpers";
import {
  buildInstanceExport,
  decryptBackupArchive,
  parseInstanceExport,
  restoreInstanceExport,
  runScheduledBackup
} from "@/server/domain/backups";
import { accounts, families } from "@/server/db/schema";

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

  it("keeps the family export restore path independent of operator backups", () => {
    // A household export is a different document kind: the instance parser
    // must refuse it rather than treating it as a database backup.
    expect(() =>
      parseInstanceExport(JSON.stringify({ version: 2, family: {}, accounts: [] }))
    ).toThrow(/not a Meridian instance export/);
  });
});
