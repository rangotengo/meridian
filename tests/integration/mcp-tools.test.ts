import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  actorOf,
  addTxn,
  db,
  daysAgo,
  latestBalance,
  makeAccount,
  makeUser,
  truncateAll,
  type TestUser
} from "../helpers";
import { entries, families, oauthGrants } from "@/server/db/schema";
import type { McpConfig } from "@/lib/env";
import { randomToken } from "@/lib/crypto";
import {
  approveAuthorizationRequest,
  consumeAuthorizationRequest,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  registerOAuthClient,
  resolveOAuthClient,
  validateAuthorizeRequest,
  type AuthorizeRequest,
  type OAuthGrantRow,
  type TokenSuccess
} from "@/server/domain/oauth";
import { POST as mcpPost } from "@/app/mcp/route";
import * as categoriesSvc from "@/server/domain/categories";
import * as budgetsSvc from "@/server/domain/budgets";
import * as recurringSvc from "@/server/domain/recurring";
import * as reportsSvc from "@/server/domain/reports";

// Stage 3: the seven tools beyond get_financial_summary. Same harness as
// mcp-oauth.test.ts (service-level consent flow + real /mcp route calls);
// figures are asserted against the seeded ledger truth and, where a
// service exists, cross-checked against that service's own output.

const CONFIG: McpConfig = {
  resourceUrl: "https://meridian.test/mcp",
  issuerUrl: "https://meridian.test",
  cimdAllowlist: [],
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 30 * 24 * 3600,
  authorizationCodeTtlSeconds: 300,
  grantTtlSeconds: 90 * 24 * 3600
};

const LOOPBACK = "http://127.0.0.1:8910/callback";
const ALL_READ_SCOPES = [
  "finance:read",
  "transactions:read",
  "transactions:notes",
  "offline_access"
];

const ENV_KEYS = ["MCP_ENABLED", "MCP_RESOURCE_URL", "MCP_ISSUER_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.MCP_ENABLED = "true";
  process.env.MCP_RESOURCE_URL = "https://meridian.test/mcp";
  process.env.MCP_ISSUER_URL = "https://meridian.test";
  await truncateAll();
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function pkce() {
  const verifier = randomToken(32);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

type Flow = { grant: OAuthGrantRow; tokens: TokenSuccess };

async function connectFlow(user: TestUser, opts: { scopes?: string[] } = {}): Promise<Flow> {
  const exec = db();
  const { client: dcr } = await registerOAuthClient(exec, {
    clientName: "Stage3 Client",
    redirectUris: [LOOPBACK]
  });
  const client = (await resolveOAuthClient(exec, dcr.id))!;
  const { verifier, challenge } = pkce();
  const request: AuthorizeRequest = await validateAuthorizeRequest(
    exec,
    {
      clientId: client.clientId,
      redirectUri: LOOPBACK,
      responseType: "code",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: (opts.scopes ?? ALL_READ_SCOPES).join(" "),
      resource: CONFIG.resourceUrl,
      state: "state-1"
    },
    CONFIG
  );
  const actor = actorOf(user);
  const { record, csrfToken } = await createAuthorizationRequest(exec, { actor, request });
  const consumed = await consumeAuthorizationRequest(exec, {
    requestId: record.id,
    actor,
    csrfToken
  });
  const { grant, code } = await approveAuthorizationRequest(exec, consumed, CONFIG);
  const tokens = await exchangeAuthorizationCode(
    exec,
    { code, redirectUri: LOOPBACK, codeVerifier: verifier, resource: CONFIG.resourceUrl },
    client,
    CONFIG
  );
  return { grant, tokens };
}

async function setCeiling(grantId: string, accountIds: string[]) {
  await db().update(oauthGrants).set({ accountIds }).where(eq(oauthGrants.id, grantId));
}

async function rpc(token: string | null, body: unknown) {
  const res = await mcpPost(
    new Request("https://meridian.test/mcp", {
      method: "POST",
      headers: {
        host: "meridian.test",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    })
  );
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        try {
          parsed = JSON.parse(line.slice(5)) as Record<string, unknown>;
        } catch {
          /* keep scanning */
        }
      }
    }
  } else if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  return { status: res.status, body: parsed };
}

type ToolResult = {
  isError?: boolean;
  content?: { text: string }[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  structuredContent?: any;
};

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(token, {
    jsonrpc: "2.0",
    id: 42,
    method: "tools/call",
    params: { name, arguments: args }
  });
  const result = (res.body as { result?: ToolResult } | null)?.result;
  return { status: res.status, result, data: result?.structuredContent };
}

async function makeCategory(user: TestUser, name: string): Promise<string> {
  const { categoryId } = await categoriesSvc.createCategory(db(), actorOf(user), { name });
  return categoryId;
}

async function familyOf(user: TestUser) {
  const [family] = await db()
    .select()
    .from(families)
    .where(eq(families.id, user.familyId))
    .limit(1);
  return family!;
}

describe("tool registry", () => {
  it("exposes exactly the eight read-only tools", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const flow = await connectFlow(user);
    const res = await rpc(flow.tokens.accessToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {}
    });
    const tools = (res.body as { result?: { tools: { name: string }[] } })?.result?.tools ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_budget_progress",
      "get_financial_summary",
      "get_income_expense_trend",
      "get_net_worth_history",
      "get_spending_breakdown",
      "list_accounts",
      "list_recurring_transactions",
      "search_transactions"
    ]);
  });
});

describe("list_accounts", () => {
  it("returns visible accounts with balances cross-checked against the ledger", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const acctA = await makeAccount(user, { openingBalanceDisplayMinor: 100_000 });
    const acctB = await makeAccount(user, { openingBalanceDisplayMinor: 5_000 });
    await addTxn(user, acctA, { amountLedgerMinor: 25_000, name: "Groceries" });
    const flow = await connectFlow(user);

    const { data } = await callTool(flow.tokens.accessToken, "list_accounts");
    expect(data.household.baseCurrency).toBe("USD");
    expect(data.accounts).toHaveLength(2);
    const a = data.accounts.find((x: { id: string }) => x.id === acctA);
    const balA = await latestBalance(acctA);
    expect(a.amountMinor).toBe(String(balA!.balanceMinor));
    expect(a.amountMinor).toBe("75000");
    expect(a.currency).toBe("USD");
    expect(a.currencyExponent).toBe(2);
    expect(a.balanceInBaseMinor).toBe("75000");
    expect(a.balanceAsOf).toBe(balA!.asOf);
    const b = data.accounts.find((x: { id: string }) => x.id === acctB);
    expect(b.amountMinor).toBe("5000");
    expect(data.fx.complete).toBe(true);
  });

  it("denies the tool without finance:read", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const flow = await connectFlow(user, { scopes: ["transactions:read", "offline_access"] });
    const { result } = await callTool(flow.tokens.accessToken, "list_accounts");
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toContain("finance:read");
  });

  it("hides accounts outside the grant ceiling", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const acctA = await makeAccount(user, { openingBalanceDisplayMinor: 100_000 });
    const acctB = await makeAccount(user, { openingBalanceDisplayMinor: 5_000 });
    const flow = await connectFlow(user);
    await setCeiling(flow.grant.id, [acctA]);

    const { data } = await callTool(flow.tokens.accessToken, "list_accounts");
    expect(data.accounts.map((x: { id: string }) => x.id)).toEqual([acctA]);
    expect(data.accounts.some((x: { id: string }) => x.id === acctB)).toBe(false);
  });
});

describe("search_transactions", () => {
  async function seedSearchHousehold() {
    const user = await makeUser({ timezone: "UTC" });
    const food = await makeCategory(user, "Food");
    const acctA = await makeAccount(user, { openingBalanceDisplayMinor: 100_000 });
    const acctB = await makeAccount(user, { openingBalanceDisplayMinor: 5_000 });
    await addTxn(user, acctA, {
      amountLedgerMinor: 25_000,
      name: "Weekly shop",
      merchant: "SuperStore",
      categoryId: food,
      notes: "secret-note-text",
      date: daysAgo(1)
    });
    await addTxn(user, acctA, {
      amountLedgerMinor: 10_000,
      name: "Coffee",
      merchant: "Cafe",
      categoryId: food,
      date: daysAgo(2)
    });
    await addTxn(user, acctA, {
      amountLedgerMinor: -50_000,
      name: "Salary",
      merchant: "Employer",
      date: daysAgo(3)
    });
    await addTxn(user, acctB, {
      amountLedgerMinor: 7_000,
      name: "Fuel",
      merchant: "GasStation",
      date: daysAgo(1)
    });
    return { user, food, acctA, acctB };
  }

  it("filters by merchant, category, kind, and date range with totals", async () => {
    const { user, food, acctA } = await seedSearchHousehold();
    const flow = await connectFlow(user);
    const token = flow.tokens.accessToken;

    const byMerchant = await callTool(token, "search_transactions", { query: "superstore" });
    expect(byMerchant.data.page.totalMatching).toBe(1);
    expect(byMerchant.data.transactions[0].description).toBe("Weekly shop");
    expect(byMerchant.data.transactions[0].amountMinor).toBe("25000");
    expect(byMerchant.data.transactions[0].kind).toBe("expense");

    const byCategory = await callTool(token, "search_transactions", { categoryId: food });
    expect(byCategory.data.page.totalMatching).toBe(2);

    const income = await callTool(token, "search_transactions", { kind: "income" });
    expect(income.data.page.totalMatching).toBe(1);
    expect(income.data.transactions[0].kind).toBe("income");
    expect(income.data.transactions[0].amountMinor).toBe("-50000");

    const ranged = await callTool(token, "search_transactions", {
      from: daysAgo(2),
      to: daysAgo(1),
      accountId: acctA
    });
    expect(ranged.data.page.totalMatching).toBe(2);
  });

  it("paginates with a stable cursor and honest totals", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const acct = await makeAccount(user, { openingBalanceDisplayMinor: 0 });
    const ids: string[] = [];
    for (let i = 1; i <= 7; i++) {
      ids.push(
        await addTxn(user, acct, {
          amountLedgerMinor: 1_000 * i,
          name: `Page txn ${i}`,
          date: daysAgo(i)
        })
      );
    }
    const flow = await connectFlow(user);
    const token = flow.tokens.accessToken;

    const seen: string[] = [];
    let firstPageIds: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const { data } = await callTool(token, "search_transactions", {
        query: "Page txn",
        limit: 3,
        ...(cursor ? { cursor } : {})
      });
      pages++;
      expect(data.page.totalMatching).toBe(7);
      expect(data.page.returned).toBeLessThanOrEqual(3);
      if (pages === 1) firstPageIds = data.transactions.map((t: { id: string }) => t.id);
      for (const t of data.transactions) seen.push(t.id);
      if (!data.page.hasMore) {
        expect(data.page.nextCursor).toBeNull();
        break;
      }
      cursor = data.page.nextCursor;
      expect(cursor).toBeTruthy();
      expect(pages).toBeLessThan(5);
    }
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    expect(seen.sort()).toEqual([...ids].sort());

    // Cursor stability: the first page is reproducible.
    const again = await callTool(token, "search_transactions", { query: "Page txn", limit: 3 });
    expect(again.data.transactions.map((t: { id: string }) => t.id)).toEqual(firstPageIds);
    // Newest first: the most recent transaction leads the first page.
    expect(firstPageIds[0]).toBe(ids[0]);
  });

  it("excludes notes without the notes scope — in results and in text matching", async () => {
    const { user } = await seedSearchHousehold();
    const noNotes = await connectFlow(user, {
      scopes: ["transactions:read", "offline_access"]
    });
    const listed = await callTool(noNotes.tokens.accessToken, "search_transactions", {
      query: "Weekly"
    });
    expect(listed.data.notesIncluded).toBe(false);
    expect(listed.data.transactions[0].notes).toBeNull();

    // The note text itself must not be searchable without the scope.
    const byNote = await callTool(noNotes.tokens.accessToken, "search_transactions", {
      query: "secret-note"
    });
    expect(byNote.data.page.totalMatching).toBe(0);

    const withNotes = await connectFlow(user);
    const found = await callTool(withNotes.tokens.accessToken, "search_transactions", {
      query: "secret-note"
    });
    expect(found.data.notesIncluded).toBe(true);
    expect(found.data.page.totalMatching).toBe(1);
    expect(found.data.transactions[0].notes).toBe("secret-note-text");
  });

  it("denies search without transactions:read", async () => {
    const { user } = await seedSearchHousehold();
    const flow = await connectFlow(user, { scopes: ["finance:read", "offline_access"] });
    const { result } = await callTool(flow.tokens.accessToken, "search_transactions", {});
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toContain("transactions:read");
  });

  it("applies the grant ceiling to search results and account filters", async () => {
    const { user, acctA, acctB } = await seedSearchHousehold();
    const flow = await connectFlow(user);
    await setCeiling(flow.grant.id, [acctA]);
    const token = flow.tokens.accessToken;

    const all = await callTool(token, "search_transactions", {});
    expect(all.data.page.totalMatching).toBe(3);
    expect(all.data.transactions.every((t: { accountId: string }) => t.accountId === acctA)).toBe(
      true
    );

    const hidden = await callTool(token, "search_transactions", { accountId: acctB });
    expect(hidden.data.page.totalMatching).toBe(0);
    expect(hidden.data.transactions).toEqual([]);
  });

  it("never leaks another household's transactions", async () => {
    const { user } = await seedSearchHousehold();
    const other = await makeUser({ timezone: "UTC" });
    const otherAcct = await makeAccount(other, { openingBalanceDisplayMinor: 1_000 });
    await addTxn(other, otherAcct, {
      amountLedgerMinor: 3_000,
      name: "Other family purchase",
      merchant: "OtherFamMerchant"
    });
    const flow = await connectFlow(user);
    const found = await callTool(flow.tokens.accessToken, "search_transactions", {
      query: "OtherFamMerchant"
    });
    expect(found.data.page.totalMatching).toBe(0);
    const accounts = await callTool(flow.tokens.accessToken, "list_accounts");
    expect(accounts.data.accounts.some((a: { id: string }) => a.id === otherAcct)).toBe(false);
  });
});

describe("get_spending_breakdown", () => {
  async function seedBreakdown() {
    const user = await makeUser({ timezone: "UTC" });
    const food = await makeCategory(user, "Food");
    const fun = await makeCategory(user, "Fun");
    const acctA = await makeAccount(user, { openingBalanceDisplayMinor: 100_000 });
    const acctB = await makeAccount(user, { openingBalanceDisplayMinor: 5_000 });
    await addTxn(user, acctA, {
      amountLedgerMinor: 25_000,
      name: "Shop",
      merchant: "SuperStore",
      categoryId: food,
      date: daysAgo(0)
    });
    await addTxn(user, acctB, {
      amountLedgerMinor: 10_000,
      name: "Corner shop",
      merchant: "SuperStore",
      categoryId: food,
      date: daysAgo(0)
    });
    await addTxn(user, acctA, {
      amountLedgerMinor: 5_000,
      name: "Cinema",
      merchant: "Cineplex",
      categoryId: fun,
      date: daysAgo(0)
    });
    return { user, food, fun, acctA, acctB };
  }

  it("groups by category with totals cross-checked against the report service", async () => {
    const { user, food } = await seedBreakdown();
    const flow = await connectFlow(user);
    const { data } = await callTool(flow.tokens.accessToken, "get_spending_breakdown", {});

    expect(data.groupBy).toBe("category");
    expect(data.total.amountMinor).toBe("40000");
    const foodGroup = data.groups.find((g: { categoryId: string }) => g.categoryId === food);
    expect(foodGroup.total.amountMinor).toBe("35000");
    expect(foodGroup.share).toBeCloseTo(0.875, 6);
    expect(data.fx.complete).toBe(true);

    const direct = await reportsSvc.spendingByCategory(
      db(),
      await familyOf(user),
      user.userId,
      data.period
    );
    const directFood = direct.categories.find((c) => c.categoryId === food);
    expect(foodGroup.total.amountMinor).toBe(String(directFood!.totalMinor));
  });

  it("groups by merchant only with transactions:read, and correctly with it", async () => {
    const { user } = await seedBreakdown();
    const financeOnly = await connectFlow(user, { scopes: ["finance:read", "offline_access"] });
    const denied = await callTool(financeOnly.tokens.accessToken, "get_spending_breakdown", {
      groupBy: "merchant"
    });
    expect(denied.result?.isError).toBe(true);
    expect(denied.result?.content?.[0]?.text).toContain("transactions:read");

    const flow = await connectFlow(user);
    const { data } = await callTool(flow.tokens.accessToken, "get_spending_breakdown", {
      groupBy: "merchant"
    });
    const store = data.groups.find((g: { merchant: string }) => g.merchant === "SuperStore");
    expect(store.total.amountMinor).toBe("35000");
    const cinema = data.groups.find((g: { merchant: string }) => g.merchant === "Cineplex");
    expect(cinema.total.amountMinor).toBe("5000");
  });

  it("applies the grant ceiling to breakdown totals", async () => {
    const { user, acctA, food } = await seedBreakdown();
    const flow = await connectFlow(user);
    await setCeiling(flow.grant.id, [acctA]);
    const { data } = await callTool(flow.tokens.accessToken, "get_spending_breakdown", {});
    const foodGroup = data.groups.find((g: { categoryId: string }) => g.categoryId === food);
    expect(foodGroup.total.amountMinor).toBe("25000");
    expect(data.total.amountMinor).toBe("30000");
  });
});

describe("get_income_expense_trend", () => {
  it("returns monthly flows with savings derived from the service figures", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const acct = await makeAccount(user, { openingBalanceDisplayMinor: 0 });
    await addTxn(user, acct, { amountLedgerMinor: -50_000, name: "Salary", date: daysAgo(0) });
    await addTxn(user, acct, { amountLedgerMinor: 25_000, name: "Shop", date: daysAgo(0) });
    const flow = await connectFlow(user);

    const { data } = await callTool(flow.tokens.accessToken, "get_income_expense_trend", {
      months: 3
    });
    expect(data.months).toHaveLength(3);
    const current = data.months.at(-1);
    expect(current.income.amountMinor).toBe("50000");
    expect(current.expenses.amountMinor).toBe("25000");
    expect(current.savings.amountMinor).toBe("25000");
    expect(data.months[0].income.amountMinor).toBe("0");
    expect(data.fx.complete).toBe(true);

    const direct = await reportsSvc.incomeExpenseSeries(db(), await familyOf(user), user.userId, 3);
    expect(current.income.amountMinor).toBe(String(direct.flows.at(-1)!.incomeMinor));
    expect(current.expenses.amountMinor).toBe(String(direct.flows.at(-1)!.expenseMinor));
  });
});

describe("get_budget_progress", () => {
  it("reports limit, spent, and remaining cross-checked against budgetOverview", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const food = await makeCategory(user, "Food");
    const acct = await makeAccount(user, { openingBalanceDisplayMinor: 100_000 });
    await budgetsSvc.setBudget(db(), actorOf(user), {
      categoryId: null,
      amountLedgerMinor: 80_000
    });
    await budgetsSvc.setBudget(db(), actorOf(user), {
      categoryId: food,
      amountLedgerMinor: 40_000
    });
    await addTxn(user, acct, {
      amountLedgerMinor: 25_000,
      name: "Shop",
      categoryId: food,
      date: daysAgo(0)
    });
    const flow = await connectFlow(user);

    const { data } = await callTool(flow.tokens.accessToken, "get_budget_progress", {});
    expect(data.overall.limit.amountMinor).toBe("80000");
    expect(data.overall.spent.amountMinor).toBe("25000");
    expect(data.overall.remaining.amountMinor).toBe("55000");
    const foodProgress = data.perCategory.find(
      (p: { categoryId: string }) => p.categoryId === food
    );
    expect(foodProgress.spent.amountMinor).toBe("25000");
    expect(foodProgress.remaining.amountMinor).toBe("15000");
    expect(foodProgress.pctUsed).toBeCloseTo(0.625, 6);
    expect(foodProgress.overBudget).toBe(false);
    expect(data.fx.complete).toBe(true);

    const direct = await budgetsSvc.budgetOverview(db(), await familyOf(user), user.userId);
    expect(data.overall.spent.amountMinor).toBe(String(direct.overall!.spentMinor));
  });

  it("flags FX-incomplete budgets instead of silently zeroing unrated spending", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const food = await makeCategory(user, "Food");
    const usd = await makeAccount(user, { openingBalanceDisplayMinor: 100_000 });
    const jpy = await makeAccount(user, { currency: "JPY", openingBalanceDisplayMinor: 0 });
    await budgetsSvc.setBudget(db(), actorOf(user), {
      categoryId: food,
      amountLedgerMinor: 40_000
    });
    await addTxn(user, jpy, {
      amountLedgerMinor: 10_000,
      name: "Tokyo groceries",
      categoryId: food,
      date: daysAgo(0)
    });
    await addTxn(user, usd, {
      amountLedgerMinor: 5_000,
      name: "Local groceries",
      categoryId: food,
      date: daysAgo(0)
    });
    const flow = await connectFlow(user);

    const { data } = await callTool(flow.tokens.accessToken, "get_budget_progress", {});
    expect(data.fx.complete).toBe(false);
    const missing = data.fx.missingRates.find((m: { from: string }) => m.from === "JPY");
    expect(missing).toBeTruthy();
    expect(missing.excludedAmountMinor).toBe("10000");
    expect(missing.excludedCurrency).toBe("JPY");
    // The USD spending is counted; the unrated JPY spending is excluded
    // AND flagged — never silently folded in or presented as complete.
    const foodProgress = data.perCategory.find(
      (p: { categoryId: string }) => p.categoryId === food
    );
    expect(foodProgress.spent.amountMinor).toBe("5000");
  });
});

describe("list_recurring_transactions", () => {
  it("separates posted entries from scheduled occurrences in shape and status", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const acct = await makeAccount(user, { openingBalanceDisplayMinor: 100_000 });

    const dueId = await recurringSvc.createSeries(db(), actorOf(user), {
      accountId: acct,
      name: "Storage rent",
      merchant: "StoreCo",
      amountLedgerMinor: 43_210,
      frequency: "monthly",
      config: { dayOfMonth: Number(daysAgo(1).slice(8, 10)) },
      nextDue: daysAgo(1)
    });
    await recurringSvc.postDueSeries(db());

    const posted = await db()
      .select({ id: entries.id })
      .from(entries)
      .where(eq(entries.recurringSeriesId, dueId));
    expect(posted).toHaveLength(1);
    const postedEntryId = posted[0]!.id;

    const nextMonthFirst = (() => {
      const now = new Date();
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
        .toISOString()
        .slice(0, 10);
    })();
    const futureId = await recurringSvc.createSeries(db(), actorOf(user), {
      accountId: acct,
      name: "Music",
      merchant: "StreamCo",
      amountLedgerMinor: 1_500,
      frequency: "monthly",
      config: { dayOfMonth: 1 },
      nextDue: nextMonthFirst
    });
    const pausedId = await recurringSvc.createSeries(db(), actorOf(user), {
      accountId: acct,
      name: "Paused gym",
      amountLedgerMinor: 3_000,
      frequency: "monthly",
      config: { dayOfMonth: 5 },
      nextDue: nextMonthFirst
    });
    await recurringSvc.setSeriesActive(db(), actorOf(user), pausedId, false);

    const flow = await connectFlow(user);
    const { data } = await callTool(flow.tokens.accessToken, "list_recurring_transactions", {
      occurrencesPerSeries: 3
    });
    expect(data.seriesCount).toBe(3);

    const due = data.series.find((s: { id: string }) => s.id === dueId);
    expect(due.actualPostings).toHaveLength(1);
    expect(due.actualPostings[0].status).toBe("posted");
    expect(due.actualPostings[0].entryId).toBe(postedEntryId);
    expect(due.actualPostings[0].amount.amountMinor).toBe("43210");
    expect(due.scheduledOccurrences).toHaveLength(3);
    expect(
      due.scheduledOccurrences.every((o: { status: string }) => o.status === "scheduled")
    ).toBe(true);
    expect(due.scheduledOccurrences[0].date).toBe(due.nextDue);

    const future = data.series.find((s: { id: string }) => s.id === futureId);
    expect(future.actualPostings).toEqual([]);
    expect(future.scheduledOccurrences.map((o: { date: string }) => o.date)).toEqual([
      nextMonthFirst,
      (() => {
        const d = new Date(`${nextMonthFirst}T00:00:00Z`);
        d.setUTCMonth(d.getUTCMonth() + 1);
        return d.toISOString().slice(0, 10);
      })(),
      (() => {
        const d = new Date(`${nextMonthFirst}T00:00:00Z`);
        d.setUTCMonth(d.getUTCMonth() + 2);
        return d.toISOString().slice(0, 10);
      })()
    ]);

    const paused = data.series.find((s: { id: string }) => s.id === pausedId);
    expect(paused.active).toBe(false);
    expect(paused.scheduledOccurrences).toEqual([]);
  });
});

describe("get_net_worth_history", () => {
  it("returns daily snapshot points with full coverage inside the account's life", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const acct = await makeAccount(user, {
      openingBalanceDisplayMinor: 100_000,
      openedOn: daysAgo(30)
    });
    await addTxn(user, acct, { amountLedgerMinor: 25_000, name: "Shop", date: daysAgo(1) });
    const flow = await connectFlow(user);

    const { data } = await callTool(flow.tokens.accessToken, "get_net_worth_history", {
      days: 7
    });
    expect(data.points).toHaveLength(7);
    expect(data.coverage.daysInRange).toBe(7);
    expect(data.coverage.daysWithSnapshots).toBe(7);
    expect(data.coverage.missingDays).toBe(0);
    expect(data.coverage.complete).toBe(true);
    const last = data.points.at(-1);
    const bal = await latestBalance(acct);
    expect(last.netWorth.amountMinor).toBe(String(bal!.balanceMinor));
    expect(last.date).toBe(daysAgo(0));
    expect(data.fx.complete).toBe(true);
  });

  it("reports pre-history ranges as missing data, never as zero points", async () => {
    const user = await makeUser({ timezone: "UTC" });
    await makeAccount(user, { openingBalanceDisplayMinor: 100_000, openedOn: daysAgo(30) });
    const flow = await connectFlow(user);

    const empty = await callTool(flow.tokens.accessToken, "get_net_worth_history", {
      from: daysAgo(45),
      to: daysAgo(31)
    });
    expect(empty.data.points).toEqual([]);
    expect(empty.data.coverage.daysWithSnapshots).toBe(0);
    expect(empty.data.coverage.daysInRange).toBe(15);
    expect(empty.data.coverage.missingDays).toBe(15);
    expect(empty.data.coverage.complete).toBe(false);
    expect(empty.data.coverage.gaps).toEqual([{ from: daysAgo(45), to: daysAgo(31), days: 15 }]);

    const spanning = await callTool(flow.tokens.accessToken, "get_net_worth_history", {
      from: daysAgo(40),
      to: daysAgo(0)
    });
    expect(spanning.data.points).toHaveLength(31);
    expect(spanning.data.coverage.missingDays).toBe(10);
    expect(spanning.data.coverage.gaps).toEqual([{ from: daysAgo(40), to: daysAgo(31), days: 10 }]);
    expect(spanning.data.coverage.complete).toBe(false);
  });
});

describe("scope enforcement matrix", () => {
  it("denies every finance tool to a transactions-only grant, naming finance:read", async () => {
    const user = await makeUser({ timezone: "UTC" });
    await makeAccount(user, { openingBalanceDisplayMinor: 1_000 });
    const flow = await connectFlow(user, {
      scopes: ["transactions:read", "transactions:notes", "offline_access"]
    });
    const token = flow.tokens.accessToken;
    const financeTools: [string, Record<string, unknown>][] = [
      ["list_accounts", {}],
      ["get_spending_breakdown", { groupBy: "category" }],
      ["get_income_expense_trend", { months: 3 }],
      ["get_budget_progress", {}],
      ["list_recurring_transactions", {}],
      ["get_net_worth_history", { days: 7 }]
    ];
    for (const [name, args] of financeTools) {
      const { result } = await callTool(token, name, args);
      expect(result?.isError, `${name} should be denied`).toBe(true);
      expect(result?.content?.[0]?.text).toContain("finance:read");
    }
    // The same grant can still use its own scope.
    const ok = await callTool(token, "search_transactions", {});
    expect(ok.result?.isError).toBeFalsy();
  });
});
