import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { entries, transactions } from "@/server/db/schema";
import * as categoriesSvc from "@/server/domain/categories";
import type { Actor } from "@/server/auth/context";
import { db, truncateAll, makeUser, makeAccount, addTxn, actorOf } from "../helpers";

/**
 * Calls the ACTUAL bulkRecategoriseEntriesAction (not a copy of its loop):
 * one transaction per entry via orchestrate.editTransaction, failures
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

import { bulkRecategoriseEntriesAction } from "@/app/(app)/actions";

function recatForm(entryIds: string[], categoryId: string | null): FormData {
  const form = new FormData();
  form.set("entryIds", JSON.stringify(entryIds));
  form.set("categoryId", categoryId ?? "");
  return form;
}

async function categoryOf(entryId: string): Promise<string | null> {
  const [row] = await db()
    .select({ categoryId: transactions.categoryId })
    .from(transactions)
    .where(eq(transactions.entryId, entryId));
  return row?.categoryId ?? null;
}

describe("bulkRecategoriseEntriesAction", () => {
  beforeEach(async () => {
    await truncateAll();
    mocks.actor = null;
    mocks.revalidated.length = 0;
  });

  it("recategorises the visible entries, skips an unknown id, and leaves balances alone", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    mocks.actor = actor;
    const accountId = await makeAccount(user);
    const { categoryId } = await categoriesSvc.createCategory(db(), actor, {
      name: "Groceries"
    });
    const a = await addTxn(user, accountId, { amountLedgerMinor: 5000, name: "A" });
    const b = await addTxn(user, accountId, { amountLedgerMinor: 3000, name: "B" });
    const before = await db()
      .select({ id: entries.id })
      .from(entries)
      .where(eq(entries.accountId, accountId));

    const res = await bulkRecategoriseEntriesAction(
      undefined,
      recatForm([a, randomUUID(), b], categoryId)
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data?.updated).toEqual([a, b]);
    expect(res.data?.skipped).toHaveLength(1);
    expect(res.data?.skipped[0]?.reason).toMatch(/not found/i);

    expect(await categoryOf(a)).toBe(categoryId);
    expect(await categoryOf(b)).toBe(categoryId);

    // Recategorising moves no money: same rows, same count.
    const after = await db()
      .select({ id: entries.id })
      .from(entries)
      .where(eq(entries.accountId, accountId));
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
  });

  it("clears the category when recategorising to Uncategorized", async () => {
    const user = await makeUser();
    mocks.actor = actorOf(user);
    const accountId = await makeAccount(user);
    const { categoryId } = await categoriesSvc.createCategory(db(), actorOf(user), {
      name: "Groceries"
    });
    const a = await addTxn(user, accountId, {
      amountLedgerMinor: 5000,
      name: "A",
      categoryId
    });

    expect(await categoryOf(a)).toBe(categoryId);
    const res = await bulkRecategoriseEntriesAction(undefined, recatForm([a], null));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data?.updated).toEqual([a]);
    expect(res.data?.skipped).toHaveLength(0);
    expect(await categoryOf(a)).toBeNull();
  });

  it("rejects more than 25 ids and changes nothing", async () => {
    const user = await makeUser();
    mocks.actor = actorOf(user);
    const accountId = await makeAccount(user);
    const { categoryId } = await categoriesSvc.createCategory(db(), actorOf(user), {
      name: "Groceries"
    });
    const ids: string[] = [];
    for (let i = 0; i < 26; i++) {
      ids.push(await addTxn(user, accountId, { amountLedgerMinor: 100, name: `T${i}` }));
    }

    const res = await bulkRecategoriseEntriesAction(undefined, recatForm(ids, categoryId));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("validation.failed");
    for (const id of ids) {
      expect(await categoryOf(id)).toBeNull();
    }
  });

  it("accepts exactly 25 ids", async () => {
    const user = await makeUser();
    mocks.actor = actorOf(user);
    const accountId = await makeAccount(user);
    const { categoryId } = await categoriesSvc.createCategory(db(), actorOf(user), {
      name: "Groceries"
    });
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      ids.push(await addTxn(user, accountId, { amountLedgerMinor: 100, name: `T${i}` }));
    }

    const res = await bulkRecategoriseEntriesAction(undefined, recatForm(ids, categoryId));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data?.updated).toHaveLength(25);
    expect(res.data?.skipped).toHaveLength(0);
    for (const id of ids) {
      expect(await categoryOf(id)).toBe(categoryId);
    }
  });
});
