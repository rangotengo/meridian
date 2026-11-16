import postgres from "postgres";
import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { hashPassword } from "@/lib/crypto";
import { registerUserWithFamily } from "@/server/domain/users";
import * as accountsSvc from "@/server/domain/accounts";
import * as orchestrate from "@/server/domain/orchestrate";
import type { TransactionEntryInput } from "@/server/domain/entries";
import { assertSafeTestDatabase } from "./setup/database-guard";
void (0 as unknown as TransactionEntryInput);

export const db = () => getDb();

const TABLES = [
  "ssis_statement_entries",
  "ssis_purchases",
  "ssis_nav_history",
  "ssis_insight_state",
  "mero_share_transactions",
  "mero_share_holdings",
  "mero_share_accounts",
  "mero_share_connections",
  "chat_messages",
  "chat_proposals",
  "saved_filters",
  "budgets",
  "transaction_tags",
  "transfers",
  "valuations",
  "transactions",
  "entries",
  "recurring_series",
  "balances",
  "account_shares",
  "accounts",
  "tags",
  "categories",
  "invitations",
  "instance_invitations",
  "auth_tokens",
  "oauth_assertion_claims",
  "oauth_tokens",
  "oauth_authorization_codes",
  "oauth_authorization_requests",
  "oauth_grants",
  "oauth_clients",
  "sessions",
  "audit_events",
  "debug_log_entries",
  "jobs",
  "cron_schedules",
  "rate_limit_counters",
  "feature_flags",
  "exchange_rates",
  "users",
  "families"
];

export async function truncateAll(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("No database URL configured for test truncation.");
  assertSafeTestDatabase(url, process.env.APP_DATABASE_URL);
  const client = getDbClient();
  await client.unsafe(`TRUNCATE ${TABLES.join(", ")} CASCADE`);
}

let rawClient: postgres.Sql | null = null;
function getDbClient(): postgres.Sql {
  if (!rawClient) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is missing in test environment");
    assertSafeTestDatabase(url, process.env.APP_DATABASE_URL);
    rawClient = postgres(url, { max: 5 });
  }
  return rawClient;
}

export type TestUser = {
  userId: string;
  familyId: string;
  email: string;
};

export async function makeUser(
  overrides: Partial<{
    email: string;
    name: string;
    familyName: string;
    currency: string;
    timezone: string;
  }> = {}
): Promise<TestUser> {
  const unique = Math.random().toString(36).slice(2, 10);
  const email = overrides.email ?? `user-${unique}@test.local`;
  const res = await registerUserWithFamily(db(), {
    email,
    password: "Sup3rSecure!Pass",
    name: overrides.name ?? `Test ${unique}`,
    familyName: overrides.familyName ?? `Family ${unique}`,
    currency: overrides.currency,
    timezone: overrides.timezone
  });
  await db().execute(
    sql`UPDATE users SET email_verified_at = now() WHERE id = ${res.userId}::uuid`
  );
  return { userId: res.userId, familyId: res.familyId, email };
}

export function actorOf(user: TestUser, role: "admin" | "member" = "admin") {
  return {
    userId: user.userId,
    sessionId: "test-session",
    familyId: user.familyId,
    familyRole: role,
    platformRole: "user" as const,
    email: user.email,
    name: "Test User",
    emailVerified: true
  };
}

export async function makeSuperAdmin(): Promise<TestUser> {
  const user = await makeUser();
  await db().execute(
    sql`UPDATE users SET platform_role = 'super_admin' WHERE id = ${user.userId}::uuid`
  );
  return user;
}

export async function makeAccount(
  user: TestUser,
  overrides: Partial<Parameters<typeof accountsSvc.createAccount>[2]> = {}
): Promise<string> {
  const res = await accountsSvc.createAccount(db(), actorOf(user), {
    type: "depository",
    name: `Checking ${Math.random().toString(36).slice(2, 6)}`,
    currency: "USD",
    openingBalanceDisplayMinor: 0,
    openedOn: daysAgo(30),
    includedInReports: true,
    joint: true,
    ...overrides
  });
  return res.accountId;
}

export async function addTxn(
  user: TestUser,
  accountId: string,
  input: Partial<{
    date: string;
    name: string;
    categoryId: string | null;
    merchant: string | null;
    notes: string | null;
    tagIds: string[];
  }> & { amountLedgerMinor: number }
) {
  const res = await orchestrate.addTransaction(db(), actorOf(user), {
    accountId,
    date: daysAgo(1),
    name: "Test transaction",
    ...input
  });
  return res.entryId;
}

export async function latestBalance(
  accountId: string
): Promise<{ balanceMinor: number; asOf: string } | null> {
  const res = await db().execute<{ balance_minor: string; as_of: string }>(sql`
    SELECT balance_minor::text AS balance_minor, as_of::text AS as_of
    FROM balances WHERE account_id = ${accountId}::uuid ORDER BY as_of DESC LIMIT 1
  `);
  const row = (res.rows ?? [])[0];
  return row ? { balanceMinor: Number(row.balance_minor), asOf: row.as_of.slice(0, 10) } : null;
}

export function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function setPassword(userId: string, hash: string): Promise<void> {
  await db().execute(sql`UPDATE users SET password_hash = ${hash} WHERE id = ${userId}::uuid`);
}

export async function joinFamily(user: TestUser, familyId: string): Promise<void> {
  await db().execute(
    sql`UPDATE users SET family_id = ${familyId}::uuid WHERE id = ${user.userId}::uuid`
  );
  user.familyId = familyId;
}

export const scryptHashForTests = hashPassword;
