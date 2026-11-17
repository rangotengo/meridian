import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { entries } from "@/server/db/schema";
import * as orchestrate from "@/server/domain/orchestrate";
import type { Actor } from "@/server/auth/context";
import { db, truncateAll, makeUser, makeAccount, addTxn, actorOf, latestBalance } from "../helpers";

/**
 * Calls the ACTUAL bulkDeleteEntriesAction (not a copy of its loop):
 * one transaction per entry via orchestrate.removeEntry, failures
 * recorded per entry instead of rolling the whole batch back, and the
 * 25-id schema cap enforced up front.
 */

const mocks = vi.hoisted(() => ({
  revalidated: [] as string[],
  actor: null as Actor | null
}));

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    mocks.revalidated.push(path);
  }
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const err = new Error(`NEXT_REDIRECT ${url}`) as Error & { digest: string };
    err.digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw err;
  }
}));

vi.mock("@/server/auth/context", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/auth/context")>();
  return {
    ...orig,
    assertActor: async () => {
      if (!mocks.actor) throw new Error("test actor not set");
      return mocks.actor;
    }
  };
});

import { bulkDeleteEntriesAction } from "@/app/(app)/actions";

function deleteForm(entryIds: string[]): FormData {
  const form = new FormData();
  form.set("entryIds", JSON.stringify(entryIds));
  return form;
}

async function countEntries(accountId: string): Promise<number> {
  const rows = await db()
    .select({ id: entries.id })
    .from(entries)
    .where(eq(entries.accountId, accountId));
  return rows.length;
}

describe("bulkDeleteEntriesAction", () => {
  beforeEach(async () => {
    await truncateAll();
    mocks.actor = null;
    mocks.revalidated.length = 0;
  });

  it("deletes the deletable entries, skips a split part, and recalculates the balance", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    mocks.actor = actor;
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

    const res = await bulkDeleteEntriesAction(undefined, deleteForm([a, childId, b]));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data?.deleted).toEqual([a, b]);
    expect(res.data?.skipped).toHaveLength(1);
    expect(res.data?.skipped[0]?.id).toBe(childId);
    expect(res.data?.skipped[0]?.reason).toMatch(/split/i);

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

  it("rejects more than 25 ids and deletes nothing", async () => {
    const user = await makeUser();
    mocks.actor = actorOf(user);
    const accountId = await makeAccount(user);
    const ids: string[] = [];
    for (let i = 0; i < 26; i++) {
      ids.push(await addTxn(user, accountId, { amountLedgerMinor: 100, name: `T${i}` }));
    }

    // 26 ids is what a cross-page selection used to submit (25 + 25);
    // the UI can no longer build one, and the action still refuses it.
    const res = await bulkDeleteEntriesAction(undefined, deleteForm(ids));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("validation.failed");
    expect(await countEntries(accountId)).toBe(26);
  });

  it("accepts exactly 25 ids", async () => {
    const user = await makeUser();
    mocks.actor = actorOf(user);
    const accountId = await makeAccount(user);
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      ids.push(await addTxn(user, accountId, { amountLedgerMinor: 100, name: `T${i}` }));
    }

    const res = await bulkDeleteEntriesAction(undefined, deleteForm(ids));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data?.deleted).toHaveLength(25);
    expect(res.data?.skipped).toHaveLength(0);
    expect(await countEntries(accountId)).toBe(0);
  });
});
