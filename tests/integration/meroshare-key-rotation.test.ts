import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, makeUser, truncateAll } from "../helpers";
import { meroShareConnections } from "@/server/db/schema";
import {
  decryptProviderSecretWithKey,
  encryptProviderSecretWithKey
} from "@/server/security/secrets";
import {
  lockMeroShareCredentialsForWrite,
  rotateMeroShareEncryptionKey
} from "@/server/domain/meroshare-rotation";

const keyA = randomBytes(32);
const keyB = randomBytes(32);

async function seedConnection(
  keyMaterial: Buffer,
  credentials: { username: string; password: string }
): Promise<string> {
  const user = await makeUser();
  const [row] = await db()
    .insert(meroShareConnections)
    .values({
      familyId: user.familyId,
      userId: user.userId,
      name: "MeroShare · TEST",
      clientId: 100,
      dpCode: "13200",
      dpName: "Test Capital Ltd",
      usernameEncrypted: encryptProviderSecretWithKey(credentials.username, keyMaterial),
      passwordEncrypted: encryptProviderSecretWithKey(credentials.password, keyMaterial)
    })
    .returning({ id: meroShareConnections.id });
  return row!.id;
}

async function storedCredentials(id: string) {
  const [row] = await db()
    .select({
      usernameEncrypted: meroShareConnections.usernameEncrypted,
      passwordEncrypted: meroShareConnections.passwordEncrypted
    })
    .from(meroShareConnections)
    .where(eq(meroShareConnections.id, id));
  return row!;
}

describe("MeroShare encryption key rotation", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("re-encrypts stored credentials so they decrypt with the new key only", async () => {
    const first = await seedConnection(keyA, { username: "demat-user-1", password: "pw-one" });
    const second = await seedConnection(keyA, { username: "demat-user-2", password: "pw-two" });
    const beforeFirst = await storedCredentials(first);

    const result = await rotateMeroShareEncryptionKey(db(), {
      currentKey: keyA,
      newKey: keyB
    });
    expect(result).toEqual({ dryRun: false, connections: 2, rotated: 2 });

    const afterFirst = await storedCredentials(first);
    expect(afterFirst.usernameEncrypted).not.toBe(beforeFirst.usernameEncrypted);
    expect(afterFirst.passwordEncrypted).not.toBe(beforeFirst.passwordEncrypted);
    expect(decryptProviderSecretWithKey(afterFirst.usernameEncrypted, keyB)).toBe("demat-user-1");
    expect(decryptProviderSecretWithKey(afterFirst.passwordEncrypted, keyB)).toBe("pw-one");
    expect(() => decryptProviderSecretWithKey(afterFirst.usernameEncrypted, keyA)).toThrow();
    expect(() => decryptProviderSecretWithKey(afterFirst.passwordEncrypted, keyA)).toThrow();

    const afterSecond = await storedCredentials(second);
    expect(decryptProviderSecretWithKey(afterSecond.usernameEncrypted, keyB)).toBe("demat-user-2");
    expect(decryptProviderSecretWithKey(afterSecond.passwordEncrypted, keyB)).toBe("pw-two");
  });

  it("dry-run verifies and counts records without writing anything", async () => {
    const id = await seedConnection(keyA, { username: "demat-user", password: "pw" });
    const before = await storedCredentials(id);

    const result = await rotateMeroShareEncryptionKey(db(), {
      currentKey: keyA,
      newKey: keyB,
      dryRun: true
    });
    expect(result).toEqual({ dryRun: true, connections: 1, rotated: 1 });

    const after = await storedCredentials(id);
    expect(after).toEqual(before);
    expect(decryptProviderSecretWithKey(after.usernameEncrypted, keyA)).toBe("demat-user");
  });

  it("aborts with nothing written when any record fails decryption", async () => {
    const good = await seedConnection(keyA, { username: "demat-user", password: "pw" });
    const user = await makeUser();
    await db()
      .insert(meroShareConnections)
      .values({
        familyId: user.familyId,
        userId: user.userId,
        name: "MeroShare · BROKEN",
        clientId: 100,
        dpCode: "13200",
        dpName: "Test Capital Ltd",
        // Encrypted under a third key: unreadable with the current key.
        usernameEncrypted: encryptProviderSecretWithKey("someone-else", randomBytes(32)),
        passwordEncrypted: encryptProviderSecretWithKey("someone-else-pw", randomBytes(32))
      });
    const before = await storedCredentials(good);

    await expect(
      rotateMeroShareEncryptionKey(db(), { currentKey: keyA, newKey: keyB })
    ).rejects.toThrow(/unreadable/i);

    const after = await storedCredentials(good);
    expect(after).toEqual(before);
    expect(decryptProviderSecretWithKey(after.usernameEncrypted, keyA)).toBe("demat-user");
    expect(decryptProviderSecretWithKey(after.passwordEncrypted, keyA)).toBe("pw");
  });

  it("refuses to rotate onto the identical key", async () => {
    await seedConnection(keyA, { username: "demat-user", password: "pw" });
    await expect(
      rotateMeroShareEncryptionKey(db(), { currentKey: keyA, newKey: keyA })
    ).rejects.toThrow(/identical/i);
  });

  it("reports zero when no connections are stored", async () => {
    const result = await rotateMeroShareEncryptionKey(db(), {
      currentKey: keyA,
      newKey: keyB
    });
    expect(result).toEqual({ dryRun: false, connections: 0, rotated: 0 });
  });
});

describe("MeroShare key rotation concurrency guard", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Seed `count` old-key connections for one user; returns their ids in order. */
  async function seedManyConnections(count: number): Promise<string[]> {
    const user = await makeUser();
    const rows = await db()
      .insert(meroShareConnections)
      .values(
        Array.from({ length: count }, (_, i) => ({
          familyId: user.familyId,
          userId: user.userId,
          name: "MeroShare · TEST",
          clientId: 100,
          dpCode: "13200",
          dpName: "Test Capital Ltd",
          usernameEncrypted: encryptProviderSecretWithKey(`user-${i}`, keyA),
          passwordEncrypted: encryptProviderSecretWithKey(`pw-${i}`, keyA)
        }))
      )
      .returning({ id: meroShareConnections.id });
    return rows.map((r) => r.id);
  }

  it("aborts when a connection is inserted during rotation by a writer without the lock", async () => {
    const ids = await seedManyConnections(400);
    const user = await makeUser();

    const rotation = rotateMeroShareEncryptionKey(db(), { currentKey: keyA, newKey: keyB });
    // Let the rotation take its snapshot and start rewriting rows; then a
    // still-running old-key process (no rotation lock) saves a new connection.
    await sleep(30);
    const [late] = await db()
      .insert(meroShareConnections)
      .values({
        familyId: user.familyId,
        userId: user.userId,
        name: "MeroShare · LATE",
        clientId: 100,
        dpCode: "13200",
        dpName: "Test Capital Ltd",
        usernameEncrypted: encryptProviderSecretWithKey("late-user", keyA),
        passwordEncrypted: encryptProviderSecretWithKey("late-pw", keyA)
      })
      .returning({ id: meroShareConnections.id });

    await expect(rotation).rejects.toThrow(/changed while the rotation was running/i);

    // Nothing was written: the snapshot rows still decrypt under the old key
    // only (no mixed-key state), and the late row is untouched.
    const first = await storedCredentials(ids[0]!);
    expect(decryptProviderSecretWithKey(first.usernameEncrypted, keyA)).toBe("user-0");
    expect(() => decryptProviderSecretWithKey(first.usernameEncrypted, keyB)).toThrow();
    const lateRow = await storedCredentials(late!.id);
    expect(decryptProviderSecretWithKey(lateRow.usernameEncrypted, keyA)).toBe("late-user");
  }, 30000);

  it("aborts when a stored credential is rewritten during rotation", async () => {
    const ids = await seedManyConnections(400);
    const lastId = ids[ids.length - 1]!;

    const rotation = rotateMeroShareEncryptionKey(db(), { currentKey: keyA, newKey: keyB });
    await sleep(30);
    // An old-key process re-saves the last connection's credentials (fresh
    // ciphertext, same plaintext) after the rotation snapshot was taken.
    await db()
      .update(meroShareConnections)
      .set({
        usernameEncrypted: encryptProviderSecretWithKey("user-399", keyA),
        passwordEncrypted: encryptProviderSecretWithKey("pw-399", keyA)
      })
      .where(eq(meroShareConnections.id, lastId));

    await expect(rotation).rejects.toThrow(/changed while the rotation was running/i);

    // Rolled back: the first row still decrypts under the old key only.
    const first = await storedCredentials(ids[0]!);
    expect(decryptProviderSecretWithKey(first.usernameEncrypted, keyA)).toBe("user-0");
    expect(() => decryptProviderSecretWithKey(first.usernameEncrypted, keyB)).toThrow();
  }, 30000);

  it("serializes a cooperating credential writer instead of interleaving with it", async () => {
    await seedConnection(keyA, { username: "demat-user-1", password: "pw-one" });
    await seedConnection(keyA, { username: "demat-user-2", password: "pw-two" });
    const writerUser = await makeUser();

    // A credential writer (current code path) holds the shared side of the
    // rotation lock inside its transaction until released.
    let releaseWriter!: () => void;
    const gate = new Promise<void>((r) => {
      releaseWriter = r;
    });
    const writer = db().transaction(async (tx) => {
      await lockMeroShareCredentialsForWrite(tx);
      await gate;
      const [row] = await tx
        .insert(meroShareConnections)
        .values({
          familyId: writerUser.familyId,
          userId: writerUser.userId,
          name: "MeroShare · WRITER",
          clientId: 100,
          dpCode: "13200",
          dpName: "Test Capital Ltd",
          usernameEncrypted: encryptProviderSecretWithKey("writer-user", keyA),
          passwordEncrypted: encryptProviderSecretWithKey("writer-pw", keyA)
        })
        .returning({ id: meroShareConnections.id });
      return row!.id;
    });
    await sleep(50); // writer now holds the shared lock

    let rotationSettled = false;
    const rotation = rotateMeroShareEncryptionKey(db(), { currentKey: keyA, newKey: keyB }).then(
      (result) => {
        rotationSettled = true;
        return result;
      },
      (error: unknown) => {
        rotationSettled = true;
        throw error;
      }
    );
    await sleep(150);
    // The rotation must wait for the writer, not interleave with it.
    expect(rotationSettled).toBe(false);

    releaseWriter();
    const writerId = await writer; // writer commits first
    const result = await rotation;
    // The writer's row committed before the snapshot, so it was rotated too.
    expect(result).toEqual({ dryRun: false, connections: 3, rotated: 3 });
    const writerRow = await storedCredentials(writerId);
    expect(decryptProviderSecretWithKey(writerRow.usernameEncrypted, keyB)).toBe("writer-user");
    expect(() => decryptProviderSecretWithKey(writerRow.usernameEncrypted, keyA)).toThrow();
  }, 30000);
});
