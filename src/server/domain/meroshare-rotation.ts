import { eq } from "drizzle-orm";
import type { Executor } from "../db/client";
import { meroShareConnections } from "../db/schema";
import {
  decryptProviderSecretWithKey,
  encryptProviderSecretWithKey
} from "../security/secrets";
import { errors } from "@/lib/errors";

export type MeroShareKeyRotationResult = {
  dryRun: boolean;
  /** Connections whose stored credentials were examined. */
  connections: number;
  /** Connections re-encrypted (or that would be, when `dryRun` is true). */
  rotated: number;
};

/**
 * Re-encrypt every stored MeroShare credential from the current key to a new
 * key. Runs in a single transaction: all records are decrypted before any
 * write happens, so one unreadable record aborts the rotation with nothing
 * written and the old key keeps working. With `dryRun`, records are verified
 * as decryptable under the current key and counted, but nothing is written.
 */
export async function rotateMeroShareEncryptionKey(
  exec: Executor,
  options: { currentKey: Buffer; newKey: Buffer; dryRun?: boolean }
): Promise<MeroShareKeyRotationResult> {
  const dryRun = options.dryRun ?? false;
  if (options.currentKey.equals(options.newKey)) {
    throw errors.validation(
      "The new MeroShare encryption key is identical to the current key; nothing to rotate."
    );
  }
  return exec.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: meroShareConnections.id,
        usernameEncrypted: meroShareConnections.usernameEncrypted,
        passwordEncrypted: meroShareConnections.passwordEncrypted
      })
      .from(meroShareConnections);

    // Decrypt everything up front: a single record that does not decrypt
    // under the current key throws here, rolling the transaction back before
    // any row has been rewritten.
    const planned = rows.map((row) => ({
      id: row.id,
      username: decryptProviderSecretWithKey(row.usernameEncrypted, options.currentKey),
      password: decryptProviderSecretWithKey(row.passwordEncrypted, options.currentKey)
    }));

    if (!dryRun) {
      for (const record of planned) {
        await tx
          .update(meroShareConnections)
          .set({
            usernameEncrypted: encryptProviderSecretWithKey(record.username, options.newKey),
            passwordEncrypted: encryptProviderSecretWithKey(record.password, options.newKey),
            updatedAt: new Date()
          })
          .where(eq(meroShareConnections.id, record.id));
      }
    }

    return { dryRun, connections: rows.length, rotated: planned.length };
  });
}
