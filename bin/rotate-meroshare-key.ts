import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Executor } from "../src/server/db/migrate-types";
import { rotateMeroShareEncryptionKey } from "../src/server/domain/meroshare-rotation";
import { parseProviderSecretKey } from "../src/server/security/secrets";

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const unknown = argv.filter((a) => a !== "--dry-run");

  if (unknown.length > 0) {
    console.log("Usage: npm run meroshare:rotate-key -- [--dry-run]");
    console.log("");
    console.log("Re-encrypts stored MeroShare credentials from the current key");
    console.log("(MERO_SHARE_ENCRYPTION_KEY) to a new key supplied via");
    console.log("MERO_SHARE_NEW_ENCRYPTION_KEY. The rotation is transactional:");
    console.log("one unreadable record aborts it with nothing written.");
    console.log("--dry-run only verifies and counts records; it writes nothing.");
    console.log("");
    console.log("After a successful rotation, set MERO_SHARE_ENCRYPTION_KEY to the");
    console.log("new key in the deployment environment and restart web + worker.");
    process.exit(1);
  }

  const currentKey = parseProviderSecretKey(
    process.env.MERO_SHARE_ENCRYPTION_KEY,
    "MERO_SHARE_ENCRYPTION_KEY"
  );
  const newKey = parseProviderSecretKey(
    process.env.MERO_SHARE_NEW_ENCRYPTION_KEY,
    "MERO_SHARE_NEW_ENCRYPTION_KEY"
  );

  const db = drizzle(process.env.DATABASE_URL!) as unknown as Executor;
  const result = await rotateMeroShareEncryptionKey(db, { currentKey, newKey, dryRun });

  if (result.dryRun) {
    console.log(
      `Dry run: ${result.rotated} of ${result.connections} MeroShare connection(s) would be re-encrypted. Nothing was written.`
    );
  } else {
    console.log(
      `Rotated ${result.rotated} of ${result.connections} MeroShare connection(s) to the new key.`
    );
    console.log(
      "Now set MERO_SHARE_ENCRYPTION_KEY to the new key and restart web + worker."
    );
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
);
