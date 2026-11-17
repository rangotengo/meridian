import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { entries } from "@/server/db/schema";
import { withTransaction } from "@/server/db/client";
import * as orchestrate from "@/server/domain/orchestrate";
import { DomainError } from "@/lib/errors";
import {
  db,
  truncateAll,
  makeUser,
  makeAccount,
  addTxn,
  actorOf,
  latestBalance
} from "../helpers";

/**
 * Exercises the exact per-item loop the bulk delete server action runs:
 * one transaction per entry via orchestrate.removeEntry, failures recorded
 * per entry instead of rolling the whole batch back.
 */
describe("bulk delete (per-item removeEntry loop)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("deletes the deletable entries, skips a split part, and recalculates the balance", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makeAccount(user);
    const a = await addTxn(user, accountId, { amountLedgerMinor: 5000, name: "A" });
    const b = await addTxn(user, accountId, { amountLedgerMinor: 3000, name: "B" });
    const parent = await addTxn(user, accountId, { amountLedgerMinor: 10000, name: "Parent" });
    await orchestrate.splitTransaction(db(), actor, parent, [
      { name: "Part 1", amountLedgerMinor: 6000 },
      { name: "Part 2", amountLedgerMinor: 4000 }
    ]);
    const children = await db()
      .select({ id: entries.id })
      .from(entries)
      .where(eq(entries.parentEntryId, parent));
    expect(children.length).toBe(2);
    const childId = children[0]!.id;

    const before = await latestBalance(accountId);
    expect(before).not.toBeNull();

    const deleted: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const entryId of [a, childId, b]) {
      try {
        await withTransaction((tx) => orchestrate.removeEntry(tx, actor, entryId));
        deleted.push(entryId);
      } catch (e) {
        skipped.push({
          id: entryId,
          reason: e instanceof DomainError ? e.userMessage : "Could not delete."
        });
      }
    }

    expect(deleted).toEqual([a, b]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.id).toBe(childId);
    expect(skipped[0]!.reason).toMatch(/split/i);

    // The split parent and its parts survive; the deleted rows are gone.
    const remaining = await db()
      .select({ id: entries.id })
      .from(entries)
      .where(eq(entries.accountId, accountId));
    const remainingIds = remaining.map((r) => r.id);
    expect(remainingIds).toContain(parent);
    expect(remainingIds).toContain(childId);
    expect(remainingIds).not.toContain(a);
    expect(remainingIds).not.toContain(b);

    // Removing 5,000 + 3,000 of outflow adds 8,000 back to the balance.
    const after = await latestBalance(accountId);
    expect(after?.balanceMinor).toBe((before?.balanceMinor ?? 0) + 8000);
  });
});
