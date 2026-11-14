import { describe, it, expect, beforeAll } from "vitest";
import { db, makeUser, makeAccount, addTxn, truncateAll, actorOf, daysAgo } from "../helpers";
import * as orchestrate from "@/server/domain/orchestrate";
import * as entriesSvc from "@/server/domain/entries";

beforeAll(async () => {
  await truncateAll();
});

describe("annotation edits on linked transfers", () => {
  it("allows annotation edits that resubmit unchanged date/amount, rejects real changes", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const from = await makeAccount(user);
    const to = await makeAccount(user);
    const date = daysAgo(1);

    const outflowId = await addTxn(user, from, {
      amountLedgerMinor: 5000,
      date,
      name: "Move out"
    });
    const inflowId = await addTxn(user, to, {
      amountLedgerMinor: -5000,
      date,
      name: "Move in"
    });
    await orchestrate.linkTransfer(db(), actor, outflowId, inflowId);

    // The transaction form submits every field for full-control users, so an
    // annotation-only save arrives with the SAME date and amount attached.
    await orchestrate.editTransaction(db(), actor, outflowId, {
      date,
      amountLedgerMinor: 5000,
      notes: "Monthly rent share",
      merchant: "Landlord"
    });

    const detail = await entriesSvc.getEntryDetail(db(), actor, outflowId);
    expect(detail.entry.notes).toBe("Monthly rent share");
    expect(detail.merchant).toBe("Landlord");
    expect(detail.transferId).not.toBeNull();

    // Annotation-only patch (no core fields at all) also works.
    await orchestrate.editTransaction(db(), actor, outflowId, { notes: "Updated note" });
    const again = await entriesSvc.getEntryDetail(db(), actor, outflowId);
    expect(again.entry.notes).toBe("Updated note");

    // Actually changing amount or date on a linked leg is still rejected.
    await expect(
      orchestrate.editTransaction(db(), actor, outflowId, { amountLedgerMinor: 6000 })
    ).rejects.toThrow(/linked transfer/i);
    await expect(
      orchestrate.editTransaction(db(), actor, outflowId, { date: daysAgo(2) })
    ).rejects.toThrow(/linked transfer/i);

    // And the rejected attempts changed nothing.
    const after = await entriesSvc.getEntryDetail(db(), actor, outflowId);
    expect(after.entry.amountMinor).toBe(5000);
    expect(after.entry.date).toBe(date);
  });
});
