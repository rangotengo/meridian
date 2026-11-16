import { and, eq, isNull, or, sql } from "drizzle-orm";
import { Executor } from "../db/client";
import { accountShares, accounts } from "../db/schema";
import type { Actor } from "../auth/context";
import { errors } from "@/lib/errors";

export type SharePermission = "full_control" | "read_write" | "read_only";
export type AccessLevel = SharePermission;
export type AccessNeed = "view" | "annotate" | "manage";

export const ACCOUNT_TYPES = [
  "depository",
  "credit_card",
  "other_asset",
  "other_liability"
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const VALUATION_DRIVEN_TYPES: AccountType[] = ["other_asset", "other_liability"];

export function isValuationDriven(type: string): boolean {
  return (VALUATION_DRIVEN_TYPES as string[]).includes(type);
}

export type BalanceTracking = "valuation" | "transactions";

export const BALANCE_TRACKING_MODES: BalanceTracking[] = ["valuation", "transactions"];

/** The tracking mode an account of this type starts with. */
export function defaultBalanceTracking(type: string): BalanceTracking {
  return isValuationDriven(type) ? "valuation" : "transactions";
}

/**
 * Whether THIS account's balance is its latest valuation (true) or the sum
 * of its transactions (false). The mode is per-account for the valuation-
 * driven types — a loan tracked by lend/repay transactions opts out — while
 * depository / credit_card accounts are always transaction-tracked no
 * matter what the column says.
 */
export function isValuationTracked(account: {
  type: string;
  balanceTracking?: string | null;
}): boolean {
  if (!isValuationDriven(account.type)) return false;
  return (account.balanceTracking ?? defaultBalanceTracking(account.type)) === "valuation";
}

export type AccountRow = typeof accounts.$inferSelect;

const NEED_RANK: Record<AccessNeed, number> = { view: 1, annotate: 2, manage: 3 };
const LEVEL_RANK: Record<AccessLevel, number> = { read_only: 1, read_write: 2, full_control: 3 };

function satisfies(level: AccessLevel, need: AccessNeed): boolean {
  return LEVEL_RANK[level] >= NEED_RANK[need];
}

export type AccountAccess =
  { granted: false } | { granted: true; account: AccountRow; level: AccessLevel };

export async function getAccountAccess(
  exec: Executor,
  actor: Actor,
  accountId: string
): Promise<AccountAccess> {
  const [account] = await exec.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!account || account.familyId !== actor.familyId) return { granted: false };
  let level: AccessLevel;
  if (account.ownerId === null || account.ownerId === actor.userId) {
    level = "full_control";
  } else {
    const [share] = await exec
      .select({ permission: accountShares.permission })
      .from(accountShares)
      .where(and(eq(accountShares.accountId, accountId), eq(accountShares.userId, actor.userId)))
      .limit(1);
    if (!share) return { granted: false };
    level = share.permission as SharePermission;
  }
  return { granted: true, account, level };
}

export async function assertAccountAccess(
  exec: Executor,
  actor: Actor,
  accountId: string,
  need: AccessNeed
): Promise<{ account: AccountRow; level: AccessLevel }> {
  const access = await getAccountAccess(exec, actor, accountId);
  if (!access.granted) throw errors.notFound("Account");
  if (!satisfies(access.level, need)) throw errors.forbidden();
  return { account: access.account, level: access.level };
}

export async function assertAccountAccessLevel(
  exec: Executor,
  actor: Actor,
  accountId: string
): Promise<AccessLevel> {
  const access = await getAccountAccess(exec, actor, accountId);
  if (!access.granted) throw errors.notFound("Account");
  return access.level;
}

export async function assertAccountOpen(
  exec: Executor,
  actor: Actor,
  accountId: string,
  need: AccessNeed
): Promise<{ account: AccountRow; level: AccessLevel }> {
  const res = await assertAccountAccess(exec, actor, accountId, need);
  if (res.account.status !== "active") {
    throw errors.conflict("This account is closed and can no longer be modified.");
  }
  return res;
}

export async function accessibleAccountIds(exec: Executor, actor: Actor): Promise<string[]> {
  const rows = await exec
    .select({ id: accounts.id })
    .from(accounts)
    .leftJoin(
      accountShares,
      and(eq(accountShares.accountId, accounts.id), eq(accountShares.userId, actor.userId))
    )
    .where(
      and(
        eq(accounts.familyId, actor.familyId),
        or(
          isNull(accounts.ownerId),
          eq(accounts.ownerId, actor.userId),
          sql`${accountShares.userId} IS NOT NULL`
        )
      )
    );
  return rows.map((r) => r.id);
}

export function canEditCore(level: AccessLevel): boolean {
  return level === "full_control";
}

export function canManageAccountSettings(level: AccessLevel): boolean {
  return level === "full_control";
}

export async function listSharedWithUsers(exec: Executor, accountId: string) {
  return exec
    .select({
      userId: accountShares.userId,
      permission: accountShares.permission,
      createdAt: accountShares.createdAt
    })
    .from(accountShares)
    .where(eq(accountShares.accountId, accountId));
}
