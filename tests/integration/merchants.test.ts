import { describe, it, expect, beforeEach } from "vitest";
import { listRecentMerchants } from "@/server/domain/merchants";
import { db, truncateAll, makeUser, makeAccount, addTxn, daysAgo } from "../helpers";

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

    const merchants = await listRecentMerchants(db(), user.familyId);
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

    expect(await listRecentMerchants(db(), user.familyId)).toEqual(["Mine"]);
    expect(await listRecentMerchants(db(), user.familyId, 0)).toEqual([]);
    expect(await listRecentMerchants(db(), "00000000-0000-0000-0000-000000000000")).toEqual(
      []
    );
  });
});
