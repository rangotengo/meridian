import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, makeUser, truncateAll } from "../helpers";
import { meroShareConnections } from "@/server/db/schema";
import {
  decryptProviderSecretWithKey,
  encryptProviderSecretWithKey
} from "@/server/security/secrets";
import { rotateMeroShareEncryptionKey } from "@/server/domain/meroshare-rotation";

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
