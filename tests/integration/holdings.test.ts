import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  db,
  makeUser,
  makeAccount,
  truncateAll,
  actorOf,
  latestBalance,
  joinFamily,
  daysAgo,
  type TestUser
} from "../helpers";
import * as accountsSvc from "@/server/domain/accounts";
import * as holdingsSvc from "@/server/domain/holdings";
import { importHoldingsCsv } from "@/server/domain/holdings-import";
import * as valuationsSvc from "@/server/domain/valuations";
import { recalculateAccount } from "@/server/domain/balances";
import { todayIn } from "@/lib/datetime";

beforeAll(async () => {
  await truncateAll();
});

async function makePortfolio(user: TestUser, name = "Brokerage"): Promise<string> {
  return makeAccount(user, {
    type: "other_asset",
    name,
    currency: "USD",
    openingBalanceDisplayMinor: 0,
    openedOn: daysAgo(30),
    joint: false
  });
}

async function balance(accountId: string): Promise<number> {
  return (await latestBalance(accountId))?.balanceMinor ?? 0;
}

async function holdingsValuationEntries(accountId: string): Promise<number> {
  const res = await db().execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM entries
    WHERE account_id = ${accountId}::uuid AND external_source = 'holdings'
  `);
  return Number((res.rows ?? [])[0]?.n ?? 0);
}

describe("manual portfolio holdings", () => {
  it("reflects add/update/delete in the account balance, with cost fallback", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);

    // Current price wins when present: 100 × $250.00.
    const added = await holdingsSvc.addHolding(db(), actor, {
      accountId,
      ticker: "nabil",
      companyName: "Nabil Bank",
      quantity: "100",
      averageCostMinor: 200_00,
      currentPriceMinor: 250_00
    });
    expect(added.portfolioValueMinor).toBe(2_500_000);
    expect(await balance(accountId)).toBe(2_500_000);

    // Tickers are normalized on write.
    const rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ticker).toBe("NABIL");

    // Without a current price the value falls back to average cost.
    await holdingsSvc.addHolding(db(), actor, {
      accountId,
      ticker: "HIDCL",
      quantity: "50.5",
      averageCostMinor: 100_00,
      currentPriceMinor: null
    });
    expect(await balance(accountId)).toBe(2_500_000 + 505_000);

    // Updating the current price revalues immediately.
    const hidcl = (await holdingsSvc.listHoldings(db(), actor, accountId)).find(
      (r) => r.ticker === "HIDCL"
    )!;
    await holdingsSvc.updateHolding(db(), actor, {
      accountId,
      holdingId: hidcl.id,
      quantity: "50.5",
      averageCostMinor: 100_00,
      currentPriceMinor: 120_00
    });
    expect(await balance(accountId)).toBe(2_500_000 + 606_000);

    // Deleting revalues from what remains; one holdings valuation per day.
    await holdingsSvc.deleteHolding(db(), actor, { accountId, holdingId: hidcl.id });
    expect(await balance(accountId)).toBe(2_500_000);
    expect(await holdingsValuationEntries(accountId)).toBe(1);
  });

  it("rejects duplicate tickers case-insensitively", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);
    await holdingsSvc.addHolding(db(), actor, {
      accountId,
      ticker: "NABIL",
      quantity: "10",
      averageCostMinor: 100_00
    });
    await expect(
      holdingsSvc.addHolding(db(), actor, {
        accountId,
        ticker: "nabil",
        quantity: "5",
        averageCostMinor: 100_00
      })
    ).rejects.toMatchObject({ code: "validation.failed" });
  });

  it("applies buy/sell adjustments with weighted-average cost", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);

    // A buy creates the holding; the trade price seeds cost and price.
    const created = await holdingsSvc.adjustHolding(db(), actor, {
      accountId,
      ticker: "API",
      side: "buy",
      quantity: "100",
      priceMinor: 100_00
    });
    expect(created.removed).toBe(false);
    let rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows[0]).toMatchObject({
      ticker: "API",
      quantity: "100",
      averageCostMinor: 100_00,
      currentPriceMinor: 100_00
    });
    expect(await balance(accountId)).toBe(1_000_000);

    // Weighted average: (100×100 + 100×200) / 200 = 150.
    await holdingsSvc.adjustHolding(db(), actor, {
      accountId,
      ticker: "API",
      side: "buy",
      quantity: "100",
      priceMinor: 200_00
    });
    rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows[0]!.quantity).toBe("200");
    expect(rows[0]!.averageCostMinor).toBe(150_00);
    // Current price is untouched by trades, so value still uses $100.
    expect(await balance(accountId)).toBe(2_000_000);

    // Partial sell: quantity drops, average cost unchanged.
    await holdingsSvc.adjustHolding(db(), actor, {
      accountId,
      ticker: "API",
      side: "sell",
      quantity: "50",
      priceMinor: 300_00
    });
    rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows[0]!.quantity).toBe("150");
    expect(rows[0]!.averageCostMinor).toBe(150_00);

    // Overselling is rejected.
    await expect(
      holdingsSvc.adjustHolding(db(), actor, {
        accountId,
        ticker: "API",
        side: "sell",
        quantity: "151",
        priceMinor: 300_00
      })
    ).rejects.toMatchObject({ code: "validation.failed" });

    // Selling the full position removes the holding and zeroes the balance.
    const sold = await holdingsSvc.adjustHolding(db(), actor, {
      accountId,
      ticker: "API",
      side: "sell",
      quantity: "150",
      priceMinor: 300_00
    });
    expect(sold.removed).toBe(true);
    expect(await holdingsSvc.listHoldings(db(), actor, accountId)).toHaveLength(0);
    expect(await balance(accountId)).toBe(0);
  });

  it("blocks manual valuations while holdings exist and allows them again after", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);
    const today = todayIn("Etc/UTC");

    const manual = await valuationsSvc.recordValuation(db(), actor, {
      accountId,
      date: daysAgo(2),
      amountDisplayMinor: 500_00,
      kind: "current"
    });
    // The valuation actions recalculate after recording; do the same here.
    await recalculateAccount(db(), accountId, daysAgo(2));
    expect(await balance(accountId)).toBe(500_00);

    const { holdingId } = await holdingsSvc.addHolding(db(), actor, {
      accountId,
      ticker: "NABIL",
      quantity: "10",
      averageCostMinor: 100_00,
      currentPriceMinor: 110_00
    });
    expect(await balance(accountId)).toBe(110_000);

    await expect(
      valuationsSvc.recordValuation(db(), actor, {
        accountId,
        date: today,
        amountDisplayMinor: 1_00,
        kind: "current"
      })
    ).rejects.toThrow(/managed by its holdings/);
    await expect(
      valuationsSvc.updateValuation(db(), actor, {
        entryId: manual.entryId,
        date: daysAgo(2),
        amountDisplayMinor: 600_00,
        kind: "current"
      })
    ).rejects.toThrow(/managed by its holdings/);
    await expect(valuationsSvc.deleteValuation(db(), actor, manual.entryId)).rejects.toThrow(
      /managed by its holdings/
    );

    // Removing the last holding writes a zero valuation for today and
    // manual valuations become available again.
    await holdingsSvc.deleteHolding(db(), actor, { accountId, holdingId });
    expect(await balance(accountId)).toBe(0);
    await valuationsSvc.recordValuation(db(), actor, {
      accountId,
      date: today,
      amountDisplayMinor: 700_00,
      kind: "current"
    });
    await recalculateAccount(db(), accountId, today);
    expect(await balance(accountId)).toBe(700_00);
  });

  it("enforces account type and access guards", async () => {
    const owner = await makeUser();
    const ownerActor = actorOf(owner);
    const accountId = await makePortfolio(owner);
    const cashId = await makeAccount(owner, { type: "depository", joint: false });

    // Holdings only exist on other-asset accounts.
    await expect(
      holdingsSvc.addHolding(db(), ownerActor, {
        accountId: cashId,
        ticker: "NABIL",
        quantity: "1",
        averageCostMinor: 100_00
      })
    ).rejects.toMatchObject({ code: "validation.failed" });

    const member = await makeUser();
    await joinFamily(member, owner.familyId);
    const memberActor = actorOf(member);

    // No share at all: the account is invisible.
    await expect(
      holdingsSvc.addHolding(db(), memberActor, {
        accountId,
        ticker: "NABIL",
        quantity: "1",
        averageCostMinor: 100_00
      })
    ).rejects.toMatchObject({ code: "resource.not_found" });

    // Read-only and read-write shares can view but never mutate.
    await accountsSvc.shareAccount(db(), ownerActor, accountId, member.userId, "read_only");
    await holdingsSvc.addHolding(db(), ownerActor, {
      accountId,
      ticker: "NABIL",
      quantity: "10",
      averageCostMinor: 100_00
    });
    expect(await holdingsSvc.listHoldings(db(), memberActor, accountId)).toHaveLength(1);
    await expect(
      holdingsSvc.addHolding(db(), memberActor, {
        accountId,
        ticker: "HIDCL",
        quantity: "1",
        averageCostMinor: 100_00
      })
    ).rejects.toMatchObject({ code: "access.denied" });

    await accountsSvc.shareAccount(db(), ownerActor, accountId, member.userId, "read_write");
    await expect(
      holdingsSvc.adjustHolding(db(), memberActor, {
        accountId,
        ticker: "NABIL",
        side: "buy",
        quantity: "1",
        priceMinor: 100_00
      })
    ).rejects.toMatchObject({ code: "access.denied" });

    // A user in another family cannot even see the account.
    const outsider = await makeUser();
    await expect(
      holdingsSvc.listHoldings(db(), actorOf(outsider), accountId)
    ).rejects.toMatchObject({ code: "resource.not_found" });
  });

  it("imports CSV with upserts and a single balance sync", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);

    const csv = [
      "ticker,quantity,average_cost,current_price,company_name",
      "NABIL,100,200.00,250.00,Nabil Bank",
      "HIDCL,50,100.00,,Hydroelectricity Investment"
    ].join("\n");
    const first = await importHoldingsCsv(db(), actor, accountId, csv);
    expect(first).toMatchObject({ created: 2, updated: 0, errors: [] });
    // 100 × 250.00 (current) + 50 × 100.00 (cost fallback) = 30,000.00.
    expect(await balance(accountId)).toBe(3_000_000);

    const second = await importHoldingsCsv(
      db(),
      actor,
      accountId,
      ["ticker,quantity,average_cost,current_price", "NABIL,120,210.00,260.00"].join("\n")
    );
    expect(second).toMatchObject({ created: 0, updated: 1, errors: [] });
    const rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    const nabil = rows.find((r) => r.ticker === "NABIL")!;
    expect(nabil.quantity).toBe("120");
    // Company name survives an upsert that omits it.
    expect(nabil.companyName).toBe("Nabil Bank");
    // 120 × 260.00 + 50 × 100.00 = 36,200.00.
    expect(await balance(accountId)).toBe(3_620_000);
  });
});
