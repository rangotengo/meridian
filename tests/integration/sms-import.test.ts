import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { db, makeUser, makeAccount, addTxn, truncateAll, daysAgo, actorOf } from "../helpers";
import { currentFamily } from "@/server/auth/context";
import { entries } from "@/server/db/schema";
import { parseSms } from "@/server/domain/sms-parser";
import * as smsImport from "@/server/domain/sms-import";
import * as categoriesSvc from "@/server/domain/categories";
import * as entriesSvc from "@/server/domain/entries";

beforeAll(async () => {
  await truncateAll();
});

const NABIL_SMS = `Dear Customer, Your 110##02167 has been withdrawn by NPR 24,360.00 on 09/09/2026 14:13:30, Remarks: PREPAID CARD 150 T
Download App: https://rebrand.ly/nBank`;

async function entryCount(accountId: string): Promise<number> {
  const res = await db().execute<{ n: string }>(
    sql`SELECT CAST(count(*) AS TEXT) AS n FROM entries WHERE account_id = ${accountId}::uuid`
  );
  return Number(res.rows?.[0]?.n ?? 0);
}

describe("sms import — preview", () => {
  it("matches the account by digits and reports no duplicate", async () => {
    const user = await makeUser({ currency: "NPR" });
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const accountId = await makeAccount(user, {
      name: "Nabil Savings 02167",
      institution: "Nabil Bank",
      currency: "NPR"
    });

    const preview = await smsImport.previewSmsImport(db(), actor, family, NABIL_SMS, "Nabil_Alert");
    expect(preview.parsed).toMatchObject({
      kind: "expense",
      amountMinor: 2_436_000,
      currency: "NPR",
      date: "2026-09-09"
    });
    expect(preview.account).toMatchObject({
      id: accountId,
      matchedBy: "account_number"
    });
    expect(preview.duplicateEntryId).toBeNull();
    expect(preview.currencyMismatch).toBe(false);
  });

  it("matches an eSewa wallet account by digits", async () => {
    const user = await makeUser({ currency: "NPR" });
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const accountId = await makeAccount(user, {
      name: "eSewa Wallet 9850",
      institution: "eSewa",
      currency: "NPR"
    });

    const preview = await smsImport.previewSmsImport(
      db(),
      actor,
      family,
      "Your eSewa account 9850 has been debited by NPR 500.00 on 17/11/2026. Remarks: Payment to Bhatbhateni",
      "eSewa"
    );
    expect(preview.account).toMatchObject({ id: accountId, matchedBy: "account_number" });
    expect(preview.parsed.bankName).toBe("eSewa");
  });

  it("flags a currency mismatch between SMS and account", async () => {
    const user = await makeUser({ currency: "USD" });
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    await makeAccount(user, {
      name: "Nabil Savings 02167",
      institution: "Nabil Bank",
      currency: "USD"
    });

    const preview = await smsImport.previewSmsImport(db(), actor, family, NABIL_SMS, "Nabil_Alert");
    expect(preview.currencyMismatch).toBe(true);
    expect(preview.account?.currency).toBe("USD");
    expect(preview.parsed.currency).toBe("NPR");
  });

  it("suggests the category most used with the payee, and null with no history", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makeAccount(user);
    const groceries = await categoriesSvc.createCategory(db(), actor, { name: "Groceries" });
    const dining = await categoriesSvc.createCategory(db(), actor, { name: "Dining" });

    await addTxn(user, accountId, {
      amountLedgerMinor: 1_000,
      date: daysAgo(2),
      categoryId: groceries.categoryId,
      merchant: "Bhatbhateni"
    });
    await addTxn(user, accountId, {
      amountLedgerMinor: 2_000,
      date: daysAgo(1),
      categoryId: groceries.categoryId,
      merchant: "Bhatbhateni"
    });
    await addTxn(user, accountId, {
      amountLedgerMinor: 500,
      date: daysAgo(1),
      categoryId: dining.categoryId,
      merchant: "Bhatbhateni"
    });

    const suggestion = await smsImport.suggestCategoryForMerchant(db(), actor, "bhatbhateni");
    expect(suggestion).toMatchObject({ id: groceries.categoryId, name: "Groceries", useCount: 2 });
    expect(await smsImport.suggestCategoryForMerchant(db(), actor, "Nobody")).toBeNull();
  });
});

describe("sms import — confirm and dedupe", () => {
  it("records the transaction once and reports the second import as a duplicate", async () => {
    const user = await makeUser({ currency: "NPR" });
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const accountId = await makeAccount(user, {
      name: "Nabil Savings 02167",
      institution: "Nabil Bank",
      currency: "NPR"
    });
    const { categoryId } = await categoriesSvc.createCategory(db(), actor, { name: "Shopping" });

    const input = {
      rawSms: NABIL_SMS,
      sender: "Nabil_Alert",
      accountId,
      categoryId
    };
    const first = await smsImport.confirmSmsImport(db(), actor, family, input);
    expect(first.duplicated).toBe(false);

    const second = await smsImport.confirmSmsImport(db(), actor, family, input);
    expect(second).toEqual({ entryId: first.entryId, duplicated: true });
    expect(await entryCount(accountId)).toBe(1);

    const [entry] = await db()
      .select()
      .from(entries)
      .where(sql`id = ${first.entryId}::uuid`);
    expect(entry).toMatchObject({
      amountMinor: 2_436_000,
      currency: "NPR",
      externalSource: "sms_shortcut"
    });
    expect(entry!.externalId).toBe(parseSms(NABIL_SMS, "Nabil_Alert").referenceId);
  });

  it("dedupes against an entry recorded through the Shortcuts flow", async () => {
    const user = await makeUser({ currency: "NPR" });
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const accountId = await makeAccount(user, {
      name: "Nabil Savings 02167",
      institution: "Nabil Bank",
      currency: "NPR"
    });
    const referenceId = parseSms(NABIL_SMS, "Nabil_Alert").referenceId!;

    // The Shortcuts API records with the same (source, reference id).
    const viaShortcuts = await entriesSvc.createTransactionEntry(db(), actor, {
      accountId,
      date: "2026-09-09",
      amountLedgerMinor: 2_436_000,
      name: "PREPAID CARD 150 T",
      externalSource: "sms_shortcut",
      externalId: referenceId
    });
    expect(viaShortcuts.duplicated).toBe(false);

    const viaWeb = await smsImport.confirmSmsImport(db(), actor, family, {
      rawSms: NABIL_SMS,
      sender: "Nabil_Alert",
      accountId
    });
    expect(viaWeb).toEqual({ entryId: viaShortcuts.entryId, duplicated: true });
    expect(await entryCount(accountId)).toBe(1);
  });

  it("rejects an SMS with no parseable amount", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const accountId = await makeAccount(user);
    await expect(
      smsImport.confirmSmsImport(db(), actor, family, {
        rawSms: "Hello, your balance is low.",
        accountId
      })
    ).rejects.toThrow("Could not find an amount");
    expect(await entryCount(accountId)).toBe(0);
  });
});
