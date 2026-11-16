import { describe, it, expect, beforeAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  db,
  makeUser,
  makeAccount,
  actorOf,
  daysAgo,
  latestBalance,
  truncateAll,
  type TestUser
} from "../helpers";
import * as exportsSvc from "@/server/domain/exports";
import * as holdingsSvc from "@/server/domain/holdings";
import * as valuationsSvc from "@/server/domain/valuations";
import { recalculateAccount } from "@/server/domain/balances";
import { importFamilyExport, parseFamilyExport } from "@/server/domain/family-import";
import { accounts, entries } from "@/server/db/schema";

beforeAll(async () => {
  await truncateAll();
});

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Delete every data row of a family (keeping the family and its users) so it can accept a restore. */
async function wipeFamilyData(familyId: string): Promise<void> {
  const exec = db();
  await exec.execute(
    sql`DELETE FROM transaction_tags WHERE transaction_id IN (SELECT t.id FROM transactions t JOIN entries e ON e.id = t.entry_id JOIN accounts a ON a.id = e.account_id WHERE a.family_id = ${familyId}::uuid)`
  );
  await exec.execute(
    sql`DELETE FROM transfers WHERE outflow_entry_id IN (SELECT e.id FROM entries e JOIN accounts a ON a.id = e.account_id WHERE a.family_id = ${familyId}::uuid)`
  );
  await exec.execute(
    sql`DELETE FROM transactions WHERE entry_id IN (SELECT e.id FROM entries e JOIN accounts a ON a.id = e.account_id WHERE a.family_id = ${familyId}::uuid)`
  );
  await exec.execute(
    sql`DELETE FROM valuations WHERE entry_id IN (SELECT e.id FROM entries e JOIN accounts a ON a.id = e.account_id WHERE a.family_id = ${familyId}::uuid)`
  );
  await exec.execute(
    sql`DELETE FROM entries WHERE account_id IN (SELECT id FROM accounts WHERE family_id = ${familyId}::uuid)`
  );
  await exec.execute(sql`DELETE FROM recurring_series WHERE family_id = ${familyId}::uuid`);
  await exec.execute(sql`DELETE FROM budgets WHERE family_id = ${familyId}::uuid`);
  await exec.execute(
    sql`DELETE FROM saved_filters WHERE user_id IN (SELECT id FROM users WHERE family_id = ${familyId}::uuid)`
  );
  await exec.execute(
    sql`DELETE FROM account_shares WHERE account_id IN (SELECT id FROM accounts WHERE family_id = ${familyId}::uuid)`
  );
  await exec.execute(
    sql`DELETE FROM balances WHERE account_id IN (SELECT id FROM accounts WHERE family_id = ${familyId}::uuid)`
  );
  await exec.execute(sql`DELETE FROM accounts WHERE family_id = ${familyId}::uuid`);
  await exec.execute(sql`DELETE FROM tags WHERE family_id = ${familyId}::uuid`);
  await exec.execute(sql`DELETE FROM categories WHERE family_id = ${familyId}::uuid`);
}

type ExportedEntry = {
  id: string;
  accountId: string;
  date: string;
  amountMinor: number;
  kind: string;
  writeOrder?: number;
};

async function roundTrip(
  user: TestUser,
  exported: unknown
): Promise<{ restoredAccountId: string; result: Awaited<ReturnType<typeof importFamilyExport>> }> {
  const actor = actorOf(user);
  await wipeFamilyData(user.familyId);
  const result = await importFamilyExport(
    db(),
    actor,
    parseFamilyExport(encode(JSON.parse(JSON.stringify(exported))))
  );
  const [restored] = await db().select().from(accounts).where(eq(accounts.familyId, user.familyId));
  return { restoredAccountId: restored!.id, result };
}

async function balanceOn(accountId: string, date: string): Promise<number | null> {
  const rows = await db().execute<{ balance_minor: string }>(sql`
    SELECT balance_minor::text AS balance_minor FROM balances
    WHERE account_id = ${accountId}::uuid AND as_of = ${date}::date
  `);
  const found = (rows.rows ?? [])[0];
  return found ? Number(found.balance_minor) : null;
}

describe("export → restore preserves same-day valuation precedence", () => {
  it("repro 1: manual valuation then holdings restores the holdings value", async () => {
    const user = await makeUser({ familyName: "PrecedenceOne" });
    const actor = actorOf(user);
    const exec = db();
    const today = daysAgo(0);

    const brokerage = await makeAccount(user, {
      name: "Repro One Brokerage",
      type: "other_asset",
      openingBalanceDisplayMinor: 0
    });
    await valuationsSvc.recordValuation(exec, actor, {
      accountId: brokerage,
      date: today,
      amountDisplayMinor: 5000,
      kind: "current",
      name: "Manual valuation"
    });
    await recalculateAccount(exec, brokerage);
    await holdingsSvc.addHolding(exec, actor, {
      accountId: brokerage,
      ticker: "NABIL",
      quantity: "10",
      averageCostMinor: null,
      currentPriceMinor: 100
    });
    expect((await latestBalance(brokerage))?.balanceMinor).toBe(1000);

    const exported = await exportsSvc.buildFamilyExport(exec, actor);
    expect(exported.version).toBe(3);
    const exportedEntries = exported.entries as ExportedEntry[];
    // Every entry carries an integer per-account rank, and the manual
    // valuation (written first) ranks below the holdings valuation.
    expect(exportedEntries.every((e) => Number.isSafeInteger(e.writeOrder))).toBe(true);
    const todaysValuations = exportedEntries
      .filter((e) => e.accountId === brokerage && e.kind === "valuation" && e.date === today)
      .sort((a, b) => (a.writeOrder ?? 0) - (b.writeOrder ?? 0));
    expect(todaysValuations.map((e) => e.amountMinor)).toEqual([5000, 1000]);

    const { restoredAccountId } = await roundTrip(user, exported);
    expect(restoredAccountId).not.toBe(brokerage);
    expect((await latestBalance(restoredAccountId))?.balanceMinor).toBe(1000);

    // The destination stamps created_at monotonically in source order, so
    // the balance engine's own tiebreak agrees with the source.
    const restoredEntries = await exec
      .select()
      .from(entries)
      .where(eq(entries.accountId, restoredAccountId));
    const restoredToday = restoredEntries
      .filter((e) => e.entryableType === "valuation" && e.date === today)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(restoredToday.map((e) => e.amountMinor)).toEqual([5000, 1000]);
  });

  it("repro 2: holdings, then zero, then manual restores the manual value", async () => {
    const user = await makeUser({ familyName: "PrecedenceTwo" });
    const actor = actorOf(user);
    const exec = db();
    const today = daysAgo(0);

    const brokerage = await makeAccount(user, {
      name: "Repro Two Brokerage",
      type: "other_asset",
      openingBalanceDisplayMinor: 0
    });
    const { holdingId } = await holdingsSvc.addHolding(exec, actor, {
      accountId: brokerage,
      ticker: "NABIL",
      quantity: "10",
      averageCostMinor: null,
      currentPriceMinor: 100
    });
    await holdingsSvc.deleteHolding(exec, actor, { accountId: brokerage, holdingId });
    await valuationsSvc.recordValuation(exec, actor, {
      accountId: brokerage,
      date: today,
      amountDisplayMinor: 5000,
      kind: "current",
      name: "Manual valuation"
    });
    await recalculateAccount(exec, brokerage);
    expect((await latestBalance(brokerage))?.balanceMinor).toBe(5000);

    const exported = await exportsSvc.buildFamilyExport(exec, actor);
    const { restoredAccountId } = await roundTrip(user, exported);
    expect((await latestBalance(restoredAccountId))?.balanceMinor).toBe(5000);
  });

  it("multi-day: ordering within each day is preserved, cross-day precedence unchanged", async () => {
    const user = await makeUser({ familyName: "PrecedenceMultiDay" });
    const actor = actorOf(user);
    const exec = db();
    const yesterday = daysAgo(1);
    const today = daysAgo(0);

    const brokerage = await makeAccount(user, {
      name: "Multi Day Brokerage",
      type: "other_asset",
      openingBalanceDisplayMinor: 0
    });
    await valuationsSvc.recordValuation(exec, actor, {
      accountId: brokerage,
      date: yesterday,
      amountDisplayMinor: 7000,
      kind: "current",
      name: "Yesterday manual"
    });
    await recalculateAccount(exec, brokerage);
    await valuationsSvc.recordValuation(exec, actor, {
      accountId: brokerage,
      date: today,
      amountDisplayMinor: 5000,
      kind: "current",
      name: "Today manual"
    });
    await recalculateAccount(exec, brokerage);
    await holdingsSvc.addHolding(exec, actor, {
      accountId: brokerage,
      ticker: "NABIL",
      quantity: "10",
      averageCostMinor: null,
      currentPriceMinor: 100
    });
    expect((await latestBalance(brokerage))?.balanceMinor).toBe(1000);
    expect(await balanceOn(brokerage, yesterday)).toBe(7000);

    const exported = await exportsSvc.buildFamilyExport(exec, actor);
    const { restoredAccountId } = await roundTrip(user, exported);
    expect((await latestBalance(restoredAccountId))?.balanceMinor).toBe(1000);
    expect(await balanceOn(restoredAccountId, yesterday)).toBe(7000);
    expect(await balanceOn(restoredAccountId, today)).toBe(1000);
  });

  it("legacy export without writeOrder restores with the previous fallback", async () => {
    const user = await makeUser({ familyName: "PrecedenceLegacy" });
    const actor = actorOf(user);
    const exec = db();
    const today = daysAgo(0);

    const brokerage = await makeAccount(user, {
      name: "Legacy Brokerage",
      type: "other_asset",
      openingBalanceDisplayMinor: 0
    });
    await valuationsSvc.recordValuation(exec, actor, {
      accountId: brokerage,
      date: today,
      amountDisplayMinor: 5000,
      kind: "current",
      name: "Manual valuation"
    });
    await recalculateAccount(exec, brokerage);
    await holdingsSvc.addHolding(exec, actor, {
      accountId: brokerage,
      ticker: "NABIL",
      quantity: "10",
      averageCostMinor: null,
      currentPriceMinor: 100
    });
    expect((await latestBalance(brokerage))?.balanceMinor).toBe(1000);

    const exported = JSON.parse(
      JSON.stringify(await exportsSvc.buildFamilyExport(exec, actor))
    ) as { entries: Record<string, unknown>[] };
    // An export written before the key existed: strip it entirely.
    for (const entry of exported.entries) delete entry.writeOrder;

    const { restoredAccountId } = await roundTrip(user, exported);
    // Previous fallback behavior, documented in family-import.ts: the
    // legacy backwards walk inserts in reverse array order, so the FIRST
    // entry in the array for a date wins the tiebreak — here the manual
    // 5000, not the source-correct holdings 1000. The restore still
    // succeeds; it just carries no precedence guarantee.
    expect((await latestBalance(restoredAccountId))?.balanceMinor).toBe(5000);
  });

  it("rejects a non-integer writeOrder at parse time", async () => {
    const user = await makeUser({ familyName: "PrecedenceBadKey" });
    const actor = actorOf(user);
    const exec = db();

    const brokerage = await makeAccount(user, {
      name: "Bad Key Brokerage",
      type: "other_asset",
      openingBalanceDisplayMinor: 0
    });
    await valuationsSvc.recordValuation(exec, actor, {
      accountId: brokerage,
      date: daysAgo(0),
      amountDisplayMinor: 5000,
      kind: "current"
    });
    const exported = JSON.parse(
      JSON.stringify(await exportsSvc.buildFamilyExport(exec, actor))
    ) as { entries: Record<string, unknown>[] };
    exported.entries[0]!.writeOrder = 1.5;
    expect(() => parseFamilyExport(encode(exported))).toThrow(/invalid write order/);
    exported.entries[0]!.writeOrder = -1;
    expect(() => parseFamilyExport(encode(exported))).toThrow(/invalid write order/);
  });
});
