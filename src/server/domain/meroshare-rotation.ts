import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { usesCloudStorage } from "../db/dialect";
import { meroShareConnections } from "../db/schema";
import { decryptProviderSecretWithKey, encryptProviderSecretWithKey } from "../security/secrets";
import { errors } from "@/lib/errors";

export type MeroShareKeyRotationResult = {
  dryRun: boolean;
  /** Connections whose stored credentials were examined. */
  connections: number;
  /** Connections re-encrypted (or that would be, when `dryRun` is true). */
  rotated: number;
};

/**
 * Advisory-lock identity serializing MeroShare credential writes against key
 * rotation. Credential writers hold the shared side for the duration of
 * their write transaction; a rotation holds the exclusive side for its whole
 * transaction, so cooperating processes can never interleave with one.
 * Postgres only — the cloud backend serializes through its Durable Object,
 * and this rotation CLI targets PostgreSQL deployments (see docs/RUNBOOKS.md).
 */
const ROTATION_LOCK_NAME = "meridian:meroshare-key-rotation";

function changedDuringRotation() {
  return errors.conflict(
    "MeroShare credentials changed while the rotation was running (a connection was created, updated, or deleted after the rotation snapshot was taken). The rotation was aborted and nothing was written. Stop every web and worker process so no credential writes can occur, then run the rotation again."
  );
}

/**
 * Take the shared side of the rotation lock inside a credential-writing
 * transaction (used when a connection's encrypted credentials are saved).
 * Any number of writers may hold it at once, but a rotation holding the
 * exclusive side waits for all of them to finish, and a writer arriving
 * during a rotation waits until the rotation commits — either way the
 * writer's rows are entirely on one side of the rotation, never inside it.
 */
export async function lockMeroShareCredentialsForWrite(tx: Executor): Promise<void> {
  if (usesCloudStorage) return;
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${ROTATION_LOCK_NAME}))`);
}

/**
 * Re-encrypt every stored MeroShare credential from the current key to a new
 * key. Runs in a single transaction: all records are decrypted before any
 * write happens, so one unreadable record aborts the rotation with nothing
 * written and the old key keeps working. With `dryRun`, records are verified
 * as decryptable under the current key and counted, but nothing is written.
 *
 * Concurrency guard: the transaction holds the exclusive side of the
 * rotation advisory lock, so credential writers running current code (which
 * take the shared side — see lockMeroShareCredentialsForWrite) serialize
 * against it instead of interleaving. Writers that predate the lock (an old
 * binary still running during a deploy) cannot be locked out, so before
 * committing, the rotation re-reads the table and verifies the stored rows
 * are exactly the re-encrypted set it produced; any row inserted, updated,
 * or deleted since the snapshot aborts the whole transaction. A rotation
 * therefore never reports success over mixed-key data — but it also cannot
 * stop an old binary from writing old-key credentials *after* it commits,
 * which is why the runbook procedure stops web + worker before rotating and
 * keeps them stopped until both run the new key.
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
    if (!usesCloudStorage)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ROTATION_LOCK_NAME}))`);

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
      snapshotUsernameEncrypted: row.usernameEncrypted,
      snapshotPasswordEncrypted: row.passwordEncrypted,
      username: decryptProviderSecretWithKey(row.usernameEncrypted, options.currentKey),
      password: decryptProviderSecretWithKey(row.passwordEncrypted, options.currentKey)
    }));

    if (!dryRun) {
      // The exact ciphertexts this rotation is responsible for, per row.
      const expected = new Map<string, string>();
      for (const record of planned) {
        const usernameEncrypted = encryptProviderSecretWithKey(record.username, options.newKey);
        const passwordEncrypted = encryptProviderSecretWithKey(record.password, options.newKey);
        expected.set(record.id, `${usernameEncrypted}\n${passwordEncrypted}`);
        // Optimistic write: only rewrite the row if its stored credentials
        // are still exactly the snapshot this rotation decrypted. If a
        // writer that does not take the rotation lock changed the row first,
        // the update matches nothing — abort rather than silently overwrite
        // their newer credentials with the snapshot's stale ones.
        const updated = await tx
          .update(meroShareConnections)
          .set({ usernameEncrypted, passwordEncrypted, updatedAt: new Date() })
          .where(
            and(
              eq(meroShareConnections.id, record.id),
              eq(meroShareConnections.usernameEncrypted, record.snapshotUsernameEncrypted),
              eq(meroShareConnections.passwordEncrypted, record.snapshotPasswordEncrypted)
            )
          )
          .returning({ id: meroShareConnections.id });
        if (updated.length === 0) throw changedDuringRotation();
      }

      // Re-verify the complete set before committing: what is stored now
      // must be exactly the rows above with exactly the ciphertexts above.
      // Any other state means a writer that does not take the rotation lock
      // (an old binary, a manual SQL session) committed a credential write
      // after the snapshot; abort so no mixed-key state is ever committed.
      const after = await tx
        .select({
          id: meroShareConnections.id,
          usernameEncrypted: meroShareConnections.usernameEncrypted,
          passwordEncrypted: meroShareConnections.passwordEncrypted
        })
        .from(meroShareConnections);
      const changed =
        after.length !== expected.size ||
        after.some(
          (row) => expected.get(row.id) !== `${row.usernameEncrypted}\n${row.passwordEncrypted}`
        );
      if (changed) throw changedDuringRotation();
    }

    return { dryRun, connections: rows.length, rotated: planned.length };
  });
}
