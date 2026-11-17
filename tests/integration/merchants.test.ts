import { describe, it, expect, beforeEach } from "vitest";
import { listRecentMerchants } from "@/server/domain/merchants";
import * as accountsSvc from "@/server/domain/accounts";
import {
  db,
  truncateAll,
  makeUser,
  makeAccount,
  addTxn,
  daysAgo,
  joinFamily,
  actorOf
} from "../helpers";

describe("listRecentMerchants", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("returns distinct merchants most recently used first", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user);
    await addTxn(user, accountId, {
      amountLedgerMinor: -1000,
      date: daysAgo(10),
      merchant: "Old Mart"
    });
    await addTxn(user, accountId, {
      amountLedgerMinor: -2000,
      date: daysAgo(2),
      merchant: "Corner Store"
    });
    await addTxn(user, accountId, {
      amountLedgerMinor: -3000,
      date: daysAgo(1),
      merchant: "Old Mart"
    });
    await addTxn(user, accountId, {
      amountLedgerMinor: -4000,
      date: daysAgo(1),
      merchant: null
    });

    const merchants = await listRecentMerchants(db(), actorOf(user));
    expect(merchants).toEqual(["Old Mart", "Corner Store"]);
  });

  it("excludes other families and respects the limit", async () => {
    const user = await makeUser();
    const other = await makeUser();
    const accountId = await makeAccount(user);
    const otherAccountId = await makeAccount(other);
    await addTxn(user, accountId, {
      amountLedgerMinor: -1000,
      date: daysAgo(1),
      merchant: "Mine"
    });
    await addTxn(other, otherAccountId, {
      amountLedgerMinor: -1000,
      date: daysAgo(1),
      merchant: "Theirs"
    });

    expect(await listRecentMerchants(db(), actorOf(user))).toEqual(["Mine"]);
    expect(await listRecentMerchants(db(), actorOf(user), 0)).toEqual([]);
    expect(
      await listRecentMerchants(
        db(),
        actorOf({ ...user, familyId: "00000000-0000-0000-0000-000000000000" })
      )
    ).toEqual([]);
  });

  it("hides merchants from another member's unshared accounts in the same family", async () => {
    const owner = await makeUser();
    const member = await makeUser();
    await joinFamily(member, owner.familyId);
    // Joint accounts (ownerId null) are visible to every family member;
    // unshared personal accounts (joint: false) are visible only to
    // their owner until shared.
    const jointAccountId = await makeAccount(owner);
    const ownerAccountId = await makeAccount(owner, { joint: false });
    const memberAccountId = await makeAccount(member, { joint: false });
    await addTxn(owner, jointAccountId, {
      amountLedgerMinor: -1000,
      date: daysAgo(3),
      merchant: "Joint Mart"
    });
    await addTxn(owner, ownerAccountId, {
      amountLedgerMinor: -1000,
      date: daysAgo(2),
      merchant: "Private Mart"
    });
    await addTxn(member, memberAccountId, {
      amountLedgerMinor: -1000,
      date: daysAgo(1),
      merchant: "Member Mart"
    });

    // The member sees their own and the joint merchants — never the
    // owner's unshared "Private Mart".
    expect(await listRecentMerchants(db(), actorOf(member))).toEqual(["Member Mart", "Joint Mart"]);
    expect(await listRecentMerchants(db(), actorOf(owner))).toEqual(["Private Mart", "Joint Mart"]);

    // Sharing the owner's account makes its merchants visible to the member.
    await accountsSvc.shareAccount(
      db(),
      actorOf(owner),
      ownerAccountId,
      member.userId,
      "read_only"
    );
    expect(await listRecentMerchants(db(), actorOf(member))).toEqual([
      "Member Mart",
      "Private Mart",
      "Joint Mart"
    ]);
  });

  it("returns every historical payee, not just the most recent window", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user);
    // 55 distinct merchants: more than the old 50-merchant cap and far
    // more than any recent-row window the old query scanned.
    for (let i = 0; i < 55; i++) {
      await addTxn(user, accountId, {
        amountLedgerMinor: -1000,
        date: daysAgo(55 - i),
        merchant: `Shop ${String(i + 1).padStart(2, "0")}`
      });
    }

    const merchants = await listRecentMerchants(db(), actorOf(user));
    expect(merchants).toHaveLength(55);
    expect(merchants[0]).toBe("Shop 55");
    expect(merchants[54]).toBe("Shop 01");
    expect(merchants).toContain("Shop 01");
  });
});
