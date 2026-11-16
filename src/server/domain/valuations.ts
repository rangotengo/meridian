import { eq } from "drizzle-orm";
import type { Executor } from "../db/client";
import { statementTimestamp } from "../db/dialect";
import { accounts, entries, valuations } from "../db/schema";
import type { Actor } from "../auth/context";
import { assertAccountAccessLevel, assertAccountOpen } from "../authorization/access";
import { errors } from "@/lib/errors";
import { displayToLedgerBalance } from "@/lib/money";
import { isIsoDate } from "@/lib/datetime";
import { recordAudit } from "../observability/audit";
import { accountHasHoldings, withHoldingsAccountLock } from "./holdings";

/**
 * While an account has manual portfolio holdings, its value is managed by
 * them (the holdings domain writes the daily valuation), so manual
 * valuation changes are rejected until the last holding is removed.
 *
 * The guard and the write run inside the account's holdings lock (see
 * holdings.ts): holdings-mode transitions are writers for the account
 * like any holdings mutation, and an unlocked check-then-write could race
 * a concurrent holdings change into a state neither side intended.
 */
async function assertNotHoldingsManaged(exec: Executor, account: AccountRow): Promise<void> {
  if (account.type !== "other_asset") return;
  if (await accountHasHoldings(exec, account.id)) {
    throw errors.validation("This account's value is managed by its holdings.");
  }
}

export const VALUATION_KINDS = ["opening", "reconciliation", "current"] as const;
export type ValuationKind = (typeof VALUATION_KINDS)[number];

export async function recordValuation(
  exec: Executor,
  actor: Actor,
  input: {
    accountId: string;
    date: string;
    amountDisplayMinor: number;
    kind?: ValuationKind;
    name?: string;
  }
): Promise<{ entryId: string }> {
  const level = await assertAccountAccessLevel(exec, actor, input.accountId);
  if (level !== "full_control") {
    throw errors.forbidden("Only full-control access can record valuations.");
  }
  await assertAccountOpen(exec, actor, input.accountId, "manage");
  if (!isIsoDate(input.date)) throw errors.validation("Date must be in YYYY-MM-DD format.");
  if (input.kind && !VALUATION_KINDS.includes(input.kind)) {
    throw errors.validation("Unknown valuation kind.");
  }

  const name =
    input.name?.trim() ||
    (input.kind === "reconciliation" ? "Reconciliation adjustment" : "Valuation update");

  const entryId = await withHoldingsAccountLock(exec, input.accountId, async (tx) => {
    const [account] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, input.accountId))
      .limit(1);
    if (!account) throw errors.notFound("Account");
    await assertNotHoldingsManaged(tx, account);

    const ledgerAmount = displayToLedgerBalance(input.amountDisplayMinor, account.type);
    const [entry] = await tx
      .insert(entries)
      .values({
        accountId: account.id,
        date: input.date,
        amountMinor: ledgerAmount,
        currency: account.currency,
        name,
        entryableType: "valuation",
        // Same-day precedence is write order: stamp the entry at
        // statement-execution time (after the account lock above), not
        // with the column default, which is the transaction's start
        // time and could predate a competitor that already committed.
        createdAt: statementTimestamp()
      })
      .returning({ id: entries.id });
    const entryId = entry?.id;
    if (!entryId) throw errors.conflict("Failed to create valuation entry.");
    await tx.insert(valuations).values({ entryId, kind: input.kind ?? "current" });
    return entryId;
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "valuation.recorded",
    entityType: "entry",
    entityId: entryId,
    metadata: { accountId: input.accountId, kind: input.kind ?? "current" }
  });

  return { entryId };
}

type ValuationEntryRow = typeof entries.$inferSelect;
type AccountRow = typeof accounts.$inferSelect;

async function loadManagedValuation(
  exec: Executor,
  actor: Actor,
  entryId: string
): Promise<{ entry: ValuationEntryRow; account: AccountRow }> {
  const [entry] = await exec.select().from(entries).where(eq(entries.id, entryId)).limit(1);
  if (!entry || entry.entryableType !== "valuation") throw errors.notFound("Valuation");
  // Tenancy is enforced through the account: assertAccountAccessLevel throws
  // notFound when the account is outside the actor's family.
  const level = await assertAccountAccessLevel(exec, actor, entry.accountId);
  if (level !== "full_control") {
    throw errors.forbidden("Only full-control access can change valuations.");
  }
  const { account } = await assertAccountOpen(exec, actor, entry.accountId, "manage");
  await assertNotHoldingsManaged(exec, account);
  return { entry, account };
}

/** Bare entry read used only to discover the owning account (immutable). */
async function loadValuationAccountId(exec: Executor, entryId: string): Promise<string> {
  const [entry] = await exec.select().from(entries).where(eq(entries.id, entryId)).limit(1);
  if (!entry || entry.entryableType !== "valuation") throw errors.notFound("Valuation");
  return entry.accountId;
}

export async function updateValuation(
  exec: Executor,
  actor: Actor,
  input: {
    entryId: string;
    date: string;
    amountDisplayMinor: number;
    kind?: ValuationKind;
  }
): Promise<{ accountId: string; previousDate: string; date: string }> {
  if (!isIsoDate(input.date)) throw errors.validation("Date must be in YYYY-MM-DD format.");
  if (input.kind && !VALUATION_KINDS.includes(input.kind)) {
    throw errors.validation("Unknown valuation kind.");
  }
  const accountId = await loadValuationAccountId(exec, input.entryId);

  const result = await withHoldingsAccountLock(exec, accountId, async (tx) => {
    // Access, open-state, and the holdings-mode guard are re-evaluated
    // inside the lock, against the transaction's snapshot.
    const { entry, account } = await loadManagedValuation(tx, actor, input.entryId);
    const ledgerAmount = displayToLedgerBalance(input.amountDisplayMinor, account.type);
    await tx
      .update(entries)
      .set({ date: input.date, amountMinor: ledgerAmount })
      .where(eq(entries.id, entry.id));
    if (input.kind) {
      await tx.update(valuations).set({ kind: input.kind }).where(eq(valuations.entryId, entry.id));
    }
    return { accountId: account.id, previousDate: entry.date, date: input.date };
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "valuation.updated",
    entityType: "entry",
    entityId: input.entryId,
    metadata: { accountId, kind: input.kind }
  });

  return result;
}

export async function deleteValuation(
  exec: Executor,
  actor: Actor,
  entryId: string
): Promise<{ accountId: string; date: string }> {
  const accountId = await loadValuationAccountId(exec, entryId);

  const result = await withHoldingsAccountLock(exec, accountId, async (tx) => {
    const { entry, account } = await loadManagedValuation(tx, actor, entryId);
    // The valuations row is removed by the entries FK cascade.
    await tx.delete(entries).where(eq(entries.id, entry.id));
    return { accountId: account.id, date: entry.date };
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "valuation.deleted",
    entityType: "entry",
    entityId: entryId,
    metadata: { accountId }
  });

  return result;
}
