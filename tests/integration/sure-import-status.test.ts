import { describe, it, expect, beforeEach } from "vitest";
import { auditEvents } from "@/server/db/schema";
import { sureImportStatus } from "@/server/domain/sure-import";
import { db, truncateAll, makeUser } from "../helpers";

describe("sureImportStatus", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("reports not imported for a family with no Sure import", async () => {
    const user = await makeUser();
    expect(await sureImportStatus(db(), user.familyId)).toEqual({
      imported: false,
      accounts: 0,
      transactions: 0
    });
  });

  it("reports the import and its counts from the audit event", async () => {
    const user = await makeUser();
    await db()
      .insert(auditEvents)
      .values({
        familyId: user.familyId,
        actorUserId: user.userId,
        action: "family.imported_from_sure",
        entityType: "family",
        entityId: user.familyId,
        metadata: { accounts: 19, transactions: 1204, transfers: 3 }
      });
    expect(await sureImportStatus(db(), user.familyId)).toEqual({
      imported: true,
      accounts: 19,
      transactions: 1204
    });
  });

  it("ignores other families and other audit actions", async () => {
    const user = await makeUser();
    const other = await makeUser();
    await db()
      .insert(auditEvents)
      .values({
        familyId: other.familyId,
        actorUserId: other.userId,
        action: "family.imported_from_sure",
        entityType: "family",
        entityId: other.familyId,
        metadata: { accounts: 2, transactions: 10 }
      });
    await db()
      .insert(auditEvents)
      .values({
        familyId: user.familyId,
        actorUserId: user.userId,
        action: "entry.created",
        entityType: "entry",
        entityId: "x",
        metadata: { accounts: 99, transactions: 99 }
      });
    expect(await sureImportStatus(db(), user.familyId)).toEqual({
      imported: false,
      accounts: 0,
      transactions: 0
    });
  });
});
