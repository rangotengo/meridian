import "dotenv/config";
import { closeDb, getDb } from "@/server/db/client";
import { recalculateAllActiveAccounts } from "@/server/domain/balances-maintenance";

/**
 * One-off ops script: rebuild every active account's balance snapshots
 * with the current engine. Same pass the nightly maintenance:balances job
 * runs. Use after an engine fix, when stored snapshots are stale.
 *
 * Usage (inside the web/worker container, where DATABASE_URL is set):
 *   npx tsx bin/rebuild-balances.ts
 */
async function main() {
  const db = getDb();
  const result = await recalculateAllActiveAccounts(db);
  console.log(
    JSON.stringify({ recalculated: result.recalculated, failures: result.failures }, null, 2)
  );
  if (result.failures.length > 0) {
    process.exitCode = 1;
  }
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
