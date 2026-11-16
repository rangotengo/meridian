/**
 * The Meridian MCP server: twelve read-only tools.
 *
 * A fresh McpServer is built per request (stateless transport). Authority
 * comes from the McpAccess resolved by the route — token → grant → user →
 * bound household, all re-read from the database on this call — and each
 * tool's scope (see TOOL_SCOPES) is enforced HERE, in the handler, not by
 * annotations (annotations are presentation hints for clients, nothing
 * more). The grant's account ceiling is intersected with the user's
 * current account access on every call and passed down to the services.
 * The four SSIS tools additionally require the grant's explicit SSIS
 * permission (oauth_grants.ssis_access): SSIS is a household-wide
 * insight dataset outside the account model, so finance:read alone
 * never unlocks it.
 *
 * Financial figures come from the existing domain services
 * (dashboardSummary, latestBalancesFor, report/budget/recurring/entry
 * services, convertMinor); this module adds no financial math of its own.
 * Amounts are integer minor units as strings, each with its currency and
 * exponent; totals that aggregate across currencies carry the FX
 * completeness block, and missing data is reported as missing — never
 * silently zeroed or presented as a complete total.
 */
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { and, asc, count, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../db/client";
import {
  accounts,
  entries,
  ssisInsightState,
  ssisNavHistory,
  ssisPurchases,
  ssisStatementEntries
} from "../db/schema";
import type { McpConfig } from "@/lib/env";
import { currencyExponent } from "@/lib/money";
import { addDays, isIsoDate, todayIn } from "@/lib/datetime";
import { latestBalancesFor } from "../domain/balances";
import { budgetOverview } from "../domain/budgets";
import { listEntriesPage } from "../domain/entries";
import { convertMinor, getRateInfo } from "../domain/exchange-rates";
import { listSeries, nextOccurrence, type Frequency, type SeriesConfig } from "../domain/recurring";
import {
  currentMonthRange,
  dashboardSummary,
  incomeExpenseSeries,
  netWorthSeries,
  spendingByCategory,
  spendingByMerchant,
  type DashboardSummary,
  type FxCompleteness
} from "../domain/reports";
import { accessibleAccountIds } from "../authorization/access";
import {
  getSsisCoverage,
  getSsisInsight,
  resolveCurrentNav,
  toSsisNavPoint,
  toSsisPurchaseRow,
  toSsisStatementRow,
  type SsisDatasetCoverage
} from "../domain/ssis";
import { recordAudit } from "../observability/audit";
import type { McpAccess } from "../domain/oauth";
import { BREAKDOWN_MERCHANT_SCOPE, NOTES_SCOPE, TOOL_SCOPES } from "./scopes";

export type McpRequestContext = {
  exec: Executor;
  access: McpAccess;
  config: McpConfig;
};

function money(amountMinor: number, currency: string) {
  return {
    amountMinor: String(amountMinor),
    currency,
    currencyExponent: currencyExponent(currency)
  };
}

function fxRatesUsed(fx: FxCompleteness) {
  return fx.fxRates.map((r) => ({
    from: r.base,
    to: r.quote,
    rate: r.rate,
    quotedOn: r.quotedOn
  }));
}

function fxMissing(fx: FxCompleteness) {
  return fx.fxIssues.map((i) => ({
    from: i.base,
    to: i.quote,
    excludedAmountMinor: String(i.amountMinor),
    excludedCurrency: i.base
  }));
}

const FX_WARNING =
  "Some amounts could not be converted to the household currency because no exchange rate exists; the affected amounts are excluded from the totals.";

/** Completeness block for any FxCompleteness-shaped service result. */
function fxFromCompleteness(fx: FxCompleteness, familyCurrency: string) {
  const ratesUsed = fxRatesUsed(fx);
  if (!fx.incompleteFx) return { complete: true, ratesUsed };
  return {
    complete: false,
    warning: FX_WARNING,
    missingRates: fxMissing(fx),
    ratesUsed,
    familyCurrency
  };
}

function fxBlock(summary: DashboardSummary, familyCurrency: string) {
  const fx: FxCompleteness = {
    incompleteFx: summary.incompleteFx ?? false,
    fxIssues: summary.fxIssues ?? [],
    fxRates: summary.fxRates ?? []
  };
  return fxFromCompleteness(fx, familyCurrency);
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

/** The SSIS scheme is NPR-denominated (the domain read model's currency). */
const SSIS_CURRENCY = "NPR";

const SSIS_SEPARATE_NOTE =
  "SSIS is a separate household insight dataset; it is not part of account balances or net worth.";

/** Bounded pagination shared by the SSIS row tools. */
const ssisPageSchema = {
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(10_000).default(0)
};

function ssisPage(limit: number, offset: number, returned: number, totalMatching: number) {
  return {
    limit,
    offset,
    returned,
    totalMatching,
    hasMore: offset + returned < totalMatching
  };
}

/**
 * Caveat lines for one SSIS dataset's persisted coverage, shared by the
 * SSIS tools. An "ok" dataset needs no caveat; anything else is spelled
 * out so stored rows are never mistaken for a complete, fresh dataset —
 * a failed holder fetch must not read as a genuinely empty position.
 */
function ssisCoverageLimitations(label: string, coverage: SsisDatasetCoverage): string[] {
  if (coverage.status === "ok") return [];
  if (coverage.status === "failed") {
    return [
      `${label} data may be incomplete: the most recent refresh could not retrieve it from Siddhartha Capital${
        coverage.fetchedAt
          ? `; the rows shown date from the last successful fetch at ${coverage.fetchedAt}`
          : "; it has never been fetched successfully"
      }.`
    ];
  }
  return [
    `${label} coverage is unknown: Meridian has no recorded successful fetch of this dataset, so the rows shown cannot be confirmed complete.`
  ];
}

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
  .refine((v) => isIsoDate(v), "date must be a real calendar date");

function encodeCursor(cursor: { date: string; id: string }): string {
  return btoa(encodeURIComponent(JSON.stringify(cursor)));
}

function decodeCursor(raw: string): { date: string; id: string } {
  try {
    const parsed = JSON.parse(decodeURIComponent(atob(raw))) as { date?: unknown; id?: unknown };
    if (
      typeof parsed.date !== "string" ||
      !isIsoDate(parsed.date) ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0
    ) {
      throw new Error("malformed");
    }
    return { date: parsed.date, id: parsed.id };
  } catch {
    throw new Error("Invalid pagination cursor.");
  }
}

export function createMeridianMcpServer(ctx: McpRequestContext): McpServer {
  const server = new McpServer({ name: "meridian", version: "1.0.0" });
  const { exec, access } = ctx;
  const { actor, family, grant } = access;
  const base = family.currency;

  /** Scope enforcement lives in the handlers (defense in depth — the
   * grant was already checked at connection resolution). */
  function requireScope(scope: string) {
    if (!grant.scopes.includes(scope)) {
      throw new Error(`This connection does not include the ${scope} scope.`);
    }
  }

  /**
   * SSIS permission: the grant's explicit SSIS flag, checked AFTER the
   * tool's finance:read scope. The flag is read from the grant row
   * resolved for THIS call, so an owner toggling it in Connected AI
   * agents takes effect immediately. The account ceiling deliberately
   * does not apply — SSIS has no accounts; that is exactly why the
   * permission is separate and opt-in.
   */
  function requireSsisPermission() {
    if (!grant.ssisAccess) {
      throw new Error(
        "This connection does not include SSIS insight access. SSIS is a separate household dataset that finance:read does not cover; the connection owner can enable it in Settings → Connected AI agents."
      );
    }
  }

  /** SSIS amounts are always NPR; null stays null (unavailable is never
   * presented as zero). */
  function ssisMoney(amountMinor: number | null) {
    return amountMinor === null ? null : money(amountMinor, SSIS_CURRENCY);
  }

  /** Accounts the caller may see right now: current access ∩ grant ceiling. */
  async function visibleAccountIds(): Promise<string[]> {
    const accessible = await accessibleAccountIds(exec, actor);
    if (grant.accountIds.length === 0) return accessible;
    const ceiling = new Set(grant.accountIds);
    return accessible.filter((id) => ceiling.has(id));
  }

  /** The account restriction handed to report services: only when the
   * grant carries a ceiling (otherwise the services' own access rules —
   * the same set — apply). The value is the live intersection. */
  function serviceRestriction(visible: string[]): string[] | undefined {
    return grant.accountIds.length > 0 ? visible : undefined;
  }

  function envelope() {
    return {
      household: { name: family.name, baseCurrency: base, timezone: family.timezone },
      asOf: new Date().toISOString()
    };
  }

  async function audit(tool: string) {
    // Metadata-only audit: tool name + grant, never result payloads.
    await recordAudit(exec, {
      familyId: family.id,
      actorUserId: actor.userId,
      action: "mcp.tool_called",
      entityType: "oauth_grant",
      entityId: grant.id,
      metadata: { tool }
    });
  }

  function respond(result: Record<string, unknown>) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result
    };
  }

  server.registerTool(
    "get_financial_summary",
    {
      title: "Get financial summary",
      description:
        "Read-only summary of the connected household: net worth, assets, liabilities, this month's income and expenses, per-account balances, and top spending categories. Amounts are integer minor units (e.g. paisa/cents) as strings, each with its currency and exponent. Totals are in the household currency; when fx.complete is false, some accounts could not be converted and totals exclude them.",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async () => {
      requireScope(TOOL_SCOPES.get_financial_summary);

      // Account visibility is re-resolved per call; the grant's account
      // ceiling (empty = all accessible, the PoC default) narrows it.
      // The restriction is passed INTO the summary service so every
      // subquery — balances, flows, categories, FX — is computed over
      // the visible set only. Filtering the account list afterwards
      // would still leak excluded accounts' totals and category names.
      const visibleIds = await visibleAccountIds();
      const summary = await dashboardSummary(
        exec,
        family,
        actor.userId,
        serviceRestriction(visibleIds)
      );

      const accountRows =
        visibleIds.length > 0
          ? await exec
              .select({
                id: accounts.id,
                name: accounts.name,
                type: accounts.type,
                currency: accounts.currency
              })
              .from(accounts)
              .where(inArray(accounts.id, visibleIds))
          : [];
      const balances = await latestBalancesFor(exec, visibleIds);
      const accountsOut = accountRows.map((a) => {
        const balance = balances.get(a.id);
        const rate = (summary.fxRates ?? []).find((r) => r.base === a.currency && r.quote === base);
        return {
          id: a.id,
          name: a.name,
          type: a.type,
          // No snapshot means the balance is UNKNOWN — null, never "0".
          amountMinor: balance ? String(balance.balanceMinor) : null,
          currency: a.currency,
          currencyExponent: currencyExponent(a.currency),
          balanceInBaseMinor:
            balance == null
              ? null
              : a.currency === base
                ? String(balance.balanceMinor)
                : rate
                  ? String(convertMinor(balance.balanceMinor, rate.rate, a.currency, base))
                  : null
        };
      });
      const balancesAsOf =
        balances.size > 0
          ? [...balances.values()]
              .map((b) => b.asOf)
              .sort()
              .at(-1)!
          : null;

      const result = {
        household: { name: family.name, baseCurrency: base, timezone: family.timezone },
        asOf: new Date().toISOString(),
        balancesAsOf,
        month: summary.monthKey,
        netWorth: money(summary.netWorthMinor, base),
        assets: money(summary.assetsMinor, base),
        liabilities: money(summary.liabilitiesMinor, base),
        incomeThisMonth: money(summary.incomeThisMonthMinor, base),
        expensesThisMonth: money(summary.expenseThisMonthMinor, base),
        accounts: accountsOut,
        topCategories: summary.topCategories.map((c) => ({
          name: c.name,
          totalMinor: String(c.totalMinor)
        })),
        fx: fxBlock(summary, base)
      };

      await audit("get_financial_summary");
      return respond(result);
    }
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List accounts",
      description:
        "Read-only list of the household accounts visible to this connection, with current balances. Each balance is in the account's own currency (integer minor units as a string, with currency and exponent) plus balanceInBaseMinor converted to the household currency when a rate exists (null when it does not — see the fx block). An account with no balance snapshot yet reports amountMinor as null rather than zero.",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async () => {
      requireScope(TOOL_SCOPES.list_accounts);

      const visibleIds = await visibleAccountIds();
      const rows =
        visibleIds.length > 0
          ? await exec
              .select({
                id: accounts.id,
                name: accounts.name,
                type: accounts.type,
                status: accounts.status,
                currency: accounts.currency,
                includedInReports: accounts.includedInReports
              })
              .from(accounts)
              .where(inArray(accounts.id, visibleIds))
          : [];
      const balances = await latestBalancesFor(exec, visibleIds);
      const today = todayIn(family.timezone);

      const missing: { base: string; quote: string; amountMinor: number }[] = [];
      const usedRates: FxCompleteness["fxRates"] = [];
      const accountsOut = [];
      for (const a of rows) {
        const balance = balances.get(a.id);
        let balanceInBaseMinor: string | null = null;
        if (balance) {
          if (a.currency === base) {
            balanceInBaseMinor = String(balance.balanceMinor);
          } else {
            const info = await getRateInfo(exec, a.currency, base, today);
            if (info) {
              balanceInBaseMinor = String(
                convertMinor(balance.balanceMinor, info.rate, a.currency, base)
              );
              if (!usedRates.some((r) => r.base === info.base && r.quote === info.quote)) {
                usedRates.push(info);
              }
            } else {
              missing.push({ base: a.currency, quote: base, amountMinor: balance.balanceMinor });
            }
          }
        }
        accountsOut.push({
          id: a.id,
          name: a.name,
          type: a.type,
          status: a.status,
          includedInReports: a.includedInReports,
          amountMinor: balance ? String(balance.balanceMinor) : null,
          currency: a.currency,
          currencyExponent: currencyExponent(a.currency),
          balanceAsOf: balance?.asOf ?? null,
          balanceInBaseMinor
        });
      }

      const result = {
        ...envelope(),
        accounts: accountsOut,
        fx: fxFromCompleteness(
          {
            incompleteFx: missing.length > 0,
            fxIssues: missing.map((m) => ({ ...m, date: today })),
            fxRates: usedRates
          },
          base
        )
      };

      await audit("list_accounts");
      return respond(result);
    }
  );

  server.registerTool(
    "search_transactions",
    {
      title: "Search transactions",
      description:
        "Read-only, paginated search over the household's posted ledger entries (newest first). Filters: date range (from/to, YYYY-MM-DD), accountId, categoryId, free-text query (matches description and merchant; notes are searched only when this connection has the transactions:notes scope), and kind (expense/income/transfer). Amounts are integer minor units as strings in each entry's own currency. Returns page.totalMatching so a page is never mistaken for the full result set. Entry notes are included only with the transactions:notes scope; otherwise the notes field is null and notesIncluded is false. Use page.nextCursor to fetch the next page.",
      inputSchema: z.object({
        from: dateString.optional(),
        to: dateString.optional(),
        accountId: z.string().uuid().optional(),
        categoryId: z.string().uuid().optional(),
        query: z.string().min(1).max(120).optional(),
        kind: z.enum(["expense", "income", "transfer"]).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().max(512).optional()
      }),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      requireScope(TOOL_SCOPES.search_transactions);

      const visible = await visibleAccountIds();
      const includeNotes = grant.scopes.includes(NOTES_SCOPE);
      const cursor = args.cursor ? decodeCursor(args.cursor) : null;
      if (args.from && args.to && args.from > args.to) {
        throw new Error("The from date must not be after the to date.");
      }

      // An account outside the visible set is indistinguishable from an
      // empty result — its existence is not leaked.
      const accountHidden = args.accountId !== undefined && !visible.includes(args.accountId);
      const page = accountHidden
        ? { items: [], nextCursor: null, totalMatching: 0 }
        : await listEntriesPage(exec, actor, {
            accountId: args.accountId,
            accountIds: visible,
            categoryId: args.categoryId,
            search: args.query,
            searchNotes: includeNotes,
            kind: args.kind,
            from: args.from,
            to: args.to,
            cursor,
            limit: args.limit,
            withTotal: true
          });

      const transactions = page.items.map((item) => ({
        id: item.id,
        date: item.date,
        description: item.name,
        merchant: item.merchant,
        ...money(item.amountMinor, item.currency),
        accountId: item.accountId,
        accountName: item.accountName,
        categoryId: item.categoryId,
        categoryName: item.categoryName,
        kind: item.transferId ? "transfer" : item.amountMinor > 0 ? "expense" : "income",
        transferId: item.transferId,
        notes: includeNotes ? item.notes : null
      }));

      const result = {
        ...envelope(),
        period: { from: args.from ?? null, to: args.to ?? null },
        notesIncluded: includeNotes,
        transactions,
        page: {
          limit: args.limit,
          returned: transactions.length,
          totalMatching: page.totalMatching ?? transactions.length,
          hasMore: page.nextCursor !== null,
          nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null
        }
      };

      await audit("search_transactions");
      return respond(result);
    }
  );

  server.registerTool(
    "get_spending_breakdown",
    {
      title: "Get spending breakdown",
      description:
        "Read-only spending totals grouped by category (default) or by merchant, over a date range (default: the current month in the household timezone). Totals are converted to the household currency; when fx.complete is false, amounts without an exchange rate were excluded and the totals are partial. Grouping by merchant additionally requires the transactions:read scope, because merchant strings are transaction text. Amounts are integer minor units as strings.",
      inputSchema: z.object({
        groupBy: z.enum(["category", "merchant"]).default("category"),
        from: dateString.optional(),
        to: dateString.optional()
      }),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      requireScope(TOOL_SCOPES.get_spending_breakdown);
      if (args.groupBy === "merchant") requireScope(BREAKDOWN_MERCHANT_SCOPE);

      const month = currentMonthRange(family.timezone);
      const range = { from: args.from ?? month.from, to: args.to ?? month.to };
      if (range.from > range.to) {
        throw new Error("The from date must not be after the to date.");
      }
      const visible = await visibleAccountIds();
      const restrict = serviceRestriction(visible);

      let groups: { key: string | null; label: string | null; totalMinor: number; share: number }[];
      let fx: FxCompleteness;
      let totalMinor = 0;
      if (args.groupBy === "merchant") {
        const res = await spendingByMerchant(exec, family, actor.userId, range, restrict);
        fx = res.fx;
        groups = res.merchants.map((m) => ({
          key: m.merchant,
          label: m.merchant,
          totalMinor: m.totalMinor,
          share: m.share
        }));
        totalMinor = res.merchants.reduce((acc, m) => acc + m.totalMinor, 0);
      } else {
        const res = await spendingByCategory(exec, family, actor.userId, range, restrict);
        fx = res.fx;
        groups = res.categories.map((c) => ({
          key: c.categoryId,
          label: c.name,
          totalMinor: c.totalMinor,
          share: c.share
        }));
        totalMinor = res.categories.reduce((acc, c) => acc + c.totalMinor, 0);
      }

      const result = {
        ...envelope(),
        groupBy: args.groupBy,
        period: range,
        groups: groups.map((g) =>
          args.groupBy === "merchant"
            ? { merchant: g.key, total: money(g.totalMinor, base), share: g.share }
            : {
                categoryId: g.key,
                categoryName: g.label,
                total: money(g.totalMinor, base),
                share: g.share
              }
        ),
        total: money(totalMinor, base),
        fx: fxFromCompleteness(fx, base)
      };

      await audit("get_spending_breakdown");
      return respond(result);
    }
  );

  server.registerTool(
    "get_income_expense_trend",
    {
      title: "Get income and expense trend",
      description:
        "Read-only monthly income, expenses, and savings (income minus expenses) for the last N months including the current one, in the household currency. Amounts are integer minor units as strings. When fx.complete is false, amounts without an exchange rate were excluded from the affected months and the figures are partial.",
      inputSchema: z.object({
        months: z.number().int().min(1).max(24).default(12)
      }),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      requireScope(TOOL_SCOPES.get_income_expense_trend);

      const visible = await visibleAccountIds();
      const res = await incomeExpenseSeries(
        exec,
        family,
        actor.userId,
        args.months,
        serviceRestriction(visible)
      );

      const result = {
        ...envelope(),
        period: {
          fromMonth: res.flows[0]?.monthKey ?? null,
          toMonth: res.flows.at(-1)?.monthKey ?? null
        },
        months: res.flows.map((f) => ({
          month: f.monthKey,
          income: money(f.incomeMinor, base),
          expenses: money(f.expenseMinor, base),
          savings: money(f.incomeMinor - f.expenseMinor, base)
        })),
        fx: fxFromCompleteness(res.fx, base)
      };

      await audit("get_income_expense_trend");
      return respond(result);
    }
  );

  server.registerTool(
    "get_budget_progress",
    {
      title: "Get budget progress",
      description:
        "Read-only progress for the current month's budgets (budgets are denominated in the household currency): limit, spent, remaining, and fraction used, overall and per category. Spent amounts are converted to the household currency; when fx.complete is false, spending without an exchange rate was excluded, so spent/remaining are partial and must not be read as exact.",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async () => {
      requireScope(TOOL_SCOPES.get_budget_progress);

      const visible = await visibleAccountIds();
      const overview = await budgetOverview(
        exec,
        family,
        actor.userId,
        serviceRestriction(visible)
      );

      const mapProgress = (p: {
        categoryId: string | null;
        categoryName: string;
        limitMinor: number;
        spentMinor: number;
        remainingMinor: number;
        pct: number;
      }) => ({
        categoryId: p.categoryId,
        categoryName: p.categoryName,
        limit: money(p.limitMinor, base),
        spent: money(p.spentMinor, base),
        remaining: money(p.remainingMinor, base),
        pctUsed: p.pct,
        overBudget: p.spentMinor > p.limitMinor
      });

      const result = {
        ...envelope(),
        month: overview.monthKey,
        overall: overview.overall ? mapProgress(overview.overall) : null,
        perCategory: overview.perCategory.map(mapProgress),
        categoriesWithoutBudget: overview.categoriesWithoutBudget,
        fx: fxFromCompleteness(overview.fx, base)
      };

      await audit("get_budget_progress");
      return respond(result);
    }
  );

  server.registerTool(
    "list_recurring_transactions",
    {
      title: "List recurring transactions",
      description:
        'Read-only list of the household\'s recurring series (subscription-like definitions) visible to this connection. Each series separates actualPostings — real, already-posted ledger entries, each with status "posted" — from scheduledOccurrences — projected future postings computed from the schedule, each with status "scheduled". Scheduled occurrences are NOT transactions and must never be added to actual spending. Amounts are integer minor units as strings in each series\' own currency.',
      inputSchema: z.object({
        occurrencesPerSeries: z.number().int().min(1).max(12).default(3)
      }),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      requireScope(TOOL_SCOPES.list_recurring_transactions);

      const visible = new Set(await visibleAccountIds());
      const series = (await listSeries(exec, actor)).filter((s) => visible.has(s.accountId));

      // Recent actual postings for these series (posted ledger entries,
      // linked by recurring_series_id) — kept strictly separate from the
      // projected occurrences below.
      const postingsBySeries = new Map<
        string,
        { entryId: string; date: string; amountMinor: number; currency: string }[]
      >();
      if (series.length > 0) {
        const rows = await exec
          .select({
            id: entries.id,
            seriesId: entries.recurringSeriesId,
            date: entries.date,
            amountMinor: entries.amountMinor,
            currency: entries.currency
          })
          .from(entries)
          .where(
            and(
              inArray(
                entries.recurringSeriesId,
                series.map((s) => s.id)
              ),
              eq(entries.entryableType, "transaction")
            )
          )
          .orderBy(desc(entries.date), desc(entries.id))
          .limit(3 * series.length);
        for (const r of rows) {
          if (!r.seriesId) continue;
          const list = postingsBySeries.get(r.seriesId) ?? [];
          if (list.length < 3) {
            list.push({
              entryId: r.id,
              date: r.date,
              amountMinor: r.amountMinor,
              currency: r.currency
            });
          }
          postingsBySeries.set(r.seriesId, list);
        }
      }

      const seriesOut = series.map((s) => {
        const scheduledOccurrences: { date: string; status: "scheduled" }[] = [];
        if (s.active) {
          let date = s.nextDue;
          for (let i = 0; i < args.occurrencesPerSeries; i++) {
            scheduledOccurrences.push({ date, status: "scheduled" });
            date = nextOccurrence(s.frequency as Frequency, (s.config ?? {}) as SeriesConfig, date);
          }
        }
        return {
          id: s.id,
          name: s.name,
          merchant: s.merchant,
          accountId: s.accountId,
          accountName: s.accountName,
          amount: money(s.amountMinor, s.currency),
          categoryId: s.categoryId,
          frequency: s.frequency,
          nextDue: s.nextDue,
          active: s.active,
          actualPostings: (postingsBySeries.get(s.id) ?? []).map((p) => ({
            entryId: p.entryId,
            date: p.date,
            amount: money(p.amountMinor, p.currency),
            status: "posted" as const
          })),
          scheduledOccurrences
        };
      });

      const result = {
        ...envelope(),
        distinction:
          "actualPostings are posted ledger entries; scheduledOccurrences are projected future postings, not transactions.",
        seriesCount: seriesOut.length,
        series: seriesOut
      };

      await audit("list_recurring_transactions");
      return respond(result);
    }
  );

  server.registerTool(
    "get_net_worth_history",
    {
      title: "Get net worth history",
      description:
        "Read-only historical net worth from the household's materialized daily balance snapshots, in the household currency (integer minor units as strings). Give either a day count (default 90) or an explicit from/to date range (maximum 730 days). The coverage block states exactly which days in the range have snapshots: days without snapshots are reported as missing (with gap ranges), never interpolated or presented as zero. Completeness is per account per day: a point where some visible account's snapshot is missing is marked complete: false with the missing account ids (and listed in coverage.partialDays), and coverage.complete is true only when every day is fully covered. When fx.complete is false, some balances could not be converted on some days and those days' values exclude them.",
      inputSchema: z.object({
        days: z.number().int().min(1).max(730).optional(),
        from: dateString.optional(),
        to: dateString.optional()
      }),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      requireScope(TOOL_SCOPES.get_net_worth_history);

      const today = todayIn(family.timezone);
      const to = args.to ?? today;
      if (to > today) {
        throw new Error("The to date must not be in the future.");
      }
      const from = args.from ?? addDays(to, -((args.days ?? 90) - 1));
      if (from > to) {
        throw new Error("The from date must not be after the to date.");
      }
      const spanDays = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
      if (spanDays > 731) {
        throw new Error("The requested range exceeds the 730-day maximum.");
      }

      const visible = await visibleAccountIds();
      // The service windows back from today; ask for enough days to cover
      // the requested range, then trim to it exactly.
      const windowDays = Math.round((Date.parse(today) - Date.parse(from)) / 86_400_000);
      const res = await netWorthSeries(
        exec,
        family,
        actor.userId,
        windowDays,
        serviceRestriction(visible)
      );
      const points = res.points.filter((p) => p.date >= from && p.date <= to);

      const present = new Set(points.map((p) => p.date));
      const gaps: { from: string; to: string; days: number }[] = [];
      let gapStart: string | null = null;
      let cursor = from;
      for (let i = 0; i < spanDays; i++) {
        const date = addDays(from, i);
        cursor = date;
        if (!present.has(date)) {
          if (gapStart === null) gapStart = date;
        } else if (gapStart !== null) {
          const gapEnd = addDays(date, -1);
          gaps.push({
            from: gapStart,
            to: gapEnd,
            days: Math.round((Date.parse(gapEnd) - Date.parse(gapStart)) / 86_400_000) + 1
          });
          gapStart = null;
        }
      }
      if (gapStart !== null) {
        gaps.push({
          from: gapStart,
          to: cursor,
          days: Math.round((Date.parse(cursor) - Date.parse(gapStart)) / 86_400_000) + 1
        });
      }
      const missingDays = gaps.reduce((acc, g) => acc + g.days, 0);

      // Per-account/day completeness within the requested range: a day
      // can have a point (some accounts reported) while another visible
      // account's snapshot is missing — such points are partial and
      // must never be presented as complete.
      const partialByDate = new Map(
        res.incompleteDates
          .filter((d) => d.date >= from && d.date <= to)
          .map((d) => [d.date, d.missingAccountIds])
      );
      const partialDays = [...partialByDate.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, missingAccountIds]) => ({ date, missingAccountIds }));

      const result = {
        ...envelope(),
        period: { from, to },
        points: points.map((p) => {
          const missingAccountIds = partialByDate.get(p.date);
          return {
            date: p.date,
            netWorth: money(p.valueMinor, base),
            complete: missingAccountIds === undefined,
            ...(missingAccountIds ? { missingAccountIds } : {})
          };
        }),
        coverage: {
          daysInRange: spanDays,
          daysWithSnapshots: points.length,
          missingDays,
          gaps,
          partialDays,
          complete: missingDays === 0 && partialDays.length === 0
        },
        fx: fxFromCompleteness(res.fx, base)
      };

      await audit("get_net_worth_history");
      return respond(result);
    }
  );

  server.registerTool(
    "get_ssis_summary",
    {
      title: "Get SSIS summary",
      description:
        "Read-only summary of the household's SSIS insight (Siddhartha Systematic Investment Scheme): totals invested, units held, current NAV and value, profit and return, plus dataset counts and per-dataset coverage. Requires the finance:read scope AND this connection's explicit SSIS permission (the owner enables it in Settings → Connected AI agents); SSIS is household-wide data separate from accounts, so account restrictions on the connection do not apply to it. Amounts are integer minor units as strings in NPR. A figure that cannot be represented exactly is null, never approximated. SSIS figures are NOT part of account balances or net worth, and this tool never imports or refreshes data. coverage reports, per dataset (purchases, statement, nav), the last known fetch outcome and the last successful fetch time; totals.complete is true only when purchase coverage is established — otherwise the totals are subtotals of the rows currently stored and may understate the position (e.g. after a partially failed refresh), never a confirmed complete zero.",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async () => {
      requireScope(TOOL_SCOPES.get_ssis_summary);
      requireSsisPermission();

      // The domain read model the Insights page uses — same NAV
      // selection, same summary math, same safe conversions.
      const insight = await getSsisInsight(exec, actor);
      const s = insight.summary;

      const limitations = [SSIS_SEPARATE_NOTE];
      if (insight.lastFetchedAt) {
        limitations.push(
          "dataAsOf is the most recent import or refresh of ANY SSIS dataset; it does not imply every dataset was refreshed then. Per-dataset freshness is reported under coverage, and MCP reads never fetch live data."
        );
      } else {
        limitations.push(
          "Freshness is unknown: no SSIS import or refresh timestamp is recorded for this household."
        );
      }
      limitations.push(...ssisCoverageLimitations("Purchase", insight.coverage.purchases));
      limitations.push(...ssisCoverageLimitations("Statement", insight.coverage.statement));
      limitations.push(...ssisCoverageLimitations("NAV", insight.coverage.nav));
      if (insight.coverage.purchases.status !== "ok") {
        limitations.push(
          "Totals are computed from the purchase rows currently stored and are observed subtotals, not a confirmed complete position (see totals.complete)."
        );
      }
      if (!insight.hasData) {
        limitations.push("No SSIS data has been imported for this household yet.");
      }
      if (s.purchaseCount > 0 && s.currentNavMinor === null) {
        limitations.push(
          "No current NAV is available, so current value, profit and return cannot be computed."
        );
      }
      if (s.totalInvestedMinor === null) {
        limitations.push(
          "The invested total exceeds the exactly-representable range and is reported as null rather than approximated."
        );
      }

      const result = {
        ...envelope(),
        ssis: {
          schemeName: insight.schemeName,
          currency: insight.currency,
          hasData: insight.hasData,
          dataAsOf: insight.lastFetchedAt,
          lastSource: insight.lastSource,
          coverage: insight.coverage,
          counts: {
            purchases: s.purchaseCount,
            statementEntries: insight.statement.length,
            navPoints: insight.navSeries.length
          },
          totals: {
            complete: insight.coverage.purchases.status === "ok",
            purchaseCount: s.purchaseCount,
            totalUnits: s.totalUnits,
            totalInvested: ssisMoney(s.totalInvestedMinor),
            currentValue: ssisMoney(s.currentValueMinor),
            profit: ssisMoney(s.profitMinor),
            returnPercent: s.returnPercent
          },
          currentNav:
            s.currentNavMinor === null
              ? null
              : { ...money(s.currentNavMinor, insight.currency), date: s.currentNavDate },
          navStats: {
            minNav: ssisMoney(insight.navStats.minNavMinor),
            maxNav: ssisMoney(insight.navStats.maxNavMinor),
            avgNav: ssisMoney(insight.navStats.avgNavMinor),
            changeFromMinPercent: insight.navStats.changeFromMinPercent
          },
          limitations
        }
      };

      await audit("get_ssis_summary");
      return respond(result);
    }
  );

  server.registerTool(
    "list_ssis_purchases",
    {
      title: "List SSIS purchases",
      description:
        "Read-only, paginated list of the household's SSIS purchases (oldest first), with optional from/to filters on the apply date (YYYY-MM-DD). Requires the finance:read scope AND this connection's explicit SSIS permission. Amounts are integer minor units as strings in NPR; unit quantities are decimal strings. Returns page.totalMatching so a page is never mistaken for the full history — note totalMatching counts only the rows currently stored; coverage reports whether the purchase dataset was fetched successfully and when, so an incomplete or stale list is distinguishable from a complete one.",
      inputSchema: z.object({
        from: dateString.optional(),
        to: dateString.optional(),
        ...ssisPageSchema
      }),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      requireScope(TOOL_SCOPES.list_ssis_purchases);
      requireSsisPermission();
      if (args.from && args.to && args.from > args.to) {
        throw new Error("The from date must not be after the to date.");
      }
      const conditions = [eq(ssisPurchases.familyId, family.id)];
      if (args.from) conditions.push(gte(ssisPurchases.applyDate, args.from));
      if (args.to) conditions.push(lte(ssisPurchases.applyDate, args.to));
      const where = and(...conditions);
      const [countRow] = await exec.select({ total: count() }).from(ssisPurchases).where(where);
      const rows = await exec
        .select()
        .from(ssisPurchases)
        .where(where)
        .orderBy(asc(ssisPurchases.applyDate), asc(ssisPurchases.requestNo))
        .limit(args.limit)
        .offset(args.offset);

      const purchases = rows.map(toSsisPurchaseRow).map((p) => ({
        requestNo: p.requestNo,
        applyDate: p.applyDate,
        units: p.units,
        amount: money(p.amountMinor, SSIS_CURRENCY),
        status: p.status,
        purchaseNav: ssisMoney(p.purchaseNavMinor),
        navDate: p.navDate,
        schemeName: p.schemeName,
        isSip: p.isSip
      }));

      const coverage = await getSsisCoverage(exec, family.id);
      const result = {
        ...envelope(),
        note: SSIS_SEPARATE_NOTE,
        dataAsOf: coverage.purchases.fetchedAt,
        coverage,
        limitations: [
          "page.totalMatching counts only the purchase rows currently stored in Meridian.",
          ...ssisCoverageLimitations("Purchase", coverage.purchases)
        ],
        period: { from: args.from ?? null, to: args.to ?? null },
        purchases,
        page: ssisPage(args.limit, args.offset, purchases.length, countRow?.total ?? 0)
      };

      await audit("list_ssis_purchases");
      return respond(result);
    }
  );

  server.registerTool(
    "list_ssis_statement",
    {
      title: "List SSIS statement entries",
      description:
        "Read-only, paginated list of the household's SSIS statement entries (oldest first), with optional from/to filters on the installment date (YYYY-MM-DD). Requires the finance:read scope AND this connection's explicit SSIS permission. Amounts are integer minor units as strings in NPR (amountCr = credited, amountDr = debited); unit quantities are decimal strings. Returns page.totalMatching so a page is never mistaken for the full statement — note totalMatching counts only the rows currently stored; coverage reports whether the statement dataset was fetched successfully and when, so an incomplete or stale list is distinguishable from a complete one.",
      inputSchema: z.object({
        from: dateString.optional(),
        to: dateString.optional(),
        ...ssisPageSchema
      }),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      requireScope(TOOL_SCOPES.list_ssis_statement);
      requireSsisPermission();
      if (args.from && args.to && args.from > args.to) {
        throw new Error("The from date must not be after the to date.");
      }
      const conditions = [eq(ssisStatementEntries.familyId, family.id)];
      if (args.from) conditions.push(gte(ssisStatementEntries.installmentDate, args.from));
      if (args.to) conditions.push(lte(ssisStatementEntries.installmentDate, args.to));
      const where = and(...conditions);
      const [countRow] = await exec
        .select({ total: count() })
        .from(ssisStatementEntries)
        .where(where);
      const rows = await exec
        .select()
        .from(ssisStatementEntries)
        .where(where)
        .orderBy(asc(ssisStatementEntries.installmentDate), asc(ssisStatementEntries.transNo))
        .limit(args.limit)
        .offset(args.offset);

      // Whitelisted DTO: the SIP registration number stored on the row
      // is a holder identifier and is deliberately not exposed.
      const statement = rows.map(toSsisStatementRow).map((r) => ({
        transNo: r.transNo,
        installmentDate: r.installmentDate,
        dueDate: r.dueDate,
        actionDate: r.actionDate,
        amountCr: money(r.amountCrMinor, SSIS_CURRENCY),
        amountDr: money(r.amountDrMinor, SSIS_CURRENCY),
        units: r.units,
        appliedNav: ssisMoney(r.appliedNavMinor),
        payment: r.payment,
        otherCharges: money(r.otherChargesMinor, SSIS_CURRENCY),
        sebonFee: money(r.sebonFeeMinor, SSIS_CURRENCY)
      }));

      const coverage = await getSsisCoverage(exec, family.id);
      const result = {
        ...envelope(),
        note: SSIS_SEPARATE_NOTE,
        dataAsOf: coverage.statement.fetchedAt,
        coverage,
        limitations: [
          "page.totalMatching counts only the statement rows currently stored in Meridian.",
          ...ssisCoverageLimitations("Statement", coverage.statement)
        ],
        period: { from: args.from ?? null, to: args.to ?? null },
        statement,
        page: ssisPage(args.limit, args.offset, statement.length, countRow?.total ?? 0)
      };

      await audit("list_ssis_statement");
      return respond(result);
    }
  );

  server.registerTool(
    "get_ssis_nav_history",
    {
      title: "Get SSIS NAV history",
      description:
        "Read-only, paginated NAV history for the household's SSIS scheme (oldest first), with optional from/to filters on the NAV date (YYYY-MM-DD). Requires the finance:read scope AND this connection's explicit SSIS permission. NAV values are integer minor units as strings in NPR. currentNav is the value in effect today under the domain's selection rules (latest recorded NAV not in the future, falling back to the last fetched quote); it is null when no NAV is known. coverage reports whether the NAV dataset was fetched successfully and when (dataAsOf alone is the most recent fetch of ANY SSIS dataset).",
      inputSchema: z.object({
        from: dateString.optional(),
        to: dateString.optional(),
        ...ssisPageSchema
      }),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      requireScope(TOOL_SCOPES.get_ssis_nav_history);
      requireSsisPermission();
      if (args.from && args.to && args.from > args.to) {
        throw new Error("The from date must not be after the to date.");
      }
      const conditions = [eq(ssisNavHistory.familyId, family.id)];
      if (args.from) conditions.push(gte(ssisNavHistory.engDate, args.from));
      if (args.to) conditions.push(lte(ssisNavHistory.engDate, args.to));
      const where = and(...conditions);
      const [countRow] = await exec.select({ total: count() }).from(ssisNavHistory).where(where);
      const rows = await exec
        .select()
        .from(ssisNavHistory)
        .where(where)
        .orderBy(asc(ssisNavHistory.engDate))
        .limit(args.limit)
        .offset(args.offset);

      // Current NAV under the domain's selection rules: the latest
      // history point not in the future (a one-row candidate list is
      // equivalent — resolveCurrentNav picks the latest eligible
      // point), falling back to the last fetched quote in state.
      const today = todayIn(family.timezone);
      const [latestRow] = await exec
        .select()
        .from(ssisNavHistory)
        .where(and(eq(ssisNavHistory.familyId, family.id), lte(ssisNavHistory.engDate, today)))
        .orderBy(desc(ssisNavHistory.engDate))
        .limit(1);
      const [state] = await exec
        .select()
        .from(ssisInsightState)
        .where(eq(ssisInsightState.familyId, family.id))
        .limit(1);
      const stateNav =
        state?.latestNavMinor != null && state?.latestNavDate
          ? { navMinor: state.latestNavMinor, navDate: state.latestNavDate }
          : null;
      const current = resolveCurrentNav(
        latestRow ? [toSsisNavPoint(latestRow)] : [],
        stateNav,
        today
      );

      const points = rows.map(toSsisNavPoint).map((p) => ({
        engDate: p.engDate,
        nepDate: p.nepDate,
        nav: money(p.navMinor, SSIS_CURRENCY)
      }));

      const coverage = await getSsisCoverage(exec, family.id);
      const result = {
        ...envelope(),
        note: SSIS_SEPARATE_NOTE,
        dataAsOf: state?.lastFetchedAt ? new Date(state.lastFetchedAt).toISOString() : null,
        coverage,
        limitations: ssisCoverageLimitations("NAV", coverage.nav),
        period: { from: args.from ?? null, to: args.to ?? null },
        currentNav: current
          ? { ...money(current.navMinor, SSIS_CURRENCY), date: current.navDate }
          : null,
        points,
        page: ssisPage(args.limit, args.offset, points.length, countRow?.total ?? 0)
      };

      await audit("get_ssis_nav_history");
      return respond(result);
    }
  );

  return server;
}

/** Build the per-request SDK handler for an already-authenticated call. */
export function handleMcpRequest(request: Request, ctx: McpRequestContext) {
  const handler = createMcpHandler(() => createMeridianMcpServer(ctx));
  return handler.fetch(request, {
    authInfo: {
      token: "opaque",
      clientId: ctx.access.grant.clientId,
      scopes: ctx.access.grant.scopes,
      expiresAt: Math.floor(ctx.access.grant.expiresAt.getTime() / 1000)
    }
  });
}
