import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  makeUser,
  makeAccount,
  truncateAll,
  actorOf,
  latestBalance,
  daysAgo,
  type TestUser
} from "../helpers";
import { entries, transfers } from "@/server/db/schema";
import type { Actor } from "@/server/auth/context";

/**
 * The create-transaction / create-transfer actions come in two wrappers
 * over one shared mutation: the page wrapper redirects on success, the
 * dialog wrapper returns the typed ActionState and never redirects. These
 * tests pin that contract against the real database and domain rules.
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

import {
  createTransactionAction,
  createTransactionDialogAction,
  createTransferAction,
  createTransferDialogAction
} from "@/app/(app)/actions";

let admin: TestUser;
let accountA: string;
let accountB: string;
let euroAccount: string;

function txnForm(overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("accountId", accountA);
  form.set("kind", "expense");
  form.set("date", daysAgo(0));
  form.set("amount", "25.00");
  form.set("name", "Dialog expense");
  for (const [k, v] of Object.entries(overrides)) form.set(k, v);
  return form;
}

function transferForm(overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("fromAccountId", accountA);
  form.set("toAccountId", accountB);
  form.set("date", daysAgo(0));
  form.set("amount", "40.00");
  form.set("name", "Dialog transfer");
  for (const [k, v] of Object.entries(overrides)) form.set(k, v);
  return form;
}

async function entriesNamed(name: string) {
  return db().select().from(entries).where(eq(entries.name, name));
}

beforeAll(async () => {
  await truncateAll();
  admin = await makeUser({ email: "dialog-actions@e2e.local", familyName: "Dialog Actions" });
  accountA = await makeAccount(admin, { name: "Actions Checking", joint: false });
  accountB = await makeAccount(admin, { name: "Actions Savings", joint: false });
  euroAccount = await makeAccount(admin, {
    name: "Actions Euro",
    currency: "EUR",
    joint: false
  });
});

beforeEach(() => {
  mocks.revalidated.length = 0;
  mocks.actor = actorOf(admin) as Actor;
});

describe("create transaction wrappers", () => {
  it("dialog action creates the entry, returns ok, and does not redirect", async () => {
    const before = await latestBalance(accountA);
    const state = await createTransactionDialogAction(undefined, txnForm());
    expect(state).toEqual({ ok: true });
    const rows = await entriesNamed("Dialog expense");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accountId).toBe(accountA);
    // Expense of 25.00 moves the materialized balance by exactly 2500.
    const after = await latestBalance(accountA);
    expect((after?.balanceMinor ?? 0) - (before?.balanceMinor ?? 0)).toBe(-2500);
    // The dialog flow invalidates the surfaces the user is looking at.
    expect(mocks.revalidated).toContain("/transactions");
    expect(mocks.revalidated).toContain("/");
    expect(mocks.revalidated).toContain(`/accounts/${accountA}`);
  });

  it("page action creates the entry and then redirects to /transactions", async () => {
    await expect(
      createTransactionAction(undefined, txnForm({ name: "Page expense" }))
    ).rejects.toMatchObject({ digest: expect.stringContaining("/transactions") });
    expect(await entriesNamed("Page expense")).toHaveLength(1);
  });

  it("dialog action reports a validation failure and writes nothing", async () => {
    const state = await createTransactionDialogAction(
      undefined,
      txnForm({ name: "", amount: "10.00" })
    );
    expect(state.ok).toBe(false);
    const all = await db().select().from(entries).where(eq(entries.amountMinor, 1000));
    expect(all.filter((e) => e.accountId === accountA && e.name === "")).toHaveLength(0);
  });

  it("dialog action rejects an actor from another family", async () => {
    const stranger = await makeUser({ email: "stranger@e2e.local", familyName: "Elsewhere" });
    mocks.actor = actorOf(stranger) as Actor;
    const state = await createTransactionDialogAction(
      undefined,
      txnForm({ name: "Cross-family attempt" })
    );
    expect(state.ok).toBe(false);
    expect(await entriesNamed("Cross-family attempt")).toHaveLength(0);
  });
});

describe("create transfer wrappers", () => {
  it("dialog action creates both legs atomically and returns ok", async () => {
    const beforeA = await latestBalance(accountA);
    const beforeB = await latestBalance(accountB);
    const state = await createTransferDialogAction(undefined, transferForm());
    expect(state).toEqual({ ok: true });

    const legs = await entriesNamed("Dialog transfer");
    expect(legs).toHaveLength(2);
    const amounts = legs.map((l) => Number(l.amountMinor)).sort((x, y) => x - y);
    expect(amounts).toEqual([-4000, 4000]);
    const transferRows = await db().select().from(transfers);
    const linked = transferRows.filter(
      (t) =>
        legs.some((l) => l.id === t.outflowEntryId) && legs.some((l) => l.id === t.inflowEntryId)
    );
    expect(linked).toHaveLength(1);

    const afterA = await latestBalance(accountA);
    const afterB = await latestBalance(accountB);
    expect((afterA?.balanceMinor ?? 0) - (beforeA?.balanceMinor ?? 0)).toBe(-4000);
    expect((afterB?.balanceMinor ?? 0) - (beforeB?.balanceMinor ?? 0)).toBe(4000);
    expect(mocks.revalidated).toContain(`/accounts/${accountA}`);
    expect(mocks.revalidated).toContain(`/accounts/${accountB}`);
  });

  it("page action creates the transfer and then redirects", async () => {
    await expect(
      createTransferAction(undefined, transferForm({ name: "Page transfer", amount: "5.00" }))
    ).rejects.toMatchObject({ digest: expect.stringContaining("/transactions") });
    expect(await entriesNamed("Page transfer")).toHaveLength(2);
  });

  it("dialog action refuses a same-account transfer and writes nothing", async () => {
    const state = await createTransferDialogAction(
      undefined,
      transferForm({ toAccountId: accountA, name: "Self transfer" })
    );
    expect(state.ok).toBe(false);
    expect(await entriesNamed("Self transfer")).toHaveLength(0);
  });

  it("dialog action refuses a cross-currency transfer and writes nothing", async () => {
    const state = await createTransferDialogAction(
      undefined,
      transferForm({ toAccountId: euroAccount, name: "Cross-currency" })
    );
    expect(state.ok).toBe(false);
    expect(await entriesNamed("Cross-currency")).toHaveLength(0);
  });
});
