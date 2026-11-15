import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  db,
  makeUser,
  makeAccount,
  addTxn,
  truncateAll,
  actorOf,
  daysAgo,
  joinFamily
} from "../helpers";
import * as reportsSvc from "@/server/domain/reports";
import * as accountsSvc from "@/server/domain/accounts";
import * as orchestrate from "@/server/domain/orchestrate";
import { currentFamily } from "@/server/auth/context";
import * as exchangeRatesSvc from "@/server/domain/exchange-rates";
import * as exportsSvc from "@/server/domain/exports";

beforeAll(async () => {
  await truncateAll();
});

describe("reports", () => {
  it("reconciles income/expense/net-worth against raw fixtures and excludes transfers", async () => {
    const user2 = await makeUser();
    const family = await currentFamily(actorOf(user2));
    const checking = await makeAccount(user2, { openingBalanceDisplayMinor: 100000 });
    const savings = await makeAccount(user2, { openingBalanceDisplayMinor: 50000 });

    await orchestrate.addTransaction(db(), actorOf(user2), {
      accountId: checking,
      date: daysAgo(1),
      amountLedgerMinor: -300000,
      name: "Salary"
    });
    await orchestrate.addTransaction(db(), actorOf(user2), {
      accountId: checking,
      date: daysAgo(0),
      amountLedgerMinor: 120000,
      name: "Rent"
    });
    await orchestrate.addTransaction(db(), actorOf(user2), {
      accountId: checking,
      date: daysAgo(0),
      amountLedgerMinor: 40000,
      name: "Groceries"
    });
    await orchestrate.makeTransferWithEntries(db(), actorOf(user2), {
      fromAccountId: checking,
      toAccountId: savings,
      date: daysAgo(0),
      amountDisplayMinor: 20000
    });

    const summary = await reportsSvc.dashboardSummary(db(), family, user2.userId);
    expect(summary.incomeThisMonthMinor).toBe(300000);
    expect(summary.expenseThisMonthMinor).toBe(160000);
    expect(summary.netWorthMinor).toBe(290000);

    const spend = await reportsSvc.spendingByCategory(db(), family, user2.userId, {
      from: daysAgo(5),
      to: daysAgo(0)
    });
    const total = spend.categories.reduce((acc, s) => acc + s.totalMinor, 0);
    expect(total).toBe(160000);
  });

  it("converts foreign-currency balances using stored rates", async () => {
    const user = await makeUser();
    const family = await currentFamily(actorOf(user));
    await db().execute(sql`UPDATE families SET currency = 'USD' WHERE id = ${family.id}::uuid`);

    await makeAccount(user, {
      openingBalanceDisplayMinor: 100000,
      currency: "EUR"
    });

    const rates = await db().execute(sql`
      SELECT count(*)::int AS c FROM exchange_rates WHERE base_currency='EUR' AND quote_currency='USD'
    `);
    if (Number((rates.rows ?? [])[0]!.c) === 0) {
      await exchangeRatesSvc.upsertRate(db(), {
        base: "EUR",
        quote: "USD",
        rate: "1.1",
        quotedOn: daysAgo(1)
      });
    }

    const series = await reportsSvc.netWorthSeries(
      db(),
      { ...family, currency: "USD" },
      user.userId,
      30
    );
    const latest = series.points[series.points.length - 1]!.valueMinor;
    expect(latest).toBe(Math.round(100000 * 1.1));
  });

  it("excludes closed accounts and report-excluded accounts from net worth", async () => {
    const user = await makeUser();
    const family = await currentFamily(actorOf(user));

    const open = await makeAccount(user, { openingBalanceDisplayMinor: 70000 });
    const excluded = await makeAccount(user, {
      openingBalanceDisplayMinor: 999999999,
      includedInReports: false
    });

    const before = await reportsSvc.netWorthSeries(db(), family, user.userId, 10);
    const latestBefore = before.points[before.points.length - 1]?.valueMinor ?? 0;

    await accountsSvc.setAccountStatus(db(), actorOf(user), open, "disabled");

    const after = await reportsSvc.netWorthSeries(db(), family, user.userId, 10);
    const latestAfter = after.points[after.points.length - 1]?.valueMinor ?? 0;

    expect(latestBefore).toBe(70000);
    expect(latestAfter).toBe(0);
    void excluded;
  });
});

describe("family export", () => {
  it("produces a complete family-scoped snapshot", async () => {
    const user = await makeUser();
    const account = await makeAccount(user);
    await addTxn(user, account, { amountLedgerMinor: 1234, name: "Export me" });

    const data = await exportsSvc.buildFamilyExport(db(), actorOf(user));
    expect(data.version).toBe(exportsSvc.EXPORT_VERSION);
    expect(data.family.members).toHaveLength(1);
    expect((data.accounts as unknown[]).length).toBeGreaterThanOrEqual(1);
    const entries = data.entries as Array<{ name: string; kind: string }>;
    expect(entries.some((e) => e.name === "Export me")).toBe(true);
  });

  it("excludes private accounts and entries of other members (S01)", async () => {
    const admin = await makeUser({ familyName: "ExportPrivacyFamily" });
    const member = await makeUser({ email: `member-${Date.now()}@test.local` });
    await joinFamily(member, admin.familyId);

    const adminPrivate = await makeAccount(admin, { name: "Admin Private", joint: false });
    await addTxn(admin, adminPrivate, { amountLedgerMinor: 5000, name: "Secret Admin Txn" });

    const memberPrivate = await makeAccount(member, { name: "Member Private", joint: false });
    await addTxn(member, memberPrivate, { amountLedgerMinor: 7500, name: "Secret Member Txn" });

    // Member export must NOT include admin's private account or transactions
    const memberExport = await exportsSvc.buildFamilyExport(db(), actorOf(member, "member"));
    const memberAccounts = memberExport.accounts as Array<{ id: string; name: string }>;
    const memberEntries = memberExport.entries as Array<{ name: string }>;
    expect(memberAccounts.some((a) => a.id === adminPrivate)).toBe(false);
    expect(memberAccounts.some((a) => a.id === memberPrivate)).toBe(true);
    expect(memberEntries.some((e) => e.name === "Secret Admin Txn")).toBe(false);
    expect(memberEntries.some((e) => e.name === "Secret Member Txn")).toBe(true);

    // Admin export must NOT include member's private account or transactions
    const adminExport = await exportsSvc.buildFamilyExport(db(), actorOf(admin, "admin"));
    const adminAccounts = adminExport.accounts as Array<{ id: string; name: string }>;
    const adminEntries = adminExport.entries as Array<{ name: string }>;
    expect(adminAccounts.some((a) => a.id === memberPrivate)).toBe(false);
    expect(adminAccounts.some((a) => a.id === adminPrivate)).toBe(true);
    expect(adminEntries.some((e) => e.name === "Secret Member Txn")).toBe(false);
    expect(adminEntries.some((e) => e.name === "Secret Admin Txn")).toBe(true);
  });
});
