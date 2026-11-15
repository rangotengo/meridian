import "dotenv/config";
import { readFile } from "node:fs/promises";
import { closeDb, getDb } from "../src/server/db/client";
import { decryptBackupArchive, restoreInstanceExport } from "../src/server/domain/backups";

async function main() {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));

  if (!file) {
    console.log("Usage: npm run backup:restore -- <backup-archive.json.enc>");
    console.log("");
    console.log("Decrypts an encrypted Meridian instance backup (created by the");
    console.log("nightly maintenance:backup job) and restores it into the database");
    console.log("configured by DATABASE_URL. The target database must be empty:");
    console.log("the restore refuses to run over existing families and applies in");
    console.log("a single transaction, so a failed restore changes nothing.");
    console.log("");
    console.log("Requires BACKUP_ENCRYPTION_KEY to match the key that created the archive.");
    process.exit(1);
  }

  const ciphertext = await readFile(file, "utf8");
  const data = decryptBackupArchive(ciphertext);
  console.log(`Archive exported at ${data.exportedAt} (format v${data.version}). Restoring...`);
  const result = await restoreInstanceExport(getDb(), data);
  for (const [table, count] of Object.entries(result.tables)) {
    if (count > 0) console.log(`  ${table}: ${count}`);
  }
  console.log(`Restore complete: ${result.totalRows} rows.`);
  console.log(
    "Verify with the /api/health endpoint and by signing in (see docs/backup-recovery.md)."
  );
}

main().then(
  async () => {
    await closeDb();
    process.exit(0);
  },
  async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await closeDb().catch(() => undefined);
    process.exit(1);
  }
);
