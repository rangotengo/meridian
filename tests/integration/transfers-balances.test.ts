import { describe, it, expect, beforeAll } from "vitest";
import {
  db,
  makeUser,
  makeAccount,
  addTxn,
  truncateAll,
  actorOf,
  latestBalance,
  daysAgo
} from "../helpers";
import { eq } from "drizzle-orm";
import { users } from "@/server/db/schema";
import * as accountsSvc from "@/server/domain/accounts";
import * as entriesSvc from "@/server/domain/entries";
import * as transfersSvc from "@/server/domain/transfers";
import * as orchestrate from "@/server/domain/orchestrate";
import * as balancesSvc from "@/server/domain/balances";
import * as exchangeRatesSvc from "@/server/domain/exchange-rates";

beforeAll(async () => {
  await truncateAll();
});

describe("transfers", () => {
  it("creates atomic pairs and is retry-safe", async () => {
    const user = await makeUser();
    const a = await makeAccount(user, { openingBalanceDisplayMinor: 50000 });
    const b = await makeAccount(user);
    const outId = await addTxn(user, a, { amountLedgerMinor: 1000, date: daysAgo(2) });
    const inId = await addTxn(user, b, { amountLedgerMinor: -1000, date: daysAgo(1) });

    const first = await orchestrate.linkTransfer(db(), actorOf(user), outId, inId);
    expect(first.existing).toBe(false);

    const retry = await orchestrate.linkTransfer(db(), actorOf(user), outId, inId);
    expect(retry.existing).toBe(true);
    expect(retry.transferId).toBe(first.transferId);
  });

  it("rejects same-account, cross-family, mismatched amounts and far dates", async () => {
    const user = await makeUser();
    const outsider = await makeUser();
    const a = await makeAccount(user);
    const b = await makeAccount(user);
    const foreign = await makeAccount(outsider);

    const same1 = await addTxn(user, a, { amountLedgerMinor: 500 });
    const same2 = await addTxn(user, a, { amountLedgerMinor: -500 });
    await expect(
      transfersSvc.createTransferFromTransactions(db(), actorOf(user), same1, same2)
    ).rejects.toMatchObject({ code: "validation.failed" });

    const out = await addTxn(user, a, { amountLedgerMinor: 900, date: daysAgo(2) });
    const inForeign = await addTxn(outsider, foreign, {
      amountLedgerMinor: -900,
      date: daysAgo(2)
    });
    await expect(
      transfersSvc.createTransferFromTransactions(db(), actorOf(user), out, inForeign)
    ).rejects.toBeTruthy();

    const badAmount = await addTxn(user, b, { amountLedgerMinor: -800 });
    await expect(
      transfersSvc.createTransferFromTransactions(db(), actorOf(user), out, badAmount)
    ).rejects.toMatchObject({ code: "validation.failed" });

    const farDate = await addTxn(user, b, { amountLedgerMinor: -900, date: daysAgo(30) });
    await expect(
      transfersSvc.createTransferFromTransactions(db(), actorOf(user), out, farDate)
    ).rejects.toMatchObject({ code: "validation.failed" });
  });

  it("suggests candidates within the date window ordered by proximity", async () => {
    const user = await makeUser();
    const a = await makeAccount(user);
    const b = await makeAccount(user);

    await addTxn(user, b, { amountLedgerMinor: -7000, name: "near match", date: daysAgo(3) });
    await addTxn(user, b, { amountLedgerMinor: -7000, name: "far match", date: daysAgo(10) });
    await addTxn(user, a, { amountLedgerMinor: 7000, name: "the source", date: daysAgo(3) });

    const page = await entriesSvc.listEntriesPage(db(), actorOf(user), { search: "the source" });
    const sourceId = page.items[0]!.id;

    const suggestions = await transfersSvc.suggestTransferMatches(db(), actorOf(user), sourceId);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]!.name).toBe("near match");
  });

  it("returns no suggestions for a read_only member instead of throwing", async () => {
    const owner = await makeUser({ familyName: "SuggestFam" });
    const member = await makeUser({
      email: `ro-member-${Date.now()}@test.local`,
      familyName: "Other"
    });
    await db().update(users).set({ familyId: owner.familyId }).where(eq(users.id, member.userId));
    member.familyId = owner.familyId;

    const a = await makeAccount(owner, { joint: false });
    const b = await makeAccount(owner, { joint: false });
    await accountsSvc.shareAccount(db(), actorOf(owner), a, member.userId, "read_only");
    await accountsSvc.shareAccount(db(), actorOf(owner), b, member.userId, "read_only");

    const sourceId = await addTxn(owner, a, {
      amountLedgerMinor: 7000,
      name: "ro source",
      date: daysAgo(3)
    });
    await addTxn(owner, b, { amountLedgerMinor: -7000, name: "ro match", date: daysAgo(3) });

    // The transaction detail page fetches suggestions for every viewer;
    // for a read_only member this must resolve empty, not throw forbidden.
    await expect(
      transfersSvc.suggestTransferMatches(db(), actorOf(member), sourceId)
    ).resolves.toEqual([]);
    // The read-only detail view itself still loads.
    await expect(entriesSvc.getEntryDetail(db(), actorOf(member), sourceId)).resolves.toBeTruthy();
    // A read_write member still receives suggestions.
    const writer = await makeUser({
      email: `rw-member-${Date.now()}@test.local`,
      familyName: "Other"
    });
    await db().update(users).set({ familyId: owner.familyId }).where(eq(users.id, writer.userId));
    writer.familyId = owner.familyId;
    await accountsSvc.shareAccount(db(), actorOf(owner), a, writer.userId, "read_write");
    await accountsSvc.shareAccount(db(), actorOf(owner), b, writer.userId, "read_write");
    const writerSuggestions = await transfersSvc.suggestTransferMatches(
      db(),
      actorOf(writer),
      sourceId
    );
    expect(writerSuggestions.length).toBeGreaterThan(0);
  });

  it("unlinking restores both legs atomically", async () => {
    const user = await makeUser();
    const a = await makeAccount(user);
    const b = await makeAccount(user);
    const outId = await addTxn(user, a, { amountLedgerMinor: 4321, date: daysAgo(2) });
    const inId = await addTxn(user, b, { amountLedgerMinor: -4321, date: daysAgo(2) });
    const linked = await orchestrate.linkTransfer(db(), actorOf(user), outId, inId);

    await orchestrate.unlinkTransfer(db(), actorOf(user), linked.transferId);

    const dOut = await entriesSvc.getEntryDetail(db(), actorOf(user), outId);
    const dIn = await entriesSvc.getEntryDetail(db(), actorOf(user), inId);
    expect(dOut.transferId).toBeNull();
    expect(dIn.transferId).toBeNull();
  });

  it("creates transfers with new paired entries via the convenience path", async () => {
    const user = await makeUser();
    const from = await makeAccount(user, { openingBalanceDisplayMinor: 200000 });
    const to = await makeAccount(user);

    await orchestrate.makeTransferWithEntries(db(), actorOf(user), {
      fromAccountId: from,
      toAccountId: to,
      date: daysAgo(1),
      amountDisplayMinor: 25000,
      name: "Card payment"
    });

    const fromBal = await latestBalance(from);
    const toBal = await latestBalance(to);
    expect(fromBal!.balanceMinor).toBe(175000);
    expect(toBal!.balanceMinor).toBe(25000);
  });
});

describe("balances", () => {
  it("handles backdated inserts by recalculating forward history", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      openingBalanceDisplayMinor: 10000,
      openedOn: daysAgo(20)
    });

    await addTxn(user, accountId, { amountLedgerMinor: 5000, date: daysAgo(3) });
    let bal = await latestBalance(accountId);
    expect(bal!.balanceMinor).toBe(5000);

    await addTxn(user, accountId, { amountLedgerMinor: 3000, date: daysAgo(15) });
    bal = await latestBalance(accountId);
    expect(bal!.balanceMinor).toBe(2000);

    await balancesSvc.recalculateAccount(db(), accountId);
    bal = await latestBalance(accountId);
    expect(bal!.balanceMinor).toBe(2000);
  });

  it("valuation-driven accounts track latest valuation", async () => {
    const user = await makeUser();
    const valuationsSvc = await import("@/server/domain/valuations");
    const car = await makeAccount(user, {
      type: "other_asset",
      openingBalanceDisplayMinor: 100000,
      openedOn: daysAgo(30)
    });

    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId: car,
      date: daysAgo(10),
      amountDisplayMinor: 120000
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId: car,
      date: daysAgo(2),
      amountDisplayMinor: 118000
    });
    await balancesSvc.recalculateAccount(db(), car);

    const bal = await latestBalance(car);
    expect(bal!.balanceMinor).toBe(118000);
  });
});

describe("exchange rates", () => {
  it("converts using dated rates with inverse fallback", async () => {
    const exec = db();
    await exchangeRatesSvc.upsertRate(exec, {
      base: "USD",
      quote: "EUR",
      rate: "0.8",
      quotedOn: daysAgo(5)
    });
    await exchangeRatesSvc.upsertRate(exec, {
      base: "USD",
      quote: "EUR",
      rate: "0.9",
      quotedOn: daysAgo(1)
    });

    expect(Number(await exchangeRatesSvc.getRate(exec, "USD", "EUR", daysAgo(0)))).toBeCloseTo(
      0.9,
      8
    );
    expect(Number(await exchangeRatesSvc.getRate(exec, "USD", "EUR", daysAgo(3)))).toBeCloseTo(
      0.8,
      8
    );
    expect(Number(await exchangeRatesSvc.getRate(exec, "EUR", "USD", daysAgo(0)))).toBeCloseTo(
      1 / 0.9,
      6
    );
    expect(await exchangeRatesSvc.getRate(exec, "GBP", "USD", daysAgo(0))).toBeNull();

    expect(exchangeRatesSvc.convertMinor(1000, "0.9")).toBe(900);
  });
});
