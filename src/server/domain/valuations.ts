import { eq } from "drizzle-orm";
import type { Executor } from "../db/client";
import { accounts, entries, valuations } from "../db/schema";
import type { Actor } from "../auth/context";
import { assertAccountAccessLevel, assertAccountOpen } from "../authorization/access";
import { errors } from "@/lib/errors";
import { displayToLedgerBalance } from "@/lib/money";
import { isIsoDate } from "@/lib/datetime";
import { recordAudit } from "../observability/audit";
import { accountHasHoldings } from "./holdings";

/**
 * While an account has manual portfolio holdings, its value is managed by
 * them (the holdings domain writes the daily valuation), so manual
 * valuation changes are rejected until the last holding is removed.
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

  const [account] = await exec
    .select()
    .from(accounts)
    .where(eq(accounts.id, input.accountId))
    .limit(1);
  if (!account) throw errors.notFound("Account");
  await assertNotHoldingsManaged(exec, account);

  const name =
    input.name?.trim() ||
    (input.kind === "reconciliation" ? "Reconciliation adjustment" : "Valuation update");

  const ledgerAmount = displayToLedgerBalance(input.amountDisplayMinor, account.type);

  const entryId = await exec.transaction(async (tx) => {
    const [entry] = await tx
      .insert(entries)
      .values({
        accountId: account.id,
        date: input.date,
        amountMinor: ledgerAmount,
        currency: account.currency,
        name,
        entryableType: "valuation"
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
    metadata: { accountId: account.id, kind: input.kind ?? "current" }
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
  const { entry, account } = await loadManagedValuation(exec, actor, input.entryId);
  const ledgerAmount = displayToLedgerBalance(input.amountDisplayMinor, account.type);

  await exec.transaction(async (tx) => {
    await tx
      .update(entries)
      .set({ date: input.date, amountMinor: ledgerAmount })
      .where(eq(entries.id, entry.id));
    if (input.kind) {
      await tx.update(valuations).set({ kind: input.kind }).where(eq(valuations.entryId, entry.id));
    }
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "valuation.updated",
    entityType: "entry",
    entityId: entry.id,
    metadata: { accountId: account.id, kind: input.kind }
  });

  return { accountId: account.id, previousDate: entry.date, date: input.date };
}

export async function deleteValuation(
  exec: Executor,
  actor: Actor,
  entryId: string
): Promise<{ accountId: string; date: string }> {
  const { entry, account } = await loadManagedValuation(exec, actor, entryId);

  // The valuations row is removed by the entries FK cascade.
  await exec.delete(entries).where(eq(entries.id, entry.id));

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "valuation.deleted",
    entityType: "entry",
    entityId: entry.id,
    metadata: { accountId: account.id }
  });

  return { accountId: account.id, date: entry.date };
}
