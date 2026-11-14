import { describe, it, expect, beforeAll } from "vitest";
import { db, makeUser, makeAccount, truncateAll, actorOf, daysAgo, joinFamily } from "../helpers";
import * as reportsSvc from "@/server/domain/reports";
import * as exchangeRatesSvc from "@/server/domain/exchange-rates";
import { currentFamily } from "@/server/auth/context";

beforeAll(async () => {
  await truncateAll();
});

describe("dashboard FX warnings", () => {
  // Runs first: exchange_rates is global, and later tests in this file insert
  // an EUR rate — the USD pair used here must still be missing at this point.
  it("does not warn about accounts the requesting user cannot see", async () => {
    const owner = await makeUser({ currency: "NPR" });
    const family = await currentFamily(actorOf(owner));
    await makeAccount(owner, {
      currency: "USD",
      openingBalanceDisplayMinor: 10000,
      joint: false
    });

    const member = await makeUser();
    await joinFamily(member, family.id);

    const memberSummary = await reportsSvc.dashboardSummary(db(), family, member.userId);
    expect(memberSummary.incompleteFx).toBeFalsy();
    expect(memberSummary.fxIssues ?? []).toHaveLength(0);
    expect(memberSummary.netWorthMinor).toBe(0);

    // Control: the owner DOES see the warning for the same account.
    const ownerSummary = await reportsSvc.dashboardSummary(db(), family, owner.userId);
    expect(ownerSummary.incompleteFx).toBe(true);
    expect(ownerSummary.fxIssues).toHaveLength(1);
    expect(ownerSummary.fxIssues?.[0]).toMatchObject({ base: "USD", quote: "NPR" });
  });

  it("flags missing rates, excludes the amounts, and exposes rate dates once added", async () => {
    const user = await makeUser({ currency: "NPR" });
    const family = await currentFamily(actorOf(user));
    await makeAccount(user, { currency: "EUR", openingBalanceDisplayMinor: 10000 });

    const missing = await reportsSvc.dashboardSummary(db(), family, user.userId);
    expect(missing.incompleteFx).toBe(true);
    expect(missing.fxIssues).toHaveLength(1);
    expect(missing.fxIssues?.[0]).toMatchObject({ base: "EUR", quote: "NPR" });
    // The EUR balance is excluded rather than summed raw into NPR totals.
    expect(missing.netWorthMinor).toBe(0);

    await exchangeRatesSvc.upsertRate(db(), {
      base: "EUR",
      quote: "NPR",
      rate: "145",
      quotedOn: daysAgo(0)
    });

    const converted = await reportsSvc.dashboardSummary(db(), family, user.userId);
    expect(converted.incompleteFx).toBe(false);
    expect(converted.netWorthMinor).toBe(10000 * 145);
    expect(converted.fxRates).toHaveLength(1);
    expect(converted.fxRates?.[0]).toMatchObject({
      base: "EUR",
      quote: "NPR",
      quotedOn: daysAgo(0)
    });
  });
});
