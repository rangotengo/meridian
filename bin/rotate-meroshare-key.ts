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
    console.log("MERO_SHARE_NEW_ENCRYPTION_KEY. PostgreSQL deployments only —");
    console.log("this does not rotate credentials inside a live Cloudflare");
    console.log("Durable Object.");
    console.log("");
    console.log("STOP web + worker (every MeroShare credential writer) before");
    console.log("running this, and keep them stopped until both are configured");
    console.log("with the new key. The rotation is transactional and aborts if a");
    console.log("credential write slips past it, but a still-running old process");
    console.log("can write old-key credentials after it commits. See the secret");
    console.log("rotation procedure in docs/RUNBOOKS.md.");
    console.log("--dry-run only verifies and counts records; it writes nothing.");
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

  if (!dryRun) {
    console.log(
      "Reminder: web + worker must be STOPPED now and stay stopped until both are configured with the new key (see docs/RUNBOOKS.md)."
    );
  }

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
      "While web + worker are still stopped, set MERO_SHARE_ENCRYPTION_KEY to the new key on BOTH apps, then redeploy/restart them and verify a MeroShare sync works."
    );
    console.log(
      "Retain the old key in your vault for as long as any retained backup contains credentials encrypted with it."
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
